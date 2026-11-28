export interface SafeCheckItem {
  id: string;
  title: string;
  status: 'ok' | 'warn' | 'info' | 'error';
  detail: string;
  evidence?: string;
}

export interface SafeCheckReport {
  origin: string;
  checkedAt: number;
  items: SafeCheckItem[];
}

export const PROBE_ORIGIN = 'https://maphound-probe.example';

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

async function safeFetch(
  fetchFn: FetchLike,
  url: string,
  init: RequestInit = {},
  timeoutMs = 5_000,
): Promise<Response | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchFn(url, { ...init, signal: controller.signal, redirect: 'follow' });
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * User-triggered, non-destructive verification checks for an explicitly enabled origin:
 * 1. CORS reflection & credentials check
 * 2. GraphQL introspection check (`{__schema{queryType{name}}}`)
 * 3. `/.well-known/security.txt` and `/.well-known/openid-configuration`
 */
export async function runSafeVerificationChecks(
  origin: string,
  fetchFn: FetchLike = (url, init) => fetch(url, init),
  now: number = Date.now(),
): Promise<SafeCheckReport> {
  const items: SafeCheckItem[] = [];

  // 1. CORS reflection check (unauthenticated probe)
  const corsRes = await safeFetch(fetchFn, `${origin}/`, {
    method: 'GET',
    credentials: 'omit',
    headers: { Origin: PROBE_ORIGIN },
  });
  if (corsRes) {
    const acao = corsRes.headers.get('access-control-allow-origin')?.trim() ?? '';
    const acac =
      corsRes.headers.get('access-control-allow-credentials')?.trim().toLowerCase() ?? '';
    void corsRes.body?.cancel().catch(() => {});
    if (acao === PROBE_ORIGIN) {
      items.push({
        id: 'verify:cors-reflection',
        title:
          acac === 'true'
            ? 'CORS reflects arbitrary Origin with Allow-Credentials: true'
            : 'CORS reflects arbitrary Origin header',
        status: 'warn',
        detail: `Server echoed Origin "${PROBE_ORIGIN}" in Access-Control-Allow-Origin${acac === 'true' ? ' alongside Access-Control-Allow-Credentials: true' : ''}.`,
        evidence: `ACAO: ${acao}${acac ? ` | ACAC: ${acac}` : ''}`,
      });
    } else if (acao === '*' && acac === 'true') {
      items.push({
        id: 'verify:cors-wildcard-creds',
        title: 'CORS wildcard (*) combined with Allow-Credentials: true',
        status: 'warn',
        detail: 'Misconfigured CORS headers combine wildcard origin with credentials.',
        evidence: 'ACAO: * | ACAC: true',
      });
    } else {
      items.push({
        id: 'verify:cors-ok',
        title: 'CORS reflection check passed',
        status: 'ok',
        detail: acao
          ? `Server returned Access-Control-Allow-Origin: ${acao} (did not reflect probe origin).`
          : 'No permissive Access-Control-Allow-Origin reflection detected.',
      });
    }
  } else {
    items.push({
      id: 'verify:cors-error',
      title: 'CORS check unreachable',
      status: 'error',
      detail: 'Could not reach the origin root to inspect CORS headers.',
    });
  }

  // 2. GraphQL Introspection check
  const gqlRes = await safeFetch(fetchFn, `${origin}/graphql`, {
    method: 'POST',
    credentials: 'omit',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: '{__schema{queryType{name}}}' }),
  });
  if (gqlRes && gqlRes.ok) {
    try {
      const text = (await gqlRes.text()).slice(0, 64_000);
      const parsed = JSON.parse(text) as {
        data?: { __schema?: { queryType?: { name?: string } } };
      };
      const queryTypeName = parsed?.data?.__schema?.queryType?.name;
      if (queryTypeName) {
        items.push({
          id: 'verify:graphql-introspection',
          title: 'GraphQL Introspection is enabled on /graphql',
          status: 'warn',
          detail: `Introspection returned root queryType "${queryTypeName}". Disable introspection in production if the schema is private.`,
          evidence: `POST /graphql -> queryType: ${queryTypeName}`,
        });
      } else {
        items.push({
          id: 'verify:graphql-disabled',
          title: 'GraphQL Introspection not exposed on /graphql',
          status: 'ok',
          detail: '/graphql responded without returning __schema metadata.',
        });
      }
    } catch {
      items.push({
        id: 'verify:graphql-none',
        title: 'No GraphQL Introspection response on /graphql',
        status: 'info',
        detail: '/graphql did not return JSON GraphQL schema data.',
      });
    }
  } else {
    void gqlRes?.body?.cancel().catch(() => {});
    items.push({
      id: 'verify:graphql-none',
      title: '/graphql endpoint not exposed',
      status: 'info',
      detail: `POST /graphql returned HTTP ${gqlRes?.status ?? 'network error'}.`,
    });
  }

  // 3. /.well-known/security.txt
  const secTxtRes = await safeFetch(fetchFn, `${origin}/.well-known/security.txt`, {
    credentials: 'omit',
  });
  if (secTxtRes && secTxtRes.ok) {
    const body = (await secTxtRes.text()).slice(0, 8_000);
    const contact = /^Contact:\s*(.+)$/im.exec(body)?.[1]?.trim();
    items.push({
      id: 'verify:security-txt',
      title: '/.well-known/security.txt found',
      status: 'info',
      detail: contact
        ? `Security contact published: ${contact.slice(0, 120)}`
        : 'security.txt is present on this origin.',
      evidence: contact ?? '/.well-known/security.txt (200)',
    });
  } else {
    void secTxtRes?.body?.cancel().catch(() => {});
    items.push({
      id: 'verify:security-txt-missing',
      title: '/.well-known/security.txt not found',
      status: 'info',
      detail: `HTTP ${secTxtRes?.status ?? 'network error'}.`,
    });
  }

  // 4. /.well-known/openid-configuration
  const oidcRes = await safeFetch(fetchFn, `${origin}/.well-known/openid-configuration`, {
    credentials: 'omit',
  });
  if (oidcRes && oidcRes.ok) {
    try {
      const json = JSON.parse((await oidcRes.text()).slice(0, 32_000)) as {
        issuer?: string;
        token_endpoint?: string;
        authorization_endpoint?: string;
      };
      if (json.issuer || json.token_endpoint) {
        items.push({
          id: 'verify:openid-config',
          title: 'OpenID Connect discovery document exposed',
          status: 'info',
          detail: `Issuer: ${json.issuer ?? 'unknown'}${json.token_endpoint ? ` · Token endpoint: ${json.token_endpoint}` : ''}`,
          evidence: '/.well-known/openid-configuration (200)',
        });
      }
    } catch {
      // not valid JSON OIDC config
    }
  } else {
    void oidcRes?.body?.cancel().catch(() => {});
  }

  return { origin, checkedAt: now, items };
}
