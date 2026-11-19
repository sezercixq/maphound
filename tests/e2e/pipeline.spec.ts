import { createHash } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { type BrowserContext, chromium, expect, test } from '@playwright/test';

// Requires an e2e build: VITE_MH_E2E=1 pnpm build
const extensionPath = resolve('.output/chrome-mv3');

let context: BrowserContext;

test.beforeAll(async () => {
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
  await context.close();
});

async function serviceWorker() {
  const [existing] = context.serviceWorkers();
  return existing ?? (await context.waitForEvent('serviceworker'));
}

test('background -> offscreen -> worker round trip', async () => {
  const sw = await serviceWorker();
  const result = await sw.evaluate(() =>
    (globalThis as unknown as { __mhPing: (t: string) => Promise<unknown> }).__mhPing('hello'),
  );
  expect(result).toEqual({ echo: 'hello', via: ['background', 'offscreen', 'worker'] });
});

test('worker reads a blob from IndexedDB and hashes it', async () => {
  const sw = await serviceWorker();
  const text = 'hello maphound';
  const result = (await sw.evaluate(
    (t) => (globalThis as unknown as { __mhScan: (t: string) => Promise<unknown> }).__mhScan(t),
    text,
  )) as { jobId: string; bytes: number; sha256: string };
  expect(result.bytes).toBe(text.length);
  expect(result.sha256).toBe(createHash('sha256').update(text).digest('hex'));
});
