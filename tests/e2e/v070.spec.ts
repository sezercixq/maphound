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

test('observes live API traffic, runs safe verification checks and validates custom ReDoS rules', async () => {
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
  await site.goto(`${base}/v070.html`);

  // 1. Live Observed API traffic appears in Endpoints tab with cURL/Python snippet buttons.
  await panel.getByTestId('tab-endpoints').click();
  await expect(panel.getByTestId('endpoint-list')).toContainText('/api/v1/live-orders', {
    timeout: 15_000,
  });
  await expect(panel.getByTestId('endpoint-list')).toContainText('Live Observed');
  await panel.getByTestId('endpoint-curl').first().click();
  const curlText = await panel.evaluate(() => navigator.clipboard.readText());
  expect(curlText).toContain('curl -i -X POST');
  expect(curlText).toContain('${API_TOKEN}');

  // 2. Controlled Safe Verification Checks (on-demand only): GraphQL introspection & security.txt.
  await panel.getByTestId('tab-audit').click();
  await panel.getByTestId('run-safe-checks-btn').click();
  const safeList = panel.getByTestId('safe-checks-list');
  await expect(safeList).toContainText('GraphQL Introspection is enabled on /graphql', {
    timeout: 10_000,
  });
  await expect(safeList).toContainText('/.well-known/security.txt found');

  // 3. Custom Rules Studio: rejects ReDoS pattern, tests safe pattern in Playground, saves & lists it.
  await panel.getByTestId('tab-rules').click();
  await panel.getByTestId('custom-rule-name').fill('Acme Internal Flag');
  await panel.getByTestId('custom-rule-pattern').fill('(a+)+$');
  await expect(panel.getByTestId('custom-rule-safety')).toContainText('Unsafe Regex');
  await expect(panel.getByTestId('custom-rule-save')).toBeDisabled();

  await panel.getByTestId('custom-rule-pattern').fill('ACME_FLAG_[A-Z0-9]{8}');
  await expect(panel.getByTestId('custom-rule-safety')).toContainText('ReDoS-Safe');
  await panel.getByTestId('custom-rule-sample').fill('token = "ACME_FLAG_9876ZYXW"');
  await expect(panel.getByTestId('custom-rule-playground-result')).toContainText('1 matches');
  await panel.getByTestId('custom-rule-save').click();
  await expect(panel.getByTestId('custom-rules-list')).toContainText('Acme Internal Flag');
});
