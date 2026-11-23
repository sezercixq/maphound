import { describe, expect, it } from 'vitest';
import type { PageIntelRecord, ScriptIntelRecord } from '@/core/db';
import {
  combineSiteIntel,
  endpointsJson,
  endpointsMarkdown,
  endpointsText,
} from '@/engine/zip/endpoints-report';

const ORIGIN = 'https://app.example';

describe('endpoints-report', () => {
  const intelRecords: ScriptIntelRecord[] = [
    {
      id: `${ORIGIN}|s1`,
      origin: ORIGIN,
      scriptHash: 's1',
      scriptUrl: `${ORIGIN}/app.js`,
      endpoints: [
        {
          value: '/internal/admin/impersonate',
          category: 'admin',
          methods: ['POST'],
          dynamic: false,
          locations: [
            {
              file: 'src/admin.tsx',
              line: 12,
              column: 4,
              kind: 'source',
              scriptUrl: `${ORIGIN}/app.js`,
            },
          ],
        },
      ],
      routes: [
        {
          path: '/admin/audit',
          kind: 'definition',
          locations: [
            {
              file: 'src/routes.tsx',
              line: 8,
              column: 2,
              kind: 'source',
              scriptUrl: `${ORIGIN}/app.js`,
            },
          ],
        },
      ],
      comments: [
        {
          marker: 'BYPASS',
          text: 'skip check in | dev',
          level: 'high',
          location: {
            file: 'src/auth.ts',
            line: 5,
            column: 0,
            kind: 'source',
            scriptUrl: `${ORIGIN}/app.js`,
          },
        },
      ],
      sinks: [
        {
          ruleId: 'dom-xss-inner-html',
          title: 'DOM innerHTML / outerHTML assignment',
          category: 'dom-xss',
          level: 'high',
          snippet: 'el.innerHTML = html;',
          location: {
            file: 'src/render.ts',
            line: 14,
            column: 2,
            kind: 'source',
            scriptUrl: `${ORIGIN}/app.js`,
          },
        },
      ],
      truncated: false,
      updatedAt: 0,
    },
  ];

  const pages: PageIntelRecord[] = [
    {
      id: `${ORIGIN}|/dashboard`,
      origin: ORIGIN,
      pageUrl: `${ORIGIN}/dashboard`,
      updatedAt: 0,
      nextData: {
        bytes: 420,
        page: '/dashboard',
        buildId: 'b42',
        query: {},
        dataFetching: ['getServerSideProps'],
        hasRuntimeConfig: false,
        pageProps: ['user', 'apiUrl'],
        keyCount: 5,
        sensitive: [
          {
            path: 'props.pageProps.user.internalToken',
            reason: 'credential',
            type: 'string',
            preview: 'tok_…1234',
          },
        ],
        outline: [],
        endpoints: ['/api/v1/billing/summary'],
      },
    },
  ];

  it('combines script intel and __NEXT_DATA__ endpoints and generates Markdown, TXT and JSON', () => {
    const merged = combineSiteIntel(intelRecords, pages);
    expect(merged.endpoints.map((e) => e.value)).toEqual([
      '/internal/admin/impersonate',
      '/api/v1/billing/summary',
    ]);

    const md = endpointsMarkdown(merged, pages, {
      origin: ORIGIN,
      generator: 'MapHound test',
      exportedAt: '2026-11-23T12:00:00Z',
    });
    expect(md).toContain('# MapHound attack surface: https://app.example');
    expect(md).toContain('`/internal/admin/impersonate`');
    expect(md).toContain('`/api/v1/billing/summary`');
    expect(md).toContain('`/admin/audit`');
    expect(md).toContain('skip check in \\| dev');
    expect(md).toContain('DOM innerHTML / outerHTML assignment');
    expect(md).toContain('tok_…1234');

    const txt = endpointsText(merged);
    expect(txt).toContain('POST /internal/admin/impersonate');
    expect(txt).toContain('ROUTE /admin/audit');

    const json = JSON.parse(endpointsJson(merged, ORIGIN));
    expect(json.summary).toEqual({ endpoints: 2, routes: 1, comments: 1 });
  });

  it('handles empty state cleanly', () => {
    const md = endpointsMarkdown(combineSiteIntel([]), [], {
      origin: ORIGIN,
      generator: 'MapHound test',
      exportedAt: '2026-11-23T12:00:00Z',
    });
    expect(md).toContain('No endpoints, routes, developer notes or code hints were discovered.');
  });
});
