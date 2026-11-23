import { describe, expect, it } from 'vitest';
import {
  analyzeSourceFile,
  extractComments,
  extractEndpoints,
  extractFileArtifacts,
  extractRoutes,
  extractSinks,
  LineIndex,
  lex,
  mergeScriptIntel,
  parseNextData,
} from '@/engine/intel';

const BASE = {
  file: 'src/App.tsx',
  kind: 'source' as const,
  scriptUrl: 'https://example.com/app.js',
  mapUrl: 'https://example.com/app.js.map',
};

describe('lex', () => {
  it('separates strings, template literals, comments and regexes without losing line numbers', () => {
    const src = [
      'const a = "hello"; // TODO: fix',
      'const b = 10 / 2 / 1;',
      'const r = /eval\\(/gi;',
      'const t = `/api/users/${user.id}/orders`;',
      '/* innerHTML = x */',
      'el.innerHTML = payload;',
    ].join('\n');
    const lexed = lex(src);
    expect(lexed.strings.map((s) => s.value)).toEqual(['hello', '/api/users/{id}/orders']);
    expect(lexed.strings[1]?.dynamic).toBe(true);
    expect(lexed.comments).toHaveLength(2);
    expect(lexed.code).not.toContain('eval');
    expect(lexed.code).not.toContain('innerHTML = x');
    expect(lexed.code).toContain('el.innerHTML = payload;');
    expect(lexed.code.split('\n')).toHaveLength(src.split('\n').length);

    const noCode = lex(src, { needCode: false });
    expect(noCode.code).toBe('');
    expect(noCode.strings).toHaveLength(2);
  });

  it('handles 5 MB bundles in linear time', () => {
    const chunk = 'const x = "/api/v1/items"; /* note */ const y = 42 / 2;\n';
    const big = chunk.repeat(Math.ceil((5 * 1024 * 1024) / chunk.length));
    const started = performance.now();
    const lexed = lex(big, { needCode: true });
    const ms = performance.now() - started;
    expect(lexed.strings.length).toBeGreaterThan(1000);
    expect(ms).toBeLessThan(1500);
  });
});

describe('extractEndpoints', () => {
  it('discovers REST, admin, graphql, next-data and websocket endpoints with HTTP methods', () => {
    const src = `
      fetch('/api/v1/users');
      axios.post('/internal/admin/impersonate', body);
      fetch('/graphql', { method: 'POST', body });
      xhr.open('DELETE', '/api/v2/orders/42');
      const auth = '/auth/oauth/token';
      const next = '/_next/data/build-123/dashboard.json';
      const ws = 'wss://realtime.acme.test/socket';
      const ext = fetch('https://payments.vendor.example/charge', { method: 'PUT' });
      const ignoreNoise = 'https://www.w3.org/2000/svg';
      const ignoreAsset = '/assets/logo.png';
      const ignoreMime = 'application/json';
    `;
    const lexed = lex(src);
    const hits = extractEndpoints(src, lexed, new LineIndex(src), BASE);
    const byVal = Object.fromEntries(hits.map((h) => [h.value, h]));

    expect(byVal['/api/v1/users']).toMatchObject({ category: 'api', methods: ['GET'] });
    expect(byVal['/internal/admin/impersonate']).toMatchObject({
      category: 'admin',
      methods: ['POST'],
    });
    expect(byVal['/graphql']).toMatchObject({ category: 'graphql', methods: ['POST'] });
    expect(byVal['/api/v2/orders/42']).toMatchObject({
      category: 'api',
      methods: ['DELETE'],
    });
    expect(byVal['/auth/oauth/token']).toMatchObject({ category: 'auth', methods: [] });
    expect(byVal['/_next/data/build-123/dashboard.json']).toMatchObject({ category: 'next-data' });
    expect(byVal['wss://realtime.acme.test/socket']).toMatchObject({ category: 'websocket' });
    expect(byVal['https://payments.vendor.example/charge']).toMatchObject({
      category: 'external',
      methods: ['PUT'],
    });
    expect(byVal['https://www.w3.org/2000/svg']).toBeUndefined();
    expect(byVal['/assets/logo.png']).toBeUndefined();
    expect(byVal['application/json']).toBeUndefined();
  });
});

