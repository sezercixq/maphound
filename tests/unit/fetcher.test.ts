import 'fake-indexeddb/auto';
import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { type JobRecord, type MaphoundHandle, openMaphoundDb, type SiteRecord } from '@/core/db';
import { Fetcher, type FetcherDeps } from '@/core/fetcher';
import { enqueueDiscovered, jobId } from '@/core/queue';

let counter = 0;
const ORIGIN = 'https://example.com';
const sha = (text: string) => createHash('sha256').update(text).digest('hex');

async function setup(site: Partial<SiteRecord> = {}) {
  const db = await openMaphoundDb(`fetcher-${counter++}`);
  await db.put('sites', {
    origin: ORIGIN,
    scope: 'origin',
    enabledAt: 0,
    settings: { aggressiveMapProbing: false, useCredentials: false },
    ...site,
  });
  return db;
}

type Route = string | Response | ((init?: RequestInit) => Promise<Response> | Response);

function router(routes: Record<string, Route>) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    const route = routes[url];
    if (route === undefined) return new Response('nope', { status: 404 });
    if (typeof route === 'string') return new Response(route, { status: 200 });
    if (typeof route === 'function') return route(init);
    return route.clone();
  });
  return { fetch: fn as unknown as typeof fetch, calls };
}

function fetcherFor(db: MaphoundHandle, fetchFn: typeof fetch, extra: Partial<FetcherDeps> = {}) {
  return new Fetcher({ db: async () => db, fetch: fetchFn, ...extra });
}

async function run(db: MaphoundHandle, fetcher: Fetcher, urls: string[], page = `${ORIGIN}/`) {
  await enqueueDiscovered(db, page, urls);
  await fetcher.pump();
  await fetcher.idle();
}

const job = (db: MaphoundHandle, kind: 'script' | 'map', url: string) =>
  db.get('jobs', jobId(kind, url)) as Promise<JobRecord | undefined>;

describe('enqueueDiscovered', () => {
  it('ignores pages that are not on an enabled site', async () => {
    const db = await setup();
    const result = await enqueueDiscovered(db, 'https://other.com/', ['https://other.com/a.js']);
    expect(result.origin).toBeNull();
    expect(await db.count('jobs')).toBe(0);
  });

  it('queues in-scope scripts and records third-party ones as skipped', async () => {
    const db = await setup();
    const result = await enqueueDiscovered(db, `${ORIGIN}/app`, [
      '/static/a.js',
      `${ORIGIN}/static/a.js#frag`,
      'https://www.googletagmanager.com/gtm.js',
      'blob:https://example.com/1',
    ]);
    expect(result).toMatchObject({ queued: 1, duplicate: 1, thirdParty: 1, invalid: 1 });
    expect((await job(db, 'script', `${ORIGIN}/static/a.js`))?.state).toBe('queued');
    expect(await job(db, 'script', 'https://www.googletagmanager.com/gtm.js')).toMatchObject({
      state: 'skipped',
      skipReason: 'third-party',
      thirdParty: 'analytics',
      origin: ORIGIN,
    });
  });

  it('accepts at most 200 URLs per message', async () => {
    const db = await setup();
    const urls = Array.from({ length: 250 }, (_, i) => `${ORIGIN}/c${i}.js`);
    expect((await enqueueDiscovered(db, `${ORIGIN}/`, urls)).queued).toBe(200);
  });
});

