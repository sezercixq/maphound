import type { LexResult, LineIndex } from './lexer';
import {
  ABSOLUTE_URL,
  API_HOST,
  ASSET_PATH,
  CATEGORY_ADMIN,
  CATEGORY_API,
  CATEGORY_AUTH,
  CATEGORY_GRAPHQL,
  CATEGORY_NEXT_DATA,
  COMMENT_MARKER,
  ENDPOINT_CONTEXT_BEFORE,
  FETCH_BEFORE,
  LICENSE_COMMENT,
  METHOD_CALL_BEFORE,
  METHOD_KEY_AFTER,
  METHOD_KEY_BEFORE,
  MIME_TYPE,
  NOISE_HOST,
  NON_ROUTE_FILE,
  NOT_URL_CHAR,
  OBJECT_KEY_AFTER,
  PATH_SHAPE,
  PLACEHOLDER,
  RELATIVE_API_START,
  ROUTE_COMPANION,
  ROUTE_DEFINITION_BEFORE,
  ROUTE_FILE_EXT,
  ROUTE_JSX_BEFORE,
  ROUTE_NAVIGATION_BEFORE,
  SENSITIVE_COMMENT,
  XHR_OPEN_BEFORE,
} from './patterns';
import {
  type CommentHit,
  ENDPOINT_CATEGORIES,
  type EndpointCategory,
  type EndpointHit,
  HINT_LEVELS,
  type HintLevel,
  HTTP_METHODS,
  type HttpMethod,
  type IntelLocation,
  type RouteHit,
  type RouteKind,
} from './types';

export const MAX_ENDPOINTS_PER_FILE = 200;
export const MAX_ROUTES_PER_FILE = 150;
export const MAX_COMMENTS_PER_FILE = 100;
const MAX_LOCATIONS_PER_HIT = 5;

const IGNORED_PREFIXES = ['data:', 'javascript:', 'mailto:', 'tel:', 'blob:', 'about:', 'webpack:'];

const ROUTE_PRIORITY: Record<RouteKind, number> = {
  definition: 4,
  file: 3,
  manifest: 2,
  navigation: 1,
};

const LEVEL_PRIORITY: Record<HintLevel, number> = {
  high: 4,
  medium: 3,
  low: 2,
  info: 1,
};

const CATEGORY_PRIORITY: Record<EndpointCategory, number> = Object.fromEntries(
  ENDPOINT_CATEGORIES.map((category, index) => [category, ENDPOINT_CATEGORIES.length - index]),
) as Record<EndpointCategory, number>;

export function classifyPath(path: string): EndpointCategory | null {
  const lower = path.toLowerCase();
  if (CATEGORY_NEXT_DATA.test(lower)) return 'next-data';
  if (CATEGORY_ADMIN.test(lower)) return 'admin';
  if (CATEGORY_GRAPHQL.test(lower)) return 'graphql';
  if (CATEGORY_AUTH.test(lower)) return 'auth';
  if (CATEGORY_API.test(lower)) return 'api';
  return null;
}

function shouldSkipRawValue(val: string): boolean {
  if (val.length < 2 || val.length > 300) return true;
  if (NOT_URL_CHAR.test(val)) return true;
  const lower = val.toLowerCase();
  if (IGNORED_PREFIXES.some((prefix) => lower.startsWith(prefix))) return true;
  if (lower.includes('..') || lower.includes('node_modules')) return true;
  if (MIME_TYPE.test(val) || ASSET_PATH.test(val)) return true;
  return false;
}

function sliceAfter(text: string, from: number, maxLen = 180): string {
  const raw = text.slice(from, Math.min(text.length, from + maxLen));
  const semi = raw.indexOf(';');
  const dblNl = raw.indexOf('\n\n');
  let cut = raw.length;
  if (semi >= 0) cut = Math.min(cut, semi);
  if (dblNl >= 0) cut = Math.min(cut, dblNl);
  return raw.slice(0, cut);
}

