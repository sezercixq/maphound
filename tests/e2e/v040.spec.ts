import { readFileSync } from 'node:fs';
import { type BrowserContext, expect, test } from '@playwright/test';
import { strFromU8, unzipSync } from 'fflate';
import { hook, launch, serviceWorker, startServer, type TestServer, v040Jwt } from './fixtures';

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

test('builds architecture tree, audits headers/storage/cookies, tracks version diff and exports SARIF v2.1.0', async () => {
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
  await site.goto(`${base}/v040.html`);

  await expect(panel.getByTestId('stat-maps')).toHaveText('1', { timeout: 20_000 });
  await expect(panel.getByTestId('stat-files')).toHaveText('2');

  // 1. Architecture tab: SDKs, collapsible tree, endpoint link, and click-to-open CodeViewer.
  await panel.getByTestId('tab-architecture').click();
  const sdkList = panel.getByTestId('arch-sdk-list');
  await expect(sdkList).toContainText('Stripe', { timeout: 10_000 });
  await expect(sdkList).toContainText('Supabase');

  const tree = panel.getByTestId('arch-tree');
  await expect(tree).toContainText('billing/');
  await expect(tree).toContainText('checkout.tsx');
  await expect(tree).toContainText('api.ts');
  await tree.getByText('checkout.tsx').click();
  await expect(panel.getByTestId('code-viewer')).toBeVisible();
  await expect(panel.getByTestId('code-viewer-path')).toHaveText('src/src/billing/checkout.tsx');
  await expect(panel.getByTestId('code-viewer')).toContainText("axios.post('/api/v1/checkout'");
  await panel.keyboard.press('Escape');
  await expect(panel.getByTestId('code-viewer')).toBeHidden();

  // 1b. OSINT tab: offline cloud assets, private IPs, masked local path, GA4 + 1-click launcher.
  await panel.getByTestId('tab-osint').click();
  const osintList = panel.getByTestId('osint-list');
  await expect(osintList).toContainText('s3://acme-uploads', { timeout: 10_000 });
  await expect(osintList).toContainText('10.24.8.15:8080');
  await expect(osintList).toContainText('G-MAPHOUND01');
  await expect(osintList).toContainText('/Users/a***e/checkout-web');
  await expect(osintList).not.toContainText('/Users/alice/');
  await expect(panel.getByTestId('osint-domain-unavailable')).toBeVisible();

  // 2. Security Audit tab: CSP weaknesses, CORS *, masked localStorage JWT, non-HttpOnly cookie.
  await panel.getByTestId('tab-audit').click();
  await expect(panel.getByTestId('audit-headers')).toContainText('Content-Security-Policy', {
    timeout: 15_000,
  });
  const auditList = panel.getByTestId('audit-list');
  await expect(auditList).toContainText("CSP allows 'unsafe-inline' scripts");
  await expect(auditList).toContainText('Permissive CORS Access-Control-Allow-Origin: *');
  await expect(auditList).toContainText('JWT stored in localStorage');
  await expect(auditList).toContainText('Sensitive cookie "session_id" lacks HttpOnly');
  await expect(auditList).not.toContainText(v040Jwt);

  // 3. One-click Disclosure Report Draft copy.
  await panel.getByTestId('tab-hints').click();
  const draftBtn = panel.getByTestId('sink-draft').first();
  await draftBtn.click();
  await expect(draftBtn).toHaveText('Copied');
  const clipboardText = await panel.evaluate(() => navigator.clipboard.readText());
  expect(clipboardText).toContain('## Security Report Draft:');
  expect(clipboardText).toContain('### Remediation');

  // 4. Snapshot & Diff: save v1 baseline, visit v2 update, verify Diff badge and delta view.
  await panel.getByTestId('tab-diff').click();
  await panel.getByTestId('save-snapshot').click();
  await expect(panel.getByText('1 snapshots saved')).toBeVisible({ timeout: 10_000 });

  await site.goto(`${base}/v040-update.html`);
  await expect(panel.getByTestId('stat-maps')).toHaveText('2', { timeout: 20_000 });
  await expect(panel.getByTestId('diff-badge')).toBeVisible({ timeout: 15_000 });
  await expect(panel.getByTestId('diff-files')).toContainText('src/src/admin/export.ts');
  await expect(panel.getByTestId('diff-endpoints')).toContainText('/internal/admin/export');
  await expect(panel.getByTestId('diff-sinks')).toContainText('document.write()');

  // 5. ZIP Export: ARCHITECTURE.md (Mermaid), AUDIT.md, DIFF.md, and SARIF v2.1.0.
  const [zipDownload] = await Promise.all([
    panel.waitForEvent('download'),
    panel.getByTestId('download-zip').click(),
  ]);
  const zipFiles = unzipSync(readFileSync((await zipDownload.path()) as string));
  for (const name of Object.keys(zipFiles)) expect(name.split('/')).not.toContain('..');

  const archMd = strFromU8(zipFiles['ARCHITECTURE.md'] as Uint8Array);
  expect(archMd).toContain('```mermaid');
  expect(archMd).toContain('flowchart LR');
  expect(archMd).toContain('/api/v1/checkout');

  const auditMd = strFromU8(zipFiles['AUDIT.md'] as Uint8Array);
  expect(auditMd).toContain('JWT stored in localStorage');
  expect(auditMd).not.toContain(v040Jwt);

  const osintMd = strFromU8(zipFiles['OSINT.md'] as Uint8Array);
  expect(osintMd).toContain('s3://acme-uploads');
  expect(osintMd).toContain('/Users/a***e/checkout-web');
  expect(osintMd).not.toContain('/Users/alice/');

  const diffMd = strFromU8(zipFiles['DIFF.md'] as Uint8Array);
  expect(diffMd).toContain('`src/src/admin/export.ts`');
  expect(diffMd).toContain('`/internal/admin/export`');

  const sarif = JSON.parse(strFromU8(zipFiles['results.sarif'] as Uint8Array));
  expect(sarif.version).toBe('2.1.0');
  expect(sarif.runs[0].tool.driver.name).toBe('MapHound');
  expect(
    sarif.runs[0].results.some(
      (r: { ruleId: string }) =>
        r.ruleId === 'sink/code-eval' || r.ruleId === 'sink/dom-xss-document-write',
    ),
  ).toBe(true);

  // 6. Disable & purge clears audits and snapshots too.
  await panel.getByTestId('disable').click();
  await panel.getByTestId('disable-confirm').click();
  await expect(panel.getByTestId('enable')).toBeVisible();
  expect(await hook<unknown[]>(sw, '__mhAudits')).toEqual([]);
  expect(await hook<unknown[]>(sw, '__mhSnapshots')).toEqual([]);
});
