import { registrableDomain } from '@/core/scope';

export type OsintLinkId =
  | 'crtsh'
  | 'wayback'
  | 'urlscan'
  | 'dork-config'
  | 'dork-api'
  | 'dork-auth'
  | 'dork-docs';

export interface OsintLink {
  id: OsintLinkId;
  group: 'recon' | 'dorks';
  url: string;
  queryPreview?: string;
}

export interface OsintLauncherSet {
  domain: string | null;
  links: OsintLink[];
}

function googleSearchUrl(query: string): string {
  return `https://www.google.com/search?q=${encodeURIComponent(query)}`;
}

/**
 * Pure URL builder for user-initiated external OSINT and Google Dork tabs.
 * Extension background code never fetches any of these URLs.
 */
export function buildOsintLinks(siteOrigin: string): OsintLauncherSet {
  let hostname = '';
  try {
    hostname = new URL(siteOrigin).hostname;
  } catch {
    return { domain: null, links: [] };
  }
  const domain = registrableDomain(hostname)?.toLowerCase() ?? null;
  if (!domain) return { domain: null, links: [] };

  const encoded = encodeURIComponent(domain);
  const dorkConfig = `site:${domain} (intitle:"index of" OR ext:env OR ext:yml OR ext:yaml OR ext:json OR ext:xml OR ext:conf OR ext:bak)`;
  const dorkApi = `site:${domain} (inurl:swagger OR inurl:api-docs OR inurl:openapi OR inurl:graphql OR inurl:/api/v1)`;
  const dorkAuth = `site:${domain} (inurl:admin OR inurl:login OR inurl:portal OR inurl:dashboard OR inurl:internal)`;
  const dorkDocs = `site:${domain} (filetype:pdf OR filetype:xlsx OR filetype:csv OR filetype:log OR filetype:sql)`;

  return {
    domain,
    links: [
      { id: 'crtsh', group: 'recon', url: `https://crt.sh/?q=%25.${encoded}` },
      { id: 'wayback', group: 'recon', url: `https://web.archive.org/web/*/${encoded}/*` },
      { id: 'urlscan', group: 'recon', url: `https://urlscan.io/search/#domain:${encoded}` },
      {
        id: 'dork-config',
        group: 'dorks',
        url: googleSearchUrl(dorkConfig),
        queryPreview: dorkConfig,
      },
      { id: 'dork-api', group: 'dorks', url: googleSearchUrl(dorkApi), queryPreview: dorkApi },
      { id: 'dork-auth', group: 'dorks', url: googleSearchUrl(dorkAuth), queryPreview: dorkAuth },
      { id: 'dork-docs', group: 'dorks', url: googleSearchUrl(dorkDocs), queryPreview: dorkDocs },
    ],
  };
}