function inferMethods(
  before: string,
  after: string,
): {
  methods: HttpMethod[];
  hasNetworkContext: boolean;
} {
  const found = new Set<HttpMethod>();
  const add = (raw: string | undefined) => {
    if (!raw) return;
    const upper = raw.toUpperCase() as HttpMethod;
    if ((HTTP_METHODS as readonly string[]).includes(upper)) found.add(upper);
  };

  const callMatch = METHOD_CALL_BEFORE.exec(before);
  if (callMatch) add(callMatch[1]);
  const keyBeforeMatch = METHOD_KEY_BEFORE.exec(before);
  if (keyBeforeMatch) add(keyBeforeMatch[1]);
  const xhrMatch = XHR_OPEN_BEFORE.exec(before);
  if (xhrMatch) add(xhrMatch[1]);
  const keyAfterMatch = METHOD_KEY_AFTER.exec(after);
  if (keyAfterMatch) add(keyAfterMatch[1]);

  const isFetch = FETCH_BEFORE.test(before);
  if (isFetch && found.size === 0) found.add('GET');

  const hasNetworkContext = found.size > 0 || isFetch || ENDPOINT_CONTEXT_BEFORE.test(before);
  const methods = [...found].sort((a, b) => HTTP_METHODS.indexOf(a) - HTTP_METHODS.indexOf(b));
  return { methods, hasNetworkContext };
}

function isRegexOrNoiseSlashPath(val: string): boolean {
  // Reject values like "/g", "/gi", "/-._", or regex-flag looking fragments.
  if (/^\/[gimsuyd]{1,4}$/.test(val)) return true;
  return !/[A-Za-z0-9]/.test(val);
}

function pushLocation(list: IntelLocation[], loc: IntelLocation): void {
  if (list.length >= MAX_LOCATIONS_PER_HIT) return;
  if (
    list.some(
      (item) => item.file === loc.file && item.line === loc.line && item.column === loc.column,
    )
  ) {
    return;
  }
  list.push(loc);
}

export function extractEndpoints(
  text: string,
  lexed: LexResult,
  lines: LineIndex,
  base: Omit<IntelLocation, 'line' | 'column'>,
): EndpointHit[] {
  const byValue = new Map<string, EndpointHit>();

  for (const tok of lexed.strings) {
    const val = tok.value.trim();
    if (shouldSkipRawValue(val)) continue;

    const before = text.slice(Math.max(0, tok.start - 100), tok.start);
    const after = sliceAfter(text, tok.end, 180);
    const { methods, hasNetworkContext } = inferMethods(before, after);

    let normalized: string | null = null;
    let category: EndpointCategory | null = null;

    if (ABSOLUTE_URL.test(val)) {
      let parsed: URL;
      try {
        parsed = new URL(val.replace(PLACEHOLDER, 'param'));
      } catch {
        continue;
      }
      if (NOISE_HOST.test(parsed.hostname) || ASSET_PATH.test(parsed.pathname)) continue;
      if (parsed.protocol === 'ws:' || parsed.protocol === 'wss:') {
        category = 'websocket';
      } else {
        category =
          classifyPath(parsed.pathname) ??
          (API_HOST.test(parsed.hostname.toLowerCase()) ? 'api' : null) ??
          (hasNetworkContext ? 'external' : null);
      }
      if (!category) continue;
      normalized = val;
    } else if (val.startsWith('/') && !val.startsWith('//') && PATH_SHAPE.test(val)) {
      if (isRegexOrNoiseSlashPath(val)) continue;
      category = classifyPath(val) ?? (hasNetworkContext ? 'api' : null);
      if (!category) continue;
      normalized = val;
    } else if (RELATIVE_API_START.test(val) && PATH_SHAPE.test(val)) {
      category = classifyPath(`/${val}`) ?? 'api';
      normalized = `/${val}`;
    }

    if (!normalized || !category) continue;

    const pos = lines.position(tok.start);
    const loc: IntelLocation = { ...base, line: pos.line, column: pos.column };
    const existing = byValue.get(normalized);
    if (existing) {
      for (const m of methods) {
        if (!existing.methods.includes(m)) existing.methods.push(m);
      }
      existing.methods.sort((a, b) => HTTP_METHODS.indexOf(a) - HTTP_METHODS.indexOf(b));
      if (CATEGORY_PRIORITY[category] > CATEGORY_PRIORITY[existing.category]) {
        existing.category = category;
      }
      existing.dynamic ||= tok.dynamic;
      pushLocation(existing.locations, loc);
      continue;
    }

    if (byValue.size >= MAX_ENDPOINTS_PER_FILE) continue;
    byValue.set(normalized, {
      value: normalized,
      category,
      methods,
      dynamic: tok.dynamic,
      locations: [loc],
    });
  }

  return [...byValue.values()];
}

