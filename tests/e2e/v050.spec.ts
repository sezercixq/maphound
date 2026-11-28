import { readFileSync } from 'node:fs';
import { type BrowserContext, expect, test } from '@playwright/test';
import { strFromU8, unzipSync } from 'fflate';
import { launch, serviceWorker, startServer, type TestServer } from './fixtures';

let context: BrowserContext;
let server: TestServer;

test.beforeAll(async () => {
  server = await startServer();
  context = await launch();
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
});

test.afterAll(async () => {
  await context?.close();
  server?.close();
});

test('audits raw debug headers, HTML comments/metas and on-demand robots.txt/sitemap.xml', async () => {
  const { base } = server;
  const sw = await serviceWorker(context);
  const extensionId = new URL(sw.url()).host;

  const panel = await context.newPage();
  await panel.goto(`chrome-extension://${extensionId}/sidepanel.html`);
  await panel.getByTestId('origin-input').fill(base);
  await panel.getByTestId('origin-submit').click();
  await panel.getByTestId('enable').click();
  await expect(panel.getByTestId('site-status')).toBeVisible();

  const site = await context.newPage();
  await site.goto(`${base}/v050.html`);
  await expect(panel.getByTestId('stat-maps')).toHaveText('1', { timeout: 20_000 });

  // 1. Audit tab: custom debug headers, collapsible raw response headers, HTML comments & meta.
  await panel.getByTestId('tab-audit').click();
  await expect(panel.getByTestId('audit-list')).toContainText(
    'Custom / debug header "x-debug-mode" exposed',
    { timeout: 15_000 },
  );
  await expect(panel.getByTestId('audit-list')).toContainText(
    'Custom / debug header "x-backend-version" exposed',
  );

  await expect(panel.getByTestId('raw-headers-table')).toBeHidden();
  await panel.getByTestId('raw-headers-toggle').click();
  await expect(panel.getByTestId('raw-headers-table')).toContainText('x-request-id');
  await expect(panel.getByTestId('raw-headers-table')).toContainText('req-e2e-050');

  const htmlCard = panel.getByTestId('html-audit-card');
  await expect(htmlCard).toContainText('CustomCMS 4.2');
  await expect(htmlCard).toContainText('TODO: remove /internal/staging-debug before prod');
  await expect(panel.getByTestId('stack-hints-card')).toContainText('CustomCMS 4.2');

  // 2. OSINT tab: discovery files are NOT auto-fetched until user clicks the button.
  await panel.getByTestId('tab-osint').click();
  await expect(panel.getByTestId('discovery-disallow')).toHaveCount(0);
  await panel.getByTestId('check-discovery-btn').click();
  await expect(panel.getByTestId('discovery-disallow')).toContainText('/admin/secret-portal', {
    timeout: 10_000,
  });
  await expect(panel.getByTestId('discovery-sitemaps')).toContainText('/sitemap.xml');
  await expect(panel.getByTestId('discovery-sitemap-urls')).toContainText('/pricing');

  // 3. ZIP export includes raw headers & HTML comments in AUDIT.md and discovery files in OSINT.md/ENDPOINTS.md.
  const [zipDownload] = await Promise.all([
    panel.waitForEvent('download'),
    panel.getByTestId('download-zip').click(),
  ]);
  const zipFiles = unzipSync(readFileSync((await zipDownload.path()) as string));
  const auditMd = strFromU8(zipFiles['AUDIT.md'] as Uint8Array);
  expect(auditMd).toContain('### Raw Response Headers');
  expect(auditMd).toContain('x-debug-mode');
  expect(auditMd).toContain('CustomCMS 4.2');

  const osintMd = strFromU8(zipFiles['OSINT.md'] as Uint8Array);
  expect(osintMd).toContain('/admin/secret-portal');
  expect(osintMd).toContain('/sitemap.xml');

  const endpointsMd = strFromU8(zipFiles['ENDPOINTS.md'] as Uint8Array);
  expect(endpointsMd).toContain('/admin/secret-portal');
  expect(endpointsMd).toContain('/pricing');
});
