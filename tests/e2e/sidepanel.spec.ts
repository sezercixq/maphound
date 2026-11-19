import { readFileSync } from 'node:fs';
import { type BrowserContext, expect, type Page, test } from '@playwright/test';
import { strFromU8, unzipSync } from 'fflate';
import { hook, jobsByUrl, launch, serviceWorker, startServer, type TestServer } from './fixtures';

let context: BrowserContext;
let server: TestServer;
let panel: Page;

test.beforeAll(async () => {
  server = await startServer();
  context = await launch();
});

test.afterAll(async () => {
  await context?.close();
  server?.close();
});

test('side panel enables a site, lists results live and exports a safe ZIP', async () => {
  const { base, thirdPartyBase } = server;
  const sw = await serviceWorker(context);
  const extensionId = new URL(sw.url()).host;
  const host = new URL(base).host.replace(':', '_');

  // Opened as a tab, the panel's "active tab" is itself: it must fall back to manual entry.
  panel = await context.newPage();
  await panel.goto(`chrome-extension://${extensionId}/sidepanel.html`);
  await panel.getByTestId('origin-input').fill('not a url ::');
  await panel.getByTestId('origin-submit').click();
  await expect(panel.getByText('Enter an http(s) address.')).toBeVisible();
  await panel.getByTestId('origin-input').fill(`${base}/some/page`);
  await panel.getByTestId('origin-submit').click();
  await expect(panel.getByTestId('origin')).toHaveText(base);
  await expect(panel.getByTestId('toggle-subdomains')).toBeDisabled(); // IP address

  await panel.getByTestId('enable').click();
  await expect(panel.getByTestId('site-status')).toHaveText('Enabled for this origin only');
  await expect(panel.getByTestId('download-zip')).toBeDisabled();

  const site = await context.newPage();
  await site.goto(`${base}/index.html`);
  // Keep the site tab active: the panel follows it (a real side panel is not a tab itself).
  await expect(panel.getByTestId('origin')).toHaveText(base);

  await expect(panel.getByTestId('stat-maps')).toHaveText('3', { timeout: 20_000 });
  await expect(panel.getByTestId('stat-third-party')).toHaveText('1');
  await expect(panel.getByTestId('stat-files')).toHaveText('9');
  await expect(panel.getByTestId('script-row').filter({ hasText: 'tp.js' })).toContainText(
    '3rd party (not scanned)',
  );
  await expect(panel.getByTestId('map-row').filter({ hasText: 'app.js.map' })).toContainText(
    '3 files',
  );
  await expect(panel.getByTestId('map-row').first()).toContainText('sources included');

  const [download] = await Promise.all([
    panel.waitForEvent('download'),
    panel.getByTestId('download-zip').click(),
  ]);
  expect(download.suggestedFilename()).toMatch(
    new RegExp(`^maphound-${host.replace('.', '\\.')}-\\d{4}-\\d{2}-\\d{2}\\.zip$`),
  );
  await expect(panel.getByTestId('download-status')).toHaveText('Saved 9 files');
  const files = unzipSync(readFileSync((await download.path()) as string));
  const names = Object.keys(files).sort();
  expect(names).toEqual(
    [
      'manifest.json',
      ...['app.js', 'chunk.js', 'lazy.mjs'].flatMap((script) => [
        `source/${host}/${script}/_vendor/lib/index.js`,
        `source/${host}/${script}/src/evil/escape.txt`,
        `source/${host}/${script}/src/src/${script}.ts`,
      ]),
    ].sort(),
  );
  for (const name of names) expect(name.split('/')).not.toContain('..');
  expect(strFromU8(files[`source/${host}/app.js/src/src/app.js.ts`] as Uint8Array)).toBe(
    "export const name = 'app.js';",
  );
  const manifest = JSON.parse(strFromU8(files['manifest.json'] as Uint8Array));
  expect(manifest.site).toEqual({ origin: base, scope: 'origin' });
  expect(manifest.summary).toMatchObject({ maps: 3, mapsExported: 3, files: 9 });
  expect(manifest.notScanned).toEqual([
    { url: `${thirdPartyBase}/tp.js`, kind: 'script', reason: 'third-party', thirdParty: 'other' },
  ]);

  // Settings change live while enabled.
  const probing = panel.getByTestId('toggle-probing');
  await expect(probing).toHaveAttribute('aria-checked', 'false');
  await probing.click();
  await expect(probing).toHaveAttribute('aria-checked', 'true');

  // Disable with confirmation deletes everything.
  await panel.getByTestId('disable').click();
  await panel.getByTestId('disable-confirm').click();
  await expect(panel.getByTestId('enable')).toBeVisible();
  expect(Object.keys(await jobsByUrl(sw))).toEqual([]);
  expect(await hook<unknown[]>(sw, '__mhMaps')).toEqual([]);
});
