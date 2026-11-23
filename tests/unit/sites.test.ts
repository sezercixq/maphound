import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

interface Registered {
  id: string;
  matches?: string[];
  js?: string[];
  world?: string;
  runAt?: string;
  persistAcrossSessions?: boolean;
}

const state = {
  granted: new Set<string>(),
  registered: new Map<string, Registered>(),
  tabs: [] as { id?: number; url: string }[],
  injected: [] as number[],
};

const browserMock = {
  permissions: {
    contains: vi.fn(async ({ origins }: { origins: string[] }) =>
      origins.every((o) => state.granted.has(o)),
    ),
    remove: vi.fn(async ({ origins }: { origins: string[] }) => {
      for (const o of origins) state.granted.delete(o);
      return true;
    }),
    request: vi.fn(),
  },
  scripting: {
    registerContentScripts: vi.fn(async (scripts: Registered[]) => {
      for (const s of scripts) {
        if (state.registered.has(s.id)) throw new Error(`Duplicate script ID '${s.id}'`);
        state.registered.set(s.id, s);
      }
    }),
    unregisterContentScripts: vi.fn(async ({ ids }: { ids: string[] }) => {
      for (const id of ids) state.registered.delete(id);
    }),
    getRegisteredContentScripts: vi.fn(async (filter?: { ids?: string[] }) =>
      [...state.registered.values()].filter((s) => !filter?.ids || filter.ids.includes(s.id)),
    ),
    executeScript: vi.fn(async ({ target }: { target: { tabId: number } }) => {
      if (target.tabId === 99) throw new Error('Cannot access contents of the page');
      state.injected.push(target.tabId);
      return [];
    }),
  },
  tabs: {
    query: vi.fn(async ({ url }: { url?: string[] }) =>
      state.tabs.filter((t) =>
        (url ?? []).some((pattern) => {
          const re = new RegExp(`^${pattern.replace(/[.]/g, '\\.').replace(/\*/g, '.*')}$`);
          const parsed = new URL(t.url);
          return re.test(`${parsed.protocol}//${parsed.hostname}${parsed.pathname}`);
        }),
      ),
    ),
  },
};

vi.mock('wxt/browser', () => ({ browser: browserMock }));

const { openMaphoundDb } = await import('@/core/db');
const { collectorScriptId, COLLECTOR_FILE } = await import('@/core/permissions');
const { addExtraOrigins, disableSite, enableSite, removeExtraOrigin, syncSites } = await import(
  '@/core/sites'
);

let counter = 0;
const freshDb = () => openMaphoundDb(`sites-${counter++}`);

beforeEach(() => {
  state.granted.clear();
  state.registered.clear();
  state.tabs = [];
  state.injected = [];
  vi.clearAllMocks();
});

describe('enableSite', () => {
  it('refuses without host permission and registers nothing', async () => {
    const db = await freshDb();
    expect(await enableSite('https://example.com', 'origin', db)).toEqual({
      ok: false,
      reason: 'permission-missing',
    });
    expect(state.registered.size).toBe(0);
    expect(await db.count('sites')).toBe(0);
  });

  it('rejects invalid origins', async () => {
    expect(await enableSite('chrome://settings', 'origin', await freshDb())).toEqual({
      ok: false,
      reason: 'invalid-origin',
    });
  });

  it('stores the site, registers the collector and injects into open tabs', async () => {
    const db = await freshDb();
    state.granted.add('https://*.example.com/*');
    state.tabs = [
      { id: 1, url: 'https://app.example.com/dash' },
      { id: 2, url: 'https://other.com/' },
      { id: 99, url: 'https://example.com/crashed' },
    ];
    const result = await enableSite('https://www.example.com/page', 'subdomains', db);
    expect(result).toEqual({ ok: true, injected: 1 });
    expect(state.injected).toEqual([1]);
    expect(await db.get('sites', 'https://www.example.com')).toMatchObject({
      scope: 'subdomains',
      settings: { aggressiveMapProbing: false, useCredentials: false },
    });
    expect(state.registered.get(collectorScriptId('https://www.example.com'))).toEqual({
      id: collectorScriptId('https://www.example.com'),
      matches: ['https://*.example.com/*'],
      js: [COLLECTOR_FILE],
      runAt: 'document_idle',
      world: 'ISOLATED',
      allFrames: false,
      persistAcrossSessions: true,
    });
  });

  it('is idempotent and keeps settings on re-enable', async () => {
    const db = await freshDb();
    state.granted.add('https://example.com/*');
    await enableSite('https://example.com', 'origin', db);
    const site = await db.get('sites', 'https://example.com');
    if (!site) throw new Error('missing site');
    await db.put('sites', { ...site, settings: { ...site.settings, aggressiveMapProbing: true } });
    expect((await enableSite('https://example.com', 'origin', db)).ok).toBe(true);
    expect(state.registered.size).toBe(1);
    expect((await db.get('sites', 'https://example.com'))?.settings.aggressiveMapProbing).toBe(
      true,
    );
  });
});

