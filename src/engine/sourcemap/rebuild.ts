import { TraceMap, traceSegment } from '@jridgewell/trace-mapping';
import type { MapSection, ParsedSourceMap } from './parse';
import { PathAllocator, sanitizeSourcePath } from './sanitize-path';

export interface RebuildLimits {
  maxFiles: number;
  maxTotalBytes: number;
  maxFileBytes: number;
}

export const DEFAULT_LIMITS: RebuildLimits = {
  maxFiles: 20_000,
  maxTotalBytes: 200 * 1024 * 1024,
  maxFileBytes: 10 * 1024 * 1024,
};

export type PartialReason = 'file-limit' | 'total-size' | 'file-size';
export type OmitReason = 'no-content' | 'too-large' | 'total-limit';

export interface RebuiltFile {
  /** Safe, unique path under `src/` or `_vendor/`. */
  path: string;
  /** The `sources` entry (with `sourceRoot`) as written in the map. Display only. */
  originalSource: string;
  section: number;
  sourceIndex: number;
  vendor: boolean;
  /** UTF-8 bytes of the content, or 0 when omitted. */
  size: number;
  /** Present when `includeContent` was set and the file was not omitted. */
  content?: string;
  omitted?: OmitReason;
}

export interface RebuildResult {
  files: RebuiltFile[];
  sourceCount: number;
  withContent: number;
  missingContent: number;
  vendorCount: number;
  totalBytes: number;
  partial: boolean;
  partialReasons: PartialReason[];
}

export interface RebuildOptions {
  /** Keep file contents in the result (export). Off for the index stored in IndexedDB. */
  includeContent?: boolean;
  limits?: Partial<RebuildLimits>;
}

/** UTF-8 byte length without allocating an encoded copy. */
export function utf8Length(text: string): number {
  let bytes = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff && i + 1 < text.length) {
      const next = text.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        i++;
      } else bytes += 3;
    } else bytes += 3;
  }
  return bytes;
}

function withSourceRoot(source: string, sourceRoot: string | undefined): string {
  if (!sourceRoot || /^[a-z][a-z0-9+.-]*:/i.test(source)) return source;
  return sourceRoot.endsWith('/') ? sourceRoot + source : `${sourceRoot}/${source}`;
}

/**
 * Third-party code goes to `_vendor/`: anything under `node_modules/` (the part after the last
 * `node_modules/`, so `_vendor/react/index.js`) and anything the map lists in `ignoreList`.
 */
function placeFile(sanitized: string, ignored: boolean): { path: string; vendor: boolean } {
  const segments = sanitized.split('/');
  const nm = segments.lastIndexOf('node_modules');
  if (nm >= 0 && nm < segments.length - 1) {
    return { path: `_vendor/${segments.slice(nm + 1).join('/')}`, vendor: true };
  }
  if (ignored) return { path: `_vendor/${sanitized}`, vendor: true };
  return { path: `src/${sanitized}`, vendor: false };
}

/**
 * Rebuild the original file tree from `sources` + `sourcesContent`. No mappings are decoded:
 * content is already in the map. Deterministic, so the index stored after fetching and the
 * export produce the same paths. Limits mark the result `partial` instead of failing.
 */
