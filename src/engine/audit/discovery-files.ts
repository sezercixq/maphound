import { SITEMAP_LOC_TAG } from './patterns';
import type { DiscoveryFilesRecord, RobotsSummary, SitemapSummary } from './types';

export const MAX_ROBOTS_PATHS = 300;
export const MAX_SITEMAP_URLS = 300;
export const MAX_SITEMAP_REFS = 50;

function safeHttpUrl(raw: string, baseOrigin?: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  try {
    const parsed = baseOrigin ? new URL(trimmed, baseOrigin) : new URL(trimmed);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    return parsed.href;
  } catch {
    return null;
  }
}

export function parseRobotsTxt(
  text: string,
  origin: string,
): Omit<RobotsSummary, 'found' | 'status'> {
  const disallow: string[] = [];
  const allow: string[] = [];
  const sitemaps: string[] = [];
  const seenDisallow = new Set<string>();
  const seenAllow = new Set<string>();
  const seenSitemaps = new Set<string>();

  for (const rawLine of text.split(/\r?\n/)) {
    const hashIdx = rawLine.indexOf('#');
    const line = (hashIdx >= 0 ? rawLine.slice(0, hashIdx) : rawLine).trim();
    if (!line) continue;
    const colon = line.indexOf(':');
    if (colon <= 0) continue;
    const directive = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();
    if (!value) continue;

    if (directive === 'disallow') {
      if (!seenDisallow.has(value) && disallow.length < MAX_ROBOTS_PATHS) {
        seenDisallow.add(value);
        disallow.push(value);
      }
    } else if (directive === 'allow') {
      if (!seenAllow.has(value) && allow.length < MAX_ROBOTS_PATHS) {
        seenAllow.add(value);
        allow.push(value);
      }
    } else if (directive === 'sitemap') {
      const url = safeHttpUrl(value, origin);
      if (url && !seenSitemaps.has(url) && sitemaps.length < MAX_SITEMAP_REFS) {
        seenSitemaps.add(url);
        sitemaps.push(url);
      }
    }
  }

  return { disallow, allow, sitemaps };
}

export function parseSitemapXml(
  text: string,
  origin: string,
): Omit<SitemapSummary, 'found' | 'status'> {
  const urls: string[] = [];
  const seen = new Set<string>();
  const slice = text.slice(0, 512_000);

  SITEMAP_LOC_TAG.lastIndex = 0;
  for (const match of slice.matchAll(SITEMAP_LOC_TAG)) {
    const raw = match[1]?.trim();
    if (!raw) continue;
    const decoded = raw
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'");
    const href = safeHttpUrl(decoded, origin);
    if (!href || seen.has(href)) continue;
    seen.add(href);
    urls.push(href);
    if (urls.length >= MAX_SITEMAP_URLS) break;
  }

  return { urls };
}

function mdCode(value: string): string {
  const clean = value.replace(/\r?\n/g, ' ').replace(/\|/g, '\\|');
  return clean.includes('`') ? `\`\` ${clean} \`\`` : `\`${clean}\``;
}

export function discoveryMarkdownLines(discovery: DiscoveryFilesRecord | undefined): string[] {
  if (!discovery) return [];
  const { robots, sitemap } = discovery;
  const hasAnything =
    robots.disallow.length > 0 ||
    robots.allow.length > 0 ||
    robots.sitemaps.length > 0 ||
    sitemap.urls.length > 0;
  if (!hasAnything) return [];

  const lines: string[] = ['## Standard Discovery Files (`robots.txt` & `sitemap.xml`)', ''];
  if (robots.found) {
    if (robots.disallow.length > 0) {
      lines.push(`### robots.txt Disallow (${robots.disallow.length})`, '');
      for (const p of robots.disallow.slice(0, 100)) lines.push(`- ${mdCode(p)}`);
      lines.push('');
    }
    if (robots.allow.length > 0) {
      lines.push(`### robots.txt Allow (${robots.allow.length})`, '');
      for (const p of robots.allow.slice(0, 50)) lines.push(`- ${mdCode(p)}`);
      lines.push('');
    }
    if (robots.sitemaps.length > 0) {
      lines.push(`### robots.txt Sitemaps (${robots.sitemaps.length})`, '');
      for (const u of robots.sitemaps) lines.push(`- ${mdCode(u)}`);
      lines.push('');
    }
  }
  if (sitemap.found && sitemap.urls.length > 0) {
    lines.push(`### sitemap.xml URLs (${sitemap.urls.length})`, '');
    for (const u of sitemap.urls.slice(0, 100)) lines.push(`- ${mdCode(u)}`);
    lines.push('');
  }
  return lines;
}