export function extractRoutes(
  text: string,
  lexed: LexResult,
  lines: LineIndex,
  base: Omit<IntelLocation, 'line' | 'column'>,
): RouteHit[] {
  const byPath = new Map<string, RouteHit>();
  const hasBuildManifest = text.includes('__BUILD_MANIFEST');

  for (const tok of lexed.strings) {
    const val = tok.value.trim();
    if (!val || val.length > 200 || NOT_URL_CHAR.test(val)) continue;
    const lower = val.toLowerCase();
    if (lower.includes('..') || lower.includes('node_modules')) continue;
    if (ABSOLUTE_URL.test(val) || MIME_TYPE.test(val) || ASSET_PATH.test(val)) continue;
    const cat = classifyPath(val);
    if (cat === 'api' || cat === 'graphql' || cat === 'next-data') continue;
    if (!PATH_SHAPE.test(val)) continue;

    const before = text.slice(Math.max(0, tok.start - 140), tok.start);
    const after = text.slice(tok.end, Math.min(text.length, tok.end + 220));

    let kind: RouteKind | null = null;
    if (
      ROUTE_DEFINITION_BEFORE.test(before) &&
      (ROUTE_COMPANION.test(after) ||
        ROUTE_JSX_BEFORE.test(before) ||
        (val.startsWith('/') && val.length > 1))
    ) {
      if (val !== '*' && !isRegexOrNoiseSlashPath(val)) kind = 'definition';
    } else if (val.startsWith('/') && val.length > 1 && ROUTE_NAVIGATION_BEFORE.test(before)) {
      if (!isRegexOrNoiseSlashPath(val)) kind = 'navigation';
    } else if (
      hasBuildManifest &&
      val.startsWith('/') &&
      !val.startsWith('/_next/') &&
      OBJECT_KEY_AFTER.test(after)
    ) {
      if (!isRegexOrNoiseSlashPath(val)) kind = 'manifest';
    }

    if (!kind) continue;

    const pos = lines.position(tok.start);
    const loc: IntelLocation = { ...base, line: pos.line, column: pos.column };
    const existing = byPath.get(val);
    if (existing) {
      if (ROUTE_PRIORITY[kind] > ROUTE_PRIORITY[existing.kind]) existing.kind = kind;
      pushLocation(existing.locations, loc);
      continue;
    }

    if (byPath.size >= MAX_ROUTES_PER_FILE) continue;
    byPath.set(val, { path: val, kind, locations: [loc] });
  }

  return [...byPath.values()];
}

function normalizeFileRoute(rawSegment: string): string {
  const cleaned = rawSegment
    .split('/')
    .filter((segment) => segment.length > 0 && !(segment.startsWith('(') && segment.endsWith(')')))
    .join('/');
  if (!cleaned || cleaned === 'index') return '/';
  const withoutIndex = cleaned.endsWith('/index') ? cleaned.slice(0, -'/index'.length) : cleaned;
  return `/${withoutIndex}`;
}

