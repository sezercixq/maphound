import { type BrowserContext, expect, test } from '@playwright/test';
import {
  hook,
  jobsByUrl,
  launch,
  leaks,
  serviceWorker,
  startServer,
  type TestServer,
} from './fixtures';

let context: BrowserContext;
let server: TestServer;

test.beforeAll(async () => {
  server = await startServer();
  context = await launch();
});

test.afterAll(async () => {
  await context?.close();
  server?.close();
});

test('enable site, collect scripts and lazy chunks, discover and analyse maps', async () => {
  const { base, thirdPartyBase } = server;
  const sw = await serviceWorker(context);
  const page = await context.newPage();
  await page.goto(`${base}/index.html`);

  // Enabled after the page loaded: the collector must arrive via executeScript.
  const enabled = await hook<{ ok: boolean; injected: number }>(
    sw,
    '__mhEnableSite',
    `${base}/`,
    'origin',
  );
  expect(enabled).toEqual({ ok: true, injected: 1 });

  const pick = (
    job: { state: string; via?: string; skipReason?: string } | undefined,
    field: 'via' | 'skipReason',
  ) => job && [job.state, job[field]];
  await expect
    .poll(
      async () => {
        const jobs = await jobsByUrl(sw);
        return {
          app: jobs[`${base}/app.js`]?.state,
          appMap: pick(jobs[`${base}/app.js.map`], 'via'),
          thirdParty: pick(jobs[`${thirdPartyBase}/tp.js`], 'skipReason'),
          chunk: jobs[`${base}/chunk.js`]?.state,
          chunkMap: pick(jobs[`${base}/chunk.js#inline-map`], 'via'),
          lazy: jobs[`${base}/lazy.mjs`]?.state,
          lazyMap: pick(jobs[`${base}/maps/lazy.mjs.map`], 'via'),
        };
      },
      { timeout: 20_000, intervals: [250] },
    )
    .toEqual({
      app: 'done',
      appMap: ['done', 'comment'],
      thirdParty: ['skipped', 'third-party'],
      chunk: 'done',
      chunkMap: ['done', 'data-uri'],
      lazy: 'done',
      lazyMap: ['done', 'header'],
    });

  // The offscreen worker parsed each map and stored its file index.
  const maps = await hook<
    {
      url: string;
      fileCount: number;
      withContent: number;
      vendorCount: number;
      files: { path: string }[];
    }[]
  >(sw, '__mhMaps');
  expect(maps).toHaveLength(3);
  for (const map of maps) {
    expect(map).toMatchObject({ fileCount: 3, withContent: 3, vendorCount: 1 });
    expect(map.files.map((f) => f.path)).toEqual(
      expect.arrayContaining(['src/evil/escape.txt', '_vendor/lib/index.js']),
    );
  }
  expect(await hook<string[]>(sw, '__mhRegistered')).toHaveLength(1);

  // Secret scan: original source location, bundle-only inlined value, public key as info.
  type Finding = {
    ruleId: string;
    severity: string;
    confidence: string;
    file: string;
    line: number;
    locationKind: string;
    secret: string;
  };
  const findings = await hook<Finding[]>(sw, '__mhFindings');
  const summary = findings
    .map((f) => [f.ruleId, f.severity, f.confidence, f.file, f.line, f.locationKind])
    .sort((a, b) => String(a[0]).localeCompare(String(b[0])));
  expect(summary).toEqual([
    ['gcp-api-key', 'info', 'high', 'app.js', 5, 'bundle'],
    ['github-classic-pat', 'critical', 'verified-format', 'src/src/app.js.ts', 2, 'source'],
    ['stripe-live-secret-key', 'critical', 'high', 'app.js', 2, 'bundle'],
  ]);
  const secrets = findings.map((f) => f.secret);
  expect(secrets).toEqual(expect.arrayContaining([leaks.github, leaks.stripe, leaks.firebase]));
  expect(secrets).not.toContain(leaks.ignored);
  expect(secrets).not.toContain(leaks.thirdParty);
});

test('registered collector runs on new navigations; disable purges', async () => {
  const { base } = server;
  const sw = await serviceWorker(context);
  const page = await context.newPage();
  await page.goto(`${base}/second.html`);
  await expect
    .poll(async () => (await jobsByUrl(sw))[`${base}/second.js`]?.state, {
      timeout: 15_000,
      intervals: [250],
    })
    .toBe('done');

  const disabled = await hook<{ ok: boolean }>(sw, '__mhDisableSite', base, true);
  expect(disabled.ok).toBe(true);
  expect(await hook<string[]>(sw, '__mhRegistered')).toEqual([]);
  expect(Object.keys(await jobsByUrl(sw))).toEqual([]);
  expect(await hook<unknown[]>(sw, '__mhMaps')).toEqual([]);
  expect(await hook<unknown[]>(sw, '__mhFindings')).toEqual([]);
});
