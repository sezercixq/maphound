import { strFromU8, unzipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import type { FindingRecord } from '@/core/db';
import { exportSourceZip } from '@/engine/zip/export';
import { findingsJson, findingsMarkdown, sortFindings } from '@/engine/zip/findings-report';

// Never a real credential; split so repository scanners do not flag it.
const SECRET = ['sk', 'live', 'Zq8Lr3TnVx2Wk9Pb6Hc1Jd4Fg7Mm'].join('_');

const finding = (over: Partial<FindingRecord>): FindingRecord => ({
  id: `o|stripe-live-secret-key|${over.secretHash ?? 'h'}`,
  ruleId: 'stripe-live-secret-key',
  ruleName: 'Stripe live secret key',
  severity: 'critical',
  confidence: 'high',
  origin: 'https://shop.example',
  scriptHash: 's',
  file: 'src/src/pay.ts',
  line: 12,
  column: 4,
  locationKind: 'source',
  preview: 'sk_l…g7Mm',
  snippet: 'const key = "sk_l…g7Mm";',
  secretHash: 'h',
  secret: SECRET,
  occurrences: 1,
  locations: [
    {
      file: 'src/src/pay.ts',
      line: 12,
      column: 4,
      kind: 'source',
      scriptUrl: 'https://shop.example/app.js',
    },
  ],
  references: ['https://docs.stripe.com/keys'],
  createdAt: 0,
  updatedAt: 0,
  ...over,
});

const context = {
  origin: 'https://shop.example',
  generator: 'MapHound test',
  exportedAt: '2026-11-20T08:00:00.000Z',
  includeSecrets: false,
};

describe('findings report', () => {
  const findings = [
    finding({
      severity: 'info',
      ruleName: 'Stripe publishable key',
      secretHash: 'p',
      file: 'src/a.ts',
    }),
    finding({}),
    finding({
      severity: 'high',
      confidence: 'verified-format',
      ruleName: 'GitHub | token',
      secretHash: 'g',
      file: 'b`c.ts',
      locationKind: 'bundle-mapped',
    }),
  ];

  it('sorts by severity then confidence', () => {
    expect(sortFindings(findings).map((f) => f.severity)).toEqual(['critical', 'high', 'info']);
  });

  it('masks secrets in findings.json unless raw export is chosen', () => {
    const masked = JSON.parse(findingsJson(findings, context));
    expect(masked.rawSecretsIncluded).toBe(false);
    expect(masked.summary).toEqual({
      total: 3,
      bySeverity: { critical: 1, high: 1, medium: 0, low: 0, info: 1 },
    });
    expect(JSON.stringify(masked)).not.toContain(SECRET);
    expect(masked.findings[0]).toMatchObject({
      rule: 'stripe-live-secret-key',
      preview: 'sk_l…g7Mm',
      secretSha256: 'h',
    });
    const raw = JSON.parse(findingsJson(findings, { ...context, includeSecrets: true }));
    expect(raw.findings[0].secret).toBe(SECRET);
  });

  it('writes a masked Markdown report that survives pipes and backticks', () => {
    for (const includeSecrets of [false, true]) {
      const md = findingsMarkdown(findings, { ...context, includeSecrets });
      expect(md).not.toContain(SECRET);
      expect(md).toContain('**3 findings:** 1 critical, 1 high, 1 info.');
      expect(md).toContain(
        '| Stripe live secret key | high | `src/src/pay.ts:12:5` | `sk_l…g7Mm` | 1× |',
      );
      expect(md).toContain(
        '| GitHub \\| token | verified-format | `` b`c.ts:12:5 `` (bundle-mapped) |',
      );
      expect(md).toContain(
        includeSecrets ? 'Raw secret values are included' : 'Secret values are masked',
      );
    }
    expect(findingsMarkdown([], context)).toContain('No secrets were found');
  });

  it('is added to the ZIP', async () => {
    const chunks: Uint8Array[] = [];
    await exportSourceZip(
      {
        site: { origin: context.origin, scope: 'origin' },
        maps: [],
        scripts: [],
        jobs: [],
        findings,
        readBlob: async () => undefined,
      },
      { generator: 'x', onData: (chunk) => chunks.push(chunk), includeSecrets: true },
    );
    const zip = new Uint8Array(chunks.reduce((n, c) => n + c.byteLength, 0));
    let offset = 0;
    for (const chunk of chunks) {
      zip.set(chunk, offset);
      offset += chunk.byteLength;
    }
    const files = unzipSync(zip);
    expect(Object.keys(files).sort()).toEqual(['FINDINGS.md', 'findings.json', 'manifest.json']);
    expect(JSON.parse(strFromU8(files['findings.json'] as Uint8Array)).findings[0].secret).toBe(
      SECRET,
    );
    expect(strFromU8(files['FINDINGS.md'] as Uint8Array)).not.toContain(SECRET);
    expect(JSON.parse(strFromU8(files['manifest.json'] as Uint8Array))).toMatchObject({
      rawSecretsIncluded: true,
      summary: { findings: { total: 3 } },
    });
  });
});
