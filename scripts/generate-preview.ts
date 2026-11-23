import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium } from '@playwright/test';

const ROOT = resolve(import.meta.dirname, '..');
const EXTENSION_DIR = join(ROOT, '.output', 'chrome-mv3');
const ASSETS_DIR = join(ROOT, 'docs', 'assets');
const ORIGIN = 'https://shop.example.com';

if (!existsSync(join(EXTENSION_DIR, 'manifest.json'))) {
  console.error('Missing .output/chrome-mv3/manifest.json. Run `pnpm build` first.');
  process.exit(1);
}

const logoSvg = readFileSync(join(ASSETS_DIR, 'logo.svg'), 'utf8');

function toDataUri(buf: Buffer): string {
  return `data:image/png;base64,${buf.toString('base64')}`;
}

function buildSeedData() {
  const now = Date.UTC(2026, 10, 23, 12, 0, 0);
  const appScriptHash = 'a1'.repeat(32);
  const chunkScriptHash = 'b2'.repeat(32);
  const lazyScriptHash = 'c3'.repeat(32);
  const appMapHash = 'd4'.repeat(32);
  const chunkMapHash = 'e5'.repeat(32);
  const lazyMapHash = 'f6'.repeat(32);

  return {
    sites: [
      {
        origin: ORIGIN,
        scope: 'origin',
        settings: {
          aggressiveMapProbing: false,
          useCredentials: false,
        },
        extraOrigins: [],
        enabledAt: now - 300_000,
      },
    ],
    scripts: [
      {
        hash: appScriptHash,
        urls: [`${ORIGIN}/app.js`],
        origin: ORIGIN,
        size: 18420,
        sourceMapRef: `${ORIGIN}/app.js.map`,
        status: 'scanned',
        lastAccess: now,
      },
      {
        hash: chunkScriptHash,
        urls: [`${ORIGIN}/chunk.js`],
        origin: ORIGIN,
        size: 9210,
        sourceMapRef: `${ORIGIN}/chunk.js#inline-map`,
        status: 'scanned',
        lastAccess: now,
      },
      {
        hash: lazyScriptHash,
        urls: [`${ORIGIN}/lazy.mjs`],
        origin: ORIGIN,
        size: 4320,
        sourceMapRef: `${ORIGIN}/lazy.mjs.map`,
        status: 'scanned',
        lastAccess: now,
      },
    ],
    jobs: [
      {
        id: `script:${ORIGIN}/app.js`,
        kind: 'script',
        url: `${ORIGIN}/app.js`,
        origin: ORIGIN,
        state: 'done',
        resultHash: appScriptHash,
        attempts: 1,
        leasedUntil: 0,
        createdAt: now - 10_000,
        updatedAt: now,
      },
      {
        id: `script:${ORIGIN}/chunk.js`,
        kind: 'script',
        url: `${ORIGIN}/chunk.js`,
        origin: ORIGIN,
        state: 'done',
        resultHash: chunkScriptHash,
        attempts: 1,
        leasedUntil: 0,
        createdAt: now - 9_000,
        updatedAt: now,
      },
      {
        id: `script:${ORIGIN}/lazy.mjs`,
        kind: 'script',
        url: `${ORIGIN}/lazy.mjs`,
        origin: ORIGIN,
        state: 'done',
        resultHash: lazyScriptHash,
        attempts: 1,
        leasedUntil: 0,
        createdAt: now - 8_000,
        updatedAt: now,
      },
      {
        id: 'script:https://cdn.shop-assets.net/vendor.js',
        kind: 'script',
        url: 'https://cdn.shop-assets.net/vendor.js',
        origin: ORIGIN,
        state: 'skipped',
        skipReason: 'third-party',
        thirdParty: 'cdn',
        attempts: 0,
        leasedUntil: 0,
        createdAt: now - 7_000,
        updatedAt: now,
      },
      {
        id: `map:${ORIGIN}/app.js.map`,
        kind: 'map',
        url: `${ORIGIN}/app.js.map`,
        origin: ORIGIN,
        parentHash: appScriptHash,
        via: 'comment',
        state: 'done',
        resultHash: appMapHash,
        attempts: 1,
        leasedUntil: 0,
        createdAt: now - 6_000,
        updatedAt: now,
      },
      {
        id: `map:${ORIGIN}/lazy.mjs.map`,
        kind: 'map',
        url: `${ORIGIN}/lazy.mjs.map`,
        origin: ORIGIN,
        parentHash: lazyScriptHash,
        via: 'header',
        state: 'done',
        resultHash: lazyMapHash,
        attempts: 1,
        leasedUntil: 0,
        createdAt: now - 5_000,
        updatedAt: now,
      },
      {
        id: `map:${ORIGIN}/chunk.js#inline-map`,
        kind: 'map',
        url: `${ORIGIN}/chunk.js#inline-map`,
        origin: ORIGIN,
        parentHash: chunkScriptHash,
        via: 'data-uri',
        state: 'done',
        resultHash: chunkMapHash,
        attempts: 1,
        leasedUntil: 0,
        createdAt: now - 4_000,
        updatedAt: now,
      },
    ],
    maps: [
      {
        id: `map:${ORIGIN}/app.js.map`,
        hash: appMapHash,
        scriptHash: appScriptHash,
        origin: ORIGIN,
        url: `${ORIGIN}/app.js.map`,
        via: 'comment',
        indexed: false,
        sourceCount: 4,
        fileCount: 4,
        withContent: 4,
        missingContent: 0,
        vendorCount: 1,
        totalBytes: 12_400,
        hasSourcesContent: true,
        partial: false,
        partialReasons: [],
        warnings: [],
        files: [
          { path: 'src/app.js.ts', size: 4200, vendor: false },
          { path: 'src/checkout.tsx', size: 3900, vendor: false },
          { path: 'src/config.ts', size: 2100, vendor: false },
          { path: '_vendor/react/index.js', size: 2200, vendor: true },
        ],
        createdAt: now,
      },
      {
        id: `map:${ORIGIN}/lazy.mjs.map`,
        hash: lazyMapHash,
        scriptHash: lazyScriptHash,
        origin: ORIGIN,
        url: `${ORIGIN}/lazy.mjs.map`,
        via: 'header',
        indexed: false,
        sourceCount: 3,
        fileCount: 3,
        withContent: 3,
        missingContent: 0,
        vendorCount: 1,
        totalBytes: 6_100,
        hasSourcesContent: true,
        partial: false,
        partialReasons: [],
        warnings: [],
        files: [
          { path: 'src/admin/export.ts', size: 3100, vendor: false },
          { path: 'src/lib/auth.ts', size: 1800, vendor: false },
          { path: '_vendor/zod/index.js', size: 1200, vendor: true },
        ],
        createdAt: now,
      },
      {
        id: `map:${ORIGIN}/chunk.js#inline-map`,
        hash: chunkMapHash,
        scriptHash: chunkScriptHash,
        origin: ORIGIN,
        url: `${ORIGIN}/chunk.js#inline-map`,
        via: 'data-uri',
        indexed: false,
        sourceCount: 2,
        fileCount: 2,
        withContent: 2,
        missingContent: 0,
        vendorCount: 0,
        totalBytes: 3_400,
        hasSourcesContent: true,
        partial: false,
        partialReasons: [],
        warnings: [],
        files: [
          { path: 'src/telemetry.ts', size: 1900, vendor: false },
          { path: 'src/storage.ts', size: 1500, vendor: false },
        ],
        createdAt: now,
      },
    ],
    findings: [
      {
        id: `${ORIGIN}|github-pat|f1`,
        ruleId: 'github-pat',
        ruleName: 'GitHub personal access token (classic)',
        severity: 'critical',
        confidence: 'verified-format',
        origin: ORIGIN,
        scriptHash: appScriptHash,
        file: 'src/app.js.ts',
        line: 2,
        column: 28,
        locationKind: 'source',
        preview: 'ghp_…AF1p',
        snippet: 'export const githubToken = "ghp_…AF1p";',
        secretHash: '11'.repeat(32),
        secret: ['ghp', 'previewPlaceholderTokenOnly00000AF1p'].join('_'),
        occurrences: 1,
        locations: [
          {
            file: 'src/app.js.ts',
            line: 2,
            column: 28,
            kind: 'source',
            scriptUrl: `${ORIGIN}/app.js`,
            mapUrl: `${ORIGIN}/app.js.map`,
          },
        ],
        references: ['https://docs.github.com/en/authentication'],
        createdAt: now,
        updatedAt: now,
      },
      {
        id: `${ORIGIN}|stripe-secret|f2`,
        ruleId: 'stripe-secret',
        ruleName: 'Stripe live secret key',
        severity: 'critical',
        confidence: 'high',
        origin: ORIGIN,
        scriptHash: appScriptHash,
        file: 'app.js',
        line: 2,
        column: 14,
        locationKind: 'bundle',
        preview: 'sk_l…f01t',
        snippet: 'const stripeKey = "sk_l…f01t";',
        secretHash: '22'.repeat(32),
        secret: ['sk', 'live', 'previewPlaceholder00000000f01t'].join('_'),
        occurrences: 1,
        locations: [
          {
            file: 'app.js',
            line: 2,
            column: 14,
            kind: 'bundle',
            scriptUrl: `${ORIGIN}/app.js`,
          },
        ],
        references: ['https://stripe.com/docs/keys'],
        createdAt: now,
        updatedAt: now,
      },
      {
        id: `${ORIGIN}|firebase-web-key|f3`,
        ruleId: 'firebase-web-key',
        ruleName: 'Firebase web API key (public)',
        severity: 'info',
        confidence: 'high',
        origin: ORIGIN,
        scriptHash: appScriptHash,
        file: 'src/config.ts',
        line: 8,
        column: 12,
        locationKind: 'source',
        preview: 'AIza…9kQ2',
        snippet: 'apiKey: "AIza…9kQ2"',
        secretHash: '33'.repeat(32),
        secret: ['AIza', 'SyPreviewPlaceholderKey000000009kQ2'].join(''),
        occurrences: 1,
        locations: [
          {
            file: 'src/config.ts',
            line: 8,
            column: 12,
            kind: 'source',
            scriptUrl: `${ORIGIN}/app.js`,
            mapUrl: `${ORIGIN}/app.js.map`,
          },
        ],
        references: [],
        createdAt: now,
        updatedAt: now,
      },
    ],
    intel: [
      {
        id: `${ORIGIN}|${appScriptHash}`,
        origin: ORIGIN,
        scriptHash: appScriptHash,
        scriptUrl: `${ORIGIN}/app.js`,
        endpoints: [
          {
            value: '/api/v1/internal/admin-export',
            category: 'admin',
            methods: ['POST'],
            dynamic: false,
            locations: [
              {
                file: 'src/app.js.ts',
                line: 6,
                column: 16,
                kind: 'source',
                scriptUrl: `${ORIGIN}/app.js`,
                mapUrl: `${ORIGIN}/app.js.map`,
              },
            ],
          },
          {
            value: '/graphql',
            category: 'graphql',
            methods: ['POST'],
            dynamic: false,
            locations: [
              {
                file: 'src/checkout.tsx',
                line: 14,
                column: 12,
                kind: 'source',
                scriptUrl: `${ORIGIN}/app.js`,
                mapUrl: `${ORIGIN}/app.js.map`,
              },
            ],
          },
          {
            value: '/api/v1/auth/session',
            category: 'auth',
            methods: ['GET'],
            dynamic: false,
            locations: [
              {
                file: 'src/lib/auth.ts',
                line: 11,
                column: 10,
                kind: 'source',
                scriptUrl: `${ORIGIN}/lazy.mjs`,
                mapUrl: `${ORIGIN}/lazy.mjs.map`,
              },
            ],
          },
          {
            value: '/api/v1/checkout',
            category: 'api',
            methods: ['POST'],
            dynamic: false,
            locations: [
              {
                file: 'src/checkout.tsx',
                line: 22,
                column: 15,
                kind: 'source',
                scriptUrl: `${ORIGIN}/app.js`,
                mapUrl: `${ORIGIN}/app.js.map`,
              },
            ],
          },
        ],
        routes: [
          {
            path: '/admin/audit-logs',
            kind: 'definition',
            locations: [
              {
                file: 'src/admin/export.ts',
                line: 4,
                column: 8,
                kind: 'source',
                scriptUrl: `${ORIGIN}/lazy.mjs`,
                mapUrl: `${ORIGIN}/lazy.mjs.map`,
              },
            ],
          },
          {
            path: '/checkout/confirm',
            kind: 'file',
            locations: [
              {
                file: 'src/checkout.tsx',
                line: 1,
                column: 0,
                kind: 'source',
                scriptUrl: `${ORIGIN}/app.js`,
                mapUrl: `${ORIGIN}/app.js.map`,
              },
            ],
          },
        ],
        comments: [
          {
            marker: 'BYPASS',
            text: 'skip RBAC check in staging until SSO migration finishes',
            level: 'high',
            location: {
              file: 'src/app.js.ts',
              line: 11,
              column: 0,
              kind: 'source',
              scriptUrl: `${ORIGIN}/app.js`,
              mapUrl: `${ORIGIN}/app.js.map`,
            },
          },
        ],
        sinks: [
          {
            ruleId: 'dom-xss-dangerously-set-inner-html',
            title: 'React dangerouslySetInnerHTML',
            category: 'dom-xss',
            level: 'high',
            snippet: '<div dangerouslySetInnerHTML={{ __html: promoBanner }} />',
            location: {
              file: 'src/checkout.tsx',
              line: 34,
              column: 6,
              kind: 'source',
              scriptUrl: `${ORIGIN}/app.js`,
              mapUrl: `${ORIGIN}/app.js.map`,
            },
          },
          {
            ruleId: 'code-eval',
            title: 'Dynamic eval() call',
            category: 'code-injection',
            level: 'high',
            snippet: 'return eval(filterExpr);',
            location: {
              file: 'src/admin/export.ts',
              line: 19,
              column: 9,
              kind: 'source',
              scriptUrl: `${ORIGIN}/lazy.mjs`,
              mapUrl: `${ORIGIN}/lazy.mjs.map`,
            },
          },
        ],
        modules: [
          {
            file: 'src/app.js.ts',
            scriptUrl: `${ORIGIN}/app.js`,
            mapUrl: `${ORIGIN}/app.js.map`,
            imports: ['./checkout', '@sentry/browser'],
            exports: ['exportAudit'],
            endpoints: [
              {
                value: '/api/v1/internal/admin-export',
                methods: ['POST'],
                category: 'admin',
                line: 6,
              },
            ],
            sdks: [{ name: 'Sentry', category: 'monitoring', source: 'import' }],
          },
          {
            file: 'src/checkout.tsx',
            scriptUrl: `${ORIGIN}/app.js`,
            mapUrl: `${ORIGIN}/app.js.map`,
            imports: ['@stripe/stripe-js', '@supabase/supabase-js'],
            exports: ['CheckoutPage'],
            endpoints: [
              { value: '/api/v1/checkout', methods: ['POST'], category: 'api', line: 22 },
            ],
            sdks: [
              { name: 'Stripe', category: 'payment', source: 'import' },
              { name: 'Supabase', category: 'backend', source: 'import' },
            ],
          },
        ],
        osint: [
          {
            category: 'cloud',
            kind: 'AWS S3 Bucket',
            value: 's3://shop-media-prod',
            locations: [
              {
                file: 'src/config.ts',
                line: 14,
                column: 18,
                kind: 'source',
                scriptUrl: `${ORIGIN}/app.js`,
                mapUrl: `${ORIGIN}/app.js.map`,
              },
            ],
          },
          {
            category: 'subdomain',
            kind: 'Subdomain Reference',
            value: 'staging-api.shop.example.com',
            detail: 'env: staging',
            locations: [
              {
                file: 'src/config.ts',
                line: 18,
                column: 14,
                kind: 'source',
                scriptUrl: `${ORIGIN}/app.js`,
                mapUrl: `${ORIGIN}/app.js.map`,
              },
            ],
          },
          {
            category: 'build-path',
            kind: 'macOS Home Path',
            value: '/Users/a***e/shop-web',
            detail: 'source map path (user masked)',
            locations: [
              {
                file: 'sourcemap.sources',
                line: 1,
                column: 0,
                kind: 'source',
                scriptUrl: `${ORIGIN}/app.js`,
                mapUrl: `${ORIGIN}/app.js.map`,
              },
            ],
          },
        ],
        truncated: false,
        updatedAt: now,
      },
    ],
    audits: [
      {
        id: `${ORIGIN}|/`,
        origin: ORIGIN,
        pageUrl: `${ORIGIN}/`,
        headers: {
          'content-security-policy': "default-src * 'unsafe-inline' 'unsafe-eval'",
          'strict-transport-security': 'max-age=31536000; includeSubDomains',
          'x-frame-options': null,
          'access-control-allow-origin': '*',
        },
        matrix: [
          {
            header: 'Content-Security-Policy',
            status: 'weak',
            value: "default-src * 'unsafe-inline' 'unsafe-eval'",
          },
          {
            header: 'Strict-Transport-Security',
            status: 'ok',
            value: 'max-age=31536000; includeSubDomains',
          },
          {
            header: 'X-Frame-Options',
            status: 'missing',
          },
          {
            header: 'Access-Control-Allow-Origin',
            status: 'weak',
            value: '*',
          },
        ],
        storageKeysChecked: 12,
        cookiesChecked: 3,
        findings: [
          {
            id: 'headers|csp-unsafe-inline',
            category: 'headers',
            ruleId: 'csp-unsafe-inline',
            severity: 'high',
            title: "CSP allows 'unsafe-inline' scripts",
            subject: 'Content-Security-Policy',
            detail: "Allows inline script execution via 'unsafe-inline' and 'unsafe-eval'.",
            recommendation: "Remove 'unsafe-inline' and use nonces or hashes.",
          },
          {
            id: 'storage|jwt-localstorage',
            category: 'storage',
            ruleId: 'storage-jwt',
            severity: 'high',
            title: 'JWT stored in localStorage',
            subject: 'localStorage:auth_token',
            detail: 'Readable by any XSS payload in the page origin.',
            preview: 'eyJh…9xQp',
            recommendation: 'Move session tokens to HttpOnly, Secure cookies.',
          },
          {
            id: 'cookie|session-no-httponly',
            category: 'cookie',
            ruleId: 'cookie-missing-httponly',
            severity: 'high',
            title: 'Sensitive cookie "session_id" lacks HttpOnly',
            subject: 'session_id',
            detail: 'Readable via document.cookie; Secure attribute missing.',
            recommendation: 'Set HttpOnly; Secure; SameSite=Lax on session cookies.',
          },
          {
            id: 'headers|cors-wildcard',
            category: 'headers',
            ruleId: 'cors-wildcard',
            severity: 'medium',
            title: 'Permissive CORS Access-Control-Allow-Origin: *',
            subject: 'Access-Control-Allow-Origin',
            detail: 'Any third-party origin can read responses.',
            recommendation: 'Restrict allowed origins to explicit trusted domains.',
          },
        ],
        updatedAt: now,
      },
    ],
    snapshots: [
      {
        id: `${ORIGIN}|${now - 3_600_000}|1`,
        origin: ORIGIN,
        createdAt: now - 3_600_000,
        signature: 'snap-v1-prev',
        frozen: true,
        scriptHashes: [appScriptHash],
        files: [
          { path: 'src/app.js.ts', hash: 'h1', size: 4200 },
          { path: 'src/config.ts', hash: 'h2', size: 2100 },
        ],
        endpoints: ['/api/v1/checkout', '/api/v1/auth/session', '/graphql'],
        routes: ['/checkout/confirm'],
        findings: [
          {
            key: `github-pat|${'11'.repeat(32)}`,
            ruleId: 'github-pat',
            ruleName: 'GitHub personal access token (classic)',
            severity: 'critical',
            file: 'src/app.js.ts',
            line: 2,
          },
        ],
        sinks: [
          {
            key: 'dom-xss-dangerously-set-inner-html|src/checkout.tsx:34',
            ruleId: 'dom-xss-dangerously-set-inner-html',
            title: 'React dangerouslySetInnerHTML',
            category: 'dom-xss',
            level: 'high',
            file: 'src/checkout.tsx',
            line: 34,
          },
        ],
      },
      {
        id: `${ORIGIN}|${now}|2`,
        origin: ORIGIN,
        createdAt: now,
        signature: 'snap-v2-curr',
        scriptHashes: [appScriptHash, chunkScriptHash, lazyScriptHash],
        files: [
          { path: 'src/app.js.ts', hash: 'h1', size: 4200 },
          { path: 'src/config.ts', hash: 'h2', size: 2100 },
          { path: 'src/admin/export.ts', hash: 'h3', size: 3100 },
        ],
        endpoints: [
          '/api/v1/checkout',
          '/api/v1/auth/session',
          '/graphql',
          '/api/v1/internal/admin-export',
        ],
        routes: ['/checkout/confirm', '/admin/audit-logs'],
        findings: [
          {
            key: `github-pat|${'11'.repeat(32)}`,
            ruleId: 'github-pat',
            ruleName: 'GitHub personal access token (classic)',
            severity: 'critical',
            file: 'src/app.js.ts',
            line: 2,
          },
        ],
        sinks: [
          {
            key: 'dom-xss-dangerously-set-inner-html|src/checkout.tsx:34',
            ruleId: 'dom-xss-dangerously-set-inner-html',
            title: 'React dangerouslySetInnerHTML',
            category: 'dom-xss',
            level: 'high',
            file: 'src/checkout.tsx',
            line: 34,
          },
          {
            key: 'code-eval|src/admin/export.ts:19',
            ruleId: 'code-eval',
            title: 'Dynamic eval() call',
            category: 'code-injection',
            level: 'high',
            file: 'src/admin/export.ts',
            line: 19,
          },
        ],
      },
    ],
  };
}

