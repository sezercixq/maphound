import { randomInt } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { type BrowserContext, chromium, type Worker } from '@playwright/test';
import { makeGithubStyleToken } from '../../src/engine/validators/github-crc32';

// Requires an e2e build (VITE_MH_E2E=1 pnpm build), which pre-grants http://127.0.0.1/*.
export const extensionPath = resolve('.output/chrome-mv3');

export interface Job {
  id: string;
  kind: 'script' | 'map';
  url: string;
  state: string;
  skipReason?: string;
  thirdParty?: string;
  via?: string;
  hash?: string;
}

const ALNUM = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
const rand = (n: number, chars = ALNUM) =>
  Array.from({ length: n }, () => chars[randomInt(chars.length)]).join('');

/**
 * Deliberately leaked, randomly generated fake credentials. Built at runtime: the repository
 * never contains a credential-shaped literal, and none of these was ever valid.
 */
export const leaks = {
  /** In the original source of app.js (src/app.js.ts, line 2). Valid CRC32 checksum. */
  github: makeGithubStyleToken('ghp', rand(30)),
  /** Inlined into the app.js bundle at "build time" (line 2); not in any source file. */
  stripe: ['sk', 'live', rand(32)].join('_'),
  /** Suppressed with maphound-ignore. */
  ignored: ['sk', 'live', rand(32)].join('_'),
  /** Firebase web config key: public, reported as info. */
  firebase: `AIza${rand(35, `${ALNUM}_-`)}`,
  /** In the third-party script: found only after the user allows its origin. */
  thirdParty: ['sk', 'live', rand(32)].join('_'),
  /** In the original source of a bundle served from the site's CDN (cdn-a.mh.test). */
  cdn: makeGithubStyleToken('ghp', rand(30)),
};

/** Fake hosts that Chromium resolves to the local test server (see `launch`). */
export const CDN_HOSTS = ['cdn-a.mh.test', 'cdn-b.mh.test'] as const;

/** A map whose sources include a traversal attempt and a vendor module. */
export const sourceMap = (file: string, firstSource = `export const name = '${file}';`) =>
  JSON.stringify({
    version: 3,
    file,
    sources: [
      `src/${file}.ts`,
      '../../../../evil/escape.txt',
      'webpack:///./node_modules/lib/index.js',
    ],
    sourcesContent: [firstSource, 'escaped?', 'module.exports = 1;'],
    mappings: 'AAAA',
  });

const appSource = `export const name = 'app.js';\nexport const githubToken = "${leaks.github}";\n`;

const nextPanelSource = [
  "import React from 'react';",
  'export async function loadUsers() {',
  "  return fetch('/api/v1/users');",
  '}',
  'export function impersonate(body: unknown) {',
  "  return axios.post('/internal/admin/impersonate', body);",
  '}',
  'export function queryGraph() {',
  "  return fetch('/graphql', { method: 'POST' });",
  '}',
  '// BYPASS: skip RBAC check in staging',
  'export function AdminPanel({ bio, params }: { bio: string; params: URLSearchParams }) {',
  "  window.addEventListener('message', (e) => {",
  '    eval(e.data);',
  '  });',
  "  window.location.href = params.get('next') ?? '/';",
  '  return (',
  '    <>',
  '      <Route path="/admin/audit-logs" element={<div />} />',
  '      <div dangerouslySetInnerHTML={{ __html: bio }} />',
  '    </>',
  '  );',
  '}',
  '',
].join('\n');

const nextAppMap = JSON.stringify({
  version: 3,
  file: 'next-app.js',
  sources: ['src/admin/panel.tsx', 'webpack:///./node_modules/vendor-pkg/index.js'],
  sourcesContent: [nextPanelSource, 'el.innerHTML = raw; // TODO: vendor internal\n'],
  mappings: 'AAAA',
});

const nextDataHtml = JSON.stringify({
  page: '/dashboard',
  buildId: 'build-v030',
  gssp: true,
  props: {
    pageProps: {
      user: {
        email: 'alice@example.test',
        isAdmin: true,
        internalToken: 'tok_9f8e7d6c5b4a3210',
      },
      apiEndpoint: '/api/v1/billing/summary',
    },
  },
});

const b64u = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url');
export const v040Jwt = `${b64u({ alg: 'HS256', typ: 'JWT' })}.${b64u({
  sub: 'u_e2e',
  role: 'admin',
  exp: 1900000000,
})}.${rand(24)}`;

