import type { MapRecord, ScriptRecord } from '@/core/db';
import { parseSourceMap, type RebuiltFile, rebuildSourceTree } from '@/engine/sourcemap';

export const DEFAULT_MAX_SEARCH_RESULTS = 200;
export const MAX_MATCHES_PER_FILE = 25;
export const MAX_LINE_SCAN_CHARS = 4_000;
export const MAX_SEARCH_PATTERN_CHARS = 200;

export interface SearchQuery {
  query: string;
  regex?: boolean;
  caseSensitive?: boolean;
  includeVendor?: boolean;
  maxResults?: number;
}

export interface SearchMatch {
  mapId: string;
  mapHash: string;
  mapUrl: string;
  scriptUrl: string;
  file: string;
  vendor: boolean;
  /** 1-based line number. */
  line: number;
  /** 0-based column inside the line. */
  column: number;
  /** Length of the match in characters. */
  length: number;
  /** Single-line excerpt suitable for display. */
  lineText: string;
  /** Offset of the match inside `lineText`. */
  previewStart: number;
  /** Length of the highlight inside `lineText`. */
  previewLength: number;
}

export interface SearchResult {
  matches: SearchMatch[];
  filesSearched: number;
  filesMatched: number;
  truncated: boolean;
  error?: string;
}

export interface FileLoadTarget {
  file: string;
  mapHash?: string;
  mapUrl?: string;
  scriptUrl?: string;
  kind?: 'source' | 'bundle';
}

export interface LoadedSourceFile {
  path: string;
  content: string;
  size: number;
  vendor: boolean;
  kind: 'source' | 'bundle';
  scriptUrl: string;
  mapUrl?: string;
}

export interface CompiledMatcher {
  findInLine(line: string): { column: number; length: number } | null;
}

export interface MapCache {
  get(hash: string): RebuiltFile[] | undefined;
  set(hash: string, files: RebuiltFile[]): unknown;
}

export function compileSearchMatcher(query: SearchQuery): CompiledMatcher {
  const raw = query.query;
  if (!raw || raw.trim().length === 0) {
    throw new Error('Search query is empty');
  }
  if (query.regex) {
    if (raw.length > MAX_SEARCH_PATTERN_CHARS) {
      throw new Error(`Pattern exceeds ${MAX_SEARCH_PATTERN_CHARS} characters`);
    }
    const re = new RegExp(raw, query.caseSensitive ? '' : 'i');
    if (re.test('')) {
      throw new Error('Pattern matches empty text');
    }
    return {
      findInLine(line) {
        re.lastIndex = 0;
        const match = re.exec(line);
        if (!match || match[0].length === 0) return null;
        return { column: match.index, length: match[0].length };
      },
    };
  }

  const needle = query.caseSensitive ? raw : raw.toLowerCase();
  return {
    findInLine(line) {
      const hay = query.caseSensitive ? line : line.toLowerCase();
      const idx = hay.indexOf(needle);
      if (idx < 0) return null;
      return { column: idx, length: needle.length };
    },
  };
}

function formatPreview(
  rawLine: string,
  col: number,
  len: number,
): { lineText: string; previewStart: number; previewLength: number } {
  let trimStart = 0;
  while (
    trimStart < rawLine.length &&
    trimStart < col &&
    (rawLine[trimStart] === ' ' || rawLine[trimStart] === '\t')
  ) {
    trimStart++;
  }
  let from = trimStart;
  let to = rawLine.length;
  if (to - from > 160) {
    from = Math.max(trimStart, col - 48);
    to = Math.min(rawLine.length, from + 160);
  }
  const prefix = from > trimStart ? '…' : '';
  const suffix = to < rawLine.length ? '…' : '';
  let body = rawLine.slice(from, to);
  if (!suffix) body = body.trimEnd();
  const lineText = `${prefix}${body}${suffix}`;
  const previewStart = prefix.length + (col - from);
  const previewLength = Math.max(0, Math.min(len, from + body.length - col));
  return { lineText, previewStart, previewLength };
}

export interface LineMatchMeta {
  mapId: string;
  mapHash: string;
  mapUrl: string;
  scriptUrl: string;
  file: string;
  vendor: boolean;
}

export function searchTextLines(
  content: string,
  matcher: CompiledMatcher,
  meta: LineMatchMeta,
  maxMatches = MAX_MATCHES_PER_FILE,
): SearchMatch[] {
  const matches: SearchMatch[] = [];
  let lineNum = 1;
  let start = 0;
  const n = content.length;

  while (start <= n && matches.length < maxMatches) {
    let end = content.indexOf('\n', start);
    if (end < 0) end = n;
    const rawLine =
      end > start && content.charCodeAt(end - 1) === 13
        ? content.slice(start, end - 1)
        : content.slice(start, end);
    if (rawLine.length > 0) {
      const scanSlice =
        rawLine.length > MAX_LINE_SCAN_CHARS ? rawLine.slice(0, MAX_LINE_SCAN_CHARS) : rawLine;
      const hit = matcher.findInLine(scanSlice);
      if (hit) {
        const preview = formatPreview(rawLine, hit.column, hit.length);
        matches.push({
          ...meta,
          line: lineNum,
          column: hit.column,
          length: hit.length,
          ...preview,
        });
      }
    }
    if (end === n) break;
    start = end + 1;
    lineNum++;
  }

  return matches;
}

