import { describe, expect, it } from 'vitest';
import {
  auditHeaders,
  auditMarkdown,
  extractStackHints,
  stackHintsMarkdownLines,
} from '@/engine/audit';
import { osintMarkdown } from '@/engine/intel';

describe('passive backend & technology stack hints', () => {
  it('extracts web server and runtime banners and flags version leaks in auditHeaders', () => {
    const out = auditHeaders(
      {
        Server: 'nginx/1.24.0',
        'X-Powered-By': 'PHP/8.2.11',
        Via: '1.1 cloudfront.net (CloudFront)',
        'X-AspNet-Version': '4.0.30319',
        'X-Generator': 'Drupal 10',
      },
      'https://app.example.com/',
    );

    expect(out.summary.server).toBe('nginx/1.24.0');
    expect(out.summary['x-powered-by']).toBe('PHP/8.2.11');
    expect(out.findings.some((f) => f.id === 'headers:banner-server' && f.severity === 'low')).toBe(
      true,
    );
    expect(
      out.findings.some((f) => f.id === 'headers:banner-x-powered-by' && f.severity === 'low'),
    ).toBe(true);
    expect(
      out.findings.some((f) => f.id === 'headers:banner-x-generator' && f.severity === 'info'),
    ).toBe(true);

    const hints = extractStackHints({
      audits: [{ headers: out.summary, cookieNames: [], findings: out.findings }],
    });
    expect(hints).toContainEqual(
      expect.objectContaining({
        category: 'server',
        name: 'nginx',
        version: '1.24.0',
        evidence: 'Header: Server',
      }),
    );
    expect(hints).toContainEqual(
      expect.objectContaining({
        category: 'runtime',
        name: 'PHP',
        version: '8.2.11',
        evidence: 'Header: X-Powered-By',
      }),
    );
    expect(hints).toContainEqual(
      expect.objectContaining({
        category: 'server',
        name: 'Amazon CloudFront',
        evidence: 'Header: Via',
      }),
    );
    expect(hints).toContainEqual(
      expect.objectContaining({
        category: 'runtime',
        name: 'ASP.NET',
        version: '4.0.30319',
        evidence: 'Header: X-AspNet-Version',
      }),
    );
  });

  it('fingerprints backend frameworks strictly from session cookie names', () => {
    const hints = extractStackHints({
      audits: [
        {
          headers: {},
          cookieNames: [
            'JSESSIONID',
            'PHPSESSID',
            'ASP.NET_SessionId',
            '.AspNetCore.Cookies',
            'connect.sid',
            'csrftoken',
            'sessionid',
            '_rails_session',
            'XSRF-TOKEN',
            'laravel_session',
          ],
          findings: [],
        },
      ],
    });
    const names = hints.map((h) => `${h.name}|${h.evidence}`);
    expect(names).toContain('Java Servlet / Spring / Tomcat|Cookie: JSESSIONID');
    expect(names).toContain('PHP|Cookie: PHPSESSID');
    expect(names).toContain('ASP.NET|Cookie: ASP.NET_SessionId');
    expect(names).toContain('ASP.NET Core|Cookie: .AspNetCore.Cookies');
    expect(names).toContain('Node.js / Express|Cookie: connect.sid');
    expect(names).toContain('Django (Python)|Cookie: csrftoken + sessionid');
    expect(names).toContain('Ruby on Rails|Cookie: _rails_session');
    expect(names).toContain('Laravel (PHP)|Cookie: XSRF-TOKEN + laravel_session');
  });

  it('does not false-positive on generic cookies or versionless Server headers', () => {
    const headerOut = auditHeaders({ Server: 'cloudflare' }, 'https://app.example.com/');
    expect(headerOut.findings.some((f) => f.id === 'headers:banner-server')).toBe(false);

    const hints = extractStackHints({
      audits: [
        {
          headers: {},
          // Only csrftoken without sessionid should NOT trigger Django; generic cookies ignored.
          cookieNames: ['csrftoken', '_ga', 'theme', 'locale'],
          findings: [],
        },
      ],
    });
    expect(hints).toEqual([]);
  });

  it('aggregates cloud storage, BaaS/database, API layer and build OS and renders in AUDIT.md and OSINT.md', () => {
    const hints = extractStackHints({
      audits: [{ headers: { 'x-powered-by': 'Express' }, cookieNames: [], findings: [] }],
      architecture: {
        sdks: [
          { name: 'Supabase', category: 'backend', files: ['src/db.ts'] },
          { name: 'Firebase', category: 'backend', files: ['src/auth.ts'] },
        ],
      },
      intel: {
        endpoints: [
          {
            value: '/graphql',
            category: 'graphql',
            methods: ['POST'],
            dynamic: false,
            locations: [],
          },
          {
            value: '/api/v1/orders',
            category: 'api',
            methods: ['GET'],
            dynamic: false,
            locations: [],
          },
        ],
        osint: [
          { category: 'cloud', kind: 'AWS S3 Bucket', value: 's3://acme-assets', locations: [] },
          {
            category: 'build-path',
            kind: 'Windows Home Path',
            value: 'C:\\Users\\d***v\\web',
            locations: [],
          },
        ],
      },
    });

    const summary = hints.map((h) => `${h.category}:${h.name}`);
    expect(summary).toContain('runtime:Node.js / Express');
    expect(summary).toContain('database:Supabase / PostgreSQL');
    expect(summary).toContain('database:Firebase / Firestore');
    expect(summary).toContain('cloud:AWS S3');
    expect(summary).toContain('api:GraphQL API');
    expect(summary).toContain('api:REST / JSON API');
    expect(summary).toContain('build-os:Windows (Build Host)');

    const auditMd = auditMarkdown(
      [],
      {
        origin: 'https://acme.example',
        generator: 'MapHound 0.4.1',
        exportedAt: '2026-11-23T12:00:00Z',
      },
      hints,
    );
    expect(auditMd).toContain('## Detected Stack & Server Hints');
    expect(auditMd).toContain('Supabase / PostgreSQL');
    expect(auditMd).toContain('`SDK: Supabase`');

    const osintMd = osintMarkdown(
      [],
      {
        origin: 'https://acme.example',
        generator: 'MapHound 0.4.1',
        exportedAt: '2026-11-23T12:00:00Z',
      },
      stackHintsMarkdownLines(hints),
    );
    expect(osintMd).toContain('## Detected Stack & Server Hints');
    expect(osintMd).toContain('Windows (Build Host)');
  });
});
