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

interface SiteRow {
  origin: string;
  extraOrigins?: string[];
}

test('third-party origins can be allowed one by one or in bulk, then removed', async () => {
  const { base, thirdPartyBase, cdnBase, vendorBase } = server;
  const sw = await serviceWorker(context);
  const panel = await context.newPage();
  await panel.goto(`chrome-extension://${new URL(sw.url()).host}/sidepanel.html`);
  await panel.getByTestId('origin-input').fill(base);
  await panel.getByTestId('origin-submit').click();
  await panel.getByTestId('enable').click();
  await expect(panel.getByTestId('site-status')).toBeVisible();

  const site = await context.newPage();
  await site.goto(`${base}/index.html`);

  // Three origins served scripts that were not scanned, the site's CDN among them.
  const rows = panel.getByTestId('third-party-row');
  await expect(rows).toHaveCount(3, { timeout: 20_000 });
  for (const origin of [thirdPartyBase, cdnBase, vendorBase]) {
    await expect(rows.filter({ hasText: new URL(origin).host })).toContainText('1 script');
  }
  await expect(panel.getByTestId('allow-all')).toHaveText('Allow & scan all (3 origins)');

  // Single origin: the CDN. Its bundle and source map are fetched and the leaked token found.
  await rows
    .filter({ hasText: new URL(cdnBase).host })
    .getByTestId('allow-origin')
    .click();
  await expect(panel.getByTestId('allowed-origin')).toHaveCount(1);
  await expect(panel.getByTestId('allowed-origin')).toContainText(new URL(cdnBase).host);
  await expect(rows).toHaveCount(2);
  await expect
    .poll(
      async () =>
        (await hook<{ secret: string; file: string }[]>(sw, '__mhFindings')).find(
          (f) => f.secret === leaks.cdn,
        )?.file,
      {
        timeout: 20_000,
      },
    )
    .toBe('src/src/cdn.js.ts');
  await expect(panel.getByTestId('finding-row').filter({ hasText: 'cdn.js.ts:1' })).toBeVisible();

  // Bulk: one prompt for the remaining two.
  await expect(panel.getByTestId('allow-all')).toHaveText('Allow & scan all (2 origins)');
  await panel.getByTestId('allow-all').click();
  await expect(panel.getByTestId('third-party')).toHaveCount(0);
  await expect(panel.getByTestId('allowed-origin')).toHaveCount(3);
  await expect
    .poll(
      async () => {
        const jobs = await jobsByUrl(sw);
        return [jobs[`${thirdPartyBase}/tp.js`]?.state, jobs[`${vendorBase}/vendor.js`]?.state];
      },
      { timeout: 20_000 },
    )
    .toEqual(['done', 'done']);
  await expect
    .poll(async () => (await hook<{ secret: string }[]>(sw, '__mhFindings')).map((f) => f.secret), {
      timeout: 20_000,
    })
    .toContain(leaks.thirdParty);
  await expect(panel.getByTestId('stat-third-party')).toHaveText('0');

  const sites = await hook<SiteRow[]>(sw, '__mhSites');
  expect(sites[0]?.extraOrigins?.sort()).toEqual([cdnBase, thirdPartyBase, vendorBase].sort());

  // Remove one: it disappears from the site and new scripts there are third party again.
  await panel
    .getByTestId('allowed-origin')
    .filter({ hasText: new URL(vendorBase).host })
    .getByTestId('remove-origin')
    .click();
  await expect(panel.getByTestId('allowed-origin')).toHaveCount(2);
  expect((await hook<SiteRow[]>(sw, '__mhSites'))[0]?.extraOrigins?.sort()).toEqual(
    [cdnBase, thirdPartyBase].sort(),
  );

  // Disable and delete: the site, its extra origins and its data are gone.
  await panel.getByTestId('disable').click();
  await panel.getByTestId('disable-confirm').click();
  await expect(panel.getByTestId('enable')).toBeVisible();
  expect(await hook<SiteRow[]>(sw, '__mhSites')).toEqual([]);
  expect(Object.keys(await jobsByUrl(sw))).toEqual([]);
});
