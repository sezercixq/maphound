import { mkdtempSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { type BrowserContext, chromium, expect, test, type Worker } from '@playwright/test';

// Requires an e2e build (VITE_MH_E2E=1 pnpm build), which pre-grants http://127.0.0.1/*.
const extensionPath = resolve('.output/chrome-mv3');

interface Job {
  id: string;
  kind: 'script' | 'map';
  url: string;
  state: string;
  skipReason?: string;
  thirdParty?: string;
  via?: string;
  hash?: string;
}

let context: BrowserContext;
let server: Server;
let base: string;
let thirdPartyBase: string;

const map = (file: string) =>
  JSON.stringify({ version: 3, file, sources: [`src/${file}.ts`], mappings: 'AAAA' });
const inline = Buffer.from(map('chunk.js')).toString('base64');

function serve(): Promise<void> {
  server = createServer((req, res) => {
    const path = new URL(req.url ?? '/', 'http://x').pathname;
    const js = (body: string, headers: Record<string, string> = {}) => {
      res.writeHead(200, { 'Content-Type': 'text/javascript', ...headers });
      res.end(body);
    };
    const html = (body: string) => {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(`<!doctype html><html><body>${body}</body></html>`);
    };
    switch (path) {
      case '/index.html':
        return html(
          `<script src="/app.js"></script><script src="${thirdPartyBase}/tp.js"></script>` +
            `<script>setTimeout(() => { const s = document.createElement('script'); s.src = '/chunk.js'; document.body.append(s); import('/lazy.mjs'); }, 2500);</script>`,
        );
      case '/second.html':
        return html('<script src="/second.js"></script>');
      case '/app.js':
        return js("console.log('app');\n//# sourceMappingURL=app.js.map\n");
      case '/app.js.map':
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(map('app.js'));
      case '/chunk.js':
        return js(
          `console.log('chunk');\n//# sourceMappingURL=data:application/json;base64,${inline}`,
        );
      case '/lazy.mjs':
        return js("console.log('lazy');\n", { SourceMap: '/maps/lazy.mjs.map' });
      case '/maps/lazy.mjs.map':
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(map('lazy.mjs'));
      case '/second.js':
        return js("console.log('second');\n");
      case '/tp.js':
        return js("console.log('third party');\n");
      default:
        res.writeHead(404);
        return res.end();
    }
  });
  return new Promise((done) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      base = `http://127.0.0.1:${port}`;
      thirdPartyBase = `http://localhost:${port}`;
      done();
    });
  });
}

test.beforeAll(async () => {
  await serve();
  context = await chromium.launchPersistentContext(
    join(mkdtempSync(join(tmpdir(), 'mh-')), 'profile'),
    {
      headless: false,
      args: [
        '--headless=new',
        `--disable-extensions-except=${extensionPath}`,
        `--load-extension=${extensionPath}`,
      ],
    },
  );
});

test.afterAll(async () => {
  await context?.close();
  server?.close();
});

async function serviceWorker(): Promise<Worker> {
  const [existing] = context.serviceWorkers();
  return existing ?? (await context.waitForEvent('serviceworker'));
}

const hook = <T>(sw: Worker, name: string, ...args: unknown[]) =>
  sw.evaluate(
    ([fn, rest]) =>
      (globalThis as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>)[
        fn as string
      ]?.(...(rest as unknown[])),
    [name, args] as const,
  ) as Promise<T>;

async function jobsByUrl(sw: Worker): Promise<Record<string, Job>> {
  const jobs = await hook<Job[]>(sw, '__mhJobs');
  return Object.fromEntries(jobs.map((job) => [job.url, job]));
}

test('enable site, collect scripts and lazy chunks, discover maps', async () => {
  const sw = await serviceWorker();
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

  await expect
    .poll(
      async () => {
        const jobs = await jobsByUrl(sw);
        return {
          app: jobs[`${base}/app.js`]?.state,
          appMap: jobs[`${base}/app.js.map`] && [
            jobs[`${base}/app.js.map`]?.state,
            jobs[`${base}/app.js.map`]?.via,
          ],
          thirdParty: jobs[`${thirdPartyBase}/tp.js`] && [
            jobs[`${thirdPartyBase}/tp.js`]?.state,
            jobs[`${thirdPartyBase}/tp.js`]?.skipReason,
          ],
          chunk: jobs[`${base}/chunk.js`]?.state,
          chunkMap: jobs[`${base}/chunk.js#inline-map`]?.via,
          lazy: jobs[`${base}/lazy.mjs`]?.state,
          lazyMap: jobs[`${base}/maps/lazy.mjs.map`] && [
            jobs[`${base}/maps/lazy.mjs.map`]?.state,
            jobs[`${base}/maps/lazy.mjs.map`]?.via,
          ],
        };
      },
      { timeout: 20_000, intervals: [250] },
    )
    .toEqual({
      app: 'fetched',
      appMap: ['fetched', 'comment'],
      thirdParty: ['skipped', 'third-party'],
      chunk: 'fetched',
      chunkMap: 'data-uri',
      lazy: 'fetched',
      lazyMap: ['fetched', 'header'],
    });

  const registered = await hook<string[]>(sw, '__mhRegistered');
  expect(registered).toHaveLength(1);
});

test('registered collector runs on new navigations; disable purges', async () => {
  const sw = await serviceWorker();
  const page = await context.newPage();
  await page.goto(`${base}/second.html`);
  await expect
    .poll(async () => (await jobsByUrl(sw))[`${base}/second.js`]?.state, {
      timeout: 15_000,
      intervals: [250],
    })
    .toBe('fetched');

  const disabled = await hook<{ ok: boolean }>(sw, '__mhDisableSite', base, true);
  expect(disabled.ok).toBe(true);
  expect(await hook<string[]>(sw, '__mhRegistered')).toEqual([]);
  expect(Object.keys(await jobsByUrl(sw))).toEqual([]);
});