describe('Fetcher', () => {
  it('stores the script, follows sourceMappingURL and stores the map', async () => {
    const db = await setup();
    const js = 'console.log(1)\n//# sourceMappingURL=app.js.map';
    const map = '{"version":3,"sources":["a.ts"],"mappings":"AAAA"}';
    const { fetch, calls } = router({ [`${ORIGIN}/app.js`]: js, [`${ORIGIN}/app.js.map`]: map });
    await run(db, fetcherFor(db, fetch), [`${ORIGIN}/app.js`]);

    expect(await job(db, 'script', `${ORIGIN}/app.js`)).toMatchObject({
      state: 'fetched',
      hash: sha(js),
    });
    expect(await job(db, 'map', `${ORIGIN}/app.js.map`)).toMatchObject({
      state: 'fetched',
      hash: sha(map),
      parentHash: sha(js),
      via: 'comment',
    });
    expect(await db.get('scripts', sha(js))).toMatchObject({
      urls: [`${ORIGIN}/app.js`],
      sourceMapRef: `${ORIGIN}/app.js.map`,
      status: 'fetched',
    });
    const blob = await db.get('blobs', sha(map));
    expect(blob?.kind).toBe('map');
    expect(await blob?.blob.text()).toBe(map);
    expect(calls.every((c) => c.init?.credentials === 'omit')).toBe(true);
  });

  it('stores identical content once, keyed by hash', async () => {
    const db = await setup();
    const { fetch } = router({ [`${ORIGIN}/a.js`]: 'same', [`${ORIGIN}/b.js`]: 'same' });
    await run(db, fetcherFor(db, fetch), [`${ORIGIN}/a.js`, `${ORIGIN}/b.js`]);
    expect(await db.count('blobs')).toBe(1);
    expect((await db.get('scripts', sha('same')))?.urls.sort()).toEqual([
      `${ORIGIN}/a.js`,
      `${ORIGIN}/b.js`,
    ]);
  });

  it('does not download a URL twice', async () => {
    const db = await setup();
    const { fetch, calls } = router({ [`${ORIGIN}/a.js`]: 'x' });
    const fetcher = fetcherFor(db, fetch);
    await run(db, fetcher, [`${ORIGIN}/a.js`]);
    await run(db, fetcher, [`${ORIGIN}/a.js`]);
    expect(calls).toHaveLength(1);
  });

  it('uses the SourceMap header over the comment', async () => {
    const db = await setup();
    const { fetch } = router({
      [`${ORIGIN}/a.js`]: new Response('x\n//# sourceMappingURL=c.map', {
        headers: { SourceMap: '/h.map' },
      }),
      [`${ORIGIN}/h.map`]: '{"mappings":""}',
    });
    await run(db, fetcherFor(db, fetch), [`${ORIGIN}/a.js`]);
    expect((await job(db, 'map', `${ORIGIN}/h.map`))?.via).toBe('header');
    expect(await job(db, 'map', `${ORIGIN}/c.map`)).toBeUndefined();
  });

  it('extracts inline data: URI maps without a request', async () => {
    const db = await setup();
    const map = '{"version":3,"mappings":"AAAA"}';
    const js = `x()\n//# sourceMappingURL=data:application/json;base64,${Buffer.from(map).toString('base64')}`;
    const { fetch, calls } = router({ [`${ORIGIN}/a.js`]: js });
    await run(db, fetcherFor(db, fetch), [`${ORIGIN}/a.js`]);
    expect(calls).toHaveLength(1);
    expect(await db.get('jobs', `map:inline:${sha(js)}`)).toMatchObject({
      state: 'fetched',
      hash: sha(map),
      via: 'data-uri',
    });
    expect((await db.get('scripts', sha(js)))?.sourceMapRef).toBe('data:');
  });

  it('records out-of-scope maps without fetching them', async () => {
    const db = await setup();
    const { fetch, calls } = router({
      [`${ORIGIN}/a.js`]: 'x\n//# sourceMappingURL=https://maps.cdn.net/a.js.map',
    });
    await run(db, fetcherFor(db, fetch), [`${ORIGIN}/a.js`]);
    expect(await job(db, 'map', 'https://maps.cdn.net/a.js.map')).toMatchObject({
      state: 'skipped',
      skipReason: 'third-party',
    });
    expect(calls).toHaveLength(1);
  });

  it('probes <script>.map only when the site setting is on', async () => {
    const off = await setup();
    const routesOff = router({ [`${ORIGIN}/a.js?v=1`]: 'x' });
    await run(off, fetcherFor(off, routesOff.fetch), [`${ORIGIN}/a.js?v=1`]);
    expect(routesOff.calls).toHaveLength(1);
    expect(await off.count('jobs')).toBe(1);

    const on = await setup({ settings: { aggressiveMapProbing: true, useCredentials: false } });
    const routesOn = router({
      [`${ORIGIN}/a.js?v=1`]: 'x',
      [`${ORIGIN}/b.js`]: 'y',
      [`${ORIGIN}/b.js.map`]: '{"mappings":""}',
    });
    await run(on, fetcherFor(on, routesOn.fetch), [`${ORIGIN}/a.js?v=1`, `${ORIGIN}/b.js`]);
    expect(await job(on, 'map', `${ORIGIN}/a.js.map`)).toMatchObject({
      state: 'skipped',
      skipReason: 'not-found',
      via: 'probe',
    });
    expect(await job(on, 'map', `${ORIGIN}/b.js.map`)).toMatchObject({
      state: 'fetched',
      via: 'probe',
    });
  });

  it('rejects map responses that are not source maps', async () => {
    const db = await setup({ settings: { aggressiveMapProbing: true, useCredentials: false } });
    const { fetch } = router({
      [`${ORIGIN}/a.js`]: 'x',
      [`${ORIGIN}/a.js.map`]: '<!doctype html>',
    });
    await run(db, fetcherFor(db, fetch), [`${ORIGIN}/a.js`]);
    expect(await job(db, 'map', `${ORIGIN}/a.js.map`)).toMatchObject({
      state: 'skipped',
      skipReason: 'not-a-map',
    });
    expect(await db.count('blobs')).toBe(1);
  });

  it('skips responses over the size limit, declared or streamed', async () => {
    const db = await setup();
    const big = 'x'.repeat(2_000);
    const stream = () =>
      new Response(
        new ReadableStream({
          start(controller) {
            for (let i = 0; i < 4; i++) controller.enqueue(new TextEncoder().encode(big));
            controller.close();
          },
        }),
      );
    const { fetch } = router({
      [`${ORIGIN}/declared.js`]: new Response(big, {
        headers: { 'Content-Length': String(big.length) },
      }),
      [`${ORIGIN}/streamed.js`]: stream,
    });
    await run(db, fetcherFor(db, fetch, { maxScriptBytes: 1_000 }), [
      `${ORIGIN}/declared.js`,
      `${ORIGIN}/streamed.js`,
    ]);
    for (const name of ['declared', 'streamed']) {
      expect(await job(db, 'script', `${ORIGIN}/${name}.js`)).toMatchObject({
        state: 'skipped',
        skipReason: 'too-large',
      });
    }
    expect(await db.count('blobs')).toBe(0);
  });

  it('aborts after the timeout and requeues with backoff', async () => {
    const db = await setup();
    const hang = (init?: RequestInit) =>
      new Promise<Response>((_, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
      });
    const { fetch } = router({ [`${ORIGIN}/slow.js`]: hang });
    const schedule = vi.fn();
    const now = 1_000_000;
    await run(db, fetcherFor(db, fetch, { timeoutMs: 30, now: () => now, schedule }), [
      `${ORIGIN}/slow.js`,
    ]);
    expect(await job(db, 'script', `${ORIGIN}/slow.js`)).toMatchObject({
      state: 'queued',
      attempts: 1,
      leasedUntil: now + 2_000,
      error: 'timeout after 30 ms',
    });
    expect(schedule).toHaveBeenCalledWith(expect.any(Function), 2_000);
  });

  it('fails permanently after the last attempt and on 4xx', async () => {
    const db = await setup();
    const { fetch } = router({ [`${ORIGIN}/gone.js`]: new Response('', { status: 403 }) });
    await run(db, fetcherFor(db, fetch), [`${ORIGIN}/gone.js`]);
    expect(await job(db, 'script', `${ORIGIN}/gone.js`)).toMatchObject({
      state: 'failed',
      error: 'HTTP 403',
    });

    const db2 = await setup();
    await db2.put('jobs', {
      id: jobId('script', `${ORIGIN}/down.js`),
      kind: 'script',
      url: `${ORIGIN}/down.js`,
      origin: ORIGIN,
      state: 'queued',
      attempts: 2,
      leasedUntil: 0,
      createdAt: 0,
      updatedAt: 0,
    });
    const down = router({ [`${ORIGIN}/down.js`]: new Response('', { status: 503 }) });
    const fetcher = fetcherFor(db2, down.fetch);
    await fetcher.pump();
    await fetcher.idle();
    expect(await job(db2, 'script', `${ORIGIN}/down.js`)).toMatchObject({
      state: 'failed',
      attempts: 3,
      error: 'HTTP 503',
    });
  });

  it('runs at most 4 requests per origin at once', async () => {
    const db = await setup({ origin: ORIGIN, scope: 'subdomains' });
    let active: Record<string, number> = {};
    const peak: Record<string, number> = {};
    const slow = (host: string) => async () => {
      active[host] = (active[host] ?? 0) + 1;
      peak[host] = Math.max(peak[host] ?? 0, active[host] ?? 0);
      await new Promise((resolve) => setTimeout(resolve, 15));
      active[host] = (active[host] ?? 1) - 1;
      return new Response(`${host}${Math.random()}`);
    };
    const routes: Record<string, Route> = {};
    const urls: string[] = [];
    for (let i = 0; i < 10; i++) {
      for (const host of ['example.com', 'static.example.com']) {
        const url = `https://${host}/c${i}.js`;
        routes[url] = slow(host);
        urls.push(url);
      }
    }
    const { fetch } = router(routes);
    active = {};
    await run(db, fetcherFor(db, fetch), urls);
    expect(peak['example.com']).toBe(4);
    expect(peak['static.example.com']).toBe(4);
    const jobs = await db.getAll('jobs');
    expect(jobs.filter((j) => j.state === 'fetched')).toHaveLength(20);
  });

  it('skips redirects that leave the site and jobs of disabled sites', async () => {
    const db = await setup();
    const redirected = new Response('evil');
    Object.defineProperty(redirected, 'url', { value: 'https://evil.net/x.js' });
    const { fetch } = router({ [`${ORIGIN}/r.js`]: () => redirected });
    await run(db, fetcherFor(db, fetch), [`${ORIGIN}/r.js`]);
    expect(await job(db, 'script', `${ORIGIN}/r.js`)).toMatchObject({
      state: 'skipped',
      skipReason: 'third-party',
    });
    expect(await db.count('blobs')).toBe(0);

    await enqueueDiscovered(db, `${ORIGIN}/`, [`${ORIGIN}/late.js`]);
    await db.delete('sites', ORIGIN);
    const fetcher = fetcherFor(db, fetch);
    await fetcher.pump();
    await fetcher.idle();
    expect(await job(db, 'script', `${ORIGIN}/late.js`)).toMatchObject({
      state: 'skipped',
      skipReason: 'site-disabled',
    });
  });

  it('sends cookies only when the site opted in and only to its own origin', async () => {
    const db = await setup({
      scope: 'subdomains',
      settings: { aggressiveMapProbing: false, useCredentials: true },
    });
    const { fetch, calls } = router({
      [`${ORIGIN}/a.js`]: 'a',
      ['https://cdn.example.com/b.js']: 'b',
    });
    await run(db, fetcherFor(db, fetch), [`${ORIGIN}/a.js`, 'https://cdn.example.com/b.js']);
    const byUrl = Object.fromEntries(calls.map((c) => [c.url, c.init?.credentials]));
    expect(byUrl).toEqual({
      [`${ORIGIN}/a.js`]: 'include',
      'https://cdn.example.com/b.js': 'omit',
    });
  });
});
