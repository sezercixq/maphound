import type { AuditRecord } from '@/core/db';
import type { ArchitectureGraph, ScriptIntel } from '@/engine/intel';

export type StackHintCategory = 'server' | 'runtime' | 'cloud' | 'database' | 'api' | 'build-os';

export const STACK_HINT_CATEGORIES: readonly StackHintCategory[] = [
  'server',
  'runtime',
  'database',
  'cloud',
  'api',
  'build-os',
];

export interface StackHint {
  category: StackHintCategory;
  name: string;
  version?: string;
  /** Short provenance tag, e.g. `Header: X-Powered-By`, `Cookie: JSESSIONID`, `SDK: Supabase`. */
  evidence: string;
  detail?: string;
}

export interface StackHintsInput {
  audits?: readonly Pick<AuditRecord, 'headers' | 'cookieNames' | 'findings'>[];
  intel?: Pick<ScriptIntel, 'endpoints' | 'osint'>;
  architecture?: Pick<ArchitectureGraph, 'sdks'>;
}

const BANNER_HEADER_LABELS: Record<string, string> = {
  server: 'Server',
  'x-powered-by': 'X-Powered-By',
  via: 'Via',
  'x-aspnet-version': 'X-AspNet-Version',
  'x-aspnetmvc-version': 'X-AspNetMvc-Version',
  'x-generator': 'X-Generator',
};

interface BannerRule {
  match: RegExp;
  name: string;
  category: 'server' | 'runtime';
}

// Bounded, non-backtracking banner matchers (run only on short HTTP header values <= 256 chars).
const BANNER_RULES: readonly BannerRule[] = [
  { match: /\bnginx(?:\/([0-9][0-9.a-z-]{0,20}))?/i, name: 'nginx', category: 'server' },
  { match: /\bopenresty(?:\/([0-9][0-9.a-z-]{0,20}))?/i, name: 'OpenResty', category: 'server' },
  {
    match: /\bapache-coyote(?:\/([0-9][0-9.a-z-]{0,20}))?/i,
    name: 'Apache Tomcat',
    category: 'server',
  },
  { match: /\btomcat(?:\/([0-9][0-9.a-z-]{0,20}))?/i, name: 'Apache Tomcat', category: 'server' },
  {
    match: /\bjetty(?:\(([0-9][0-9.a-z-]{0,20})\)|\/([0-9][0-9.a-z-]{0,20}))?/i,
    name: 'Eclipse Jetty',
    category: 'server',
  },
  {
    match: /\bapache(?:\/([0-9][0-9.a-z-]{0,20}))?/i,
    name: 'Apache HTTP Server',
    category: 'server',
  },
  { match: /\bcloudflare\b/i, name: 'Cloudflare', category: 'server' },
  { match: /\bcloudfront\b/i, name: 'Amazon CloudFront', category: 'server' },
  { match: /\bvercel\b/i, name: 'Vercel Edge', category: 'server' },
  { match: /\bnetlify\b/i, name: 'Netlify', category: 'server' },
  { match: /\bfastly\b/i, name: 'Fastly CDN', category: 'server' },
  { match: /\benvoy\b/i, name: 'Envoy Proxy', category: 'server' },
  { match: /\bcaddy\b/i, name: 'Caddy', category: 'server' },
  {
    match: /\bmicrosoft-iis(?:\/([0-9][0-9.]{0,16}))?/i,
    name: 'Microsoft IIS',
    category: 'server',
  },
  {
    match: /\bgunicorn(?:\/([0-9][0-9.a-z-]{0,20}))?/i,
    name: 'Gunicorn (Python)',
    category: 'runtime',
  },
  { match: /\buvicorn\b/i, name: 'Uvicorn (Python)', category: 'runtime' },
  { match: /\bexpress\b/i, name: 'Node.js / Express', category: 'runtime' },
  { match: /\bnext\.js(?:[\s/]([0-9][0-9.a-z-]{0,20}))?/i, name: 'Next.js', category: 'runtime' },
  { match: /\bphp(?:\/([0-9][0-9.a-z-]{0,20}))?/i, name: 'PHP', category: 'runtime' },
  { match: /\basp\.net\b/i, name: 'ASP.NET', category: 'runtime' },
  { match: /\bwordpress(?:\s+([0-9][0-9.]{0,16}))?/i, name: 'WordPress', category: 'runtime' },
  { match: /\bdrupal(?:\s+([0-9][0-9.]{0,16}))?/i, name: 'Drupal', category: 'runtime' },
];

const VERSION_TOKEN = /[0-9]+\.[0-9]+(?:\.[0-9]+)?/;

export function hasBannerVersion(value: string): boolean {
  return VERSION_TOKEN.test(value.slice(0, 256));
}