function buildHeroHtml(panelDataUri: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    width: 1280px;
    height: 800px;
    overflow: hidden;
    background: #080a0e;
    color: #f4f4f5;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Inter, Roboto, sans-serif;
    position: relative;
  }
  .bg-grid {
    position: absolute;
    inset: 0;
    background-image:
      linear-gradient(rgba(255,255,255,0.022) 1px, transparent 1px),
      linear-gradient(90deg, rgba(255,255,255,0.022) 1px, transparent 1px);
    background-size: 32px 32px;
  }
  .glow-left {
    position: absolute;
    width: 720px;
    height: 720px;
    left: -140px;
    top: -120px;
    background: radial-gradient(circle, rgba(16,185,129,0.16) 0%, rgba(16,185,129,0.04) 45%, transparent 72%);
  }
  .glow-right {
    position: absolute;
    width: 680px;
    height: 680px;
    right: -140px;
    bottom: -160px;
    background: radial-gradient(circle, rgba(239,68,68,0.12) 0%, rgba(239,68,68,0.03) 45%, transparent 72%);
  }
  .layout {
    position: relative;
    z-index: 1;
    display: grid;
    grid-template-columns: 410px 475px 315px;
    gap: 24px;
    padding: 30px 28px;
    height: 800px;
    align-items: center;
  }

  /* Left column */
  .brand {
    display: flex;
    align-items: center;
    gap: 12px;
    margin-bottom: 26px;
  }
  .brand-logo svg { width: 38px; height: 38px; display: block; }
  .brand-name { font-size: 26px; font-weight: 700; letter-spacing: -0.02em; color: #ffffff; }
  .version-pill {
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    font-size: 11px;
    font-weight: 600;
    color: #34d399;
    background: rgba(16,185,129,0.12);
    border: 1px solid rgba(16,185,129,0.28);
    padding: 3px 8px;
    border-radius: 999px;
  }
  .headline {
    font-size: 38px;
    line-height: 1.1;
    font-weight: 800;
    letter-spacing: -0.03em;
    color: #fafafa;
    margin-bottom: 18px;
  }
  .headline .accent { color: #10b981; }
  .subtitle {
    font-size: 15px;
    line-height: 1.55;
    color: #a1a1aa;
    margin-bottom: 24px;
  }
  .bullets { list-style: none; display: flex; flex-direction: column; gap: 13px; margin-bottom: 28px; }
  .bullets li {
    display: flex;
    align-items: flex-start;
    gap: 10px;
    font-size: 13.5px;
    line-height: 1.4;
    color: #d4d4d8;
  }
  .check {
    width: 18px;
    height: 18px;
    border-radius: 5px;
    background: rgba(16,185,129,0.14);
    border: 1px solid rgba(16,185,129,0.3);
    color: #34d399;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    font-size: 11px;
    font-weight: 700;
    flex-shrink: 0;
    margin-top: 1px;
  }
  .bullets strong { color: #ffffff; font-weight: 650; }
  .badges { display: flex; flex-wrap: wrap; gap: 8px; }
  .pill {
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    font-size: 11px;
    color: #a1a1aa;
    background: rgba(255,255,255,0.03);
    border: 1px solid rgba(255,255,255,0.1);
    padding: 5px 11px;
    border-radius: 999px;
  }

  /* Middle column */
  .middle-wrap {
    position: relative;
    padding-bottom: 64px;
  }
  .eyebrow {
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.08em;
    color: #10b981;
    margin-bottom: 10px;
  }
  .editor {
    background: #0d1017;
    border: 1px solid rgba(255,255,255,0.09);
    border-radius: 12px;
    overflow: hidden;
    box-shadow: 0 24px 60px rgba(0,0,0,0.6);
  }
  .editor-bar {
    display: flex;
    align-items: center;
    gap: 7px;
    padding: 10px 14px;
    background: rgba(255,255,255,0.025);
    border-bottom: 1px solid rgba(255,255,255,0.07);
  }
  .dot { width: 9px; height: 9px; border-radius: 50%; background: #3f3f46; }
  .editor-path {
    margin-left: 6px;
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    font-size: 11px;
    color: #71717a;
  }
  .editor-body {
    display: grid;
    grid-template-columns: 142px 1fr;
    min-height: 356px;
  }
  .tree {
    border-right: 1px solid rgba(255,255,255,0.06);
    padding: 12px 0;
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    font-size: 10.5px;
    line-height: 1.9;
    color: #a1a1aa;
  }
  .tree-row { padding: 0 10px; white-space: nowrap; }
  .tree-row.active {
    background: rgba(16,185,129,0.12);
    color: #34d399;
    border-left: 2px solid #10b981;
  }
  .tree-row.report { color: #d4d4d8; }
  .tree-row.report-hi { color: #6ee7b7; }
  .tree-sep {
    height: 1px;
    background: rgba(255,255,255,0.06);
    margin: 6px 10px;
  }
  .code {
    padding: 12px 0;
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    font-size: 10.2px;
    line-height: 1.95;
    color: #e4e4e7;
    overflow: hidden;
  }
  .code-line {
    display: flex;
    padding: 0 12px;
    white-space: pre;
  }
  .ln {
    width: 22px;
    color: #52525b;
    text-align: right;
    margin-right: 12px;
    flex-shrink: 0;
    user-select: none;
  }
  .code-line.secret-hit {
    background: rgba(239,68,68,0.16);
    border-left: 2px solid #ef4444;
    padding-left: 10px;
  }
  .code-line.endpoint-hit {
    background: rgba(16,185,129,0.12);
    border-left: 2px solid #10b981;
    padding-left: 10px;
  }
  .kw { color: #c4b5fd; }
  .str { color: #fcd34d; }
  .ep { color: #34d399; font-weight: 600; }
  .cmt { color: #71717a; }
  .sec-val { color: #fca5a5; font-weight: 600; }

  .float-card {
    position: absolute;
    right: -8px;
    bottom: -4px;
    width: 290px;
    background: #140f12;
    border: 1px solid rgba(239,68,68,0.42);
    border-radius: 11px;
    padding: 14px 16px;
    box-shadow: 0 18px 42px rgba(0,0,0,0.72);
  }
  .float-meta {
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    font-size: 10.5px;
    font-weight: 700;
    color: #f87171;
    margin-bottom: 5px;
  }
  .float-meta span { color: #a1a1aa; font-weight: 500; }
  .float-title {
    font-size: 14px;
    font-weight: 700;
    color: #ffffff;
    margin-bottom: 4px;
  }
  .float-sub {
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    font-size: 11px;
    color: #a1a1aa;
    margin-bottom: 10px;
  }
  .float-badges { display: flex; gap: 6px; align-items: center; }
  .verified-pill {
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    font-size: 10px;
    font-weight: 600;
    color: #34d399;
    background: rgba(16,185,129,0.14);
    border: 1px solid rgba(16,185,129,0.3);
    padding: 3px 8px;
    border-radius: 5px;
  }
  .endpoint-pill {
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    font-size: 10px;
    color: #d4d4d8;
    background: rgba(255,255,255,0.05);
    border: 1px solid rgba(255,255,255,0.1);
    padding: 3px 8px;
    border-radius: 5px;
  }

  /* Right column: Live Side Panel screenshot */
  .panel-frame {
    height: 740px;
    border-radius: 14px;
    overflow: hidden;
    border: 1px solid rgba(255,255,255,0.12);
    background: #0b0d11;
    box-shadow: 0 24px 64px rgba(0,0,0,0.75);
  }
  .panel-frame img {
    width: 100%;
    height: 100%;
    object-fit: cover;
    object-position: top center;
    display: block;
  }
</style>
</head>
<body>
  <div class="bg-grid"></div>
  <div class="glow-left"></div>
  <div class="glow-right"></div>
  <div class="layout">
    <div class="left">
      <div class="brand">
        <div class="brand-logo">${logoSvg}</div>
        <span class="brand-name">MapHound</span>
        <span class="version-pill">v0.4.0</span>
      </div>
      <h1 class="headline">
        Exposed source maps,<br/>
        <span class="accent">rebuilt and audited</span><br/>
        right in your browser.
      </h1>
      <p class="subtitle">
        Recovers the original source tree behind a site's JavaScript and audits secrets, endpoints, passive OSINT, and headers. Nothing leaves your machine.
      </p>
      <ul class="bullets">
        <li>
          <span class="check">✓</span>
          <span><strong>Source map reconstruction</strong> with Zip-Slip-safe export &amp; SARIF v2.1.0</span>
        </li>
        <li>
          <span class="check">✓</span>
          <span><strong>55 ReDoS-proven detectors</strong>, offline CRC32 &amp; JWT checks</span>
        </li>
        <li>
          <span class="check">✓</span>
          <span><strong>Endpoint, sink, OSINT &amp; security audit</strong> in a linear-time analyzer</span>
        </li>
        <li>
          <span class="check">✓</span>
          <span><strong>Zero static host permissions</strong>, single &amp; bulk CDN origin control</span>
        </li>
      </ul>
      <div class="badges">
        <span class="pill">Manifest V3</span>
        <span class="pill">100% local</span>
        <span class="pill">SARIF v2.1.0</span>
        <span class="pill">MIT</span>
      </div>
    </div>

    <div class="middle-wrap">
      <div class="eyebrow">REBUILT FROM app.js.map</div>
      <div class="editor">
        <div class="editor-bar">
          <span class="dot"></span><span class="dot"></span><span class="dot"></span>
          <span class="editor-path">source/shop.example.com/app.js/src/app.js.ts</span>
        </div>
        <div class="editor-body">
          <div class="tree">
            <div class="tree-row">▾ source</div>
            <div class="tree-row" style="padding-left:20px">▾ shop.example.com</div>
            <div class="tree-row" style="padding-left:30px">▾ app.js</div>
            <div class="tree-row" style="padding-left:40px">▾ src</div>
            <div class="tree-row active" style="padding-left:48px">app.js.ts</div>
            <div class="tree-row" style="padding-left:50px">checkout.tsx</div>
            <div class="tree-row" style="padding-left:50px">config.ts</div>
            <div class="tree-row" style="padding-left:40px">▸ _vendor</div>
            <div class="tree-sep"></div>
            <div class="tree-row report">FINDINGS.md</div>
            <div class="tree-row report">ENDPOINTS.md</div>
            <div class="tree-row report-hi">OSINT.md</div>
            <div class="tree-row report">AUDIT.md</div>
            <div class="tree-row report">ARCHITECTURE.md</div>
            <div class="tree-row report">DIFF.md</div>
            <div class="tree-row report-hi">results.sarif</div>
          </div>
          <div class="code">
            <div class="code-line"><span class="ln">1</span><span><span class="kw">export const</span> name = <span class="str">'app.js'</span>;</span></div>
            <div class="code-line secret-hit"><span class="ln">2</span><span><span class="kw">export const</span> githubToken = <span class="sec-val">"ghp_…AF1p"</span>;</span></div>
            <div class="code-line"><span class="ln">3</span><span></span></div>
            <div class="code-line"><span class="ln">4</span><span><span class="kw">export async function</span> exportAudit() {</span></div>
            <div class="code-line"><span class="ln">5</span><span>  <span class="kw">const</span> auth = <span class="str">\`token \${githubToken}\`</span>;</span></div>
            <div class="code-line endpoint-hit"><span class="ln">6</span><span>  <span class="kw">return</span> fetch(<span class="ep">'/api/v1/internal/admin-export'</span>, {</span></div>
            <div class="code-line"><span class="ln">7</span><span>    method: <span class="str">'POST'</span>,</span></div>
            <div class="code-line"><span class="ln">8</span><span>    headers: { Authorization: auth },</span></div>
            <div class="code-line"><span class="ln">9</span><span>  });</span></div>
            <div class="code-line"><span class="ln">10</span><span>}</span></div>
            <div class="code-line"><span class="ln">11</span><span><span class="cmt">// BYPASS: skip RBAC check in staging</span></span></div>
          </div>
        </div>
      </div>
      <div class="float-card">
        <div class="float-meta">CRITICAL <span>· src/app.js.ts:2</span></div>
        <div class="float-title">GitHub personal access token</div>
        <div class="float-sub">ghp_…AF1p · CRC32 checksum valid</div>
        <div class="float-badges">
          <span class="verified-pill">verified format</span>
          <span class="endpoint-pill">SARIF + Draft ready</span>
        </div>
      </div>
    </div>

    <div class="panel-frame">
      <img src="${panelDataUri}" alt="MapHound v0.4.0 live side panel" />
    </div>
  </div>
</body>
</html>`;
}

function buildIntelShowcaseHtml(endpointsUri: string, osintUri: string, auditUri: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    width: 1280px;
    height: 800px;
    overflow: hidden;
    background: #080a0e;
    color: #f4f4f5;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Inter, Roboto, sans-serif;
    position: relative;
  }
  .bg-grid {
    position: absolute;
    inset: 0;
    background-image:
      linear-gradient(rgba(255,255,255,0.02) 1px, transparent 1px),
      linear-gradient(90deg, rgba(255,255,255,0.02) 1px, transparent 1px);
    background-size: 32px 32px;
  }
  .glow-top {
    position: absolute;
    width: 900px;
    height: 460px;
    left: 190px;
    top: -180px;
    background: radial-gradient(circle, rgba(16,185,129,0.14) 0%, transparent 70%);
  }
  .wrap {
    position: relative;
    z-index: 1;
    padding: 28px 34px 26px;
    height: 800px;
    display: flex;
    flex-direction: column;
    gap: 20px;
  }
  .header {
    display: flex;
    align-items: center;
    justify-content: space-between;
  }
  .header-left { display: flex; align-items: center; gap: 14px; }
  .header-logo svg { width: 32px; height: 32px; display: block; }
  .title { font-size: 24px; font-weight: 800; letter-spacing: -0.02em; color: #ffffff; }
  .title span { color: #10b981; }
  .sub { font-size: 13px; color: #a1a1aa; margin-top: 2px; }
  .header-pills { display: flex; gap: 8px; }
  .pill {
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    font-size: 11px;
    color: #a1a1aa;
    background: rgba(255,255,255,0.03);
    border: 1px solid rgba(255,255,255,0.1);
    padding: 5px 11px;
    border-radius: 999px;
  }
  .pill.green {
    color: #34d399;
    border-color: rgba(16,185,129,0.3);
    background: rgba(16,185,129,0.1);
  }
  .grid {
    flex: 1;
    min-height: 0;
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 22px;
  }
  .col {
    display: flex;
    flex-direction: column;
    gap: 10px;
    min-height: 0;
  }
  .col-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0 2px;
  }
  .col-title {
    font-size: 13px;
    font-weight: 700;
    color: #f4f4f5;
    letter-spacing: -0.01em;
  }
  .col-tag {
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    font-size: 10.5px;
    color: #34d399;
    background: rgba(16,185,129,0.1);
    border: 1px solid rgba(16,185,129,0.25);
    padding: 2px 7px;
    border-radius: 5px;
  }
  .col-tag.sky {
    color: #38bdf8;
    background: rgba(56,189,248,0.1);
    border-color: rgba(56,189,248,0.25);
  }
  .col-tag.amber {
    color: #fbbf24;
    background: rgba(251,191,36,0.1);
    border-color: rgba(251,191,36,0.25);
  }
  .shot {
    flex: 1;
    min-height: 0;
    border-radius: 13px;
    overflow: hidden;
    border: 1px solid rgba(255,255,255,0.11);
    background: #0b0d11;
    box-shadow: 0 20px 50px rgba(0,0,0,0.65);
  }
  .shot img {
    width: 100%;
    height: 100%;
    object-fit: cover;
    object-position: top center;
    display: block;
  }
</style>
</head>
<body>
  <div class="bg-grid"></div>
  <div class="glow-top"></div>
  <div class="wrap">
    <div class="header">
      <div class="header-left">
        <div class="header-logo">${logoSvg}</div>
        <div>
          <h1 class="title">Attack Surface, <span>Passive OSINT</span> &amp; Security Audit</h1>
          <p class="sub">Real-time Side Panel views captured on https://shop.example.com — 100% offline analysis, zero background API requests</p>
        </div>
      </div>
      <div class="header-pills">
        <span class="pill green">v0.4.0 Live UI</span>
        <span class="pill">OSINT.md · AUDIT.md · ENDPOINTS.md</span>
      </div>
    </div>
    <div class="grid">
      <div class="col">
        <div class="col-head">
          <span class="col-title">Endpoints &amp; Frontend Routes</span>
          <span class="col-tag">ENDPOINTS.md</span>
        </div>
        <div class="shot"><img src="${endpointsUri}" alt="Endpoints tab" /></div>
      </div>
      <div class="col">
        <div class="col-head">
          <span class="col-title">Passive OSINT &amp; 1-Click Launcher</span>
          <span class="col-tag sky">OSINT.md</span>
        </div>
        <div class="shot"><img src="${osintUri}" alt="OSINT tab" /></div>
      </div>
      <div class="col">
        <div class="col-head">
          <span class="col-title">HTTP Headers, Cookies &amp; Storage</span>
          <span class="col-tag amber">AUDIT.md</span>
        </div>
        <div class="shot"><img src="${auditUri}" alt="Security Audit tab" /></div>
      </div>
    </div>
  </div>
</body>
</html>`;
}

async function main() {
  const userDataDir = mkdtempSync(join(tmpdir(), 'mh-preview-'));
  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    locale: 'en-US',
    viewport: { width: 390, height: 900 },
    deviceScaleFactor: 2,
    args: [
      '--headless=new',
      '--lang=en-US',
      `--disable-extensions-except=${EXTENSION_DIR}`,
      `--load-extension=${EXTENSION_DIR}`,
    ],
  });

  try {
    const [existingSw] = context.serviceWorkers();
    const sw = existingSw ?? (await context.waitForEvent('serviceworker'));
    const extensionId = new URL(sw.url()).host;

    const panel = await context.newPage();
    await panel.setViewportSize({ width: 390, height: 900 });
    await panel.goto(`chrome-extension://${extensionId}/sidepanel.html`);
    await panel.waitForSelector('[data-testid="origin-input"]');

    // Wait for the extension's own getDb() to initialize the v4 IndexedDB schema.
    await panel.waitForFunction(async () => {
      try {
        const db = await new Promise<IDBDatabase>((res, rej) => {
          const req = indexedDB.open('maphound');
          req.onsuccess = () => res(req.result);
          req.onerror = () => rej(req.error);
        });
        const ready = db.version >= 4 && db.objectStoreNames.contains('snapshots');
        db.close();
        return ready;
      } catch {
        return false;
      }
    });

    const seed = buildSeedData();
    await panel.evaluate(async (data) => {
      const db = await new Promise<IDBDatabase>((resolveDb, rejectDb) => {
        const req = indexedDB.open('maphound', 4);
        req.onsuccess = () => resolveDb(req.result);
        req.onerror = () => rejectDb(req.error);
      });
      const stores = [
        'sites',
        'scripts',
        'jobs',
        'maps',
        'findings',
        'intel',
        'audits',
        'snapshots',
      ] as const;
      const tx = db.transaction([...stores], 'readwrite');
      for (const storeName of stores) {
        const store = tx.objectStore(storeName);
        for (const item of data[storeName]) {
          store.put(item);
        }
      }
      await new Promise<void>((res, rej) => {
        tx.oncomplete = () => res();
        tx.onerror = () => rej(tx.error);
      });
      db.close();
    }, seed);

    await panel.reload();
    await panel.waitForSelector('[data-testid="origin-input"]');
    await panel.getByTestId('origin-input').fill(ORIGIN);
    await panel.getByTestId('origin-submit').click();
    await panel.getByTestId('stat-maps').waitFor({ state: 'visible', timeout: 15_000 });
    await panel.waitForFunction(
      () => document.querySelector('[data-testid="stat-maps"]')?.textContent?.trim() === '3',
    );
    await panel.waitForTimeout(250);

    // 1. Live Overview screenshot (full panel)
    const overviewPng = await panel.screenshot({ type: 'png' });

    // Hide the site card + sticky export bar slightly for dense tab captures in the 2nd showcase
    // so the actual Endpoints / OSINT / Security Audit content fills the 3-up frames crisply.
    await panel.setViewportSize({ width: 390, height: 740 });
    await panel.addStyleTag({
      content: `
        ::-webkit-scrollbar { display: none; }
        .sticky.bottom-0 { display: none !important; }
        header,
        .flex.min-h-screen > div:has([data-testid="site-status"]),
        .flex.min-h-screen > div:has([data-testid="stat-scripts"]) {
          display: none !important;
        }
      `,
    });

    // Helper to capture each tab from the exact top edge of TabBar
    const captureTab = async (tabId: string) => {
      await panel.getByTestId(tabId).click();
      await panel.evaluate(() => window.scrollTo(0, 0));
      await panel.waitForTimeout(200);
      return panel.screenshot({ type: 'png' });
    };

    const endpointsPng = await captureTab('tab-endpoints');
    const osintPng = await captureTab('tab-osint');
    const auditPng = await captureTab('tab-audit');

    // Compose the two 1280x800 showcase PNGs using a clean page
    const canvas = await context.newPage();
    await canvas.setViewportSize({ width: 1280, height: 800 });

    await canvas.setContent(buildHeroHtml(toDataUri(overviewPng)), { waitUntil: 'load' });
    const heroOut = join(ASSETS_DIR, 'maphound-preview.png');
    writeFileSync(heroOut, await canvas.screenshot({ type: 'png' }));
    console.log(`Generated ${heroOut}`);

    await canvas.setContent(
      buildIntelShowcaseHtml(toDataUri(endpointsPng), toDataUri(osintPng), toDataUri(auditPng)),
      { waitUntil: 'load' },
    );
    const intelOut = join(ASSETS_DIR, 'maphound-intel-preview.png');
    writeFileSync(intelOut, await canvas.screenshot({ type: 'png' }));
    console.log(`Generated ${intelOut}`);
  } finally {
    await context.close();
    rmSync(userDataDir, { recursive: true, force: true });
  }
}

await main();
