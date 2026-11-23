import { readFileSync } from 'node:fs';
import { type BrowserContext, expect, type Page, test } from '@playwright/test';
import { strFromU8, unzipSync } from 'fflate';
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
  await expect(panel.getByTestId('stat-third-party')).toHaveText('3');
  await expect(panel.getByTestId('stat-files')).toHaveText('9');
  await expect(panel.getByTestId('script-row').filter({ hasText: 'tp.js' })).toContainText(
    '3rd party (not scanned)',
  );
  await expect(panel.getByTestId('map-row').filter({ hasText: 'app.js.map' })).toContainText(
    '3 files',
  );
  await expect(panel.getByTestId('map-row').first()).toContainText('sources included');

  // Findings: critical and high first; lower severities behind a toggle.
  await expect(panel.getByTestId('finding-row')).toHaveCount(2, { timeout: 20_000 });
  await expect(panel.getByTestId('finding-counts')).toContainText('2 critical');
  await expect(panel.getByTestId('finding-counts')).toContainText('1 info');
  const github = panel
    .getByTestId('finding-row')
    .filter({ hasText: 'GitHub personal access token' });
  await expect(github).toContainText('verified format');
  await expect(github.getByTestId('finding-location')).toContainText('app.js.ts:2');
  await expect(github.getByTestId('finding-secret')).toHaveText(`ghp_…${leaks.github.slice(-4)}`);
  await github.getByTestId('finding-reveal').click();
  await expect(github.getByTestId('finding-secret')).toHaveText(leaks.github);
  await github.getByTestId('finding-reveal').click();
  await expect(
    panel.getByTestId('finding-row').filter({ hasText: 'Stripe live secret key' }),
  ).toContainText('found in bundle');
  await panel.getByTestId('findings-toggle').click();
  await expect(panel.getByTestId('finding-row')).toHaveCount(3);
  await expect(panel.getByTestId('finding-row').last()).toHaveAttribute('data-severity', 'info');

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
      'ARCHITECTURE.md',
      'AUDIT.md',
      'ENDPOINTS.md',
      'FINDINGS.md',
      'OSINT.md',
      'findings.json',
      'manifest.json',
      'results.sarif',
      ...['app.js', 'chunk.js', 'lazy.mjs'].flatMap((script) => [
        `source/${host}/${script}/_vendor/lib/index.js`,
        `source/${host}/${script}/src/evil/escape.txt`,
        `source/${host}/${script}/src/src/${script}.ts`,
      ]),
    ].sort(),
  );
  for (const name of names) expect(name.split('/')).not.toContain('..');
  expect(strFromU8(files[`source/${host}/app.js/src/src/app.js.ts`] as Uint8Array)).toContain(
    "export const name = 'app.js';",
  );

  // Reports: masked by default.
  const report = strFromU8(files['FINDINGS.md'] as Uint8Array);
  expect(report).toContain('**3 findings:** 2 critical, 1 info.');
  expect(report).toContain(
    '| GitHub personal access token (classic) | verified-format | `src/src/app.js.ts:2:',
  );
  expect(report).toContain(`ghp_…${leaks.github.slice(-4)}`);
  const masked = strFromU8(files['findings.json'] as Uint8Array);
  for (const secret of [leaks.github, leaks.stripe, leaks.firebase]) {
    expect(report).not.toContain(secret);
    expect(masked).not.toContain(secret);
  }
  expect(JSON.parse(masked).rawSecretsIncluded).toBe(false);
  const manifest = JSON.parse(strFromU8(files['manifest.json'] as Uint8Array));
  expect(manifest.site).toEqual({ origin: base, scope: 'origin' });
  expect(manifest.summary).toMatchObject({ maps: 3, mapsExported: 3, files: 9 });
  expect(manifest.notScanned.map((entry: { url: string }) => entry.url).sort()).toEqual(
    [
      `${thirdPartyBase}/tp.js`,
      `${server.cdnBase}/cdn.js`,
      `${server.vendorBase}/vendor.js`,
    ].sort(),
  );
  expect(manifest.notScanned[0]).toMatchObject({
    kind: 'script',
    reason: 'third-party',
    thirdParty: 'other',
  });

  // Opt-in raw values: only findings.json gets them, FINDINGS.md stays masked.
  await panel.getByTestId('include-secrets').check();
  await expect(panel.getByText('The archive will contain working credentials.')).toBeVisible();
  const [rawDownload] = await Promise.all([
    panel.waitForEvent('download'),
    panel.getByTestId('download-zip').click(),
  ]);
  const rawFiles = unzipSync(readFileSync((await rawDownload.path()) as string));
  const raw = JSON.parse(strFromU8(rawFiles['findings.json'] as Uint8Array));
  expect(raw.rawSecretsIncluded).toBe(true);
  expect(raw.findings.map((f: { secret: string }) => f.secret).sort()).toEqual(
    [leaks.github, leaks.stripe, leaks.firebase].sort(),
  );
  expect(strFromU8(rawFiles['FINDINGS.md'] as Uint8Array)).not.toContain(leaks.github);

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
