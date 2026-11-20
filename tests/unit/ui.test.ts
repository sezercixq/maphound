import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { JobRecord, MapRecord, ScriptRecord } from '@/core/db';
import {
  CONFIDENCE_KEYS,
  fileName,
  formatBytes,
  hostOf,
  SEVERITY_KEYS,
  statusOf,
  THIRD_PARTY_KEYS,
  VIA_KEYS,
} from '@/ui/format';
import { buildViewModel } from '@/ui/view-model';

const job = (over: Partial<JobRecord>): JobRecord => ({
  id: over.url ?? 'x',
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

describe('format', () => {
  it('formats sizes', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(1536)).toBe('1.5 KB');
    expect(formatBytes(25 * 1024 * 1024)).toBe('25 MB');
    expect(formatBytes(-1)).toBe('–');
  });
  it('shortens URLs', () => {
    expect(fileName('https://e.com/static/js/main.abc.js')).toBe('main.abc.js');
    expect(fileName('https://e.com/a.js?v=1')).toBe('a.js?v=1');
    expect(fileName('https://e.com/a.js?version=1234567890')).toBe('a.js?version=1…');
    expect(fileName('https://e.com/a.js#inline-map')).toBe('a.js');
    expect(fileName('https://e.com/')).toBe('e.com');
    expect(hostOf('http://127.0.0.1:8080/x')).toBe('127.0.0.1:8080');
  });
  it('labels job states', () => {
    expect(statusOf(job({ state: 'fetched' }))).toEqual({ key: 'stateScanning', tone: 'busy' });
    expect(statusOf(job({ state: 'fetched', kind: 'map' }))).toEqual({
      key: 'stateScanning',
      tone: 'busy',
    });
    expect(statusOf(job({ state: 'skipped', skipReason: 'third-party' }))).toEqual({
      key: 'skipThirdParty',
      tone: 'warn',
    });
    expect(statusOf(job({ state: 'skipped', skipReason: 'not-found' }))).toEqual({
      key: 'skipNotFound',
      tone: 'muted',
    });
    expect(statusOf(job({ state: 'failed' })).tone).toBe('error');
  });
});

describe('buildViewModel', () => {
  it('joins jobs, scripts and maps into rows and stats', () => {
    const jobs = [
      job({
        url: 'https://cdn.io/gtm.js',
        state: 'skipped',
        skipReason: 'third-party',
        thirdParty: 'analytics',
        createdAt: 1,
      }),
      job({ url: 'https://example.com/b.js', state: 'fetched', hash: 'sb', createdAt: 3 }),
      job({ url: 'https://example.com/a.js', state: 'fetched', hash: 'sa', createdAt: 2 }),
      job({
        url: 'https://example.com/a.js.map',
        id: 'map-a',
        kind: 'map',
        state: 'done',
        parentHash: 'sa',
        hash: 'ma',
        createdAt: 4,
      }),
      job({
        url: 'https://example.com/b.js.map',
        id: 'map-b',
        kind: 'map',
        state: 'queued',
        parentHash: 'sb',
        createdAt: 5,
      }),
    ];
    const scripts = [{ hash: 'sa', size: 2048 } as ScriptRecord];
    const maps = [{ id: 'map-a', withContent: 12 } as MapRecord];
    const vm = buildViewModel(jobs, scripts, maps);
    expect(vm.scripts.map((r) => [r.name, r.size, r.thirdParty, r.maps.map((m) => m.id)])).toEqual([
      ['a.js', 2048, false, ['map-a']],
      ['b.js', null, false, ['map-b']],
      ['gtm.js', null, true, []],
    ]);
    expect(vm.maps.map((r) => [r.name, r.record?.withContent ?? null])).toEqual([
      ['a.js.map', 12],
      ['b.js.map', null],
    ]);
    expect(vm.stats).toEqual({ scripts: 2, thirdParty: 1, maps: 1, files: 12, exportable: true });
    expect(vm.scanning).toBe(true);
  });

  it('is not exportable without source content', () => {
    expect(
      buildViewModel([], [], [{ id: 'm', withContent: 0 } as MapRecord]).stats.exportable,
    ).toBe(false);
  });
});

describe('locales', () => {
  const load = (lang: string) =>
    JSON.parse(readFileSync(`public/_locales/${lang}/messages.json`, 'utf8')) as Record<
      string,
      { message: string }
    >;
  const placeholders = (text: string) => (text.match(/\$\d/g) ?? []).sort();

  it('has the same keys and placeholders in every language', () => {
    const en = load('en');
    const tr = load('tr');
    expect(Object.keys(tr).sort()).toEqual(Object.keys(en).sort());
    for (const key of Object.keys(en)) {
      expect(placeholders(tr[key]?.message ?? ''), key).toEqual(
        placeholders(en[key]?.message ?? ''),
      );
    }
    expect(tr.downloadZip?.message).toBe('Kaynak Kodları İndir (ZIP)');
  });

  it('defines every key the UI uses', () => {
    const en = load('en');
    const used = new Set<string>();
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = `${dir}/${entry.name}`;
        if (entry.isDirectory()) walk(path);
        else
          for (const match of readFileSync(path, 'utf8').matchAll(/\bt\(\s*'([A-Za-z]+)'/g))
            used.add(match[1] as string);
      }
    };
    walk('src/ui');
    for (const map of [THIRD_PARTY_KEYS, VIA_KEYS, SEVERITY_KEYS, CONFIDENCE_KEYS])
      for (const key of Object.values(map)) used.add(key);
    for (const state of ['queued', 'fetching', 'fetched', 'scanning', 'done', 'failed'] as const) {
      used.add(statusOf(job({ state })).key);
      used.add(statusOf(job({ state, kind: 'map' })).key);
    }
    for (const reason of [
      'third-party',
      'too-large',
      'not-found',
      'not-a-map',
      'unsupported-url',
      'site-disabled',
    ] as const) {
      used.add(statusOf(job({ state: 'skipped', skipReason: reason })).key);
    }
    expect(used.size).toBeGreaterThan(30);
    for (const key of used) expect(Object.keys(en), key).toContain(key);
  });
});
