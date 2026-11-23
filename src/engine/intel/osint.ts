import { registrableDomain } from '@/core/scope';
import { maskSecret } from '@/engine/scan/mask';
import type { LexResult, LineIndex } from './lexer';
import {
  OSINT_ATLASSIAN,
  OSINT_AUTH0_TENANT,
  OSINT_AZURE_BLOB,
  OSINT_CLERK_TENANT,
  OSINT_CLOUDFLARE_R2,
  OSINT_EMAIL,
  OSINT_FIREBASE_HOST,
  OSINT_GA4,
  OSINT_GCS_SUBDOMAIN,
  OSINT_GCS_URL,
  OSINT_GIT_REPO,
  OSINT_GTM,
  OSINT_HOST_CANDIDATE,
  OSINT_INTERCOM_BEFORE,
  OSINT_INTERNAL_HOST,
  OSINT_IPV4,
  OSINT_LINEAR,
  OSINT_LOCAL_BUILD_PATH,
  OSINT_MIXPANEL_BEFORE,
  OSINT_POSTHOG,
  OSINT_S3_PATH_URL,
  OSINT_S3_URI,
  OSINT_S3_URL,
  OSINT_SEGMENT_BEFORE,
  OSINT_SENTRY_DSN,
  OSINT_STRIPE_PK,
  OSINT_UA,
} from './patterns';
import { type IntelLocation, OSINT_CATEGORIES, type OsintCategory, type OsintHit } from './types';

export const MAX_OSINT_PER_FILE = 150;

export interface OsintExtractOptions {
  siteOrigin?: string;
}

const INTERESTING_SUBDOMAIN_PREFIXES = new Set([
  'staging',
  'stage',
  'stg',
  'dev',
  'develop',
  'internal',
  'intranet',
  'api',
  'apis',
  'admin',
  'vpn',
  'qa',
  'uat',
  'test',
  'sandbox',
  'corp',
  'ops',
  'staff',
  'beta',
  'canary',
  'preprod',
  'sso',
  'auth',
  'graphql',
]);

const IGNORED_PRIVATE_IPS = new Set([
  '10.0.0.0',
  '10.0.0.1',
  '10.0.0.2',
  '172.16.0.0',
  '172.16.0.1',
  '192.168.0.0',
  '192.168.0.1',
  '192.168.1.0',
  '192.168.1.1',
  '192.168.1.254',
]);

const NOISE_EMAIL_LOCALS = new Set([
  'example',
  'user',
  'test',
  'demo',
  'name',
  'email',
  'you',
  'your-email',
  'someone',
  'noreply',
  'no-reply',
  'donotreply',
  'do-not-reply',
]);

const NOISE_GIT_ORGS = new Set([
  'facebook',
  'reactjs',
  'vercel',
  'nextjs',
  'vuejs',
  'angular',
  'sveltejs',
  'tailwindlabs',
  'webpack',
  'babel',
  'tc39',
  'w3c',
  'mdn',
  'lodash',
  'microsoft',
  'google',
  'axios',
]);

const CLOUD_STATIC_HOSTS = new Set([
  's3.amazonaws.com',
  'storage.googleapis.com',
  'storage.cloud.google.com',
]);

function isValidDnsHost(host: string): boolean {
  if (host.length < 4 || host.length > 253) return false;
  const labels = host.split('.');
  if (labels.length < 2) return false;
  for (const label of labels) {
    if (!label || label.length > 63) return false;
    if (label.startsWith('-') || label.endsWith('-')) return false;
  }
  const tld = labels[labels.length - 1] ?? '';
  if (/^[0-9]+$/.test(tld) || tld.length < 2) return false;
  return true;
}

