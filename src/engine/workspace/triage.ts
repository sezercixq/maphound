import type { Severity } from '@/core/db';

export type TriageStatus = 'unreviewed' | 'confirmed' | 'investigating' | 'false_positive';

export const TRIAGE_STATUSES: readonly TriageStatus[] = [
  'unreviewed',
  'confirmed',
  'investigating',
  'false_positive',
];

export type TriageFindingKind = 'secret' | 'sink' | 'audit' | 'supply-chain' | 'oauth';

/** Persistent researcher triage record stored in IndexedDB (`triage` store). */
export interface TriageRecord {
  /** Stable deterministic hash/id so false positives stay muted across rescans. */
  id: string;
  origin: string;
  domain: string;
  kind: TriageFindingKind;
  title: string;
  severity: Severity;
  status: TriageStatus;
  note: string;
  asset?: string;
  evidence?: string;
  cwe?: string;
  updatedAt: number;
}

/** Build a deterministic, rescan-stable triage ID for any finding type. */
export function findingTriageId(kind: TriageFindingKind, ...parts: readonly string[]): string {
  const clean = parts.map((p) => p.trim().replace(/\s+/g, ' ')).join('|');
  return `${kind}:${clean}`;
}

export interface TriageFilterResult<T> {
  visible: T[];
  dismissedCount: number;
}

/**
 * Filter items using the triage map: `false_positive` entries are hidden by default
 * unless `showDismissed` is enabled.
 */
export function filterByTriage<T>(
  items: readonly T[],
  getId: (item: T) => string,
  triageById: ReadonlyMap<string, TriageRecord>,
  showDismissed = false,
): TriageFilterResult<T> {
  let dismissedCount = 0;
  const visible: T[] = [];
  for (const item of items) {
    const rec = triageById.get(getId(item));
    if (rec?.status === 'false_positive') {
      dismissedCount++;
      if (showDismissed) visible.push(item);
      continue;
    }
    visible.push(item);
  }
  return { visible, dismissedCount };
}

const DEFAULT_CWE: Record<TriageFindingKind, string> = {
  secret: 'CWE-798 (Use of Hard-coded Credentials)',
  sink: 'CWE-79 (Improper Neutralization of Input During Web Page Generation)',
  audit: 'CWE-693 (Protection Mechanism Failure)',
  'supply-chain': 'CWE-829 (Inclusion of Functionality from Untrusted Control Sphere)',
  oauth: 'CWE-352 (Cross-Site Request Forgery / OAuth Flow Weakness)',
};

const DEFAULT_IMPACT: Record<TriageFindingKind, string> = {
  secret:
    'Exposed credentials or tokens in client-side bundles/source maps may allow unauthorized access to backend APIs or third-party services depending on key scope.',
  sink: 'Untrusted data reaching a sensitive client-side sink can enable client-side script execution, open redirects, or unauthorized state changes.',
  audit:
    'Missing or weakened browser security controls reduce defense-in-depth against XSS, clickjacking, session theft, or cross-origin data exposure.',
  'supply-chain':
    'Missing Subresource Integrity, outdated client libraries, or suspicious third-party script behavior increase the risk of client-side supply-chain compromise.',
  oauth:
    'Weak OAuth 2.0 / OIDC / SAML client configurations can expose tokens via browser history/Referer headers or permit CSRF and redirect manipulation.',
};

const DEFAULT_REMEDIATION: Record<TriageFindingKind, string> = {
  secret:
    'Rotate and revoke the affected credential immediately, remove it from frontend source/build pipelines, and proxy privileged calls through a server-side endpoint.',
  sink: 'Validate and sanitize untrusted input before passing it to sensitive sinks, prefer safe DOM APIs (`textContent`), and enforce strict origin/allowlist checks.',
  audit:
    'Harden HTTP security headers (CSP, HSTS, X-Frame-Options), enforce `HttpOnly`/`Secure`/`SameSite` on session cookies, and avoid storing sensitive tokens in Web Storage.',
  'supply-chain':
    'Pin third-party assets with `integrity` (SHA-384) and `crossorigin="anonymous"`, upgrade vulnerable client dependencies, and restrict script origins via CSP.',
  oauth:
    'Migrate to Authorization Code Flow with PKCE (`S256`), enforce cryptographically random `state` and `nonce` parameters, and strictly validate exact `redirect_uri` values.',
};

