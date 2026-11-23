import 'fake-indexeddb/auto';
import { randomInt } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { analyzeMap } from '@/core/analyze';
import { type JobRecord, type MaphoundHandle, openMaphoundDb } from '@/core/db';
import { Processor } from '@/core/processor';
import { scanScript } from '@/core/scan-job';
import { rescanSite } from '@/core/sites';
import { type RuleSet, Scanner } from '@/engine/scan';
import { makeGithubStyleToken } from '@/engine/validators';
import rules from '@/generated/rules.json';

vi.mock('wxt/browser', () => ({ browser: {} }));

const scanner = new Scanner(rules as RuleSet);
const ORIGIN = 'https://example.com';
const ALNUM = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
const rand = (n: number) =>
  Array.from({ length: n }, () => ALNUM[randomInt(ALNUM.length)]).join('');
const stripe = () => ['sk', 'live', rand(32)].join('_');
let counter = 0;

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const vlq = (value: number) => {
  let v = value < 0 ? (-value << 1) | 1 : value << 1;
  let out = '';
  do {
    let digit = v & 31;
    v >>>= 5;
    if (v > 0) digit |= 32;
    out += B64[digit];
  } while (v > 0);
  return out;
};

async function putBlob(db: MaphoundHandle, hash: string, kind: 'script' | 'map', text: string) {
  const blob = new Blob([text]);
  await db.put('blobs', { hash, kind, blob, size: blob.size, lastAccess: 0 });
}

const job = (over: Partial<JobRecord>): JobRecord => ({
  id: 'x',
  kind: 'script',
  url: `${ORIGIN}/app.js`,
  origin: ORIGIN,
  state: 'fetched',
  attempts: 0,
  leasedUntil: 0,
  createdAt: 0,
  updatedAt: 0,
  ...over,
});

/**
 * app.js line 1 maps to src/config.ts line 1; line 2 (a value the bundler inlined) maps to
 * src/env.ts line 3. The map's sources hold a GitHub token in src/config.ts line 2.
 */
async function fixture() {
  const db = await openMaphoundDb(`scanjob-${counter++}`);
  const github = makeGithubStyleToken('ghp', rand(30));
  const inlined = stripe();
  const bundle = `console.log("app");\nconst s="${inlined}";\n//# sourceMappingURL=app.js.map\n`;
  const map = JSON.stringify({
    version: 3,
    sources: ['webpack:///./src/config.ts', 'webpack:///./src/env.ts'],
    sourcesContent: [
      `export const a = 1;\nexport const token = "${github}";\n`,
      'export const s = import.meta.env.VITE_STRIPE;\n',
    ],
    mappings: `${vlq(0)}${vlq(0)}${vlq(0)}${vlq(0)};${vlq(0)}${vlq(1)}${vlq(2)}${vlq(0)}`,
  });
  await db.put('sites', {
    origin: ORIGIN,
    scope: 'origin',
    enabledAt: 0,
    settings: { aggressiveMapProbing: false, useCredentials: false },
  });
  await putBlob(db, 'script-hash', 'script', bundle);
  await putBlob(db, 'map-hash', 'map', map);
  await db.put('scripts', {
    hash: 'script-hash',
    urls: [`${ORIGIN}/app.js`],
    origin: ORIGIN,
    size: bundle.length,
    sourceMapRef: `${ORIGIN}/app.js.map`,
    status: 'fetched',
    lastAccess: 0,
  });
  await analyzeMap(db, {
    jobId: 'map-job',
    blobKey: 'map-hash',
    scriptHash: 'script-hash',
    origin: ORIGIN,
    url: `${ORIGIN}/app.js.map`,
  });
  return { db, github, inlined };
}

