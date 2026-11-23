import { describe, expect, it } from 'vitest';
import {
  analyzeSourceFile,
  architectureMarkdown,
  buildArchitectureGraph,
  mergeScriptIntel,
  resolveInternalImport,
} from '@/engine/intel';

describe('architecture & dependency graph', () => {
  it('resolves relative internal imports across TS/JS and index files', () => {
    const known = new Set([
      'src/src/billing/checkout.tsx',
      'src/src/billing/api.ts',
      'src/src/shared/auth/index.ts',
    ]);
    expect(resolveInternalImport('src/src/billing/checkout.tsx', './api', known)).toBe(
      'src/src/billing/api.ts',
    );
    expect(resolveInternalImport('src/src/billing/checkout.tsx', '../shared/auth', known)).toBe(
      'src/src/shared/auth/index.ts',
    );
    expect(
      resolveInternalImport('src/src/billing/checkout.tsx', '@stripe/stripe-js', known),
    ).toBeNull();
  });

  it('extracts imports, exports, third-party SDKs and API data flows into a tree and Mermaid doc', () => {
    const checkout = analyzeSourceFile(
      [
        "import { loadStripe } from '@stripe/stripe-js';",
        "import { submitOrder } from './api';",
        "import posthog from 'posthog-js';",
        'export const STRIPE_READY = true;',
        'export function CheckoutButton() {',
        "  posthog.capture('checkout_open');",
        "  return axios.post('/api/v1/checkout', {});",
        '}',
      ].join('\n'),
      {
        file: 'src/src/billing/checkout.tsx',
        kind: 'source',
        scriptUrl: 'https://shop.test/app.js',
        mapUrl: 'https://shop.test/app.js.map',
      },
    );

    const api = analyzeSourceFile(
      [
        "import { createClient } from '@supabase/supabase-js';",
        "import * as Sentry from '@sentry/browser';",
        "export async function submitOrder() { return fetch('/internal/billing/submit'); }",
        'export default submitOrder;',
      ].join('\n'),
      {
        file: 'src/src/billing/api.ts',
        kind: 'source',
        scriptUrl: 'https://shop.test/app.js',
        mapUrl: 'https://shop.test/app.js.map',
      },
    );

    const vendor = analyzeSourceFile(
      "import Stripe from 'stripe'; export const v = 1;",
      {
        file: '_vendor/stripe/index.js',
        kind: 'source',
        scriptUrl: 'https://shop.test/app.js',
      },
      { vendor: true },
    );

    const merged = mergeScriptIntel([checkout, api, vendor]);
    const graph = buildArchitectureGraph(merged.modules ?? []);

    expect(graph.nodes.map((n) => n.file)).toEqual([
      'src/src/billing/api.ts',
      'src/src/billing/checkout.tsx',
    ]);
    expect(graph.edges).toEqual([
      { from: 'src/src/billing/checkout.tsx', to: 'src/src/billing/api.ts' },
    ]);

    const apiNode = graph.nodes.find((n) => n.file === 'src/src/billing/api.ts');
    expect(apiNode?.importedBy).toEqual(['src/src/billing/checkout.tsx']);
    expect(apiNode?.exports).toEqual(['default', 'submitOrder']);
    expect(apiNode?.packages).toEqual(['@sentry/browser', '@supabase/supabase-js']);

    expect(graph.sdks.map((s) => s.name).sort()).toEqual([
      'PostHog',
      'Sentry',
      'Stripe',
      'Supabase',
    ]);
    expect(graph.dataFlows.map((d) => [d.file, d.endpoint, d.methods])).toEqual([
      ['src/src/billing/api.ts', '/internal/billing/submit', ['GET']],
      ['src/src/billing/checkout.tsx', '/api/v1/checkout', ['POST']],
    ]);

    expect(graph.tree[0]).toMatchObject({
      name: 'src',
      kind: 'folder',
      fileCount: 2,
      endpointCount: 2,
    });

    const md = architectureMarkdown(graph, {
      origin: 'https://shop.test',
      generator: 'MapHound test',
      exportedAt: '2026-11-23T13:00:00Z',
    });
    expect(md).toContain('```mermaid');
    expect(md).toContain('flowchart LR');
    expect(md).toContain('M0["src/src/billing/api.ts"]');
    expect(md).toContain('SDK: Stripe');
    expect(md).toContain('/api/v1/checkout');
  });
});
