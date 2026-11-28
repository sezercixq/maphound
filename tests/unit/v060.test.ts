import { describe, expect, it } from 'vitest';
import { auditJwtDeep, auditStorageEntries, inspectJwtToken } from '@/engine/audit';
import { buildOpenApiSpec, buildSarifLog } from '@/engine/export';
import { analyzeSourceFile } from '@/engine/intel';

const b64u = (obj: unknown) => Buffer.from(JSON.stringify(obj)).toString('base64url');

describe('v0.6.0 source-to-sink taint flow tracker', () => {
  it('detects confirmed source-to-sink flows across assignments and destructuring and clears on sanitizers', () => {
    const code = [
      'function renderProfile() {',
      '  const params = new URLSearchParams(location.search);',
      '  const rawName = params.get("name");',
      '  document.getElementById("out").innerHTML = rawName;',
      '  const safe = DOMPurify.sanitize(rawName);',
      '  document.getElementById("safe").innerHTML = safe;',
      '}',
      'function handleRedirect() {',
      '  const { nextUrl } = JSON.parse(sessionStorage.getItem("redir"));',
      '  window.location.assign(nextUrl);',
      '}',
      'function handleMerge(event) {',
      '  const payload = event.data;',
      '  Object.assign(targetObj, payload);',
      '}',
    ].join('\n');

    const intel = analyzeSourceFile(code, {
      file: 'src/profile.ts',
      kind: 'source',
      scriptUrl: 'https://app.example.com/app.js',
    });

    const flows = intel.sinks.filter((s) => s.category === 'taint-flow');
    expect(
      flows.some(
        (f) => f.ruleId === 'taint-dom-xss' && f.trace?.sourceLine === 2 && f.trace?.sinkLine === 4,
      ),
    ).toBe(true);
    // Line 6 is sanitized via DOMPurify.sanitize -> must NOT be flagged as taint flow
    expect(flows.some((f) => f.trace?.sinkLine === 6)).toBe(false);
    expect(flows.some((f) => f.ruleId === 'taint-open-redirect' && f.trace?.sinkLine === 10)).toBe(
      true,
    );
    expect(
      flows.some((f) => f.ruleId === 'taint-proto-pollution' && f.trace?.sinkLine === 14),
    ).toBe(true);

    const sarif = buildSarifLog({
      findings: [],
      sinks: flows,
      origin: 'https://app.example.com',
      version: '0.6.0',
    });
    expect(sarif.runs[0].results[0]?.message.text).toContain('Flow:');
  });
});

describe('v0.6.0 postMessage & AuthZ/IDOR surface analyzer', () => {
  it('flags unvalidated postMessage handlers, client-side authz gates and IDOR endpoints', () => {
    const code = [
      'window.addEventListener("message", (event) => {',
      '  applyTheme(event.data);',
      '});',
      'window.addEventListener("message", (event) => {',
      '  if (event.origin !== "https://trusted.example.com") return;',
      '  applyTheme(event.data);',
      '});',
      'export function renderPanel(user) {',
      '  if (user.isAdmin || user.permissions.includes("billing:write")) {',
      '    fetch(`/api/v1/users/${userId}/invoices?accountId=42`);',
      '  }',
      '}',
    ].join('\n');

    const intel = analyzeSourceFile(code, {
      file: 'src/admin.ts',
      kind: 'source',
      scriptUrl: 'https://app.example.com/app.js',
    });

    const authz = intel.sinks.filter((s) => s.category === 'authz-idor');
    const unvalidated = authz.filter((h) => h.ruleId === 'authz-unvalidated-postmessage');
    expect(unvalidated).toHaveLength(1);
    expect(unvalidated[0]?.location.line).toBe(1);
    expect(authz.some((h) => h.ruleId === 'authz-client-gate')).toBe(true);
    expect(authz.some((h) => h.ruleId === 'authz-idor-candidate')).toBe(true);
  });
});

