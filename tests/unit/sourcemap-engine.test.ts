import { describe, expect, it } from 'vitest';
import {
  createPositionMapper,
  parseSourceMap,
  rebuildSourceTree,
  SourceMapParseError,
  stripXssiPrefix,
  utf8Length,
} from '@/engine/sourcemap';

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
function vlq(value: number): string {
  let v = value < 0 ? (-value << 1) | 1 : value << 1;
  let out = '';
  do {
    let digit = v & 31;
    v >>>= 5;
    if (v > 0) digit |= 32;
    out += B64[digit];
  } while (v > 0);
  return out;
}
/** Encode absolute segments [genCol, source, line, col, name?] per generated line. */
function encode(lines: number[][][]): string {
  let source = 0;
  let line = 0;
  let col = 0;
  let name = 0;
  return lines
    .map((segments) => {
      let gen = 0;
      return segments
        .map((seg) => {
          const [g = 0, s = 0, l = 0, c = 0, n] = seg;
          let out = vlq(g - gen) + vlq(s - source) + vlq(l - line) + vlq(c - col);
          gen = g;
          source = s;
          line = l;
          col = c;
          if (n !== undefined) {
            out += vlq(n - name);
            name = n;
          }
          return out;
        })
        .join(',');
    })
    .join(';');
}

const map = (over: Record<string, unknown> = {}) =>
  JSON.stringify({ version: 3, sources: [], mappings: '', ...over });

describe('parseSourceMap', () => {
  it('strips the XSSI prefix and a BOM', () => {
    expect(stripXssiPrefix(")]}'\n{}")).toBe('{}');
    expect(stripXssiPrefix(")]}',\n{}")).toBe('{}');
    expect(stripXssiPrefix('﻿{}')).toBe('{}');
    const parsed = parseSourceMap(`)]}'\n${map({ sources: ['a.ts'] })}`);
    expect(parsed.sections[0]?.map.sources).toEqual(['a.ts']);
  });

  it('accepts version "3" and rejects other versions', () => {
    expect(parseSourceMap(map({ version: '3' })).sections).toHaveLength(1);
    expect(() => parseSourceMap(map({ version: 2 }))).toThrow(/unsupported source map version/);
  });

  it('reports typed errors', () => {
    const code = (text: string) => {
      try {
        parseSourceMap(text);
      } catch (error) {
        return error instanceof SourceMapParseError ? error.code : 'other';
      }
      return 'none';
    };
    expect(code('<!doctype html>')).toBe('invalid-json');
    expect(code('[1,2]')).toBe('not-a-map');
    expect(code('{"version":3}')).toBe('not-a-map');
    expect(code('{"version":4,"sources":[]}')).toBe('unsupported-version');
  });

  it('normalizes hostile field types', () => {
    const parsed = parseSourceMap(
      map({
        sources: ['a.ts', 7, null, { x: 1 }],
        sourcesContent: ['A', 5],
        names: ['n', 3],
        sourceRoot: 9,
        x_google_ignoreList: [0, 9, -1, 1.5, '2', 3],
        mappings: 12,
      }),
    );
    const m = parsed.sections[0]?.map;
    expect(m?.sources).toEqual(['a.ts', null, null, null]);
    expect(m?.sourcesContent).toEqual(['A', null]);
    expect(m?.names).toEqual(['n']);
    expect(m?.sourceRoot).toBeUndefined();
    expect(m?.ignoreList).toEqual([0, 3]);
    expect(m?.mappings).toBe('');
    expect(parsed.warnings).toContain('missing "mappings"; positions cannot be mapped');
  });

  it('flattens index maps with offsets and skips url sections', () => {
    const parsed = parseSourceMap(
      JSON.stringify({
        version: 3,
        sections: [
          {
            offset: { line: 0, column: 0 },
            map: { version: 3, sources: ['a.ts'], mappings: 'AAAA' },
          },
          {
            offset: { line: 10, column: 4 },
            map: { version: 3, sources: ['b.ts'], mappings: 'AAAA' },
          },
          { offset: { line: 20, column: 0 }, url: 'other.map' },
          { offset: { line: -1, column: 0 }, map: { version: 3, sources: [] } },
          { offset: { line: 30, column: 0 }, map: { version: 7, sources: [] } },
        ],
      }),
    );
    expect(parsed.indexed).toBe(true);
    expect(parsed.sections.map((s) => s.offset)).toEqual([
      { line: 0, column: 0 },
      { line: 10, column: 4 },
    ]);
    expect(parsed.warnings).toEqual([
      'skipped section that references an external map',
      'skipped section with invalid offset',
      'skipped section: unsupported source map version: 7',
    ]);
  });
});