describe('extractRoutes & extractFileArtifacts', () => {
  it('extracts React/Vue router definitions, navigations, and Next.js __BUILD_MANIFEST', () => {
    const src = `
      const routes = [{ path: '/admin/users', component: UsersPage }, { path: 'settings', element: <Settings /> }];
      const jsx = <Route path="/billing/invoices" element={<Invoices />} />;
      router.push('/account/security');
      const link = <Link href="/reports/audit" />;
      self.__BUILD_MANIFEST = { "/secret-preview": ["static/chunks/pages/secret.js"] };
    `;
    const lexed = lex(src);
    const routes = extractRoutes(src, lexed, new LineIndex(src), BASE);
    const byPath = Object.fromEntries(routes.map((r) => [r.path, r.kind]));
    expect(byPath['/admin/users']).toBe('definition');
    expect(byPath['settings']).toBe('definition');
    expect(byPath['/billing/invoices']).toBe('definition');
    expect(byPath['/account/security']).toBe('navigation');
    expect(byPath['/reports/audit']).toBe('navigation');
    expect(byPath['/secret-preview']).toBe('manifest');
  });

  it('derives file-system routes and Next.js API routes from rebuilt file paths', () => {
    expect(extractFileArtifacts('src/pages/admin/audit.tsx', BASE.scriptUrl).route?.path).toBe(
      '/admin/audit',
    );
    expect(
      extractFileArtifacts('src/app/(dashboard)/settings/page.tsx', BASE.scriptUrl).route?.path,
    ).toBe('/settings');
    expect(extractFileArtifacts('src/pages/api/v1/health.ts', BASE.scriptUrl).endpoint?.value).toBe(
      '/api/v1/health',
    );
    expect(
      extractFileArtifacts('src/app/api/internal/users/route.ts', BASE.scriptUrl).endpoint,
    ).toMatchObject({ value: '/api/internal/users', category: 'admin' });
    expect(extractFileArtifacts('src/pages/_app.tsx', BASE.scriptUrl)).toEqual({});
    expect(extractFileArtifacts('src/pages/admin/audit.test.tsx', BASE.scriptUrl)).toEqual({});
  });
});

describe('extractComments', () => {
  it('captures developer markers and ignores license headers', () => {
    const src = `
      /* @license MIT Copyright 2026 Acme TODO: ignore license */
      // BYPASS: skip RBAC check in staging
      // FIXME: hardcoded password fallback for admin
      /* TODO: refactor pagination helper */
    `;
    const lexed = lex(src);
    const comments = extractComments(src, lexed, new LineIndex(src), BASE);
    expect(comments.map((c) => [c.marker, c.level])).toEqual([
      ['BYPASS', 'high'],
      ['FIXME', 'high'],
      ['TODO', 'low'],
    ]);
  });
});