function isRealPrivateIp(ip: string): boolean {
  const parts = ip.split('.');
  if (parts.length !== 4) return false;
  const octets = parts.map((p) => Number(p));
  if (octets.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false;
  const [a, b, , d] = octets as [number, number, number, number];
  const isRfc1918 = a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
  if (!isRfc1918) return false;
  if (d === 0 || d === 255) return false;
  return !IGNORED_PRIVATE_IPS.has(ip);
}

function maskPersonName(name: string): string {
  const clean = name.trim();
  if (clean.length <= 2) return '*'.repeat(Math.max(clean.length, 2));
  if (clean.length <= 4)
    return `${clean[0]}${'*'.repeat(clean.length - 2)}${clean[clean.length - 1]}`;
  return `${clean[0]}${'***'}${clean[clean.length - 1]}`;
}

function formatMaskedBuildPath(
  rawMatch: string,
  user: string,
  project?: string,
): {
  kind: string;
  value: string;
} {
  const maskedUser = maskPersonName(user);
  const tail = project ? `/${project}` : '';
  if (rawMatch.startsWith('/Users/')) {
    return { kind: 'macOS Home Path', value: `/Users/${maskedUser}${tail}` };
  }
  if (rawMatch.startsWith('/home/')) {
    return { kind: 'Linux Home Path', value: `/home/${maskedUser}${tail}` };
  }
  const drive = rawMatch.slice(0, 2);
  const winTail = project ? `\\${project}` : '';
  return { kind: 'Windows Home Path', value: `${drive}\\Users\\${maskedUser}${winTail}` };
}

function parseRootDomain(siteOrigin?: string): { siteHost: string; rootDomain: string } | null {
  if (!siteOrigin) return null;
  try {
    const host = new URL(siteOrigin).hostname.toLowerCase();
    const root = registrableDomain(host)?.toLowerCase() ?? null;
    if (!root) return null;
    return { siteHost: host, rootDomain: root };
  } catch {
    return null;
  }
}

export function extractOsint(
  text: string,
  lexed: LexResult,
  lines: LineIndex,
  base: Omit<IntelLocation, 'line' | 'column'>,
  options: OsintExtractOptions = {},
): OsintHit[] {
  const results = new Map<string, OsintHit>();
  const siteInfo = parseRootDomain(options.siteOrigin);

  const record = (
    category: OsintCategory,
    kind: string,
    value: string,
    offset: number,
    detail?: string,
  ) => {
    if (!value) return;
    const key = `${category}\u0000${kind}\u0000${value}`;
    const pos = lines.position(Math.max(0, offset));
    const loc: IntelLocation = { ...base, line: pos.line, column: pos.column };
    const existing = results.get(key);
    if (existing) {
      if (!existing.detail && detail) existing.detail = detail;
      if (
        existing.locations.length < 10 &&
        !existing.locations.some(
          (l) => l.file === loc.file && l.line === loc.line && l.column === loc.column,
        )
      ) {
        existing.locations.push(loc);
      }
      return;
    }
    if (results.size >= MAX_OSINT_PER_FILE) return;
    results.set(key, { category, kind, value, ...(detail ? { detail } : {}), locations: [loc] });
  };

  const scanChunk = (raw: string, offset: number, beforeSlice?: string) => {
    const val = raw.trim();
    if (!val || val.length > 1000) return;

    // 1. Cloud Storage & Services
    const s3Url = OSINT_S3_URL.exec(val);
    if (s3Url?.[1]) {
      record('cloud', 'AWS S3 Bucket', `s3://${s3Url[1].toLowerCase()}`, offset);
    }
    const s3Path = OSINT_S3_PATH_URL.exec(val);
    if (s3Path?.[1]) {
      record('cloud', 'AWS S3 Bucket', `s3://${s3Path[1].toLowerCase()}`, offset);
    }
    const s3Uri = OSINT_S3_URI.exec(val);
    if (s3Uri?.[1]) {
      record('cloud', 'AWS S3 Bucket', `s3://${s3Uri[1].toLowerCase()}`, offset);
    }
    const gcsUrl = OSINT_GCS_URL.exec(val);
    if (gcsUrl?.[1]) {
      record('cloud', 'GCS Bucket', `gs://${gcsUrl[1].toLowerCase()}`, offset);
    }
    const gcsSub = OSINT_GCS_SUBDOMAIN.exec(val);
    if (gcsSub?.[1]) {
      record('cloud', 'GCS Bucket', `gs://${gcsSub[1].toLowerCase()}`, offset);
    }
    const firebase = OSINT_FIREBASE_HOST.exec(val);
    if (firebase?.[1]) {
      const host = firebase[1].toLowerCase();
      record('cloud', 'Firebase Project', host, offset, `project: ${host.split('.')[0]}`);
    }
    const azure = OSINT_AZURE_BLOB.exec(val);
    if (azure?.[1]) {
      const account = azure[1].toLowerCase();
      const target = azure[2]
        ? `${account}.blob.core.windows.net/${azure[2]}`
        : `${account}.blob.core.windows.net`;
      record('cloud', 'Azure Blob Storage', target, offset);
    }
    const r2 = OSINT_CLOUDFLARE_R2.exec(val);
    if (r2?.[1]) {
      const account = r2[1].toLowerCase();
      record('cloud', 'Cloudflare R2', r2[2] ? `${account}/${r2[2]}` : account, offset);
    }

    // 2. Active-domain Subdomain discovery
    if (siteInfo) {
      OSINT_HOST_CANDIDATE.lastIndex = 0;
      for (const m of val.matchAll(OSINT_HOST_CANDIDATE)) {
        const host = m[1]?.toLowerCase() ?? '';
        if (
          !host ||
          CLOUD_STATIC_HOSTS.has(host) ||
          !isValidDnsHost(host) ||
          host === siteInfo.rootDomain ||
          host === siteInfo.siteHost ||
          !host.endsWith(`.${siteInfo.rootDomain}`)
        ) {
          continue;
        }
        const firstLabel = host.split('.')[0] ?? '';
        const tag = INTERESTING_SUBDOMAIN_PREFIXES.has(firstLabel)
          ? `env: ${firstLabel}`
          : undefined;
        record('subdomain', 'Subdomain Reference', host, offset, tag);
      }
    }

    // 3. Private RFC1918 IPv4 & Internal hosts
    OSINT_IPV4.lastIndex = 0;
    for (const m of val.matchAll(OSINT_IPV4)) {
      const ip = m[1] ?? '';
      const port = m[2];
      if (!isRealPrivateIp(ip)) continue;
      if (port) {
        const portNum = Number(port);
        if (!Number.isInteger(portNum) || portNum < 1 || portNum > 65535) continue;
      }
      const display = port ? `${ip}:${port}` : ip;
      record('internal-ip', 'Private IPv4', display, offset, 'RFC1918');
    }
    OSINT_INTERNAL_HOST.lastIndex = 0;
    for (const m of val.matchAll(OSINT_INTERNAL_HOST)) {
      const host = m[1]?.toLowerCase() ?? '';
      if (isValidDnsHost(host)) {
        record('internal-ip', 'Internal Host', host, offset);
      }
    }

    // 4. Local Build Paths
    OSINT_LOCAL_BUILD_PATH.lastIndex = 0;
    for (const m of val.matchAll(OSINT_LOCAL_BUILD_PATH)) {
      if (!m[1]) continue;
      const formatted = formatMaskedBuildPath(m[0], m[1], m[2]);
      record('build-path', formatted.kind, formatted.value, offset, 'user masked');
    }

    // 5. Developer & Org Attribution
    if (siteInfo) {
      OSINT_EMAIL.lastIndex = 0;
      for (const m of val.matchAll(OSINT_EMAIL)) {
        const local = m[1]?.toLowerCase() ?? '';
        const domain = m[2]?.toLowerCase() ?? '';
        if (
          !local ||
          local.startsWith('.') ||
          local.endsWith('.') ||
          NOISE_EMAIL_LOCALS.has(local) ||
          !isValidDnsHost(domain)
        ) {
          continue;
        }
        if (domain === siteInfo.rootDomain || domain.endsWith(`.${siteInfo.rootDomain}`)) {
          record('attribution', 'Corporate Email', `${local}@${domain}`, offset);
        }
      }
    }

    const sentry = OSINT_SENTRY_DSN.exec(val);
    if (sentry?.[1] && sentry[2] && sentry[3]) {
      record(
        'attribution',
        'Sentry DSN',
        `https://${maskSecret(sentry[1])}@${sentry[2].toLowerCase()}/${sentry[3]}`,
        offset,
        `project: ${sentry[3]}`,
      );
    }
    const git = OSINT_GIT_REPO.exec(val);
    if (git?.[1] && git[2] && git[3]) {
      const org = git[2].toLowerCase();
      if (!NOISE_GIT_ORGS.has(org)) {
        const host = git[1].toLowerCase();
        const repo = git[3].replace(/\.git$/i, '');
        record('attribution', 'Repository Reference', `${host}/${git[2]}/${repo}`, offset);
      }
    }
    const atlassian = OSINT_ATLASSIAN.exec(val);
    if (atlassian?.[1]) {
      const ws = atlassian[1].toLowerCase();
      record('attribution', 'Atlassian Workspace', `${ws}.atlassian.net`, offset, atlassian[2]);
    }
    const linear = OSINT_LINEAR.exec(val);
    if (linear?.[1]) {
      record(
        'attribution',
        'Linear Workspace',
        `linear.app/${linear[1].toLowerCase()}`,
        offset,
        linear[2],
      );
    }

    // 6. Telemetry & Tech IDs
    const ga4 = OSINT_GA4.exec(val);
    if (ga4?.[1]) record('telemetry', 'Google Analytics 4', ga4[1], offset);
    const gtm = OSINT_GTM.exec(val);
    if (gtm?.[1]) record('telemetry', 'Google Tag Manager', gtm[1], offset);
    const ua = OSINT_UA.exec(val);
    if (ua?.[1]) record('telemetry', 'Universal Analytics', ua[1], offset);
    const posthog = OSINT_POSTHOG.exec(val);
    if (posthog?.[1]) record('telemetry', 'PostHog Key', maskSecret(posthog[1]), offset);
    const stripe = OSINT_STRIPE_PK.exec(val);
    if (stripe?.[1]) record('telemetry', 'Stripe Publishable Key', maskSecret(stripe[1]), offset);
    const auth0 = OSINT_AUTH0_TENANT.exec(val);
    if (auth0?.[1]) record('telemetry', 'Auth0 Tenant', auth0[1].toLowerCase(), offset);
    const clerk = OSINT_CLERK_TENANT.exec(val);
    if (clerk?.[1]) record('telemetry', 'Clerk Tenant', clerk[1].toLowerCase(), offset);

    if (beforeSlice && val.length >= 6 && val.length <= 64 && !/\s/.test(val)) {
      if (OSINT_INTERCOM_BEFORE.test(beforeSlice) && /^[a-z0-9_-]{6,24}$/i.test(val)) {
        record('telemetry', 'Intercom App ID', val, offset);
      } else if (OSINT_SEGMENT_BEFORE.test(beforeSlice)) {
        record('telemetry', 'Segment Write Key', maskSecret(val), offset);
      } else if (OSINT_MIXPANEL_BEFORE.test(beforeSlice)) {
        record('telemetry', 'Mixpanel Token', maskSecret(val), offset);
      }
    }
  };

  for (const tok of lexed.strings) {
    const beforeSlice = text.slice(Math.max(0, tok.start - 40), tok.start);
    scanChunk(tok.value, tok.start, beforeSlice);
  }
  for (const comment of lexed.comments) {
    scanChunk(comment.text, comment.start);
  }

  return sortOsintHits([...results.values()]);
}

export function extractSourcePathLeaks(
  rawSources: readonly (string | null)[],
  scriptUrl: string,
  mapUrl?: string,
): OsintHit[] {
  const seen = new Map<string, OsintHit>();
  for (const raw of rawSources) {
    if (!raw) continue;
    OSINT_LOCAL_BUILD_PATH.lastIndex = 0;
    const match = OSINT_LOCAL_BUILD_PATH.exec(raw);
    if (!match?.[1]) continue;
    const formatted = formatMaskedBuildPath(match[0], match[1], match[2]);
    const key = `build-path\u0000${formatted.kind}\u0000${formatted.value}`;
    if (seen.has(key)) continue;
    seen.set(key, {
      category: 'build-path',
      kind: formatted.kind,
      value: formatted.value,
      detail: 'source map path (user masked)',
      locations: [
        {
          file: 'sourcemap.sources',
          line: 1,
          column: 0,
          kind: 'source',
          scriptUrl,
          ...(mapUrl ? { mapUrl } : {}),
        },
      ],
    });
  }
  return sortOsintHits([...seen.values()]);
}

export function sortOsintHits(hits: OsintHit[]): OsintHit[] {
  return hits.sort(
    (a, b) =>
      OSINT_CATEGORIES.indexOf(a.category) - OSINT_CATEGORIES.indexOf(b.category) ||
      a.kind.localeCompare(b.kind) ||
      a.value.localeCompare(b.value),
  );
}

const CATEGORY_TITLES: Record<OsintCategory, string> = {
  cloud: 'Cloud Storage & Services',
  subdomain: 'Subdomain References',
  'internal-ip': 'Internal IPs & Hosts',
  'build-path': 'Local Build Paths',
  attribution: 'Developer & Org Attribution',
  telemetry: 'Tech Stack & Telemetry IDs',
};

function mdCell(value: string): string {
  return value.replace(/\r?\n/g, ' ').replace(/\|/g, '\\|');
}

function mdCode(value: string): string {
  const clean = mdCell(value);
  return clean.includes('`') ? `\`\` ${clean} \`\`` : `\`${clean}\``;
}

export function osintMarkdown(
  hits: readonly OsintHit[],
  context: { origin: string; generator: string; exportedAt: string },
): string {
  const lines: string[] = [
    `# MapHound passive OSINT: ${context.origin}`,
    '',
    `Generated ${context.exportedAt} by ${context.generator}.`,
    '100% offline extraction from collected scripts, rebuilt sources and source map paths. No external requests were made.',
    '',
    `- **Total OSINT items:** ${hits.length}`,
  ];
  for (const cat of OSINT_CATEGORIES) {
    const count = hits.filter((h) => h.category === cat).length;
    if (count > 0) lines.push(`- **${CATEGORY_TITLES[cat]}:** ${count}`);
  }
  lines.push('');

  if (hits.length === 0) {
    lines.push('No passive OSINT indicators extracted from the scanned files.', '');
    return lines.join('\n');
  }

  for (const cat of OSINT_CATEGORIES) {
    const group = hits.filter((h) => h.category === cat);
    if (group.length === 0) continue;
    lines.push(`## ${CATEGORY_TITLES[cat]}`, '');
    lines.push('| Kind | Value | Detail | First seen |');
    lines.push('| --- | --- | --- | --- |');
    for (const hit of group) {
      const first = hit.locations[0];
      const where = first ? `${first.file}:${first.line}` : '–';
      lines.push(
        `| ${mdCell(hit.kind)} | ${mdCode(hit.value)} | ${hit.detail ? mdCell(hit.detail) : '–'} | ${mdCode(where)} |`,
      );
    }
    lines.push('');
  }

  return lines.join('\n');
}
