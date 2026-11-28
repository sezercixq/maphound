import { describe, expect, it } from 'vitest';
import {
  auditHeaders,
  auditHtmlMetadata,
  auditMarkdown,
  discoveryMarkdownLines,
  extractStackHints,
  parseRobotsTxt,
  parseSitemapXml,
} from '@/engine/audit';
import { osintMarkdown } from '@/engine/intel';
import { endpointsMarkdown } from '@/engine/zip/endpoints-report';

describe('v0.5.0 raw headers & custom debug header audit', () => {
  it('captures all raw response headers and flags custom debug/internal/version headers', () => {
    const out = auditHeaders(
      {
        'Content-Type': 'text/html; charset=utf-8',
        'X-Request-Id': 'req-998877',
        'X-Debug-Mode': 'enabled',
        'X-Internal-Node': 'prod-eu-04',
        'X-Backend-Version': '3.4.1',
        'X-Runtime': '0.042101',
      },
      'https://app.example.com/',
    );

    expect(out.rawHeaders.map((h) => h.name)).toEqual([
      'Content-Type',
      'X-Backend-Version',
      'X-Debug-Mode',
      'X-Internal-Node',
      'X-Request-Id',
      'X-Runtime',
    ]);

    const customIds = out.findings
      .filter((f) => f.ruleId === 'custom-debug-header')
      .map((f) => `${f.subject}:${f.severity}`);
    expect(customIds).toContain('X-Debug-Mode:low');
    expect(customIds).toContain('X-Internal-Node:low');
    expect(customIds).toContain('X-Backend-Version:low');
    expect(customIds).toContain('X-Runtime:info');
    // Standard tracing header X-Request-Id is captured in rawHeaders but not flagged as a finding.
    expect(customIds.some((id) => id.startsWith('X-Request-Id'))).toBe(false);
  });
});

describe('v0.5.0 HTML DOM comment & meta tag auditor', () => {
  it('extracts flagged HTML comments, masks tokens, ignores trivial comments and parses metas', () => {
    const fakeBearer = ['Bearer ', 'abc1234567890SECRETtoken987654321'].join('');
    const result = auditHtmlMetadata(
      [
        'TODO: remove /internal/staging-debug before launch',
        `BYPASS: auth header ${fakeBearer}`,
        'Build release v2.14.3',
        '[if IE 9]>old browser<![endif]',
        'just a normal copyright note',
        '/$',
      ],
      [
        { name: 'generator', content: 'Drupal 10.2' },
        { name: 'author', content: 'Platform Security Team' },
        { name: 'viewport', content: 'width=device-width, initial-scale=1' },
        { name: 'csrf-token', content: 'csrf_1234567890abcdef1234567890' },
      ],
    );

    expect(result.comments).toHaveLength(3);
    expect(result.comments[0]?.tags).toContain('BYPASS');
    expect(result.comments[0]?.tags).toContain('SECRET_HINT');
    expect(result.comments[0]?.text).not.toContain('abc1234567890SECRETtoken987654321');
    expect(result.comments[1]?.tags).toEqual(expect.arrayContaining(['TODO', 'PATH']));
    expect(result.comments[2]?.tags).toContain('VERSION');

    expect(result.metas.map((m) => m.name)).toEqual(['generator', 'author', 'csrf-token']);
    expect(result.metas.find((m) => m.name === 'csrf-token')?.content).not.toContain(
      'csrf_1234567890abcdef1234567890',
    );

    // Generator meta feeds stack hints too.
    const hints = extractStackHints({
      audits: [{ headers: {}, findings: [], htmlAudit: result }],
    });
    expect(hints).toContainEqual(
      expect.objectContaining({
        name: 'Drupal',
        version: '10.2',
        evidence: 'Meta: generator',
      }),
    );
  });
});

describe('v0.5.0 standard discovery files parser (robots.txt & sitemap.xml)', () => {
  it('parses Disallow, Allow, Sitemap directives and sitemap.xml <loc> URLs safely', () => {
    const robots = parseRobotsTxt(
      [
        '# Production robots',
        'User-agent: *',
        'Disallow: /admin/panel # hidden panel',
        'Disallow: /internal/export',
        'Disallow: /admin/panel',
        'Allow: /public/docs',
        'Sitemap: https://shop.example.com/sitemap.xml',
        'Sitemap: /sitemap-products.xml',
        'Sitemap: javascript:alert(1)',
      ].join('\n'),
      'https://shop.example.com',
    );
    expect(robots.disallow).toEqual(['/admin/panel', '/internal/export']);
    expect(robots.allow).toEqual(['/public/docs']);
    expect(robots.sitemaps).toEqual([
      'https://shop.example.com/sitemap.xml',
      'https://shop.example.com/sitemap-products.xml',
    ]);

    const sitemap = parseSitemapXml(
      `<?xml version="1.0" encoding="UTF-8"?>
      <urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
        <url><loc>https://shop.example.com/pricing</loc></url>
        <url><loc>https://shop.example.com/api-docs?v=1&amp;lang=en</loc></url>
        <url><loc>javascript:evil()</loc></url>
      </urlset>`,
      'https://shop.example.com',
    );
    expect(sitemap.urls).toEqual([
      'https://shop.example.com/pricing',
      'https://shop.example.com/api-docs?v=1&lang=en',
    ]);

    const discoveryLines = discoveryMarkdownLines({
      origin: 'https://shop.example.com',
      checkedAt: 1,
      robots: { found: true, status: 200, ...robots },
      sitemap: { found: true, status: 200, ...sitemap },
    });

    const ctx = {
      origin: 'https://shop.example.com',
      generator: 'MapHound 0.5.0',
      exportedAt: '2026-11-23T12:00:00Z',
    };
    const osintMd = osintMarkdown([], ctx, discoveryLines);
    expect(osintMd).toContain('`/admin/panel`');
    expect(osintMd).toContain('`https://shop.example.com/sitemap.xml`');

    const endpointsMd = endpointsMarkdown(
      { endpoints: [], routes: [], comments: [], sinks: [], truncated: false },
      [],
      ctx,
      discoveryLines,
    );
    expect(endpointsMd).toContain('`/internal/export`');
    expect(endpointsMd).toContain('`https://shop.example.com/pricing`');

    const auditMd = auditMarkdown(
      [
        {
          id: 'https://shop.example.com|/',
          origin: 'https://shop.example.com',
          pageUrl: 'https://shop.example.com/',
          headers: {},
          rawHeaders: [{ name: 'X-Debug-Mode', value: 'true' }],
          matrix: [],
          findings: [],
          htmlAudit: {
            metas: [{ name: 'generator', content: 'CustomCMS 4.2' }],
            comments: [{ text: 'TODO: disable debug', tags: ['TODO'], level: 'medium' }],
          },
          storageKeysChecked: 0,
          cookiesChecked: 0,
          updatedAt: 1,
        },
      ],
      ctx,
    );
    expect(auditMd).toContain('### Raw Response Headers');
    expect(auditMd).toContain('`X-Debug-Mode`');
    expect(auditMd).toContain('### HTML Source Comments & Meta');
    expect(auditMd).toContain('`CustomCMS 4.2`');
  });
});
