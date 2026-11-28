import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { openMaphoundDb } from '@/core/db';
import { buildOpenApiSpec } from '@/engine/export';
import { scanWithCustomRules, testCustomRule, validateCustomRegex } from '@/engine/rules';
import {
  buildObservedApiEvent,
  buildRuntimeDomEvent,
  mergeObservedApiEvent,
  observedEventsToEndpoints,
  summarizePayloadShape,
} from '@/engine/runtime';
import {
  generateCurlSnippet,
  generatePostMessageFixSnippet,
  generatePythonRequestsSnippet,
  PROBE_ORIGIN,
  runSafeVerificationChecks,
} from '@/engine/verify';

describe('v0.7.0 passive runtime API & GraphQL observer', () => {
  it('captures REST & GraphQL metadata, masks auth header values, and enriches OpenAPI 3.0.3', () => {
    const rest = buildObservedApiEvent({
      origin: 'https://shop.example.com',
      url: 'https://shop.example.com/api/v1/cart',
      method: 'post',
      status: 201,
      headerNames: ['Authorization', 'X-CSRF-Token', 'Content-Type'],
      requestBody: JSON.stringify({ sku: 'A-1', qty: 2 }),
      responseBody: JSON.stringify({ cartId: 'c1', total: 49 }),
    });
    expect(rest).not.toBeNull();
    expect(rest?.authHeaders).toEqual(['Authorization', 'X-CSRF-Token']);
    expect(rest?.requestKeys).toEqual(['qty', 'sku']);
    expect(rest?.responseKeys).toEqual(['cartId', 'total']);

    const merged = mergeObservedApiEvent(rest!, { ...rest!, count: 1, status: 200 });
    expect(merged.count).toBe(2);
    expect(merged.status).toBe(200);

    const gql = buildObservedApiEvent({
      origin: 'https://shop.example.com',
      url: '/graphql',
      method: 'POST',
      status: 200,
      requestBody: JSON.stringify({
        operationName: 'UpdateBilling',
        query: 'mutation UpdateBilling($id: ID!) { updateBilling(id: $id) { ok } }',
        variables: { id: '42', plan: 'pro' },
      }),
    });
    expect(gql?.graphql).toEqual({
      operationName: 'UpdateBilling',
      operationType: 'mutation',
      variables: ['id', 'plan'],
    });

    const liveEndpoints = observedEventsToEndpoints([rest!, gql!]);
    expect(liveEndpoints.every((e) => e.liveObserved)).toBe(true);

    const spec = buildOpenApiSpec({
      origin: 'https://shop.example.com',
      endpoints: [],
      observedApi: [rest!, gql!],
    });
    const cartOp = spec.paths['/api/v1/cart']?.post;
    expect(cartOp?.['x-maphound-live-observed']).toBe(true);
    expect(cartOp?.requestBody?.content['application/json'].schema.properties).toEqual({
      qty: { type: 'string' },
      sku: { type: 'string' },
    });
    expect(cartOp?.['x-maphound-response-keys']).toEqual(['cartId', 'total']);
  });
});

describe('v0.7.0 opt-in Runtime Guard DOM & postMessage event model', () => {
  it('sanitizes stack frames and summarizes payload shape without leaking raw values', () => {
    const ev = buildRuntimeDomEvent({
      origin: 'https://shop.example.com',
      kind: 'innerHTML',
      detail: 'div.innerHTML = (42 chars)',
      rawStack: [
        'Error',
        '    at runtime-hook.js:12:5',
        '    at renderBanner (https://shop.example.com/app.js:44:10)',
        '    at init (https://shop.example.com/app.js:90:3)',
      ].join('\n'),
    });
    expect(ev.stack).toHaveLength(2);
    expect(ev.stack[0]).toContain('renderBanner');
    expect(summarizePayloadShape({ action: 'login', token: 'secret' })).toBe(
      'object{action, token}',
    );
  });
});

