import { describe, expect, it } from 'vitest';
import type { MapRecord, ScriptRecord } from '@/core/db';
import {
  compileSearchMatcher,
  loadSourceFile,
  searchSiteMaps,
  searchTextLines,
} from '@/engine/search/source-search';

const ORIGIN = 'https://example.com';

const mapRec: MapRecord = {
  id: 'map-1',
  hash: 'mh1',
  scriptHash: 'sh1',
  origin: ORIGIN,
  url: `${ORIGIN}/app.js.map`,
  via: 'comment',
  indexed: false,
  sourceCount: 2,
  fileCount: 2,
  withContent: 2,
  missingContent: 0,
  vendorCount: 1,
  totalBytes: 100,
  hasSourcesContent: true,
  partial: false,
  partialReasons: [],
  warnings: [],
  files: [],
  createdAt: 0,
};

const scriptRec: ScriptRecord = {
  hash: 'sh1',
  urls: [`${ORIGIN}/app.js`],
  origin: ORIGIN,
  size: 50,
  sourceMapRef: `${ORIGIN}/app.js.map`,
  status: 'scanned',
  lastAccess: 0,
};

const mapJson = JSON.stringify({
  version: 3,
  sources: ['webpack:///./src/panel.tsx', 'webpack:///./node_modules/pkg/index.js'],
  sourcesContent: [
    'const x = 1;\nexport function Panel() {\n  return <div dangerouslySetInnerHTML={{ __html: bio }} />;\n}\n',
    'export const vendorDanger = "dangerouslySetInnerHTML";\n',
  ],
  mappings: 'AAAA',
});

describe('searchTextLines', () => {
  it('computes accurate preview offsets for highlighting', () => {
    const matcher = compileSearchMatcher({ query: 'dangerouslySetInnerHTML' });
    const matches = searchTextLines(
      '    return <div dangerouslySetInnerHTML={{ __html: bio }} />;',
      matcher,
      {
        mapId: 'm',
        mapHash: 'mh',
        mapUrl: 'u',
        scriptUrl: 's',
        file: 'src/panel.tsx',
        vendor: false,
      },
    );
    expect(matches).toHaveLength(1);
    const m = matches[0]!;
    expect(m.line).toBe(1);
    expect(m.lineText.slice(m.previewStart, m.previewStart + m.previewLength)).toBe(
      'dangerouslySetInnerHTML',
    );
  });
});

describe('searchSiteMaps', () => {
  const readBlob = async (hash: string) => {
    if (hash === 'mh1') return new Blob([mapJson]);
    if (hash === 'sh1') return new Blob(['console.log("bundle");']);
    return undefined;
  };

  it('searches first-party sources and toggles _vendor/', async () => {
    const firstParty = await searchSiteMaps([mapRec], [scriptRec], readBlob, {
      query: 'dangerouslySetInnerHTML',
    });
    expect(firstParty.filesSearched).toBe(1);
    expect(firstParty.filesMatched).toBe(1);
    expect(firstParty.matches.map((m) => [m.file, m.line])).toEqual([['src/src/panel.tsx', 3]]);

    const withVendor = await searchSiteMaps([mapRec], [scriptRec], readBlob, {
      query: 'dangerouslySetInnerHTML',
      includeVendor: true,
    });
    expect(withVendor.filesSearched).toBe(2);
    expect(withVendor.matches).toHaveLength(2);
  });

  it('supports regex and case-sensitive search and rejects invalid or empty-matching patterns', async () => {
    const regexOut = await searchSiteMaps([mapRec], [scriptRec], readBlob, {
      query: 'dangerously.*HTML',
      regex: true,
    });
    expect(regexOut.matches).toHaveLength(1);

    const caseOut = await searchSiteMaps([mapRec], [scriptRec], readBlob, {
      query: 'dangerouslysetinnerhtml',
      caseSensitive: true,
    });
    expect(caseOut.matches).toHaveLength(0);

    const badRegex = await searchSiteMaps([mapRec], [scriptRec], readBlob, {
      query: '(unclosed',
      regex: true,
    });
    expect(badRegex.error).toBeTruthy();

    const emptyMatchRegex = await searchSiteMaps([mapRec], [scriptRec], readBlob, {
      query: 'a*',
      regex: true,
    });
    expect(emptyMatchRegex.error).toMatch(/empty/);
  });

  it('loads original source files and falls back to bundle blobs', async () => {
    const sourceFile = await loadSourceFile([mapRec], [scriptRec], readBlob, {
      file: 'src/src/panel.tsx',
      kind: 'source',
    });
    expect(sourceFile?.content).toContain('export function Panel');

    const bundleFile = await loadSourceFile([mapRec], [scriptRec], readBlob, {
      file: 'app.js',
      scriptUrl: `${ORIGIN}/app.js`,
      kind: 'bundle',
    });
    expect(bundleFile?.kind).toBe('bundle');
    expect(bundleFile?.content).toBe('console.log("bundle");');
  });
});