/** Derive Next.js / Nuxt / SvelteKit routes and Next.js API endpoints from rebuilt file paths. */
export function extractFileArtifacts(
  rebuiltPath: string,
  scriptUrl: string,
  mapUrl?: string,
): { route?: RouteHit; endpoint?: EndpointHit } {
  let clean = rebuiltPath.replace(/^src\//, '');
  if (clean.startsWith('src/')) clean = clean.slice(4);
  if (!ROUTE_FILE_EXT.test(clean)) return {};
  const stem = clean.replace(ROUTE_FILE_EXT, '');
  if (NON_ROUTE_FILE.test(stem)) return {};

  const location: IntelLocation = {
    file: rebuiltPath,
    line: 1,
    column: 0,
    kind: 'source',
    scriptUrl,
    ...(mapUrl ? { mapUrl } : {}),
  };

  const pagesApi = /^(?:.*\/)?pages\/(api\/.+)$/.exec(stem);
  if (pagesApi?.[1]) {
    const endpointPath = normalizeFileRoute(pagesApi[1]);
    return {
      endpoint: {
        value: endpointPath,
        category: classifyPath(endpointPath) ?? 'api',
        methods: [],
        dynamic: endpointPath.includes('['),
        locations: [location],
      },
    };
  }

  const appApi = /^(?:.*\/)?app\/(api\/.+)\/route$/.exec(stem);
  if (appApi?.[1]) {
    const endpointPath = normalizeFileRoute(appApi[1]);
    return {
      endpoint: {
        value: endpointPath,
        category: classifyPath(endpointPath) ?? 'api',
        methods: [],
        dynamic: endpointPath.includes('['),
        locations: [location],
      },
    };
  }

  const pagesRoute = /^(?:.*\/)?pages\/(.+)$/.exec(stem);
  if (pagesRoute?.[1]) {
    const sub = pagesRoute[1];
    const first = sub.split('/')[0] ?? '';
    if (
      first === 'api' ||
      first === '_app' ||
      first === '_document' ||
      first === '_error' ||
      first === '_middleware'
    ) {
      return {};
    }
    return {
      route: { path: normalizeFileRoute(sub), kind: 'file', locations: [location] },
    };
  }

  const appPage = /^(?:.*\/)?app\/(?:(.+)\/)?page$/.exec(stem);
  if (appPage) {
    return {
      route: { path: normalizeFileRoute(appPage[1] ?? ''), kind: 'file', locations: [location] },
    };
  }

  const sveltePage = /^(?:.*\/)?routes\/(?:(.+)\/)?\+page$/.exec(clean.replace(/\.svelte$/, ''));
  if (sveltePage && clean.endsWith('.svelte')) {
    return {
      route: {
        path: normalizeFileRoute(sveltePage[1] ?? ''),
        kind: 'file',
        locations: [location],
      },
    };
  }

  return {};
}

export function extractComments(
  _text: string,
  lexed: LexResult,
  lines: LineIndex,
  base: Omit<IntelLocation, 'line' | 'column'>,
): CommentHit[] {
  const hits: CommentHit[] = [];
  const seen = new Set<string>();

  for (const comment of lexed.comments) {
    if (hits.length >= MAX_COMMENTS_PER_FILE) break;
    if (LICENSE_COMMENT.test(comment.text)) continue;

    COMMENT_MARKER.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = COMMENT_MARKER.exec(comment.text)) !== null) {
      const marker = (match[1] ?? '').toUpperCase();
      const note = (match[2] ?? '').replace(/\*\/\s*$/, '').trim();
      if (note.length < 4) continue;

      const offset = comment.start + 2 + match.index;
      const pos = lines.position(offset);
      const dedupeKey = `${pos.line}:${marker}`;
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);

      let level: HintLevel = 'low';
      if (marker === 'BYPASS' || marker === 'SECURITY' || marker === 'INTERNAL') {
        level = 'high';
      } else if (SENSITIVE_COMMENT.test(note)) {
        level = 'high';
      } else if (marker === 'HACK' || marker === 'FIXME') {
        level = 'medium';
      }

      hits.push({
        marker,
        text: note,
        level,
        location: { ...base, line: pos.line, column: pos.column },
      });
      if (hits.length >= MAX_COMMENTS_PER_FILE) break;
    }
  }

  hits.sort(
    (a, b) =>
      LEVEL_PRIORITY[b.level] - LEVEL_PRIORITY[a.level] ||
      HINT_LEVELS.indexOf(a.level) - HINT_LEVELS.indexOf(b.level) ||
      a.location.line - b.location.line,
  );
  return hits;
}
