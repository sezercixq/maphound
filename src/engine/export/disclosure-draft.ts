import type { FindingRecord } from '@/core/db';
import type { AuditFinding } from '@/engine/audit';
import type { EndpointHit, SinkCategory, SinkHit } from '@/engine/intel';

const SINK_IMPACT: Record<SinkCategory, { impact: string; remediation: string }> = {
  'taint-flow': {
    impact:
      'Untrusted browser input flows directly into a dangerous execution, DOM, redirect, or object-merge sink without sanitization, enabling high-impact client-side exploitation.',
    remediation:
      'Sanitize or strictly validate untrusted input at the boundary (e.g. DOMPurify, allowlisted URLs, safe property keys) before passing it to the sink.',
  },
  'dom-xss': {
    impact:
      'If user-controlled or untrusted data reaches this DOM HTML sink, an attacker can execute arbitrary JavaScript in the origin of the application.',
    remediation:
      'Replace raw HTML insertion with textContent/JSX text binding, or sanitize strictly with DOMPurify before rendering.',
  },
  'code-injection': {
    impact:
      'Evaluating dynamic strings as JavaScript enables arbitrary client-side code execution and potential session compromise.',
    remediation:
      'Remove eval() / new Function() / string timers and use structured JSON parsing or static function references.',
  },
  messaging: {
    impact:
      'Cross-window message handlers without strict event.origin checks (or wildcard targetOrigin) can allow malicious pages to inject commands or intercept sensitive payloads.',
    remediation:
      'Validate event.origin against an explicit allowlist of trusted origins before processing event.data, and pass an explicit targetOrigin to postMessage().',
  },
  redirect: {
    impact:
      'Assigning unvalidated input to window.location or window.open enables Open Redirect or javascript: URI execution.',
    remediation:
      'Validate redirect targets against an allowlist of same-origin relative paths or permitted hosts and block non-http(s) schemes.',
  },
  'authz-idor': {
    impact:
      'Client-side authorization gates, unvalidated postMessage handlers, or predictable object-ID endpoints may allow unauthorized access or cross-origin actions if not strictly enforced server-side.',
    remediation:
      'Enforce object-level authorization (BOLA/IDOR checks) on the server for every request and validate event.origin against an explicit allowlist in message handlers.',
  },
  crypto: {
    impact:
      'Weak randomness (Math.random), deprecated hashes (MD5/SHA-1), AES-ECB, static IVs/salts, or weak/long-lived JWT configurations undermine confidentiality and token integrity.',
    remediation:
      'Use crypto.getRandomValues(), SHA-256/Argon2, authenticated encryption (AES-GCM) with unique random IVs, and short-lived asymmetrically signed JWTs.',
  },
  framework: {
    impact:
      'Bypassing framework template escaping or exposing hydration state increases client-side XSS and data-exposure risk.',
    remediation:
      'Use framework auto-escaping bindings and ensure server-rendered props contain only public, non-sensitive data.',
  },
};

export function draftSecretReport(finding: FindingRecord, origin: string): string {
  const scriptUrl = finding.locations[0]?.scriptUrl ?? 'N/A';
  const lines = [
    `## Security Report Draft: Exposed ${finding.ruleName}`,
    '',
    `- **Target:** \`${origin}\``,
    `- **Severity:** ${finding.severity.toUpperCase()} (${finding.confidence})`,
    `- **Location:** \`${finding.file}:${finding.line}:${finding.column + 1}\``,
    `- **Asset URL:** \`${scriptUrl}\``,
    `- **Masked Evidence:** \`${finding.preview}\``,
    '',
    '### Summary',
    `Client-side static analysis detected a ${finding.ruleName} embedded in publicly served frontend code (${finding.locationKind}).`,
    '',
    '### Code Context (Masked)',
    '```js',
    finding.snippet,
    '```',
    '',
    '### Impact',
    'Anyone loading the public JavaScript bundle or its source map can extract this credential and access the associated provider APIs or resources.',
    '',
    '### Remediation',
    '1. Revoke and rotate the exposed credential immediately.',
    '2. Move privileged API calls and secret keys to a backend service or server-side environment variables.',
    '3. Disable public `.map` source map exposure in production builds.',
  ];
  if (finding.references.length > 0) {
    lines.push('', `### Reference`, `- ${finding.references[0]}`);
  }
  return `${lines.join('\n')}\n`;
}

export function draftEndpointReport(endpoint: EndpointHit, origin: string): string {
  const loc = endpoint.locations[0];
  const methods = endpoint.methods.length > 0 ? endpoint.methods.join(', ') : 'Unknown';
  const lines = [
    `## Security Report Draft: Exposed Client-Side Endpoint (${endpoint.value})`,
    '',
    `- **Target:** \`${origin}\``,
    `- **Category:** ${endpoint.category}`,
    `- **Methods Observed:** ${methods}`,
    `- **Location:** ${loc ? `\`${loc.file}:${loc.line}\`` : 'N/A'}`,
    '',
    '### Summary',
    `Publicly served client-side code references the \`${endpoint.value}\` (${endpoint.category}) endpoint.`,
    '',
    '### Recommended Verification',
    '1. Confirm strict server-side authentication and role-based access control (RBAC) are enforced on this route.',
    '2. Verify internal, debug, or administrative endpoints are not reachable from untrusted client sessions.',
    '3. Strip references to unreleased or internal-only endpoints from production bundles.',
  ];
  return `${lines.join('\n')}\n`;
}

export function draftSinkReport(sink: SinkHit, origin: string): string {
  const guidance = SINK_IMPACT[sink.category];
  const lines = [
    `## Security Report Draft: ${sink.title}`,
    '',
    `- **Target:** \`${origin}\``,
    `- **Category:** ${sink.category} (${sink.level})`,
    `- **Location:** \`${sink.location.file}:${sink.location.line}:${sink.location.column + 1}\``,
    `- **Asset URL:** \`${sink.location.scriptUrl}\``,
    '',
    '### Code Context',
    '```js',
    sink.snippet,
    '```',
    '',
    '### Potential Impact',
    guidance.impact,
    '',
    '### Remediation',
    guidance.remediation,
  ];
  return `${lines.join('\n')}\n`;
}

export function draftAuditReport(finding: AuditFinding, origin: string): string {
  const lines = [
    `## Security Report Draft: ${finding.title}`,
    '',
    `- **Target:** \`${origin}\``,
    `- **Category:** ${finding.category}`,
    `- **Severity:** ${finding.severity.toUpperCase()}`,
    `- **Subject:** \`${finding.subject}\``,
  ];
  if (finding.preview) lines.push(`- **Masked Preview:** \`${finding.preview}\``);
  lines.push('', '### Details', finding.detail, '', '### Remediation', finding.recommendation);
  return `${lines.join('\n')}\n`;
}