describe('scanScript', () => {
  it('locates secrets in original sources and maps bundle-only ones back', async () => {
    const { db, github, inlined } = await fixture();
    const result = await scanScript(db, scanner, {
      jobId: 'j',
      scriptHash: 'script-hash',
      origin: ORIGIN,
      url: `${ORIGIN}/app.js`,
    });
    expect(result).toEqual({ ok: true, findings: 2, hits: 2 });
    const findings = await db.getAllFromIndex('findings', 'by-origin', ORIGIN);
    const byRule = Object.fromEntries(findings.map((f) => [f.ruleId, f]));
    expect(byRule['github-classic-pat']).toMatchObject({
      severity: 'critical',
      confidence: 'verified-format',
      file: 'src/src/config.ts',
      line: 2,
      column: 22,
      locationKind: 'source',
      secret: github,
      occurrences: 1,
    });
    expect(byRule['github-classic-pat']?.snippet).not.toContain(github);
    expect(byRule['github-classic-pat']?.references[0]).toMatch(/^https:\/\/github\.blog/);
    expect(byRule['stripe-live-secret-key']).toMatchObject({
      file: 'src/src/env.ts',
      line: 3,
      locationKind: 'bundle-mapped',
      secret: inlined,
      locations: [
        expect.objectContaining({ bundleLine: 2, bundleColumn: 9, scriptUrl: `${ORIGIN}/app.js` }),
      ],
    });
    expect((await db.get('scripts', 'script-hash'))?.status).toBe('scanned');
  });

  it('merges the same secret seen by another script into one finding', async () => {
    const { db, github } = await fixture();
    await scanScript(db, scanner, {
      jobId: 'j',
      scriptHash: 'script-hash',
      origin: ORIGIN,
      url: `${ORIGIN}/app.js`,
    });
    await putBlob(db, 'other', 'script', `x("${github}")`);
    await scanScript(db, scanner, {
      jobId: 'k',
      scriptHash: 'other',
      origin: ORIGIN,
      url: `${ORIGIN}/other.js`,
    });
    const github2 = (await db.getAll('findings')).filter((f) => f.ruleId === 'github-classic-pat');
    expect(github2).toHaveLength(1);
    expect(github2[0]).toMatchObject({ file: 'src/src/config.ts', occurrences: 2 });
    expect(github2[0]?.locations.map((l) => [l.kind, l.file])).toEqual([
      ['source', 'src/src/config.ts'],
      ['bundle', 'other.js'],
    ]);
  });

  it('populates intel for first-party code, skips vendor sinks, and clears intel on rescan', async () => {
    const db = await openMaphoundDb(`scanjob-intel-${counter++}`);
    const map = JSON.stringify({
      version: 3,
      sources: ['webpack:///./src/panel.tsx', 'webpack:///./node_modules/vendor/a.js'],
      sourcesContent: [
        `fetch('/api/v1/users');\nel.innerHTML = raw;\n// BYPASS: skip check`,
        `el.innerHTML = vendorRaw;\n// TODO: vendor internal`,
      ],
      mappings: 'AAAA',
    });
    await db.put('blobs', {
      hash: 'sh',
      kind: 'script',
      blob: new Blob(["console.log('/graphql');"]),
      size: 24,
      lastAccess: 0,
    });
    await db.put('blobs', {
      hash: 'mh',
      kind: 'map',
      blob: new Blob([map]),
      size: map.length,
      lastAccess: 0,
    });
    await analyzeMap(db, {
      jobId: 'mj',
      blobKey: 'mh',
      scriptHash: 'sh',
      origin: ORIGIN,
      url: `${ORIGIN}/app.js.map`,
    });
    await scanScript(db, scanner, {
      jobId: 'sj',
      scriptHash: 'sh',
      origin: ORIGIN,
      url: `${ORIGIN}/app.js`,
    });
    const intel = await db.get('intel', `${ORIGIN}|sh`);
    expect(intel?.endpoints.map((e) => e.value).sort()).toEqual(['/api/v1/users', '/graphql']);
    expect(intel?.sinks).toHaveLength(1);
    expect(intel?.sinks[0]?.location.file).toBe('src/src/panel.tsx');
    expect(intel?.comments).toHaveLength(1);
    expect(intel?.comments[0]?.marker).toBe('BYPASS');

    await rescanSite(ORIGIN, db);
    expect(await db.count('intel')).toBe(0);
  });

  it('fails softly when the blob is gone', async () => {
    const db = await openMaphoundDb(`scanjob-${counter++}`);
    expect(
      await scanScript(db, scanner, { jobId: 'j', scriptHash: 'nope', origin: ORIGIN, url: 'u' }),
    ).toMatchObject({
      ok: false,
      permanent: false,
    });
  });
});

describe('Processor ordering', () => {
  it('scans a script only after its maps are settled', async () => {
    const db = await openMaphoundDb(`scanjob-${counter++}`);
    await db.put('jobs', job({ id: 'script', hash: 'h', createdAt: 0 }));
    await db.put(
      'jobs',
      job({
        id: 'map',
        kind: 'map',
        url: `${ORIGIN}/app.js.map`,
        parentHash: 'h',
        hash: 'm',
        state: 'queued',
        createdAt: 1,
      }),
    );
    const order: string[] = [];
    const processor = new Processor({
      db: async () => db,
      analyze: async ({ jobId }) => {
        order.push(jobId);
        return {
          ok: true,
          summary: { fileCount: 0, withContent: 0, missingContent: 0, partial: false },
        };
      },
      scan: async ({ jobId }) => {
        order.push(jobId);
        return { ok: true, findings: 0, hits: 0 };
      },
    });
    await processor.pump();
    expect(order).toEqual([]); // map still queued for download
    await db.put('jobs', { ...((await db.get('jobs', 'map')) as JobRecord), state: 'fetched' });
    await processor.pump();
    expect(order).toEqual(['map', 'script']);
    expect((await db.get('jobs', 'script'))?.state).toBe('done');
  });
});

describe('rescanSite', () => {
  it('deletes findings and requeues scanned scripts', async () => {
    const { db } = await fixture();
    await scanScript(db, scanner, {
      jobId: 'j',
      scriptHash: 'script-hash',
      origin: ORIGIN,
      url: `${ORIGIN}/app.js`,
    });
    await db.put(
      'jobs',
      job({ id: 'done-script', hash: 'script-hash', state: 'done', attempts: 2 }),
    );
    await db.put('jobs', job({ id: 'skipped', state: 'skipped', skipReason: 'third-party' }));
    expect(await rescanSite(ORIGIN, db)).toEqual({ queued: 1 });
    expect(await db.count('findings')).toBe(0);
    expect(await db.get('jobs', 'done-script')).toMatchObject({ state: 'fetched', attempts: 0 });
    expect((await db.get('jobs', 'skipped'))?.state).toBe('skipped');
  });
});
