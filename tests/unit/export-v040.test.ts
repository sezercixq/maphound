import { describe, expect, it } from 'vitest';
import type { FindingRecord } from '@/core/db';
import type { AuditFinding } from '@/engine/audit';
import {
  buildSarifLog,
  draftAuditReport,
  draftEndpointReport,
  draftSecretReport,
  draftSinkReport,
  sarifJson,
} from '@/engine/export';
import type { EndpointHit, SinkHit } from '@/engine/intel';

const SECRET = ['sk', 'live', 'FakeTestSecret9876543210'].join('_');

const finding: FindingRecord = {
  id: 'o|stripe-live-secret-key|h1',
  ruleId: 'stripe-live-secret-key',
  ruleName: 'Stripe live secret key',
  severity: 'critical',
  confidence: 'high',
  origin: 'https://app.example',
  scriptHash: 's1',
  file: 'src/pay.ts',
  line: 12,
  column: 10,
  locationKind: 'source',
  preview: 'sk_l…3210',
  snippet: 'const k = "sk_l…3210";',
  secretHash: 'h1',
  secret: SECRET,
  occurrences: 1,
  locations: [
    {
      file: 'src/pay.ts',
      line: 12,
      column: 10,
      kind: 'source',
      scriptUrl: 'https://app.example/pay.js',
    },
  ],
  references: ['https://docs.stripe.com/keys'],
  createdAt: 0,
  updatedAt: 0,
};

const sink: SinkHit = {
  ruleId: 'dom-xss-dangerously-set-inner-html',
  title: 'React dangerouslySetInnerHTML',
  category: 'dom-xss',
  level: 'high',
  snippet: '<div dangerouslySetInnerHTML={{ __html: html }} />',
  location: {
    file: 'src/profile.tsx',
    line: 20,
    column: 6,
    kind: 'source',
    scriptUrl: 'https://app.example/app.js',
  },
};

describe('SARIF v2.1.0 & disclosure drafts', () => {
  it('produces valid SARIF v2.1.0 output without raw secrets', () => {
    const raw = sarifJson({
      findings: [finding],
      sinks: [sink],
      origin: 'https://app.example',
      version: '0.4.0',
    });
    expect(raw).not.toContain(SECRET);
    const parsed = buildSarifLog({
      findings: [finding],
      sinks: [sink],
      origin: 'https://app.example',
      version: '0.4.0',
    });
    expect(parsed.version).toBe('2.1.0');
    expect(parsed.$schema).toContain('sarif-2.1.0.json');
    expect(parsed.runs[0].tool.driver.rules.map((r) => r.id)).toEqual([
      'sink/dom-xss-dangerously-set-inner-html',
      'stripe-live-secret-key',
    ]);
    expect(parsed.runs[0].results).toHaveLength(2);
    expect(parsed.runs[0].results[0]).toMatchObject({
      ruleId: 'stripe-live-secret-key',
      level: 'error',
      locations: [
        {
          physicalLocation: {
            artifactLocation: { uri: 'src/pay.ts', uriBaseId: '%SRCROOT%' },
            region: { startLine: 12, startColumn: 11 },
          },
        },
      ],
    });
    expect(parsed.runs[0].results[1]).toMatchObject({
      ruleId: 'sink/dom-xss-dangerously-set-inner-html',
      level: 'error',
    });
  });

  it('builds masked Markdown disclosure drafts for secrets, endpoints, sinks and audits', () => {
    const secretDraft = draftSecretReport(finding, 'https://app.example');
    expect(secretDraft).toContain('Exposed Stripe live secret key');
    expect(secretDraft).toContain('sk_l…3210');
    expect(secretDraft).not.toContain(SECRET);

    const endpoint: EndpointHit = {
      value: '/internal/admin/users',
      category: 'admin',
      methods: ['POST'],
      dynamic: false,
      locations: [
        {
          file: 'src/admin.ts',
          line: 8,
          column: 2,
          kind: 'source',
          scriptUrl: 'https://app.example/app.js',
        },
      ],
    };
    const epDraft = draftEndpointReport(endpoint, 'https://app.example');
    expect(epDraft).toContain('/internal/admin/users');
    expect(epDraft).toContain('POST');

    const sinkDraft = draftSinkReport(sink, 'https://app.example');
    expect(sinkDraft).toContain('React dangerouslySetInnerHTML');
    expect(sinkDraft).toContain('DOMPurify');

    const audit: AuditFinding = {
      id: 'headers:csp-missing',
      category: 'headers',
      ruleId: 'csp-missing',
      title: 'Missing Content-Security-Policy header',
      severity: 'high',
      subject: 'Content-Security-Policy',
      detail: 'No CSP returned.',
      recommendation: 'Configure strict CSP.',
    };
    const auditDraft = draftAuditReport(audit, 'https://app.example');
    expect(auditDraft).toContain('Missing Content-Security-Policy header');
    expect(auditDraft).toContain('Configure strict CSP.');
  });
});
