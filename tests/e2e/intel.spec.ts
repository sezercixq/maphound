import { readFileSync } from 'node:fs';
import { type BrowserContext, expect, test } from '@playwright/test';
import { strFromU8, unzipSync } from 'fflate';
import { hook, launch, serviceWorker, startServer, type TestServer } from './fixtures';

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

test('extracts endpoints, routes, sinks, __NEXT_DATA__, searches sources and exports ENDPOINTS.md', async () => {
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
  await site.goto(`${base}/next.html`);

  // Wait for map analysis, script scan, and __NEXT_DATA__ capture.
  await expect(panel.getByTestId('stat-maps')).toHaveText('1', { timeout: 20_000 });
  await expect(panel.getByTestId('stat-files')).toHaveText('2');
  await expect(panel.getByText('No secrets found in the scanned scripts.')).toBeVisible({
    timeout: 20_000,
  });
  await expect(panel.getByTestId('finding-row')).toHaveCount(0);

  // Endpoints & routes tab: API methods, Next data endpoints, router paths, developer notes.
  await panel.getByTestId('tab-endpoints').click();
  const endpoints = panel.getByTestId('endpoint-row');
  await expect(endpoints.filter({ hasText: '/internal/admin/impersonate' })).toContainText('POST', {
    timeout: 20_000,
  });
  await expect(endpoints.filter({ hasText: '/api/v1/users' })).toContainText('GET');
  await expect(endpoints.filter({ hasText: '/graphql' })).toContainText('POST');
  await expect(endpoints.filter({ hasText: '/api/v1/billing/summary' })).toBeVisible({
    timeout: 20_000,
  });
  await expect(
    panel.getByTestId('route-row').filter({ hasText: '/admin/audit-logs' }),
  ).toBeVisible();
  await expect(
    panel.getByTestId('comment-row').filter({ hasText: 'skip RBAC check in staging' }),
  ).toContainText('BYPASS');

  // TXT and JSON exports work locally.
  const [txtDownload] = await Promise.all([
    panel.waitForEvent('download'),
    panel.getByTestId('endpoints-export-txt').click(),
  ]);
  const txtContent = readFileSync((await txtDownload.path()) as string, 'utf8');
  expect(txtContent).toContain('POST /internal/admin/impersonate');
  expect(txtContent).toContain('ROUTE /admin/audit-logs');

  const [jsonDownload] = await Promise.all([
    panel.waitForEvent('download'),
    panel.getByTestId('endpoints-export-json').click(),
  ]);
  const jsonContent = JSON.parse(readFileSync((await jsonDownload.path()) as string, 'utf8'));
  expect(jsonContent.summary.endpoints).toBeGreaterThanOrEqual(4);

  // Code Hints tab: __NEXT_DATA__ SSR summary + static sinks (excluding _vendor/).
  await panel.getByTestId('tab-hints').click();
  const nextCard = panel.getByTestId('next-data-card');
  await expect(nextCard).toBeVisible();
  await expect(nextCard).toContainText('getServerSideProps');
  await expect(nextCard).toContainText('tok_…3210');
  await expect(nextCard).not.toContainText('tok_9f8e7d6c5b4a3210');

  const sinks = panel.getByTestId('sink-row');
  await expect(sinks.filter({ hasText: 'React dangerouslySetInnerHTML' })).toBeVisible();
  await expect(
    sinks.filter({ hasText: 'postMessage listener without origin check' }),
  ).toBeVisible();
  await expect(sinks.filter({ hasText: 'Dynamic eval() call' })).toBeVisible();
  await expect(sinks.filter({ hasText: 'Dynamic location redirect candidate' })).toBeVisible();
  await expect(sinks.filter({ hasText: 'vendor-pkg' })).toHaveCount(0);

  // Search tab: plain text + regex search + Code Viewer modal with highlighted line.
  await panel.getByTestId('tab-search').click();
  const searchInput = panel.getByTestId('source-search-input');
  await searchInput.fill('impersonate');
  await expect(panel.getByTestId('source-search-result')).toHaveCount(2, { timeout: 10_000 });
  await expect(panel.getByTestId('source-search-result').first()).toContainText(
    'src/src/admin/panel.tsx',
  );

  await panel.getByTestId('source-search-regex').click();
  await searchInput.fill('dangerously.*HTML');
  await expect(panel.getByTestId('source-search-result')).toHaveCount(1, { timeout: 10_000 });
  await panel.getByTestId('source-search-result').first().click();

  const viewer = panel.getByTestId('code-viewer');
  await expect(viewer).toBeVisible();
  await expect(panel.getByTestId('code-viewer-path')).toHaveText('src/src/admin/panel.tsx');
  const highlighted = panel.locator('[data-testid="code-viewer-line"][data-highlighted="true"]');
  await expect(highlighted).toHaveCount(1);
  await expect(highlighted).toContainText('dangerouslySetInnerHTML');

  await panel.keyboard.press('Escape');
  await expect(viewer).toBeHidden();

  // ZIP export includes ENDPOINTS.md with masked __NEXT_DATA__ and Zip-Slip-safe paths.
  const [zipDownload] = await Promise.all([
    panel.waitForEvent('download'),
    panel.getByTestId('download-zip').click(),
  ]);
  const zipFiles = unzipSync(readFileSync((await zipDownload.path()) as string));
  for (const name of Object.keys(zipFiles)) expect(name.split('/')).not.toContain('..');
  const endpointsMd = strFromU8(zipFiles['ENDPOINTS.md'] as Uint8Array);
  expect(endpointsMd).toContain('/internal/admin/impersonate');
  expect(endpointsMd).toContain('/admin/audit-logs');
  expect(endpointsMd).toContain('React dangerouslySetInnerHTML');
  expect(endpointsMd).toContain('tok_…3210');
  expect(endpointsMd).not.toContain('tok_9f8e7d6c5b4a3210');

  // Disable & purge removes intel and pages too.
  await panel.getByTestId('disable').click();
  await panel.getByTestId('disable-confirm').click();
  await expect(panel.getByTestId('enable')).toBeVisible();
  expect(await hook<unknown[]>(sw, '__mhIntel')).toEqual([]);
  expect(await hook<unknown[]>(sw, '__mhPages')).toEqual([]);
});