async function rebuildCached(
  map: MapRecord,
  readBlob: (hash: string) => Promise<Blob | undefined>,
  cache?: MapCache,
): Promise<RebuiltFile[] | null> {
  const cached = cache?.get(map.hash);
  if (cached) return cached;
  const blob = await readBlob(map.hash);
  if (!blob) return null;
  let files: RebuiltFile[];
  try {
    files = rebuildSourceTree(parseSourceMap(await blob.text()), { includeContent: true }).files;
  } catch {
    return null;
  }
  cache?.set(map.hash, files);
  return files;
}

function scriptUrlForMap(map: MapRecord, scriptsByHash: Map<string, ScriptRecord>): string {
  return scriptsByHash.get(map.scriptHash)?.urls[0] ?? map.url.replace(/#inline-map$/, '');
}

export async function searchSiteMaps(
  maps: readonly MapRecord[],
  scripts: readonly ScriptRecord[],
  readBlob: (hash: string) => Promise<Blob | undefined>,
  query: SearchQuery,
  cache?: MapCache,
): Promise<SearchResult> {
  if (!query.query || query.query.trim().length === 0) {
    return { matches: [], filesSearched: 0, filesMatched: 0, truncated: false };
  }

  let matcher: CompiledMatcher;
  try {
    matcher = compileSearchMatcher(query);
  } catch (error) {
    return {
      matches: [],
      filesSearched: 0,
      filesMatched: 0,
      truncated: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }

  const maxResults = query.maxResults ?? DEFAULT_MAX_SEARCH_RESULTS;
  const includeVendor = query.includeVendor ?? false;
  const scriptsByHash = new Map(scripts.map((s) => [s.hash, s]));
  const sortedMaps = [...maps].sort((a, b) => a.url.localeCompare(b.url));

  const matches: SearchMatch[] = [];
  let filesSearched = 0;
  let filesMatched = 0;
  let truncated = false;

  for (const map of sortedMaps) {
    if (matches.length >= maxResults) {
      truncated = true;
      break;
    }
    const files = await rebuildCached(map, readBlob, cache);
    if (!files) continue;
    const scriptUrl = scriptUrlForMap(map, scriptsByHash);

    for (const file of files) {
      if (file.content === undefined) continue;
      if (file.vendor && !includeVendor) continue;
      filesSearched++;
      const remaining = maxResults - matches.length;
      if (remaining <= 0) {
        truncated = true;
        break;
      }
      const perFileCap = Math.min(MAX_MATCHES_PER_FILE, remaining);
      const found = searchTextLines(
        file.content,
        matcher,
        {
          mapId: map.id,
          mapHash: map.hash,
          mapUrl: map.url,
          scriptUrl,
          file: file.path,
          vendor: file.vendor,
        },
        perFileCap,
      );
      if (found.length > 0) {
        filesMatched++;
        matches.push(...found);
        if (matches.length >= maxResults) {
          truncated = true;
          break;
        }
      }
    }
  }

  return { matches, filesSearched, filesMatched, truncated };
}

function bundleNameFromUrl(url: string): string {
  try {
    return new URL(url).pathname.split('/').filter(Boolean).pop() ?? url;
  } catch {
    return url;
  }
}

export async function loadSourceFile(
  maps: readonly MapRecord[],
  scripts: readonly ScriptRecord[],
  readBlob: (hash: string) => Promise<Blob | undefined>,
  target: FileLoadTarget,
  cache?: MapCache,
): Promise<LoadedSourceFile | null> {
  const scriptsByHash = new Map(scripts.map((s) => [s.hash, s]));

  if (target.kind !== 'bundle') {
    const score = (map: MapRecord): number => {
      if (target.mapHash && map.hash === target.mapHash) return 3;
      if (target.mapUrl && map.url === target.mapUrl) return 2;
      if (target.scriptUrl && scriptUrlForMap(map, scriptsByHash) === target.scriptUrl) return 1;
      return 0;
    };
    const orderedMaps = [...maps].sort((a, b) => score(b) - score(a) || a.url.localeCompare(b.url));
    for (const map of orderedMaps) {
      const files = await rebuildCached(map, readBlob, cache);
      if (!files) continue;
      const hit = files.find((f) => f.path === target.file && f.content !== undefined);
      if (hit && hit.content !== undefined) {
        return {
          path: hit.path,
          content: hit.content,
          size: hit.size,
          vendor: hit.vendor,
          kind: 'source',
          scriptUrl: scriptUrlForMap(map, scriptsByHash),
          mapUrl: map.url,
        };
      }
    }
  }

  const matchedScript =
    scripts.find((s) => target.scriptUrl && s.urls.includes(target.scriptUrl)) ??
    scripts.find((s) => s.urls.some((u) => bundleNameFromUrl(u) === target.file));
  if (matchedScript) {
    const blob = await readBlob(matchedScript.hash);
    if (blob) {
      const content = await blob.text();
      return {
        path: target.file,
        content,
        size: matchedScript.size,
        vendor: false,
        kind: 'bundle',
        scriptUrl: matchedScript.urls[0] ?? target.scriptUrl ?? target.file,
      };
    }
  }

  return null;
}