describe('collectorScriptId', () => {
  it('is distinct per origin and never starts with an underscore', () => {
    const a = collectorScriptId('http://localhost:3000');
    expect(a).not.toBe(collectorScriptId('http://localhost:4000'));
    expect(a.startsWith('_')).toBe(false);
  });
});

describe('disableSite', () => {
  it('unregisters, revokes unshared patterns and optionally purges', async () => {
    const db = await freshDb();
    state.granted.add('http://localhost/*');
    await enableSite('http://localhost:3000', 'origin', db);
    await enableSite('http://localhost:4000', 'origin', db);
    await db.put('jobs', {
      id: 'j',
      kind: 'script',
      url: 'http://localhost:3000/a.js',
      origin: 'http://localhost:3000',
      state: 'queued',
      attempts: 0,
      leasedUntil: 0,
      createdAt: 0,
      updatedAt: 0,
    });

    await db.put('intel', {
      id: 'http://localhost:3000|s1',
      origin: 'http://localhost:3000',
      scriptHash: 's1',
      scriptUrl: 'http://localhost:3000/a.js',
      endpoints: [],
      routes: [],
      comments: [],
      sinks: [],
      truncated: false,
      updatedAt: 0,
    });
    await db.put('pages', {
      id: 'http://localhost:3000|/',
      origin: 'http://localhost:3000',
      pageUrl: 'http://localhost:3000/',
      nextData: {
        bytes: 10,
        query: {},
        dataFetching: [],
        hasRuntimeConfig: false,
        pageProps: [],
        keyCount: 0,
        sensitive: [],
        outline: [],
        endpoints: [],
      },
      updatedAt: 0,
    });

    await db.put('audits', {
      id: 'http://localhost:3000|/',
      origin: 'http://localhost:3000',
      pageUrl: 'http://localhost:3000/',
      headers: {},
      matrix: [],
      findings: [],
      storageKeysChecked: 0,
      cookiesChecked: 0,
      updatedAt: 0,
    });
    await db.put('snapshots', {
      id: 'http://localhost:3000|1',
      origin: 'http://localhost:3000',
      createdAt: 1,
      signature: 'sig',
      scriptHashes: [],
      files: [],
      endpoints: [],
      routes: [],
      findings: [],
      sinks: [],
    });

    expect((await disableSite('http://localhost:3000', true, db)).revoked).toEqual([]);
    expect(state.granted.has('http://localhost/*')).toBe(true);
    expect(await db.count('jobs')).toBe(0);
    expect(await db.count('intel')).toBe(0);
    expect(await db.count('pages')).toBe(0);
    expect(await db.count('audits')).toBe(0);
    expect(await db.count('snapshots')).toBe(0);
    expect(state.registered.has(collectorScriptId('http://localhost:3000'))).toBe(false);

    expect((await disableSite('http://localhost:4000', false, db)).revoked).toEqual([
      'http://localhost/*',
    ]);
    expect(state.granted.size).toBe(0);
    expect(state.registered.size).toBe(0);
  });
});

describe('syncSites', () => {
  it('disables sites whose permission was revoked and repairs registrations', async () => {
    const db = await freshDb();
    state.granted.add('https://a.com/*');
    state.granted.add('https://b.com/*');
    await enableSite('https://a.com', 'origin', db);
    await enableSite('https://b.com', 'origin', db);

    state.granted.delete('https://a.com/*'); // revoked in chrome://extensions
    state.registered.delete(collectorScriptId('https://b.com')); // lost on update
    state.registered.set('mh-collector-stale', { id: 'mh-collector-stale' });
    state.registered.set('someone-else', { id: 'someone-else' });

    expect(await syncSites(db)).toEqual({ disabled: ['https://a.com'] });
    expect(await db.get('sites', 'https://a.com')).toBeUndefined();
    expect([...state.registered.keys()].sort()).toEqual(
      [collectorScriptId('https://b.com'), 'someone-else'].sort(),
    );
  });
});

describe('disableSite with a required permission', () => {
  it('still disables and purges when Chrome refuses to revoke', async () => {
    const db = await freshDb();
    state.granted.add('https://req.com/*');
    await enableSite('https://req.com', 'origin', db);
    browserMock.permissions.remove.mockRejectedValueOnce(
      new Error('You cannot remove required permissions.'),
    );
    expect(await disableSite('https://req.com', true, db)).toEqual({ ok: true, revoked: [] });
    expect(await db.count('sites')).toBe(0);
    expect(state.registered.size).toBe(0);
  });
});

