import { getDomain, getDomainWithoutSuffix } from 'tldts';
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

const PSL = { allowPrivateDomains: true } as const;

/**
 * Registrable domain (eTLD+1) from the Public Suffix List, private suffixes included:
 * `www.airbnb.com.tr` -> `airbnb.com.tr`, `shop.example.co.uk` -> `example.co.uk`,
 * `me.github.io` -> `me.github.io`. Null for IPs, `localhost` and bare public suffixes.
 */
export function registrableDomain(hostname: string): string | null {
  return getDomain(hostname, PSL);
}

/**
 * Same brand under another registrable domain, e.g. `airbnb.com.tr` and `airbnb.com`.
 * Only a hint for the UI: the user still decides, origin by origin.
 */
export function isRelatedDomain(a: string, b: string): boolean {
  const left = getDomainWithoutSuffix(a, PSL);
  return (
    Boolean(left) &&
    left === getDomainWithoutSuffix(b, PSL) &&
    registrableDomain(a) !== registrableDomain(b)
  );
}

/**
 * Host that a `subdomains` scope is rooted at: the registrable domain, so enabling
 * `https://app.example.com` with subdomains covers `example.com` and every `*.example.com`
 * (`cdn.example.com` included), while `me.github.io` never widens to all of `github.io`.
 */
export function scopeBaseHost(origin: string, scope: Scope): string {
  const { hostname } = new URL(origin);
  if (scope === 'origin') return hostname;
  return registrableDomain(hostname) ?? hostname;
}

/** Effective scope: IP addresses, `localhost` and public suffixes cannot have subdomains. */
export function effectiveScope(origin: string, scope: Scope): Scope {
  return scope === 'subdomains' && registrableDomain(new URL(origin).hostname)
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

type ScopedSite = Pick<SiteRecord, 'origin' | 'scope'> & Partial<Pick<SiteRecord, 'extraOrigins'>>;

/** Every pattern a site holds: its own scope plus each extra origin the user allowed. */
export function sitePatterns(site: ScopedSite): string[] {
  const patterns = originPatterns(site.origin, site.scope);
  for (const extra of site.extraOrigins ?? []) patterns.push(...originPatterns(extra, 'origin'));
  return [...new Set(patterns)];
}

/** Whether `url` is on the site itself: same scheme, and same origin or (if chosen) a subdomain. */
export function isInSiteScope(url: string, site: Pick<SiteRecord, 'origin' | 'scope'>): boolean {
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

/**
 * Whether a script or map URL may be fetched and scanned for the site: on the site itself, or
 * on one of the extra origins (CDNs, sibling domains) the user allowed. Extra origins match
 * exactly, port included.
 */
export function isInScope(url: string, site: ScopedSite): boolean {
  if (isInSiteScope(url, site)) return true;
  if (!site.extraOrigins?.length) return false;
  try {
    return site.extraOrigins.includes(new URL(url).origin);
  } catch {
    return false;
  }
}

/** The enabled site whose scope covers a page URL. Exact-origin sites win over subdomain ones. */
export function siteForUrl<T extends Pick<SiteRecord, 'origin' | 'scope'>>(
  sites: readonly T[],
  url: string,
): T | undefined {
  // Pages belong to a site by its own scope; extra origins only widen what may be fetched.
  const matches = sites.filter((site) => isInSiteScope(url, site));
  return matches.find((site) => site.scope === 'origin') ?? matches[0];
}

/**
 * Patterns that can be revoked when `removed` is disabled: those no remaining site still needs,
 * extra origins included. Two localhost ports, for example, share `http://localhost/*`.
 */
export function patternsToRevoke(removed: ScopedSite, remaining: readonly ScopedSite[]): string[] {
  const keep = new Set(remaining.flatMap(sitePatterns));
  return sitePatterns(removed).filter((pattern) => !keep.has(pattern));
}

/** Pattern of one extra origin that can be revoked when it is removed from `site`. */
export function extraOriginPatternsToRevoke(
  extra: string,
  site: ScopedSite,
  others: readonly ScopedSite[],
): string[] {
  const keep = new Set([
    ...others.flatMap(sitePatterns),
    ...sitePatterns({
      ...site,
      extraOrigins: (site.extraOrigins ?? []).filter((o) => o !== extra),
    }),
  ]);
  return originPatterns(extra, 'origin').filter((pattern) => !keep.has(pattern));
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
