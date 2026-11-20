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
  /** In the third-party script, which is never scanned. */
  thirdParty: ['sk', 'live', rand(32)].join('_'),
};

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

export interface TestServer {
  base: string;
  thirdPartyBase: string;
  close(): void;
}

/** Test site on 127.0.0.1; the same server as `localhost` plays a third party. */
export function startServer(): Promise<TestServer> {
  let thirdPartyBase = '';
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
            `<script>setTimeout(() => { const s = document.createElement('script'); s.src = '/chunk.js'; document.body.append(s); import('/lazy.mjs'); }, 2500);</script>`,
        );
      case '/second.html':
        return html('<script src="/second.js"></script>');
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
      done({ base: `http://127.0.0.1:${port}`, thirdPartyBase, close: () => server.close() });
    });
  });
}

export function launch(): Promise<BrowserContext> {
  return chromium.launchPersistentContext(join(mkdtempSync(join(tmpdir(), 'mh-')), 'profile'), {
    headless: false,
    acceptDownloads: true,
    args: [
      '--headless=new',
      `--disable-extensions-except=${extensionPath}`,
      `--load-extension=${extensionPath}`,
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
