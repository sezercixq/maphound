/** Defensive source map parsing (ECMA-426, version 3, including index maps with `sections`). */

export interface SourceMapV3 {
  version: 3;
  file?: string;
  sourceRoot?: string;
  sources: (string | null)[];
  sourcesContent?: (string | null)[];
  names: string[];
  mappings: string;
  /** `ignoreList`, or the older `x_google_ignoreList`. Indices into `sources`. */
  ignoreList: number[];
}

/** One regular map placed at an offset (0-based) in the generated file. */
export interface MapSection {
  offset: { line: number; column: number };
  map: SourceMapV3;
}

export interface ParsedSourceMap {
  /** A regular map is a single section at offset 0:0. */
  sections: MapSection[];
  indexed: boolean;
  file?: string;
  warnings: string[];
}

export type ParseErrorCode = 'invalid-json' | 'not-a-map' | 'unsupported-version';

export class SourceMapParseError extends Error {
  constructor(
    readonly code: ParseErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'SourceMapParseError';
  }
}

/** Index maps may not nest per spec; tolerate a little, refuse pathological depth. */
const MAX_SECTION_DEPTH = 4;
const MAX_SECTIONS = 10_000;

/** Strip the anti-XSSI prefix `)]}'` (and the rest of its line) plus a BOM. */
export function stripXssiPrefix(text: string): string {
  const body = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  if (!body.startsWith(")]}'")) return body;
  const newline = body.indexOf('\n');
  return newline < 0 ? '' : body.slice(newline + 1);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function checkVersion(raw: Record<string, unknown>): void {
  // Some generators emit "3" as a string; anything else is not something we understand.
  if (raw.version !== 3 && raw.version !== '3') {
    throw new SourceMapParseError(
      'unsupported-version',
      `unsupported source map version: ${String(raw.version)}`,
    );
  }
}

function normalizeMap(raw: Record<string, unknown>, warnings: string[]): SourceMapV3 {
  checkVersion(raw);
  if (!Array.isArray(raw.sources)) {
    throw new SourceMapParseError('not-a-map', 'source map has no "sources" array');
  }
  const sources = raw.sources.map((s) => (typeof s === 'string' ? s : null));
  let sourcesContent: (string | null)[] | undefined;
  if (Array.isArray(raw.sourcesContent)) {
    sourcesContent = raw.sourcesContent.map((c) => (typeof c === 'string' ? c : null));
  } else if (raw.sourcesContent !== undefined && raw.sourcesContent !== null) {
    warnings.push('ignored non-array "sourcesContent"');
  }
  const ignoreRaw = Array.isArray(raw.ignoreList)
    ? raw.ignoreList
    : Array.isArray(raw.x_google_ignoreList)
      ? raw.x_google_ignoreList
      : [];
  const ignoreList = ignoreRaw.filter(
    (i): i is number => Number.isInteger(i) && (i as number) >= 0 && (i as number) < sources.length,
  );
  let mappings = '';
  if (typeof raw.mappings === 'string') mappings = raw.mappings;
  else warnings.push('missing "mappings"; positions cannot be mapped');

  return {
    version: 3,
    file: typeof raw.file === 'string' ? raw.file : undefined,
    sourceRoot: typeof raw.sourceRoot === 'string' && raw.sourceRoot ? raw.sourceRoot : undefined,
    sources,
    sourcesContent,
    names: Array.isArray(raw.names)
      ? raw.names.filter((n): n is string => typeof n === 'string')
      : [],
    mappings,
    ignoreList,
  };
}

function flatten(
  raw: Record<string, unknown>,
  base: { line: number; column: number },
  depth: number,
  out: MapSection[],
  warnings: string[],
): void {
  if (!Array.isArray(raw.sections)) {
    out.push({ offset: base, map: normalizeMap(raw, warnings) });
    return;
  }
  checkVersion(raw);
  if (depth >= MAX_SECTION_DEPTH) {
    warnings.push('index map nested too deeply; inner sections skipped');
    return;
  }
  for (const section of raw.sections) {
    if (out.length >= MAX_SECTIONS) {
      warnings.push(`more than ${MAX_SECTIONS} sections; the rest were skipped`);
      return;
    }
    if (!isRecord(section) || !isRecord(section.offset)) {
      warnings.push('skipped malformed section');
      continue;
    }
    if (!isRecord(section.map)) {
      // `url` sections point at another file; fetching them is out of scope.
      warnings.push(
        section.url
          ? 'skipped section that references an external map'
          : 'skipped section without map',
      );
      continue;
    }
    const line = Number(section.offset.line);
    const column = Number(section.offset.column);
    if (!Number.isInteger(line) || !Number.isInteger(column) || line < 0 || column < 0) {
      warnings.push('skipped section with invalid offset');
      continue;
    }
    const offset =
      line === 0
        ? { line: base.line, column: base.column + column }
        : { line: base.line + line, column };
    try {
      flatten(section.map, offset, depth + 1, out, warnings);
    } catch (error) {
      if (!(error instanceof SourceMapParseError)) throw error;
      warnings.push(`skipped section: ${error.message}`);
    }
  }
}

/** Parse source map JSON text. Throws `SourceMapParseError` for anything that is not a v3 map. */
export function parseSourceMap(text: string): ParsedSourceMap {
  let raw: unknown;
  try {
    raw = JSON.parse(stripXssiPrefix(text));
  } catch (error) {
    throw new SourceMapParseError('invalid-json', `invalid JSON: ${(error as Error).message}`);
  }
  if (!isRecord(raw)) throw new SourceMapParseError('not-a-map', 'source map is not a JSON object');
  const warnings: string[] = [];
  const sections: MapSection[] = [];
  flatten(raw, { line: 0, column: 0 }, 0, sections, warnings);
  return {
    sections,
    indexed: Array.isArray(raw.sections),
    file: typeof raw.file === 'string' ? raw.file : undefined,
    warnings,
  };
}
