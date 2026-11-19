import 'fake-indexeddb/auto';
import { openDB } from 'idb';
import { describe, expect, it, vi } from 'vitest';
import { analyzeMap, collectGarbage } from '@/core/analyze';
import { DB_VERSION, type JobRecord, type MaphoundHandle, openMaphoundDb } from '@/core/db';
import { LEASE_MS, resumeJobs } from '@/core/jobs';
import { Processor } from '@/core/processor';

let counter = 0;
const ORIGIN = 'https://example.com';
const freshDb = () => openMaphoundDb(`proc-${counter++}`);

const mapJson = JSON.stringify({
  version: 3,
  sources: [
    'webpack:///./src/a.ts',
    'webpack:///./node_modules/lib/x.js',
    'webpack:///../../etc/passwd',
  ],
  sourcesContent: ['export const a = 1;', 'x', null],
  mappings: 'AAAA',
});

async function putBlob(db: MaphoundHandle, hash: string, text: string) {
  const blob = new Blob([text]);
  await db.put('blobs', { hash, kind: 'map', blob, size: blob.size, lastAccess: 0 });
}

const mapJob = (over: Partial<JobRecord> = {}): JobRecord => ({
  id: 'map:https://example.com/a.js.map',
  kind: 'map',
  url: 'https://example.com/a.js.map',
  origin: ORIGIN,
  hash: 'm1',
  parentHash: 's1',
  via: 'comment',
  state: 'fetched',
  attempts: 0,
  leasedUntil: 0,
  createdAt: 0,
  updatedAt: 0,
  ...over,
});

describe('analyzeMap', () => {
  it('stores the rebuilt file index without contents', async () => {
    const db = await freshDb();
    await putBlob(db, 'm1', mapJson);
    const result = await analyzeMap(db, {
      jobId: 'j',
      blobKey: 'm1',
      scriptHash: 's1',
      origin: ORIGIN,
      url: 'https://example.com/a.js.map',
      via: 'comment',
    });
    expect(result).toEqual({
      ok: true,
      summary: { fileCount: 3, withContent: 2, missingContent: 1, partial: false },
    });
    const record = await db.get('maps', 'j');
    expect(record?.files).toEqual([
      { path: 'src/src/a.ts', size: 19, vendor: false },
      { path: '_vendor/lib/x.js', size: 1, vendor: true },
      { path: 'src/etc/passwd', size: 0, vendor: false, omitted: 'no-content' },
    ]);
    expect(record).toMatchObject({
      origin: ORIGIN,
      scriptHash: 's1',
      hasSourcesContent: true,
      vendorCount: 1,
    });
  });

  it('reports invalid maps as permanent failures', async () => {
    const db = await freshDb();
    await putBlob(db, 'bad', '<html>');
    const result = await analyzeMap(db, {
      jobId: 'j',
      blobKey: 'bad',
      scriptHash: '',
      origin: ORIGIN,
      url: 'u',
    });
    expect(result).toMatchObject({ ok: false, permanent: true });
    expect(await db.count('maps')).toBe(0);
  });
});