export function rebuildSourceTree(
  parsed: ParsedSourceMap,
  options: RebuildOptions = {},
): RebuildResult {
  const limits = { ...DEFAULT_LIMITS, ...options.limits };
  const includeContent = options.includeContent ?? false;
  const allocator = new PathAllocator();
  const seen = new Map<string, string | null>();
  const reasons = new Set<PartialReason>();
  const files: RebuiltFile[] = [];
  let sourceCount = 0;
  let totalBytes = 0;
  let withContent = 0;
  let missingContent = 0;
  let vendorCount = 0;

  outer: for (const [sectionIndex, section] of parsed.sections.entries()) {
    const { map } = section;
    const ignored = new Set(map.ignoreList);
    for (const [sourceIndex, source] of map.sources.entries()) {
      sourceCount++;
      const original = withSourceRoot(source ?? `unnamed-${sourceIndex}`, map.sourceRoot);
      const content = map.sourcesContent?.[sourceIndex] ?? null;
      // The same module repeated across sections: keep one copy.
      if (seen.has(original) && seen.get(original) === content) continue;
      if (files.length >= limits.maxFiles) {
        reasons.add('file-limit');
        break outer;
      }
      seen.set(original, content);

      const placed = placeFile(
        sanitizeSourcePath(original, `unnamed-${sourceIndex}`),
        ignored.has(sourceIndex),
      );
      const file: RebuiltFile = {
        path: allocator.allocate(placed.path),
        originalSource: original,
        section: sectionIndex,
        sourceIndex,
        vendor: placed.vendor,
        size: 0,
      };
      if (placed.vendor) vendorCount++;

      if (content === null) {
        file.omitted = 'no-content';
        missingContent++;
      } else {
        const size = utf8Length(content);
        if (size > limits.maxFileBytes) {
          file.omitted = 'too-large';
          reasons.add('file-size');
        } else if (totalBytes + size > limits.maxTotalBytes) {
          file.omitted = 'total-limit';
          reasons.add('total-size');
        } else {
          file.size = size;
          totalBytes += size;
          withContent++;
          if (includeContent) file.content = content;
        }
      }
      files.push(file);
    }
  }

  return {
    files,
    sourceCount,
    withContent,
    missingContent,
    vendorCount,
    totalBytes,
    partial: reasons.size > 0,
    partialReasons: [...reasons],
  };
}

export interface OriginalPosition {
  /** Rebuilt path of the original file. */
  path: string;
  /** 1-based. */
  line: number;
  /** 0-based. */
  column: number;
  name: string | null;
}

export interface PositionMapper {
  /** Map a bundle position (1-based line, 0-based column) back to the original file. */
  originalPositionFor(line: number, column: number): OriginalPosition | null;
}

/**
 * Bundle-to-source position mapping with `@jridgewell/trace-mapping`. Only needed when
 * `sourcesContent` is missing: a finding in the bundle can still point at the original file
 * and line. Mappings are decoded lazily, per section, on first use.
 */
export function createPositionMapper(
  parsed: ParsedSourceMap,
  rebuilt: RebuildResult,
): PositionMapper {
  const pathOf = new Map<string, string>();
  for (const file of rebuilt.files) pathOf.set(`${file.section}:${file.sourceIndex}`, file.path);
  const traced = new Map<number, TraceMap>();
  const sections = parsed.sections;

  const traceFor = (index: number, section: MapSection): TraceMap => {
    let map = traced.get(index);
    if (!map) {
      map = new TraceMap({
        version: 3,
        sources: section.map.sources,
        names: section.map.names,
        mappings: section.map.mappings,
      });
      traced.set(index, map);
    }
    return map;
  };

  return {
    originalPositionFor(line, column) {
      const line0 = line - 1;
      let index = -1;
      for (let i = 0; i < sections.length; i++) {
        const { offset } = sections[i] as MapSection;
        if (offset.line < line0 || (offset.line === line0 && offset.column <= column)) index = i;
        else break;
      }
      const section = sections[index];
      if (!section || !section.map.mappings) return null;
      const relLine = line0 - section.offset.line;
      const relColumn = relLine === 0 ? column - section.offset.column : column;
      const map = traceFor(index, section);
      const segment = traceSegment(map, relLine, relColumn);
      if (!segment || segment.length < 4) return null;
      const [, sourceIndex, origLine, origColumn, nameIndex] = segment as unknown as number[];
      const path = pathOf.get(`${index}:${sourceIndex}`);
      if (path === undefined || origLine === undefined || origColumn === undefined) return null;
      return {
        path,
        line: origLine + 1,
        column: origColumn,
        name: nameIndex === undefined ? null : (section.map.names[nameIndex] ?? null),
      };
    },
  };
}