const v040CheckoutSource = [
  "import { loadStripe } from '@stripe/stripe-js';",
  "import { submitOrder } from './api';",
  'export function checkout() {',
  "  return axios.post('/api/v1/checkout', {});",
  '}',
  '',
].join('\n');

const v040ApiSource = [
  "import { createClient } from '@supabase/supabase-js';",
  '// Built at /Users/alice/checkout-web',
  'const uploadsBucket = "https://acme-uploads.s3.amazonaws.com/receipts";',
  'const internalHealth = "http://10.24.8.15:8080/health";',
  'const analyticsId = "G-MAPHOUND01";',
  'export function submitOrder(payload: string) {',
  '  return eval(payload);',
  '}',
  '',
].join('\n');

const v040V1Map = JSON.stringify({
  version: 3,
  file: 'v040-v1.js',
  sources: ['src/billing/checkout.tsx', 'src/billing/api.ts'],
  sourcesContent: [v040CheckoutSource, v040ApiSource],
  mappings: 'AAAA',
});

const v040V2Source = [
  'export function exportData(html: string) {',
  '  document.write(html);',
  "  return fetch('/internal/admin/export');",
  '}',
  '',
].join('\n');

const v040V2Map = JSON.stringify({
  version: 3,
  file: 'v040-v2.js',
  sources: ['src/admin/export.ts'],
  sourcesContent: [v040V2Source],
  mappings: 'AAAA',
});

export interface TestServer {
  base: string;
  thirdPartyBase: string;
  /** The site's own CDN, with a source map. */
  cdnBase: string;
  /** Another third-party origin without a map. */
  vendorBase: string;
  close(): void;
}