describe('Processor', () => {
  it('moves fetched map jobs to done through the analyzer', async () => {
    const db = await freshDb();
    await putBlob(db, 'm1', mapJson);
    await db.put('jobs', mapJob());
    await db.put('jobs', mapJob({ id: 'script', kind: 'script', url: 'https://example.com/a.js' }));
    const analyze = vi.fn((request) => analyzeMap(db, request));
    const processor = new Processor({ db: async () => db, analyze });
    await processor.pump();
    await processor.idle();
    expect(analyze).toHaveBeenCalledTimes(1);
    expect((await db.get('jobs', mapJob().id))?.state).toBe('done');
    expect((await db.get('jobs', 'script'))?.state).toBe('fetched');
    expect(await db.count('maps')).toBe(1);
  });

  it('fails invalid maps at once and retries transient errors with backoff', async () => {
    const db = await freshDb();
    await db.put('jobs', mapJob({ id: 'invalid' }));
    await db.put('jobs', mapJob({ id: 'flaky', createdAt: 1 }));
    const schedule = vi.fn();
    const now = 5_000_000;
    const processor = new Processor({
      db: async () => db,
      now: () => now,
      schedule,
      analyze: async ({ jobId }) =>
        jobId === 'invalid'
          ? { ok: false, permanent: true, error: 'invalid JSON' }
          : Promise.reject(new Error('offscreen document closed')),
    });
    await processor.pump();
    expect(await db.get('jobs', 'invalid')).toMatchObject({
      state: 'failed',
      error: 'invalid JSON',
    });
    expect(await db.get('jobs', 'flaky')).toMatchObject({
      state: 'fetched',
      attempts: 1,
      leasedUntil: now + 2_000,
      error: 'offscreen document closed',
    });
    expect(schedule).toHaveBeenCalledWith(expect.any(Function), 2_000);
  });
});

describe('resumeJobs for analysis', () => {
  it('returns an expired scanning lease to fetched, not to the fetch queue', async () => {
    const db = await freshDb();
    await db.put('jobs', mapJob({ state: 'scanning', attempts: 1, leasedUntil: 10 }));
    await resumeJobs(db, 10 + LEASE_MS);
    expect((await db.get('jobs', mapJob().id))?.state).toBe('fetched');
  });
});

describe('collectGarbage', () => {
  it('deletes only blobs nothing references', async () => {
    const db = await freshDb();
    for (const hash of ['used-by-job', 'used-by-map', 'used-by-script', 'orphan'])
      await putBlob(db, hash, hash);
    await db.put('jobs', mapJob({ hash: 'used-by-job' }));
    await db.put('scripts', {
      hash: 'used-by-script',
      urls: [],
      origin: ORIGIN,
      size: 1,
      sourceMapRef: null,
      status: 'fetched',
      lastAccess: 0,
    });
    await putBlob(db, 'm1', mapJson);
    await analyzeMap(db, { jobId: 'x', blobKey: 'm1', scriptHash: '', origin: ORIGIN, url: 'u' });
    const record = await db.get('maps', 'x');
    if (!record) throw new Error('map not stored');
    await db.put('maps', { ...record, hash: 'used-by-map' });
    expect(await collectGarbage(db)).toBe(2); // orphan and m1
    expect((await db.getAllKeys('blobs')).sort()).toEqual([
      'used-by-job',
      'used-by-map',
      'used-by-script',
    ]);
  });
});

describe('schema migration', () => {
  it('upgrades a v1 database and recreates maps keyed by job id', async () => {
    const name = `migrate-${counter++}`;
    const v1 = await openDB(name, 1, {
      upgrade(db) {
        db.createObjectStore('sites', { keyPath: 'origin' });
        db.createObjectStore('scripts', { keyPath: 'hash' }).createIndex('by-origin', 'origin');
        db.createObjectStore('blobs', { keyPath: 'hash' });
        db.createObjectStore('maps', { keyPath: 'hash' }).createIndex(
          'by-scriptHash',
          'scriptHash',
        );
        db.createObjectStore('findings', { keyPath: 'id' });
        const jobs = db.createObjectStore('jobs', { keyPath: 'id' });
        jobs.createIndex('by-state', 'state');
        jobs.createIndex('by-origin', 'origin');
      },
    });
    await v1.put('sites', { origin: ORIGIN });
    v1.close();
    const db = await openMaphoundDb(name);
    expect(db.version).toBe(DB_VERSION);
    expect(await db.get('sites', ORIGIN)).toEqual({ origin: ORIGIN });
    const store = db.transaction('maps').store;
    expect(store.keyPath).toBe('id');
    expect([...store.indexNames].sort()).toEqual(['by-hash', 'by-origin', 'by-scriptHash']);
  });
});
