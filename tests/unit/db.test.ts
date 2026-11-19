import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { type JobRecord, openMaphoundDb } from '@/core/db';
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
      ['blobs', 'findings', 'jobs', 'maps', 'scripts', 'sites'].sort(),
    );
    expect([...db.transaction('findings').store.indexNames].sort()).toEqual(
      ['by-origin', 'by-scriptHash', 'by-secretHash'].sort(),
    );
    expect([...db.transaction('jobs').store.indexNames].sort()).toEqual(['by-origin', 'by-state']);
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