describe('v0.6.0 cryptographic weakness & deep JWT auditor', () => {
  it('flags Math.random in security context, MD5/SHA-1, ECB mode, static IV and deep JWT issues', () => {
    const badJwt = `${b64u({ alg: 'none', typ: 'JWT' })}.${b64u({
      sub: 'u1',
      admin: true,
      role: 'superadmin',
      iat: 1700000000,
      exp: 1700000000 + 90 * 86_400,
    })}.sigplaceholder1234567890`;

    const code = [
      'function generateCsrfToken() {',
      '  return Math.random().toString(36).slice(2);',
      '}',
      'function randomColor() {',
      '  return Math.floor(Math.random() * 255);',
      '}',
      'const digest = CryptoJS.MD5(password);',
      'const encrypted = CryptoJS.AES.encrypt(data, key, { mode: CryptoJS.mode.ECB, iv: "1234567890abcdef" });',
      `const hardcodedJwt = "${badJwt}";`,
    ].join('\n');

    const intel = analyzeSourceFile(code, {
      file: 'src/crypto.ts',
      kind: 'source',
      scriptUrl: 'https://app.example.com/app.js',
    });

    const cryptoHits = intel.sinks.filter((s) => s.category === 'crypto');
    expect(cryptoHits.some((h) => h.ruleId === 'crypto-math-random' && h.location.line === 2)).toBe(
      true,
    );
    // Line 5 (randomColor) is NOT in security context
    expect(cryptoHits.some((h) => h.ruleId === 'crypto-math-random' && h.location.line === 5)).toBe(
      false,
    );
    expect(cryptoHits.some((h) => h.ruleId === 'crypto-weak-hash')).toBe(true);
    expect(cryptoHits.some((h) => h.ruleId === 'crypto-ecb-mode')).toBe(true);
    expect(cryptoHits.some((h) => h.ruleId === 'crypto-static-iv-salt')).toBe(true);
    expect(cryptoHits.some((h) => h.ruleId === 'jwt-alg-none')).toBe(true);
    expect(cryptoHits.some((h) => h.ruleId === 'jwt-long-lived')).toBe(true);
    expect(cryptoHits.some((h) => h.ruleId === 'jwt-privileged-claims')).toBe(true);
    // Raw JWT must NEVER leak unmasked in snippets
    expect(JSON.stringify(cryptoHits)).not.toContain(badJwt);

    const jwtIssues = inspectJwtToken(badJwt);
    expect(jwtIssues.map((i) => i.ruleId)).toEqual([
      'jwt-alg-none',
      'jwt-long-lived',
      'jwt-privileged-claims',
    ]);

    const storageFindings = auditStorageEntries(
      [{ key: 'auth_jwt', value: badJwt }],
      'localStorage',
    );
    expect(
      storageFindings.some((f) => f.ruleId === 'jwt-alg-none' && f.severity === 'critical'),
    ).toBe(true);
    expect(auditJwtDeep(badJwt, 'session_jwt', 'cookie')).toHaveLength(3);
  });
});

describe('v0.6.0 OpenAPI 3.0.3 generator', () => {
  it('generates Burp/Postman compatible OpenAPI 3.0.3 spec with parameters, requestBody and securitySchemes', () => {
    const spec = buildOpenApiSpec({
      origin: 'https://shop.example.com',
      version: '0.6.0',
      endpoints: [
        {
          value: '/api/v1/users/:userId/orders?status=open&accountId=1',
          category: 'api',
          methods: ['GET', 'POST'],
          dynamic: true,
          locations: [
            {
              file: 'src/orders.ts',
              line: 12,
              column: 4,
              kind: 'source',
              scriptUrl: 'https://shop.example.com/app.js',
            },
          ],
        },
        {
          value: '/api/v1/internal/export',
          category: 'admin',
          methods: ['POST'],
          dynamic: false,
          locations: [],
        },
      ],
    });

    expect(spec.openapi).toBe('3.0.3');
    expect(spec.servers[0]?.url).toBe('https://shop.example.com');
    expect(spec.components.securitySchemes.BearerAuth.scheme).toBe('bearer');
    expect(spec.components.securitySchemes.ApiKeyAuth.name).toBe('X-API-Key');

    const ordersPath = spec.paths['/api/v1/users/{userId}/orders'];
    expect(ordersPath?.get?.parameters?.map((p) => `${p.in}:${p.name}`)).toEqual([
      'path:userId',
      'query:status',
      'query:accountId',
    ]);
    expect(ordersPath?.post?.requestBody?.content['application/json']).toBeDefined();
    expect(spec.paths['/api/v1/internal/export']?.post?.security).toEqual([
      { BearerAuth: [] },
      { ApiKeyAuth: [] },
    ]);
  });
});
