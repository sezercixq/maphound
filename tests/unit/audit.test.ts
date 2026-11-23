import { describe, expect, it } from 'vitest';
import type { AuditRecord } from '@/core/db';
import {
  auditCookies,
  auditHeaders,
  auditMarkdown,
  auditSetCookieHeaders,
  auditStorageEntries,
} from '@/engine/audit';

function fakeJwt(payloadObj: Record<string, unknown>): string {
  const b64 = (obj: unknown) => Buffer.from(JSON.stringify(obj)).toString('base64url');
  return `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64(payloadObj)}.signature1234567890abcdef`;
}

describe('auditHeaders', () => {
  it('flags missing or weak CSP, HSTS, XFO, XCTO, Referrer-Policy and wildcard CORS', () => {
    const out = auditHeaders(
      {
        'Content-Security-Policy': "default-src * 'unsafe-inline' 'unsafe-eval'",
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Credentials': 'true',
        'Referrer-Policy': 'unsafe-url',
      },
      'https://app.example/dash',
    );

    const rules = new Set(out.findings.map((f) => f.ruleId));
    expect(rules).toContain('csp-unsafe-inline');
    expect(rules).toContain('csp-unsafe-eval');
    expect(rules).toContain('csp-wildcard');
    expect(rules).toContain('hsts-missing');
    expect(rules).toContain('xfo-missing');
    expect(rules).toContain('xcto-missing');
    expect(rules).toContain('referrer-weak');
    expect(rules).toContain('cors-wildcard-creds');
    expect(out.matrix.find((m) => m.header === 'Content-Security-Policy')?.status).toBe('weak');
  });

  it('passes cleanly when hardened headers are present', () => {
    const out = auditHeaders(
      {
        'Content-Security-Policy':
          "default-src 'self'; script-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'",
        'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
        'X-Frame-Options': 'DENY',
        'X-Content-Type-Options': 'nosniff',
        'Referrer-Policy': 'strict-origin-when-cross-origin',
      },
      'https://app.example/',
    );
    expect(out.findings).toEqual([]);
    expect(out.matrix.every((m) => m.status === 'ok')).toBe(true);
  });
});

describe('auditStorageEntries', () => {
  it('detects JWTs, Bearer tokens and sensitive keys while masking raw values', () => {
    const jwt = fakeJwt({ sub: 'u1', role: 'admin', exp: 1900000000 });
    const bearerSecret = 'Bearer super_secret_token_9876543210';
    const findings = auditStorageEntries(
      [
        { key: 'supabase.auth.token', value: JSON.stringify({ access_token: jwt }) },
        { key: 'api_header', value: bearerSecret },
        { key: 'refreshToken', value: 'rt_9988776655443322' },
        { key: 'theme', value: 'dark' },
      ],
      'localStorage',
    );
    expect(findings.map((f) => f.ruleId)).toEqual([
      'storage-jwt',
      'storage-bearer-token',
      'storage-sensitive-key',
    ]);
    const serialized = JSON.stringify(findings);
    expect(serialized).not.toContain(jwt);
    expect(serialized).not.toContain('super_secret_token_9876543210');
    expect(serialized).not.toContain('rt_9988776655443322');
    expect(findings[0]?.detail).toContain('role=admin');
  });
});

describe('auditCookies', () => {
  it('flags missing HttpOnly, Secure and SameSite flags without leaking raw values', () => {
    const jwt = fakeJwt({ sub: '42' });
    const headerFindings = auditSetCookieHeaders(
      [`session_id=${jwt}; Path=/; SameSite=None`, '_ga=GA1.2.12345.67890; Path=/'],
      'https://app.example/',
    );
    const rules = headerFindings.map((f) => f.ruleId);
    expect(rules).toEqual([
      'cookie-missing-httponly',
      'cookie-samesite-none-insecure',
      'cookie-missing-secure',
    ]);
    expect(JSON.stringify(headerFindings)).not.toContain(jwt);

    const clientFindings = auditCookies(
      [{ name: 'auth_cookie', value: 'secret123', fromDocumentCookie: true }],
      'http://127.0.0.1:8080/',
    );
    expect(clientFindings[0]).toMatchObject({
      ruleId: 'cookie-missing-httponly',
      severity: 'high',
      subject: 'auth_cookie',
    });
  });

  it('renders AUDIT.md report cleanly', () => {
    const record: AuditRecord = {
      id: 'https://app.example|/',
      origin: 'https://app.example',
      pageUrl: 'https://app.example/',
      headers: {},
      matrix: [{ header: 'Content-Security-Policy', status: 'missing', value: null }],
      findings: [
        {
          id: 'headers:csp-missing',
          category: 'headers',
          ruleId: 'csp-missing',
          title: 'Missing Content-Security-Policy header',
          severity: 'high',
          subject: 'Content-Security-Policy',
          detail: 'No CSP returned.',
          recommendation: 'Add strict CSP.',
        },
      ],
      storageKeysChecked: 3,
      cookiesChecked: 1,
      updatedAt: 0,
    };
    const md = auditMarkdown([record], {
      origin: 'https://app.example',
      generator: 'MapHound test',
      exportedAt: '2026-11-23T13:00:00Z',
    });
    expect(md).toContain('# MapHound security audit: https://app.example');
    expect(md).toContain('Missing Content-Security-Policy header');
  });
});