describe('v0.7.0 controlled safe verification & safe request/fix snippets', () => {
  it('verifies CORS reflection, GraphQL introspection and .well-known endpoints on demand', async () => {
    const mockFetch = async (url: string, init?: RequestInit) => {
      if (url.endsWith('/')) {
        const reqOrigin = (init?.headers as Record<string, string> | undefined)?.Origin ?? '';
        return new Response('ok', {
          status: 200,
          headers: {
            'Access-Control-Allow-Origin': reqOrigin || PROBE_ORIGIN,
            'Access-Control-Allow-Credentials': 'true',
          },
        });
      }
      if (url.endsWith('/graphql')) {
        return new Response(
          JSON.stringify({ data: { __schema: { queryType: { name: 'Query' } } } }),
          {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          },
        );
      }
      if (url.endsWith('/.well-known/security.txt')) {
        return new Response('Contact: mailto:security@shop.example.com\n', { status: 200 });
      }
      if (url.endsWith('/.well-known/openid-configuration')) {
        return new Response(
          JSON.stringify({
            issuer: 'https://auth.shop.example.com',
            token_endpoint: 'https://auth.shop.example.com/oauth/token',
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      return new Response('not found', { status: 404 });
    };

    const report = await runSafeVerificationChecks('https://shop.example.com', mockFetch, 1000);
    expect(report.items.some((i) => i.id === 'verify:cors-reflection' && i.status === 'warn')).toBe(
      true,
    );
    expect(
      report.items.some((i) => i.id === 'verify:graphql-introspection' && i.status === 'warn'),
    ).toBe(true);
    expect(report.items.some((i) => i.id === 'verify:security-txt')).toBe(true);
    expect(report.items.some((i) => i.id === 'verify:openid-config')).toBe(true);

    const curl = generateCurlSnippet(
      { value: '/api/v1/orders', methods: ['POST'], category: 'api' },
      'https://shop.example.com',
    );
    expect(curl).toContain("curl -i -X POST 'https://shop.example.com/api/v1/orders'");
    expect(curl).toContain('${API_TOKEN}');

    const py = generatePythonRequestsSnippet(
      { value: '/api/v1/orders', methods: ['GET'], category: 'api' },
      'https://shop.example.com',
    );
    expect(py).toContain('requests.get');
    expect(py).toContain("os.environ.get('API_TOKEN'");

    const fix = generatePostMessageFixSnippet(
      {
        title: 'Unvalidated postMessage Handler',
        location: { file: 'src/msg.ts', line: 10, column: 0, kind: 'source', scriptUrl: '' },
      },
      'https://shop.example.com',
    );
    expect(fix).toContain('ALLOWED_ORIGINS');
    expect(fix).toContain('event.origin');
  });
});

describe('v0.7.0 Custom Rules Studio & ReDoS safety engine', () => {
  it('rejects ReDoS nested quantifiers, runs live playground and scans source with safe custom rules', async () => {
    expect(validateCustomRegex('(a+)+$').safe).toBe(false);
    expect(validateCustomRegex('([a-z]+)*').safe).toBe(false);
    expect(validateCustomRegex('(foo)\\1').safe).toBe(false);

    const safeCheck = validateCustomRegex('ACME_FLAG_[A-Z0-9]{8}', '');
    expect(safeCheck.safe).toBe(true);

    const play = testCustomRule('ACME_FLAG_[A-Z0-9]{8}', '', 'const flag = "ACME_FLAG_1234ABCD";');
    expect(play.safety.safe).toBe(true);
    expect(play.matches).toHaveLength(1);
    expect(play.matches[0]?.line).toBe(1);
    // Preview is always masked
    expect(play.matches[0]?.preview).not.toBe('ACME_FLAG_1234ABCD');

    const hits = scanWithCustomRules(
      'const internal = "ACME_FLAG_1234ABCD";',
      [
        {
          id: 'r1',
          name: 'Acme Lab Flag',
          pattern: 'ACME_FLAG_[A-Z0-9]{8}',
          flags: '',
          severity: 'high',
          scope: 'code',
          enabled: true,
          createdAt: 1,
        },
      ],
      'code',
    );
    expect(hits).toHaveLength(1);
    expect(hits[0]?.ruleId).toBe('custom/r1');

    // Verify IndexedDB v5 creates customRules, runtimeApi and runtimeDom stores cleanly
    const db = await openMaphoundDb(`mh-v5-test-${Date.now()}`);
    expect(db.objectStoreNames.contains('customRules')).toBe(true);
    expect(db.objectStoreNames.contains('runtimeApi')).toBe(true);
    expect(db.objectStoreNames.contains('runtimeDom')).toBe(true);
    db.close();
  });
});