/** Test site on 127.0.0.1; the same server as `localhost` plays a third party. */
export function startServer(): Promise<TestServer> {
  let thirdPartyBase = '';
  let cdnBase = '';
  let vendorBase = '';
  const inline = Buffer.from(sourceMap('chunk.js')).toString('base64');
  const server = createServer((req, res) => {
    const path = new URL(req.url ?? '/', 'http://x').pathname;
    const send = (type: string, body: string, headers: Record<string, string> = {}) => {
      res.writeHead(200, { 'Content-Type': type, ...headers });
      res.end(body);
    };
    const js = (body: string, headers?: Record<string, string>) =>
      send('text/javascript', body, headers);
    const html = (body: string) =>
      send('text/html', `<!doctype html><html><body>${body}</body></html>`);
    switch (path) {
      case '/index.html':
        return html(
          `<script src="/app.js"></script><script src="${thirdPartyBase}/tp.js"></script>` +
            `<script src="${cdnBase}/cdn.js"></script><script src="${vendorBase}/vendor.js"></script>` +
            `<script>setTimeout(() => { const s = document.createElement('script'); s.src = '/chunk.js'; document.body.append(s); import('/lazy.mjs'); }, 2500);</script>`,
        );
      case '/second.html':
        return html('<script src="/second.js"></script>');
      case '/next.html':
        return html(
          `<script id="__NEXT_DATA__" type="application/json">${nextDataHtml}</script>` +
            '<script src="/next-app.js"></script>',
        );
      case '/next-app.js':
        return js("console.log('next-app');\n//# sourceMappingURL=next-app.js.map\n");
      case '/next-app.js.map':
        return send('application/json', nextAppMap);
      case '/v040.html':
        return send(
          'text/html',
          `<!doctype html><html><body><script>localStorage.setItem('auth_token', '${v040Jwt}');</script><script src="/v040-v1.js"></script></body></html>`,
          {
            'Content-Security-Policy': "default-src * 'unsafe-inline' 'unsafe-eval'",
            'Access-Control-Allow-Origin': '*',
            'Set-Cookie': 'session_id=e2e_session_val; Path=/',
          },
        );
      case '/v040-v1.js':
        return js("console.log('v040-v1');\n//# sourceMappingURL=v040-v1.js.map\n");
      case '/v040-v1.js.map':
        return send('application/json', v040V1Map);
      case '/v040-update.html':
        return html('<script src="/v040-v2.js"></script>');
      case '/v040-v2.js':
        return js("console.log('v040-v2');\n//# sourceMappingURL=v040-v2.js.map\n");
      case '/v040-v2.js.map':
        return send('application/json', v040V2Map);
      case '/v050.html':
        return send(
          'text/html',
          [
            '<!doctype html><html><head>',
            '<meta name="generator" content="CustomCMS 4.2">',
            '<meta name="author" content="Acme DevOps">',
            '</head><body>',
            '<!-- TODO: remove /internal/staging-debug before prod -->',
            '<script src="/v040-v1.js"></script>',
            '</body></html>',
          ].join('\n'),
          {
            'X-Debug-Mode': 'enabled',
            'X-Backend-Version': '2.8.1',
            'X-Request-Id': 'req-e2e-050',
          },
        );
      case '/robots.txt':
        return send(
          'text/plain',
          [
            'User-agent: *',
            'Disallow: /admin/secret-portal',
            'Disallow: /internal/backups',
            'Allow: /docs/public',
            `Sitemap: http://${req.headers.host}/sitemap.xml`,
          ].join('\n'),
        );
      case '/sitemap.xml':
        return send(
          'application/xml',
          `<?xml version="1.0" encoding="UTF-8"?><urlset><url><loc>http://${req.headers.host}/pricing</loc></url><url><loc>http://${req.headers.host}/status</loc></url></urlset>`,
        );
      case '/app.js':
        return js(
          [
            "console.log('app');",
            `const stripeKey = "${leaks.stripe}";`,
            `const placeholder = "${['sk', 'live', 'x'.repeat(24)].join('_')}";`,
            `const vetted = "${leaks.ignored}"; // maphound-ignore`,
            `const firebaseConfig = { apiKey: "${leaks.firebase}", authDomain: "demo-app.firebaseapp.com" };`,
            '//# sourceMappingURL=app.js.map',
            '',
          ].join('\n'),
        );
      case '/app.js.map':
        return send('application/json', sourceMap('app.js', appSource));
      case '/chunk.js':
        return js(
          `console.log('chunk');\n//# sourceMappingURL=data:application/json;base64,${inline}`,
        );
      case '/lazy.mjs':
        return js("console.log('lazy');\n", { SourceMap: '/maps/lazy.mjs.map' });
      case '/maps/lazy.mjs.map':
        return send('application/json', sourceMap('lazy.mjs'));
      case '/second.js':
        return js("console.log('second');\n");
      case '/cdn.js':
        return js("console.log('cdn bundle');\n//# sourceMappingURL=cdn.js.map\n");
      case '/cdn.js.map':
        return send(
          'application/json',
          sourceMap('cdn.js', `export const deployToken = "${leaks.cdn}";\n`),
        );
      case '/vendor.js':
        return js("console.log('vendor');\n");
      case '/tp.js':
        return js(`console.log('third party', "${leaks.thirdParty}");\n`);
      default:
        res.writeHead(404);
        return res.end();
    }
  });
  return new Promise((done) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      thirdPartyBase = `http://localhost:${port}`;
      cdnBase = `http://${CDN_HOSTS[0]}:${port}`;
      vendorBase = `http://${CDN_HOSTS[1]}:${port}`;
      done({
        base: `http://127.0.0.1:${port}`,
        thirdPartyBase,
        cdnBase,
        vendorBase,
        close: () => server.close(),
      });
    });
  });
}

export function launch(): Promise<BrowserContext> {
  return chromium.launchPersistentContext(join(mkdtempSync(join(tmpdir(), 'mh-')), 'profile'), {
    headless: false,
    locale: 'en-US',
    acceptDownloads: true,
    args: [
      '--headless=new',
      '--lang=en-US',
      `--disable-extensions-except=${extensionPath}`,
      `--load-extension=${extensionPath}`,
      `--host-resolver-rules=${CDN_HOSTS.map((host) => `MAP ${host} 127.0.0.1`).join(', ')}`,
    ],
  });
}

export async function serviceWorker(context: BrowserContext): Promise<Worker> {
  const [existing] = context.serviceWorkers();
  return existing ?? (await context.waitForEvent('serviceworker'));
}

/** Call an e2e hook exposed on the service worker's global scope. */
export function hook<T>(sw: Worker, name: string, ...args: unknown[]): Promise<T> {
  return sw.evaluate(
    ([fn, rest]) =>
      (globalThis as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>)[
        fn as string
      ]?.(...(rest as unknown[])),
    [name, args] as const,
  ) as Promise<T>;
}

export async function jobsByUrl(sw: Worker): Promise<Record<string, Job>> {
  const jobs = await hook<Job[]>(sw, '__mhJobs');
  return Object.fromEntries(jobs.map((job) => [job.url, job]));
}
