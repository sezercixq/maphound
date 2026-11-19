import type { Scope, SiteRecord, ThirdPartyKind } from './db';

/** Parse user or tab input into a canonical http(s) origin, or null. */
export function parseOrigin(input: string): string | null {
  const raw = input.trim();
  if (!raw) return null;
  let url: URL;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  if (!url.hostname) return null;
  return url.origin;
}

function isIpHost(hostname: string): boolean {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(hostname) || hostname.startsWith('[');
}

/**
 * Host that a `subdomains` scope is rooted at. A leading `www.` is dropped, so enabling
 * `https://www.example.com` with subdomains covers `example.com` and every `*.example.com`.
 */
export function scopeBaseHost(origin: string, scope: Scope): string {
  const { hostname } = new URL(origin);
  if (scope === 'origin' || isIpHost(hostname) || !hostname.includes('.')) return hostname;
  return hostname.startsWith('www.') ? hostname.slice(4) : hostname;
}

/** Effective scope: IP addresses and single-label hosts (localhost) cannot have subdomains. */
export function effectiveScope(origin: string, scope: Scope): Scope {
  const { hostname } = new URL(origin);
  return scope === 'subdomains' && !isIpHost(hostname) && hostname.includes('.')
    ? 'subdomains'
    : 'origin';
}

/**
 * Chrome match patterns to request for a site. Match patterns cannot carry a port, so a
 * pattern covers every port of the host; `isInScope` still enforces the exact origin.
 */
export function originPatterns(origin: string, scope: Scope): string[] {
  const { protocol } = new URL(origin);
  const host = scopeBaseHost(origin, scope);
  return effectiveScope(origin, scope) === 'subdomains'
    ? [`${protocol}//*.${host}/*`]
    : [`${protocol}//${host}/*`];
}

/** Whether `url` belongs to the site: same scheme, and same origin or (if chosen) a subdomain. */
export function isInScope(url: string, site: Pick<SiteRecord, 'origin' | 'scope'>): boolean {
  let target: URL;
  try {
    target = new URL(url);
  } catch {
    return false;
  }
  const base = new URL(site.origin);
  if (target.protocol !== base.protocol) return false;
  if (effectiveScope(site.origin, site.scope) === 'origin') return target.origin === base.origin;
  const root = scopeBaseHost(site.origin, site.scope);
  return target.hostname === root || target.hostname.endsWith(`.${root}`);
}

/** The enabled site whose scope covers a page URL. Exact-origin sites win over subdomain ones. */
export function siteForUrl<T extends Pick<SiteRecord, 'origin' | 'scope'>>(
  sites: readonly T[],
  url: string,
): T | undefined {
  const matches = sites.filter((site) => isInScope(url, site));
  return matches.find((site) => site.scope === 'origin') ?? matches[0];
}

/**
 * Patterns that can be revoked when `removed` is disabled: those no remaining site still needs.
 * Two localhost ports, for example, share `http://localhost/*`.
 */
export function patternsToRevoke(
  removed: Pick<SiteRecord, 'origin' | 'scope'>,
  remaining: readonly Pick<SiteRecord, 'origin' | 'scope'>[],
): string[] {
  const keep = new Set(remaining.flatMap((site) => originPatterns(site.origin, site.scope)));
  return originPatterns(removed.origin, removed.scope).filter((pattern) => !keep.has(pattern));
}

const ANALYTICS_HOSTS = [
  'google-analytics.com',
  'googletagmanager.com',
  'googleadservices.com',
  'doubleclick.net',
  'googlesyndication.com',
  'connect.facebook.net',
  'facebook.net',
  'hotjar.com',
  'segment.com',
  'segment.io',
  'mixpanel.com',
  'amplitude.com',
  'clarity.ms',
  'cloudflareinsights.com',
  'newrelic.com',
  'nr-data.net',
  'sentry-cdn.com',
  'datadoghq-browser-agent.com',
  'intercomcdn.com',
  'intercom.io',
  'hs-scripts.com',
  'hs-analytics.net',
  'tiktok.com',
  'snap.licdn.com',
];

const CDN_HOSTS = [
  'cdn.jsdelivr.net',
  'unpkg.com',
  'cdnjs.cloudflare.com',
  'ajax.googleapis.com',
  'gstatic.com',
  'code.jquery.com',
  'stackpath.bootstrapcdn.com',
  'cdn.skypack.dev',
  'esm.sh',
  'js.stripe.com',
  'www.google.com',
  'recaptcha.net',
];

function hostMatches(hostname: string, list: readonly string[]): boolean {
  return list.some((entry) => hostname === entry || hostname.endsWith(`.${entry}`));
}

/** Label for an out-of-scope script. Only used for display; out of scope is never scanned. */
export function classifyThirdParty(url: string): ThirdPartyKind {
  let hostname: string;
  try {
    hostname = new URL(url).hostname;
  } catch {
    return 'other';
  }
  if (hostMatches(hostname, ANALYTICS_HOSTS)) return 'analytics';
  if (hostMatches(hostname, CDN_HOSTS)) return 'cdn';
  return 'other';
}