function collectCookieNames(
  audits: readonly Pick<AuditRecord, 'headers' | 'cookieNames' | 'findings'>[],
): Set<string> {
  const names = new Set<string>();
  for (const audit of audits) {
    for (const name of audit.cookieNames ?? []) {
      const clean = name.trim();
      if (clean) names.add(clean);
    }
    for (const finding of audit.findings) {
      if (finding.category === 'cookie' && finding.subject.trim()) {
        names.add(finding.subject.trim());
      }
    }
  }
  return names;
}

export function extractStackHints(input: StackHintsInput): StackHint[] {
  const map = new Map<string, StackHint>();

  const add = (hint: StackHint) => {
    const key = `${hint.category}\u0000${hint.name.toLowerCase()}`;
    const existing = map.get(key);
    if (!existing) {
      map.set(key, hint);
    } else if (!existing.version && hint.version) {
      existing.version = hint.version;
    }
  };

  const audits = input.audits ?? [];

  // 1. Web server, reverse proxy & runtime banners from collected HTTP headers
  for (const audit of audits) {
    for (const [rawKey, rawVal] of Object.entries(audit.headers ?? {})) {
      if (!rawVal) continue;
      const key = rawKey.toLowerCase();
      const label = BANNER_HEADER_LABELS[key];
      if (!label) continue;
      const val = rawVal.trim().slice(0, 256);
      if (!val) continue;

      if (key === 'x-aspnet-version' || key === 'x-aspnetmvc-version') {
        add({
          category: 'runtime',
          name: key === 'x-aspnetmvc-version' ? 'ASP.NET MVC' : 'ASP.NET',
          version: val,
          evidence: `Header: ${label}`,
        });
        continue;
      }

      let matchedAny = false;
      for (const rule of BANNER_RULES) {
        const m = rule.match.exec(val);
        if (!m) continue;
        matchedAny = true;
        const version = m[1] || m[2] || undefined;
        add({
          category: rule.category,
          name: rule.name,
          ...(version ? { version } : {}),
          evidence: `Header: ${label}`,
        });
      }

      // If an explicit banner header like Server or X-Powered-By didn't match a known brand, still surface it cleanly.
      if (!matchedAny && (key === 'server' || key === 'x-powered-by' || key === 'x-generator')) {
        const slash = val.indexOf('/');
        const name = (slash > 0 ? val.slice(0, slash) : val).slice(0, 48).trim();
        const ver =
          slash > 0
            ? val
                .slice(slash + 1)
                .split(/\s+/)[0]
                ?.slice(0, 24)
            : undefined;
        if (name) {
          add({
            category: key === 'server' ? 'server' : 'runtime',
            name,
            ...(ver && VERSION_TOKEN.test(ver) ? { version: ver } : {}),
            evidence: `Header: ${label}`,
          });
        }
      }
    }
  }

  // 2. Session cookie fingerprinting (cookie names only — never values)
  const cookieNames = collectCookieNames(audits);
  const lowerCookieMap = new Map<string, string>();
  for (const name of cookieNames) {
    lowerCookieMap.set(name.toLowerCase(), name);
  }

  if (lowerCookieMap.has('jsessionid')) {
    add({
      category: 'runtime',
      name: 'Java Servlet / Spring / Tomcat',
      evidence: `Cookie: ${lowerCookieMap.get('jsessionid')}`,
    });
  }
  if (lowerCookieMap.has('phpsessid')) {
    add({
      category: 'runtime',
      name: 'PHP',
      evidence: `Cookie: ${lowerCookieMap.get('phpsessid')}`,
    });
  }
  if (lowerCookieMap.has('asp.net_sessionid')) {
    add({
      category: 'runtime',
      name: 'ASP.NET',
      evidence: `Cookie: ${lowerCookieMap.get('asp.net_sessionid')}`,
    });
  }
  for (const name of cookieNames) {
    if (name.toLowerCase().startsWith('.aspnetcore.')) {
      add({
        category: 'runtime',
        name: 'ASP.NET Core',
        evidence: `Cookie: ${name}`,
      });
      break;
    }
  }
  if (lowerCookieMap.has('connect.sid')) {
    add({
      category: 'runtime',
      name: 'Node.js / Express',
      evidence: `Cookie: ${lowerCookieMap.get('connect.sid')}`,
    });
  }
  if (lowerCookieMap.has('csrftoken') && lowerCookieMap.has('sessionid')) {
    add({
      category: 'runtime',
      name: 'Django (Python)',
      evidence: 'Cookie: csrftoken + sessionid',
    });
  }
  if (lowerCookieMap.has('_rails_session')) {
    add({
      category: 'runtime',
      name: 'Ruby on Rails',
      evidence: `Cookie: ${lowerCookieMap.get('_rails_session')}`,
    });
  }
  if (lowerCookieMap.has('laravel_session')) {
    add({
      category: 'runtime',
      name: 'Laravel (PHP)',
      evidence: lowerCookieMap.has('xsrf-token')
        ? 'Cookie: XSRF-TOKEN + laravel_session'
        : `Cookie: ${lowerCookieMap.get('laravel_session')}`,
    });
  }
  if (lowerCookieMap.has('rack.session')) {
    add({
      category: 'runtime',
      name: 'Ruby / Rack',
      evidence: `Cookie: ${lowerCookieMap.get('rack.session')}`,
    });
  }

  // 3. Cloud storage, database / BaaS, API layer & build OS from OSINT + Architecture
  for (const sdk of input.architecture?.sdks ?? []) {
    if (sdk.name === 'Supabase') {
      add({ category: 'database', name: 'Supabase / PostgreSQL', evidence: 'SDK: Supabase' });
    } else if (sdk.name === 'Firebase') {
      add({ category: 'database', name: 'Firebase / Firestore', evidence: 'SDK: Firebase' });
    } else if (sdk.name === 'AWS SDK') {
      add({ category: 'cloud', name: 'AWS Cloud SDK', evidence: 'SDK: AWS SDK' });
    } else if (sdk.name === 'Auth0' || sdk.name === 'Clerk') {
      add({ category: 'runtime', name: `${sdk.name} Auth`, evidence: `SDK: ${sdk.name}` });
    }
  }

  for (const hit of input.intel?.osint ?? []) {
    if (hit.category === 'cloud') {
      if (hit.kind === 'AWS S3 Bucket') {
        add({
          category: 'cloud',
          name: 'AWS S3',
          evidence: 'OSINT: AWS S3 Bucket',
          detail: hit.value,
        });
      } else if (hit.kind === 'GCS Bucket') {
        add({
          category: 'cloud',
          name: 'Google Cloud Storage',
          evidence: 'OSINT: GCS Bucket',
          detail: hit.value,
        });
      } else if (hit.kind === 'Azure Blob Storage') {
        add({
          category: 'cloud',
          name: 'Azure Blob Storage',
          evidence: 'OSINT: Azure Blob Storage',
          detail: hit.value,
        });
      } else if (hit.kind === 'Cloudflare R2') {
        add({
          category: 'cloud',
          name: 'Cloudflare R2',
          evidence: 'OSINT: Cloudflare R2',
          detail: hit.value,
        });
      } else if (hit.kind === 'Firebase Project') {
        add({
          category: 'database',
          name: 'Firebase / Firestore',
          evidence: 'OSINT: Firebase Project',
          detail: hit.value,
        });
      }
    } else if (hit.category === 'build-path') {
      if (hit.kind === 'Windows Home Path') {
        add({
          category: 'build-os',
          name: 'Windows (Build Host)',
          evidence: 'SourceMap: Windows path',
        });
      } else if (hit.kind === 'macOS Home Path') {
        add({
          category: 'build-os',
          name: 'macOS (Build Host)',
          evidence: 'SourceMap: macOS path',
        });
      } else if (hit.kind === 'Linux Home Path') {
        add({
          category: 'build-os',
          name: 'Linux (Build Host)',
          evidence: 'SourceMap: Linux path',
        });
      }
    }
  }

  const endpoints = input.intel?.endpoints ?? [];
  if (endpoints.length > 0) {
    const hasGraphql = endpoints.some((e) => e.category === 'graphql');
    const hasRest = endpoints.some(
      (e) => e.category === 'api' || e.category === 'admin' || e.category === 'auth',
    );
    const hasWs = endpoints.some((e) => e.category === 'websocket');
    const hasNextData = endpoints.some((e) => e.category === 'next-data');
    if (hasGraphql) {
      add({ category: 'api', name: 'GraphQL API', evidence: 'Endpoints: /graphql' });
    }
    if (hasRest) {
      add({
        category: 'api',
        name: 'REST / JSON API',
        evidence: `Endpoints: ${endpoints.length} paths`,
      });
    }
    if (hasWs) {
      add({ category: 'api', name: 'WebSocket', evidence: 'Endpoints: ws/wss' });
    }
    if (hasNextData) {
      add({ category: 'runtime', name: 'Next.js', evidence: 'Endpoints: /_next/data' });
    }
  }

  return [...map.values()].sort(
    (a, b) =>
      STACK_HINT_CATEGORIES.indexOf(a.category) - STACK_HINT_CATEGORIES.indexOf(b.category) ||
      a.name.localeCompare(b.name),
  );
}

function mdCell(value: string): string {
  return value.replace(/\r?\n/g, ' ').replace(/\|/g, '\\|');
}

function mdCode(value: string): string {
  const clean = mdCell(value);
  return clean.includes('`') ? `\`\` ${clean} \`\`` : `\`${clean}\``;
}

export function stackHintsMarkdownLines(hints: readonly StackHint[]): string[] {
  if (hints.length === 0) return [];
  const lines: string[] = [
    '## Detected Stack & Server Hints',
    '',
    '| Category | Technology | Version | Evidence |',
    '| --- | --- | --- | --- |',
  ];
  for (const hint of hints) {
    lines.push(
      `| ${mdCell(hint.category)} | ${mdCell(hint.name)} | ${hint.version ? mdCode(hint.version) : '–'} | ${mdCode(hint.evidence)} |`,
    );
  }
  lines.push('');
  return lines;
}
