import { readFileSync } from 'node:fs';
import { type BrowserContext, expect, test } from '@playwright/test';
import { strFromU8, unzipSync } from 'fflate';
import { launch, serviceWorker, startServer, type TestServer, v060BadJwt } from './fixtures';

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

test('tracks source-to-sink taint flows, AuthZ/IDOR, weak crypto/JWT and exports OpenAPI 3.0.3', async () => {
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
  await site.goto(`${base}/v060.html`);
  await expect(panel.getByTestId('stat-maps')).toHaveText('1', { timeout: 20_000 });

  // 1. Code Hints tab: Taint Flow (Source -> Sink trace), Unvalidated postMessage, AuthZ/IDOR, Weak Crypto.
  await panel.getByTestId('tab-hints').click();
  const sinkList = panel.getByTestId('sink-list');
  await expect(sinkList).toContainText('Confirmed Source-to-Sink Flow', { timeout: 15_000 });
  await expect(panel.getByTestId('sink-trace').first()).toContainText('L2 → L4');
  await expect(sinkList).toContainText('Unvalidated postMessage Handler');
  await expect(sinkList).toContainText('AuthZ / IDOR Candidate endpoint');
  await expect(sinkList).toContainText('Weak PRNG: Math.random()');
  await expect(sinkList).toContainText('Weak cryptographic hash (MD5 / SHA-1)');

  // 2. Security Audit tab: deep JWT checks (alg: "none", long-lived, privileged claims, strictly masked).
  await panel.getByTestId('tab-audit').click();
  const auditList = panel.getByTestId('audit-list');
  await expect(auditList).toContainText('JWT uses insecure alg: "none"', { timeout: 15_000 });
  await expect(auditList).toContainText('Long-lived JWT');
  await expect(auditList).toContainText('JWT contains privileged role/scope claims');
  await expect(auditList).not.toContainText(v060BadJwt);

  // 3. Endpoints tab: OpenAPI 3.0.3 direct download.
  await panel.getByTestId('tab-endpoints').click();
  const [openApiDownload] = await Promise.all([
    panel.waitForEvent('download'),
    panel.getByTestId('endpoints-export-openapi').click(),
  ]);
  const openApiDoc = JSON.parse(readFileSync((await openApiDownload.path()) as string, 'utf8'));
  expect(openApiDoc.openapi).toBe('3.0.3');
  expect(openApiDoc.components.securitySchemes.BearerAuth.scheme).toBe('bearer');
  expect(openApiDoc.paths['/api/v1/users/{userId}/export']?.post).toBeDefined();

  // 4. ZIP export includes openapi.json and SARIF with taint trace.
  const [zipDownload] = await Promise.all([
    panel.waitForEvent('download'),
    panel.getByTestId('download-zip').click(),
  ]);
  const zipFiles = unzipSync(readFileSync((await zipDownload.path()) as string));
  const zipOpenApi = JSON.parse(strFromU8(zipFiles['openapi.json'] as Uint8Array));
  expect(zipOpenApi.openapi).toBe('3.0.3');

  const sarif = JSON.parse(strFromU8(zipFiles['results.sarif'] as Uint8Array));
  expect(
    sarif.runs[0].results.some(
      (r: { ruleId: string; message: { text: string } }) =>
        r.ruleId === 'sink/taint-dom-xss' && r.message.text.includes('Flow:'),
    ),
  ).toBe(true);
});