describe('extractSinks', () => {
  it('flags dangerous DOM, eval, postMessage, redirect and framework sinks while avoiding noise', () => {
    const src = `
      const s = "eval(notReal) innerHTML = nope";
      // document.write(commentedOut);
      el.innerHTML = userInput;
      cleanEl.innerHTML = '';
      safeEl.innerHTML = DOMPurify.sanitize(userInput);
      el.outerHTML = chunk;
      document.write(banner);
      const cmp = <div dangerouslySetInnerHTML={{ __html: bio }} />;
      eval(payload);
      const fn = new Function('a', body);
      setTimeout("alert(1)", 100);
      window.addEventListener('message', (e) => { eval(e.data); });
      window.addEventListener('message', (e) => { if (e.origin !== 'https://ok.test') return; handle(e.data); });
      frame.contentWindow.postMessage(secret, '*');
      window.location.href = params.get('next');
      window.location.href = '/static-login';
      const ignored = eval(vetted); // maphound-ignore
      const vue = '<div v-html="raw"></div>';
    `;
    const lexed = lex(src);
    const sinks = extractSinks(src, lexed, new LineIndex(src), BASE);
    const ids = sinks.map((s) => `${s.ruleId}:${s.level}`);

    expect(ids).toContain('dom-xss-inner-html:high');
    expect(ids).toContain('dom-xss-inner-html:low');
    expect(ids).toContain('dom-xss-document-write:high');
    expect(ids).toContain('dom-xss-dangerously-set-inner-html:high');
    expect(ids).toContain('code-eval:high');
    expect(ids).toContain('code-new-function:high');
    expect(ids).toContain('code-string-timer:medium');
    expect(ids).toContain('messaging-unverified-origin:high');
    expect(ids).toContain('messaging-postmessage-wildcard:medium');
    expect(ids).toContain('open-redirect:high');

    // Static clearing, checked-origin listener, static redirect, ignored line, string literals must NOT trigger.
    const verifiedListenerLines = sinks.filter((s) => s.ruleId === 'messaging-unverified-origin');
    expect(verifiedListenerLines).toHaveLength(1);
    expect(sinks.filter((s) => s.ruleId === 'open-redirect')).toHaveLength(1);
    expect(sinks.filter((s) => s.ruleId === 'code-eval')).toHaveLength(2); // line 10 + inside listener, NOT string or maphound-ignore
  });

  it('skips vendor files completely', () => {
    const out = analyzeSourceFile(
      'eval(x); fetch("/api/vendor"); // BYPASS: vendor',
      { ...BASE, file: '_vendor/pkg/index.js' },
      { vendor: true },
    );
    expect(out.endpoints).toEqual([]);
    expect(out.comments).toEqual([]);
    expect(out.sinks).toEqual([]);
  });
});

describe('parseNextData', () => {
  it('summarizes SSR props, masks sensitive values and extracts embedded endpoints', () => {
    const raw = JSON.stringify({
      page: '/dashboard',
      buildId: 'b123',
      gssp: true,
      query: { tab: 'billing' },
      props: {
        pageProps: {
          user: {
            email: 'alice@example.test',
            isAdmin: true,
            internalToken: 'tok_0123456789abcdef',
          },
          apiUrl: '/api/v1/billing/summary',
        },
      },
    });
    const summary = parseNextData(raw);
    expect(summary).not.toBeNull();
    expect(summary?.page).toBe('/dashboard');
    expect(summary?.buildId).toBe('b123');
    expect(summary?.dataFetching).toEqual(['getServerSideProps']);
    expect(summary?.pageProps).toEqual(['user', 'apiUrl']);
    expect(summary?.endpoints).toEqual(['/api/v1/billing/summary']);
    const byPath = Object.fromEntries((summary?.sensitive ?? []).map((s) => [s.path, s]));
    expect(byPath['props.pageProps.user.email']).toMatchObject({
      reason: 'pii',
      preview: 'a…e@example.test',
    });
    expect(byPath['props.pageProps.user.isAdmin']).toMatchObject({
      reason: 'privilege',
      preview: 'true',
    });
    expect(byPath['props.pageProps.user.internalToken']).toMatchObject({
      reason: 'credential',
      preview: 'tok_…cdef',
    });
  });

  it('rejects malformed or unrelated JSON', () => {
    expect(parseNextData('not json')).toBeNull();
    expect(parseNextData('{"hello":"world"}')).toBeNull();
  });
});

describe('mergeScriptIntel', () => {
  it('deduplicates across sources and preserves priority order', () => {
    const a = analyzeSourceFile('fetch("/api/users");', BASE);
    const b = analyzeSourceFile('axios.post("/api/users", {}); fetch("/admin/audit");', {
      ...BASE,
      file: 'src/Admin.tsx',
    });
    const merged = mergeScriptIntel([a, b]);
    expect(merged.endpoints.map((e) => [e.value, e.category, e.methods])).toEqual([
      ['/admin/audit', 'admin', ['GET']],
      ['/api/users', 'api', ['GET', 'POST']],
    ]);
    expect(merged.endpoints[1]?.locations).toHaveLength(2);
  });
});
