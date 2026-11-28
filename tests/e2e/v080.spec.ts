import { type BrowserContext, expect, test } from '@playwright/test';
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

test('audits SRI/OAuth/outdated libraries, toggles Target Workspace and saves Bug Bounty triage', async () => {
  const { base } = server;
  const sw = await serviceWorker(context);
  const extensionId = new URL(sw.url()).host;

  const panel = await context.newPage();
  await panel.goto(`chrome-extension://${extensionId}/sidepanel.html`);
  await panel.getByTestId('origin-input').fill(base);
  await panel.getByTestId('origin-submit').click();
  await panel.getByTestId('enable').click();
  await expect(panel.getByTestId('site-status')).toBeVisible();

  // Visit a page with cross-origin script missing SRI, OAuth fragment token + Implicit Flow params,
  // and a bundle containing outdated jQuery v3.4.1 + OAuth Implicit Flow.
  const site = await context.newPage();
  await site.goto(
    `${base}/v080.html?response_type=token&client_id=demo&redirect_uri=https://evil.test/cb#access_token=eyJhbGciOiJSUzI1NiJ9.sample.sig`,
  );

  // 1. Target Workspace switcher is visible and toggles cleanly.
  await expect(panel.getByTestId('workspace-switcher')).toBeVisible();
  await panel.getByTestId('workspace-mode-target').click();
  await expect(panel.getByTestId('workspace-mode-target')).toContainText('127.0.0.1');

  // 2. Code Hints tab detects outdated jQuery & OAuth Implicit Flow in bundle.
  await panel.getByTestId('tab-hints').click();
  const sinkList = panel.getByTestId('sink-list');
  await expect(sinkList).toContainText('Outdated jquery 3.4.1', { timeout: 15_000 });
  await expect(sinkList).toContainText('OAuth Implicit Flow');

  // 3. Security Audit tab detects Missing SRI and OAuth fragment token leak.
  await panel.getByTestId('tab-audit').click();
  const auditList = panel.getByTestId('audit-list');
  await expect(auditList).toContainText('Missing Subresource Integrity (SRI)', { timeout: 10_000 });
  await expect(auditList).toContainText('OAuth access_token exposed');

  // 4. Bug Bounty Triage: confirm first audit finding, add a researcher note, copy HackerOne/Bugcrowd report.
  const firstRow = panel.getByTestId('audit-row').first();
  await firstRow.getByTestId('triage-status-select').selectOption('confirmed');
  await expect(firstRow.getByTestId('triage-copy-bounty')).toBeVisible();

  await firstRow.getByTestId('triage-note-toggle').click();
  await firstRow.getByTestId('triage-note-input').fill('Confirmed in production flow');
  await firstRow.getByTestId('triage-note-save').click();
  await expect(firstRow.getByTestId('triage-note-preview')).toContainText(
    'Confirmed in production flow',
  );

  await panel.getByTestId('copy-triage-report').click();
  const reportText = await panel.evaluate(() => navigator.clipboard.readText());
  expect(reportText).toContain('# Bug Bounty Triage Report');
  expect(reportText).toContain('Confirmed in production flow');
  expect(reportText).toContain('## Remediation');
});
