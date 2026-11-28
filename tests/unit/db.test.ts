import 'fake-indexeddb/auto';
import { openDB } from 'idb';
import { beforeEach, describe, expect, it } from 'vitest';
import { DB_VERSION, type JobRecord, openMaphoundDb } from '@/core/db';
import { LEASE_MS, MAX_ATTEMPTS, resumeJobs } from '@/core/jobs';

let counter = 0;
const freshDb = () => openMaphoundDb(`test-${counter++}`);

const job = (over: Partial<JobRecord>): JobRecord => ({
  id: 'j1',
  kind: 'script',
  url: 'https://example.com/a.js',
  origin: 'https://example.com',
  state: 'queued',
  attempts: 0,
  leasedUntil: 0,
  createdAt: 0,
  updatedAt: 0,
  ...over,
});

describe('schema', () => {
  it('creates all stores and indexes', async () => {
    const db = await freshDb();
    expect([...db.objectStoreNames].sort()).toEqual(
      [
        'audits',
        'blobs',
        'customRules',
        'findings',
        'intel',
        'jobs',
        'maps',
        'pages',
        'runtimeApi',
        'runtimeDom',
        'scripts',
        'sites',
        'snapshots',
      ].sort(),
    );
    expect([...db.transaction('findings').store.indexNames].sort()).toEqual(
      ['by-origin', 'by-scriptHash', 'by-secretHash'].sort(),
    );
    expect([...db.transaction('intel').store.indexNames].sort()).toEqual([
      'by-origin',
      'by-scriptHash',
    ]);
    expect([...db.transaction('pages').store.indexNames]).toEqual(['by-origin']);
    expect([...db.transaction('audits').store.indexNames]).toEqual(['by-origin']);
    expect([...db.transaction('snapshots').store.indexNames]).toEqual(['by-origin']);
    expect([...db.transaction('jobs').store.indexNames].sort()).toEqual(['by-origin', 'by-state']);
  });

  it('upgrades a v3 database to v4 preserving existing records', async () => {
    const name = `migrate-v3-${counter++}`;
    const v3 = await openDB(name, 3, {
      upgrade(db) {
        db.createObjectStore('sites', { keyPath: 'origin' });
        db.createObjectStore('scripts', { keyPath: 'hash' }).createIndex('by-origin', 'origin');
        db.createObjectStore('blobs', { keyPath: 'hash' });
        db.createObjectStore('maps', { keyPath: 'id' }).createIndex('by-origin', 'origin');
        db.createObjectStore('findings', { keyPath: 'id' }).createIndex('by-origin', 'origin');
        db.createObjectStore('intel', { keyPath: 'id' }).createIndex('by-origin', 'origin');
        db.createObjectStore('pages', { keyPath: 'id' }).createIndex('by-origin', 'origin');
        db.createObjectStore('jobs', { keyPath: 'id' }).createIndex('by-origin', 'origin');
      },
    });
    await v3.put('sites', { origin: 'https://example.com' });
    v3.close();

    const db = await openMaphoundDb(name);
    expect(db.version).toBe(DB_VERSION);
    expect(await db.get('sites', 'https://example.com')).toEqual({
      origin: 'https://example.com',
    });
    expect([...db.objectStoreNames]).toEqual(expect.arrayContaining(['audits', 'snapshots']));
  });

  it('upgrades a v2 database to v3 preserving existing records', async () => {
    const name = `migrate-v2-${counter++}`;
    const v2 = await openDB(name, 2, {
      upgrade(db) {
        db.createObjectStore('sites', { keyPath: 'origin' });
        db.createObjectStore('scripts', { keyPath: 'hash' }).createIndex('by-origin', 'origin');
        db.createObjectStore('blobs', { keyPath: 'hash' });
        db.createObjectStore('maps', { keyPath: 'id' }).createIndex('by-origin', 'origin');
        db.createObjectStore('findings', { keyPath: 'id' }).createIndex('by-origin', 'origin');
        db.createObjectStore('jobs', { keyPath: 'id' }).createIndex('by-origin', 'origin');
      },
    });
    await v2.put('sites', { origin: 'https://example.com' });
    v2.close();

    const db = await openMaphoundDb(name);
    expect(db.version).toBe(DB_VERSION);
    expect(await db.get('sites', 'https://example.com')).toEqual({
      origin: 'https://example.com',
    });
    expect([...db.objectStoreNames]).toEqual(expect.arrayContaining(['intel', 'pages']));
  });

  it('round-trips a blob record', async () => {
    const db = await freshDb();
    await db.put('blobs', {
      hash: 'h',
      kind: 'script',
      blob: new Blob(['abc']),
      size: 3,
      lastAccess: 1,
    });
    const got = await db.get('blobs', 'h');
    expect(got?.size).toBe(3);
  });
});

describe('resumeJobs', () => {
  let now: number;
  beforeEach(() => {
    now = 1_000_000;
  });

  it('requeues expired leases and keeps live ones', async () => {
    const db = await freshDb();
    await db.put(
      'jobs',
      job({ id: 'expired', state: 'fetching', attempts: 1, leasedUntil: now - 1 }),
    );
    await db.put('jobs', job({ id: 'live', state: 'scanning', leasedUntil: now + LEASE_MS }));
    const out = await resumeJobs(db, now);
    expect(out).toEqual({ requeued: 1, failed: 0 });
    expect((await db.get('jobs', 'expired'))?.state).toBe('queued');
    expect((await db.get('jobs', 'live'))?.state).toBe('scanning');
  });

  it('fails jobs that exhausted their attempts', async () => {
    const db = await freshDb();
    await db.put(
      'jobs',
      job({ id: 'dead', state: 'scanning', attempts: MAX_ATTEMPTS, leasedUntil: 1 }),
    );
    const out = await resumeJobs(db, now);
    expect(out).toEqual({ requeued: 0, failed: 1 });
    expect((await db.get('jobs', 'dead'))?.state).toBe('failed');
  });
});