describe('extra origins', () => {
  async function enabled() {
    const db = await freshDb();
    state.granted.add('https://*.airbnb.com.tr/*');
    await enableSite('https://www.airbnb.com.tr', 'subdomains', db);
    const skipped = (url: string, kind: 'script' | 'map' = 'script') => ({
      id: `${kind}:${url}`,
      kind,
      url,
      origin: 'https://www.airbnb.com.tr',
      state: 'skipped' as const,
      skipReason: 'third-party' as const,
      thirdParty: 'other' as const,
      attempts: 0,
      leasedUntil: 0,
      createdAt: 0,
      updatedAt: 0,
    });
    for (const url of [
      'https://a0.muscache.com/a.js',
      'https://a0.muscache.com/b.js',
      'https://d0a7e.airbnb.com/c.js',
    ]) {
      await db.put('jobs', skipped(url));
    }
    await db.put('jobs', skipped('https://a0.muscache.com/a.js.map', 'map'));
    await db.put('jobs', skipped('https://www.googletagmanager.com/gtm.js'));
    return db;
  }

  it('refuses origins without host permission', async () => {
    const db = await enabled();
    expect(
      await addExtraOrigins('https://www.airbnb.com.tr', ['https://a0.muscache.com'], db),
    ).toEqual({
      ok: false,
      reason: 'permission-missing',
    });
    expect((await db.get('sites', 'https://www.airbnb.com.tr'))?.extraOrigins).toEqual([]);
  });

  it('adds granted origins in bulk and requeues their scripts and maps', async () => {
    const db = await enabled();
    state.granted.add('https://a0.muscache.com/*');
    state.granted.add('https://d0a7e.airbnb.com/*');
    const result = await addExtraOrigins(
      'https://www.airbnb.com.tr',
      [
        'https://a0.muscache.com/some/path',
        'https://d0a7e.airbnb.com',
        'https://static.airbnb.com.tr',
      ],
      db,
    );
    expect(result).toEqual({
      ok: true,
      added: ['https://a0.muscache.com', 'https://d0a7e.airbnb.com'],
      requeued: 4,
    });
    expect((await db.get('sites', 'https://www.airbnb.com.tr'))?.extraOrigins).toEqual([
      'https://a0.muscache.com',
      'https://d0a7e.airbnb.com',
    ]);
    const requeued = await db.get('jobs', 'map:https://a0.muscache.com/a.js.map');
    expect(requeued).toMatchObject({ state: 'queued', attempts: 0 });
    expect(requeued?.skipReason).toBeUndefined();
    expect((await db.get('jobs', 'script:https://www.googletagmanager.com/gtm.js'))?.state).toBe(
      'skipped',
    );
    expect(await addExtraOrigins('https://nope.example', ['https://a0.muscache.com'], db)).toEqual({
      ok: false,
      reason: 'site-not-enabled',
    });
  });

  it('removes one origin and revokes its pattern', async () => {
    const db = await enabled();
    state.granted.add('https://a0.muscache.com/*');
    await addExtraOrigins('https://www.airbnb.com.tr', ['https://a0.muscache.com'], db);
    expect(
      await removeExtraOrigin('https://www.airbnb.com.tr', 'https://a0.muscache.com', db),
    ).toEqual({
      ok: true,
      revoked: ['https://a0.muscache.com/*'],
    });
    expect(state.granted.has('https://a0.muscache.com/*')).toBe(false);
    expect((await db.get('sites', 'https://www.airbnb.com.tr'))?.extraOrigins).toEqual([]);
    expect(
      (await removeExtraOrigin('https://www.airbnb.com.tr', 'https://a0.muscache.com', db)).ok,
    ).toBe(false);
  });

  it('revokes every extra origin when the site is disabled', async () => {
    const db = await enabled();
    state.granted.add('https://a0.muscache.com/*');
    state.granted.add('https://d0a7e.airbnb.com/*');
    await addExtraOrigins(
      'https://www.airbnb.com.tr',
      ['https://a0.muscache.com', 'https://d0a7e.airbnb.com'],
      db,
    );
    const { revoked } = await disableSite('https://www.airbnb.com.tr', true, db);
    expect(revoked.sort()).toEqual([
      'https://*.airbnb.com.tr/*',
      'https://a0.muscache.com/*',
      'https://d0a7e.airbnb.com/*',
    ]);
    expect(state.granted.size).toBe(0);
    expect(await db.count('jobs')).toBe(0);
  });

  it('keeps extra origins on re-enable and drops those revoked in Chrome', async () => {
    const db = await enabled();
    state.granted.add('https://a0.muscache.com/*');
    state.granted.add('https://d0a7e.airbnb.com/*');
    await addExtraOrigins(
      'https://www.airbnb.com.tr',
      ['https://a0.muscache.com', 'https://d0a7e.airbnb.com'],
      db,
    );
    await enableSite('https://www.airbnb.com.tr', 'subdomains', db);
    expect((await db.get('sites', 'https://www.airbnb.com.tr'))?.extraOrigins).toHaveLength(2);
    state.granted.delete('https://a0.muscache.com/*');
    expect(await syncSites(db)).toEqual({ disabled: [] });
    expect((await db.get('sites', 'https://www.airbnb.com.tr'))?.extraOrigins).toEqual([
      'https://d0a7e.airbnb.com',
    ]);
  });
});