export interface BountyReportMeta {
  target: string;
  generator: string;
  exportedAt: string;
}

/** Generate a single HackerOne / Bugcrowd formatted Markdown report for one confirmed finding. */
export function generateSingleBountyReport(record: TriageRecord, meta: BountyReportMeta): string {
  const cwe = record.cwe || DEFAULT_CWE[record.kind];
  const lines: string[] = [
    `# [${record.severity.toUpperCase()}] ${record.title}`,
    '',
    `- **Target:** \`${meta.target}\``,
    `- **Severity:** \`${record.severity.toUpperCase()}\``,
    `- **Classification:** ${cwe}`,
    `- **Triage Status:** \`${record.status}\``,
    `- **Category:** \`${record.kind}\``,
    ...(record.asset ? [`- **Affected Asset:** \`${record.asset}\``] : []),
    `- **Generated:** ${meta.exportedAt} (${meta.generator})`,
    '',
    '## Summary',
    '',
    record.note.trim()
      ? record.note.trim()
      : `${record.title} identified during passive client-side security review of \`${meta.target}\`.`,
    '',
    '## Evidence',
    '',
  ];

  if (record.evidence?.trim()) {
    lines.push('```text', record.evidence.trim(), '```', '');
  } else {
    lines.push(`Observed on \`${record.asset ?? record.origin}\` (masked for safe reporting).`, '');
  }

  lines.push(
    '## Verification Steps',
    '',
    `1. Navigate to \`${record.origin}\` in a browser with DevTools open.`,
    record.asset
      ? `2. Inspect the affected asset (\`${record.asset}\`) and verify the reported pattern/configuration.`
      : '2. Inspect the served client bundle, response headers, or page configuration.',
    '3. Confirm whether the issue is reproducible in the current production deployment without modifying user data.',
    '',
    '## Security Impact',
    '',
    DEFAULT_IMPACT[record.kind],
    '',
    '## Remediation',
    '',
    DEFAULT_REMEDIATION[record.kind],
    '',
  );

  return lines.join('\n');
}

const SEVERITY_RANK: Record<Severity, number> = {
  critical: 5,
  high: 4,
  medium: 3,
  low: 2,
  info: 1,
};

/**
 * Generate `TRIAGE_REPORT.md` covering confirmed (or selected) findings in HackerOne/Bugcrowd
 * structure for direct submission or ZIP archival.
 */
export function generateTriageReportMarkdown(
  records: readonly TriageRecord[],
  meta: BountyReportMeta,
  options: { includeInvestigating?: boolean } = {},
): string {
  const selected = records
    .filter(
      (r) =>
        r.status === 'confirmed' || (options.includeInvestigating && r.status === 'investigating'),
    )
    .sort(
      (a, b) =>
        SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity] || a.title.localeCompare(b.title),
    );

  const lines: string[] = [
    `# Bug Bounty Triage Report — ${meta.target}`,
    '',
    `- **Target:** \`${meta.target}\``,
    `- **Generator:** ${meta.generator}`,
    `- **Exported:** ${meta.exportedAt}`,
    `- **Confirmed Findings:** ${selected.filter((r) => r.status === 'confirmed').length}`,
    '',
  ];

  if (selected.length === 0) {
    lines.push('No confirmed findings were selected for this report.', '');
    return lines.join('\n');
  }

  lines.push(
    '## Executive Summary',
    '',
    '| # | Severity | Category | Title | Asset | Status |',
    '|---|----------|----------|-------|-------|--------|',
  );
  selected.forEach((rec, i) => {
    const asset = (rec.asset ?? rec.origin).replace(/\|/g, '\\|');
    const title = rec.title.replace(/\|/g, '\\|');
    lines.push(
      `| ${i + 1} | ${rec.severity.toUpperCase()} | ${rec.kind} | ${title} | \`${asset}\` | ${rec.status} |`,
    );
  });
  lines.push('', '---', '');

  selected.forEach((rec, i) => {
    lines.push(`## Finding ${i + 1}`, '', generateSingleBountyReport(rec, meta), '---', '');
  });

  return lines.join('\n');
}
