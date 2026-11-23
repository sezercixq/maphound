import { strFromU8, unzipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import type { JobRecord, MapRecord, ScriptRecord } from '@/core/db';
import { exportFileName, exportSourceZip } from '@/engine/zip/export';

const ORIGIN = 'http://127.0.0.1:8080';

function mapRecord(id: string, hash: string, scriptHash: string, url: string): MapRecord {
  return {
    id,
    hash,
    scriptHash,
    origin: ORIGIN,
    url,
    via: 'comment',
    indexed: false,
    sourceCount: 0,
    fileCount: 0,
    withContent: 0,
    missingContent: 0,
    vendorCount: 0,
    totalBytes: 0,
    hasSourcesContent: true,
    partial: false,
    partialReasons: [],
    warnings: [],
    files: [],
    createdAt: 0,
  };
}

const script = (hash: string, url: string): ScriptRecord => ({
  hash,
  urls: [url],
  origin: ORIGIN,
  size: 10,
  sourceMapRef: `${url}.map`,
  status: 'fetched',
  lastAccess: 0,
});

const blobs: Record<string, string> = {
  m1: JSON.stringify({
    version: 3,
    sources: [
      'webpack:///./src/App.tsx',
      'webpack:///./node_modules/react/index.js',
      'webpack:///../../../../../etc/cron.d/evil',
      'C:\\Users\\victim\\AppData\\evil.bat',
      'webpack:///./src/no-content.ts',
      'webpack:///./src/CON.ts',
    ],
    sourcesContent: ['export default 1;', 'module.exports = {};', 'pwn', 'echo', null, 'x'],
    mappings: '',
  }),
  m2: `)]}'\n${JSON.stringify({ version: 3, sources: ['lib/a.ts'], sourcesContent: ['a'], mappings: '' })}`,
  m3: JSON.stringify({ version: 3, sources: ['nothing.ts'], mappings: '' }),
  m4: '<!doctype html>',
};

async function build() {
  const chunks: Uint8Array[] = [];
  let finals = 0;
  const progress: number[] = [];
  const jobs: JobRecord[] = [
    {
      id: 'script:https://www.googletagmanager.com/gtm.js',
      kind: 'script',
      url: 'https://www.googletagmanager.com/gtm.js',
      origin: ORIGIN,
      state: 'skipped',
      skipReason: 'third-party',
      thirdParty: 'analytics',
      attempts: 0,
      leasedUntil: 0,
      createdAt: 0,
      updatedAt: 0,
    },
  ];
  const stats = await exportSourceZip(
    {
      site: { origin: ORIGIN, scope: 'origin' },
      maps: [
        mapRecord('a', 'm1', 's1', `${ORIGIN}/static/main.js.map`),
        // Same script file name on another path: gets its own folder (sorted by URL, so
        // /admin/main.js gets main.js and /static/main.js gets main-2.js).
        mapRecord('b', 'm2', 's2', `${ORIGIN}/admin/main.js.map`),
        mapRecord('c', 'm3', 's3', `${ORIGIN}/empty.js.map`),
        mapRecord('d', 'm4', 's4', `${ORIGIN}/broken.js.map`),
        mapRecord('e', 'missing', 's5', `${ORIGIN}/gone.js.map`),
      ],
      scripts: [
        script('s1', `${ORIGIN}/static/main.js`),
        script('s2', `${ORIGIN}/admin/main.js?v=2`),
        script('s3', `${ORIGIN}/empty.js`),
      ],
      jobs,
      readBlob: async (hash) =>
        blobs[hash] === undefined ? undefined : new Blob([blobs[hash] as string]),
    },
    {
      generator: 'MapHound test',
      now: new Date('2026-11-20T10:00:00Z'),
      onData: (chunk, final) => {
        chunks.push(chunk);
        if (final) finals++;
      },
      onProgress: ({ done }) => progress.push(done),
    },
  );
  const total = chunks.reduce((n, c) => n + c.byteLength, 0);
  const zip = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    zip.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { stats, files: unzipSync(zip), chunks: chunks.length, finals, progress };
}

describe('exportSourceZip', () => {
  it('lays out source trees per host and script, with vendor code apart', async () => {
    const { files, stats, finals, progress } = await build();
    expect(Object.keys(files).sort()).toEqual(
      [
        'ENDPOINTS.md',
        'FINDINGS.md',
        'findings.json',
        'manifest.json',
        'source/127.0.0.1_8080/main-2.js/src/src/App.tsx',
        'source/127.0.0.1_8080/main-2.js/_vendor/react/index.js',
        'source/127.0.0.1_8080/main-2.js/src/etc/cron.d/evil',
        'source/127.0.0.1_8080/main-2.js/src/Users/victim/AppData/evil.bat',
        'source/127.0.0.1_8080/main-2.js/src/src/_CON.ts',
        'source/127.0.0.1_8080/main.js/src/lib/a.ts',
      ].sort(),
    );
    expect(strFromU8(files['source/127.0.0.1_8080/main-2.js/src/src/App.tsx'] as Uint8Array)).toBe(
      'export default 1;',
    );
    expect(stats).toEqual({
      maps: 2,
      files: 6,
      bytes: 17 + 20 + 3 + 4 + 1 + 1,
      skippedMaps: 2,
      findings: 0,
    });
    expect(finals).toBe(1);
    expect(progress).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it('never produces an entry that could escape the extraction folder', async () => {
    const { files } = await build();
    for (const name of Object.keys(files)) {
      expect(name).toMatch(
        /^(manifest\.json|ENDPOINTS\.md|FINDINGS\.md|findings\.json|source\/[^/]+\/[^/]+\/(src|_vendor)\/.+)$/,
      );
      expect(name.split('/')).not.toContain('..');
      expect(name).not.toMatch(/[\\:\u0000]|^\//);
    }
  });

  it('writes a manifest describing what was and was not exported', async () => {
    const { files } = await build();
    const manifest = JSON.parse(strFromU8(files['manifest.json'] as Uint8Array));
    expect(manifest).toMatchObject({
      generator: 'MapHound test',
      exportedAt: '2026-11-20T10:00:00.000Z',
      site: { origin: ORIGIN, scope: 'origin' },
      summary: { scripts: 5, maps: 5, mapsExported: 2, files: 6 },
      notScanned: [
        {
          url: 'https://www.googletagmanager.com/gtm.js',
          kind: 'script',
          reason: 'third-party',
          thirdParty: 'analytics',
        },
      ],
    });
    const byUrl = Object.fromEntries(
      manifest.scripts.flatMap((s: { maps: { url: string }[] }) => s.maps.map((m) => [m.url, m])),
    );
    expect(byUrl[`${ORIGIN}/static/main.js.map`]).toMatchObject({
      folder: 'source/127.0.0.1_8080/main-2.js',
      files: 6,
      filesWithContent: 5,
      vendorFiles: 1,
      missingContent: ['src/src/no-content.ts'],
    });
    expect(byUrl[`${ORIGIN}/empty.js.map`]).toMatchObject({
      folder: null,
      missingContent: ['src/nothing.ts'],
    });
    expect(byUrl[`${ORIGIN}/broken.js.map`].error).toMatch(/invalid JSON/);
    expect(byUrl[`${ORIGIN}/gone.js.map`].error).toBe('map blob missing');
    expect(manifest.scripts.find((s: { sha256: string }) => s.sha256 === 's2').urls).toEqual([
      `${ORIGIN}/admin/main.js?v=2`,
    ]);
  });

  it('includes populated ENDPOINTS.md when intel and pages are provided', async () => {
    const chunks: Uint8Array[] = [];
    await exportSourceZip(
      {
        site: { origin: ORIGIN, scope: 'origin' },
        maps: [],
        scripts: [],
        jobs: [],
        intel: [
          {
            id: `${ORIGIN}|s1`,
            origin: ORIGIN,
            scriptHash: 's1',
            scriptUrl: `${ORIGIN}/app.js`,
            endpoints: [
              {
                value: '/internal/admin/users',
                category: 'admin',
                methods: ['POST'],
                dynamic: false,
                locations: [
                  {
                    file: 'src/admin.ts',
                    line: 10,
                    column: 2,
                    kind: 'source',
                    scriptUrl: `${ORIGIN}/app.js`,
                  },
                ],
              },
            ],
            routes: [],
            comments: [],
            sinks: [],
            truncated: false,
            updatedAt: 0,
          },
        ],
        readBlob: async () => undefined,
      },
      { generator: 'MapHound test', onData: (chunk) => chunks.push(chunk) },
    );
    const zip = new Uint8Array(chunks.reduce((n, c) => n + c.byteLength, 0));
    let offset = 0;
    for (const chunk of chunks) {
      zip.set(chunk, offset);
      offset += chunk.byteLength;
    }
    const files = unzipSync(zip);
    const endpointsMd = strFromU8(files['ENDPOINTS.md'] as Uint8Array);
    expect(endpointsMd).toContain('/internal/admin/users');
    expect(endpointsMd).toContain('POST');
  });

  it('stops when aborted', async () => {
    const controller = new AbortController();
    controller.abort(new Error('cancelled'));
    await expect(
      exportSourceZip(
        {
          site: { origin: ORIGIN, scope: 'origin' },
          maps: [mapRecord('a', 'm1', 's1', 'u')],
          scripts: [],
          jobs: [],
          readBlob: async () => undefined,
        },
        { generator: 'x', onData: () => {}, signal: controller.signal },
      ),
    ).rejects.toThrow('cancelled');
  });
});

describe('exportFileName', () => {
  it('names the archive after the host and date', () => {
    expect(exportFileName('http://127.0.0.1:8080', new Date('2026-11-20T23:00:00Z'))).toBe(
      'maphound-127.0.0.1_8080-2026-11-20.zip',
    );
    expect(exportFileName('https://example.com')).toMatch(
      /^maphound-example\.com-\d{4}-\d{2}-\d{2}\.zip$/,
    );
  });
});