describe('rebuildSourceTree', () => {
  const parsed = parseSourceMap(
    map({
      sources: [
        'webpack:///./src/App.tsx',
        'webpack:///./node_modules/react/index.js',
        'webpack:///../../../../etc/passwd',
        'webpack:///./src/missing.ts',
        'webpack:///./src/App.tsx?vue&type=style',
        'polyfills/core.js',
      ],
      sourcesContent: ['app', 'react', 'root:x:0:0', null, 'style'],
      x_google_ignoreList: [5],
    }),
  );

  it('rebuilds a safe tree with vendor code separated', () => {
    const result = rebuildSourceTree(parsed, { includeContent: true });
    expect(result.files.map((f) => [f.path, f.vendor, f.content ?? f.omitted])).toEqual([
      ['src/src/App.tsx', false, 'app'],
      ['_vendor/react/index.js', true, 'react'],
      ['src/etc/passwd', false, 'root:x:0:0'],
      ['src/src/missing.ts', false, 'no-content'],
      ['src/src/App-2.tsx', false, 'style'],
      ['_vendor/polyfills/core.js', true, 'no-content'],
    ]);
    expect(result).toMatchObject({
      sourceCount: 6,
      withContent: 4,
      missingContent: 2,
      vendorCount: 2,
      totalBytes: 3 + 5 + 10 + 5,
      partial: false,
    });
  });

  it('produces identical paths with and without content', () => {
    const a = rebuildSourceTree(parsed, { includeContent: true }).files.map((f) => f.path);
    const b = rebuildSourceTree(parsed).files;
    expect(b.map((f) => f.path)).toEqual(a);
    expect(b.every((f) => f.content === undefined)).toBe(true);
  });

  it('applies sourceRoot unless the source is absolute', () => {
    const result = rebuildSourceTree(
      parseSourceMap(
        map({
          sourceRoot: 'webpack:///app',
          sources: ['lib/x.ts', 'https://cdn.io/y.js'],
          sourcesContent: ['x', 'y'],
        }),
      ),
    );
    expect(result.files.map((f) => [f.originalSource, f.path])).toEqual([
      ['webpack:///app/lib/x.ts', 'src/app/lib/x.ts'],
      ['https://cdn.io/y.js', 'src/cdn.io/y.js'],
    ]);
  });

  it('marks partial results when limits are hit', () => {
    const big = parseSourceMap(
      map({ sources: ['a', 'b', 'c', 'd'], sourcesContent: ['1234', '12345678901', '123', 'é'] }),
    );
    const files = rebuildSourceTree(big, { limits: { maxFiles: 3 } });
    expect(files.files).toHaveLength(3);
    expect(files.partialReasons).toEqual(['file-limit']);

    const sizes = rebuildSourceTree(big, { limits: { maxFileBytes: 10, maxTotalBytes: 8 } });
    expect(sizes.files.map((f) => f.omitted ?? f.size)).toEqual([4, 'too-large', 3, 'total-limit']);
    expect(sizes.partial).toBe(true);
    expect(sizes.partialReasons.sort()).toEqual(['file-size', 'total-size']);
    expect(sizes.totalBytes).toBe(7);
  });

  it('deduplicates identical modules repeated across sections', () => {
    const sectioned = parseSourceMap(
      JSON.stringify({
        version: 3,
        sections: [
          {
            offset: { line: 0, column: 0 },
            map: {
              version: 3,
              sources: ['webpack/bootstrap', 'a.ts'],
              sourcesContent: ['boot', 'A'],
              mappings: '',
            },
          },
          {
            offset: { line: 5, column: 0 },
            map: {
              version: 3,
              sources: ['webpack/bootstrap', 'a.ts'],
              sourcesContent: ['boot', 'A2'],
              mappings: '',
            },
          },
        ],
      }),
    );
    expect(rebuildSourceTree(sectioned).files.map((f) => f.path)).toEqual([
      'src/webpack/bootstrap',
      'src/a.ts',
      'src/a-2.ts',
    ]);
  });

  it('counts UTF-8 bytes', () => {
    expect(utf8Length('aé€😀')).toBe(1 + 2 + 3 + 4);
    expect(utf8Length('\ud800x')).toBe(3 + 1);
  });
});

describe('createPositionMapper', () => {
  it('maps bundle positions to rebuilt files when content is missing', () => {
    const parsed = parseSourceMap(
      map({
        sources: ['webpack:///./src/a.ts', 'webpack:///./src/b.ts'],
        names: ['apiKey'],
        mappings: encode([
          [
            [0, 0, 0, 0],
            [10, 1, 4, 2, 0],
          ],
          [[0, 1, 9, 0]],
        ]),
      }),
    );
    const rebuilt = rebuildSourceTree(parsed);
    expect(rebuilt.missingContent).toBe(2);
    const mapper = createPositionMapper(parsed, rebuilt);
    expect(mapper.originalPositionFor(1, 0)).toEqual({
      path: 'src/src/a.ts',
      line: 1,
      column: 0,
      name: null,
    });
    expect(mapper.originalPositionFor(1, 12)).toEqual({
      path: 'src/src/b.ts',
      line: 5,
      column: 2,
      name: 'apiKey',
    });
    expect(mapper.originalPositionFor(2, 3)).toEqual({
      path: 'src/src/b.ts',
      line: 10,
      column: 0,
      name: null,
    });
    expect(mapper.originalPositionFor(40, 0)).toBeNull();
  });

  it('picks the right section of an index map', () => {
    const parsed = parseSourceMap(
      JSON.stringify({
        version: 3,
        sections: [
          {
            offset: { line: 0, column: 0 },
            map: { version: 3, sources: ['one.ts'], mappings: encode([[[0, 0, 0, 0]]]) },
          },
          {
            offset: { line: 2, column: 5 },
            map: { version: 3, sources: ['two.ts'], mappings: encode([[[0, 0, 7, 1]]]) },
          },
        ],
      }),
    );
    const mapper = createPositionMapper(parsed, rebuildSourceTree(parsed));
    expect(mapper.originalPositionFor(1, 3)?.path).toBe('src/one.ts');
    expect(mapper.originalPositionFor(3, 6)).toEqual({
      path: 'src/two.ts',
      line: 8,
      column: 1,
      name: null,
    });
  });
});
