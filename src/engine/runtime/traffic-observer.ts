import { classifyPath, type EndpointHit, type HttpMethod } from '@/engine/intel';

export const MAX_OBSERVED_API_EVENTS = 200;

export interface ObservedGraphqlInfo {
  operationName?: string;
  operationType: 'query' | 'mutation' | 'subscription';
  variables: string[];
}

export interface ObservedApiEvent {
  /** Stable dedupe key: `${origin}|${method}|${path}|${graphqlOp}` */
  id: string;
  origin: string;
  method: HttpMethod;
  path: string;
  status: number;
  /** Header names only (e.g. Authorization, X-CSRF-Token, X-API-Key) — never raw values. */
  authHeaders: string[];
  requestKeys: string[];
  responseKeys: string[];
  graphql?: ObservedGraphqlInfo;
  count: number;
  lastSeen: number;
}

const AUTH_HEADER_NAMES = new Set([
  'authorization',
  'x-csrf-token',
  'x-xsrf-token',
  'x-api-key',
  'x-auth-token',
  'x-access-token',
  'api-key',
  'apikey',
]);

const CANONICAL_AUTH_LABELS: Record<string, string> = {
  authorization: 'Authorization',
  'x-csrf-token': 'X-CSRF-Token',
  'x-xsrf-token': 'X-XSRF-Token',
  'x-api-key': 'X-API-Key',
  'x-auth-token': 'X-Auth-Token',
  'x-access-token': 'X-Access-Token',
  'api-key': 'API-Key',
  apikey: 'ApiKey',
};

const VALID_METHODS = new Set<HttpMethod>([
  'GET',
  'POST',
  'PUT',
  'PATCH',
  'DELETE',
  'HEAD',
  'OPTIONS',
]);

export function normalizeHttpMethod(raw: string | undefined): HttpMethod {
  const upper = (raw ?? 'GET').trim().toUpperCase() as HttpMethod;
  return VALID_METHODS.has(upper) ? upper : 'GET';
}

export function extractAuthHeaderNames(headerNames: readonly string[]): string[] {
  const found = new Set<string>();
  for (const name of headerNames) {
    const lower = name.trim().toLowerCase();
    if (AUTH_HEADER_NAMES.has(lower)) {
      found.add(CANONICAL_AUTH_LABELS[lower] ?? name.trim());
    }
  }
  return [...found].sort();
}

export function extractJsonShapeKeys(rawText: string | null | undefined, maxKeys = 24): string[] {
  if (!rawText || rawText.length > 256_000) return [];
  const trimmed = rawText.trim();
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return [];
  try {
    const parsed: unknown = JSON.parse(trimmed);
    const target = Array.isArray(parsed) ? parsed[0] : parsed;
    if (!target || typeof target !== 'object' || Array.isArray(target)) return [];
    return Object.keys(target as Record<string, unknown>)
      .slice(0, maxKeys)
      .sort();
  } catch {
    return [];
  }
}

const GQL_OP_RE =
  /^\s{0,40}(query|mutation|subscription)(?:\s{1,8}([A-Za-z_][A-Za-z0-9_]{0,60}))?/i;

export function parseGraphqlPayload(
  rawText: string | null | undefined,
): ObservedGraphqlInfo | undefined {
  if (!rawText || rawText.length > 128_000) return undefined;
  const trimmed = rawText.trim();
  if (!trimmed.startsWith('{')) return undefined;
  try {
    const parsed = JSON.parse(trimmed) as Record<string, unknown>;
    if (typeof parsed.query !== 'string') return undefined;
    const queryStr = parsed.query.trim();
    const match = GQL_OP_RE.exec(queryStr);
    const opType = (match?.[1]?.toLowerCase() ?? 'query') as ObservedGraphqlInfo['operationType'];
    const opName =
      typeof parsed.operationName === 'string' && parsed.operationName.trim()
        ? parsed.operationName.trim().slice(0, 64)
        : match?.[2];
    const variables =
      parsed.variables && typeof parsed.variables === 'object' && !Array.isArray(parsed.variables)
        ? Object.keys(parsed.variables as Record<string, unknown>)
            .slice(0, 24)
            .sort()
        : [];
    return {
      ...(opName ? { operationName: opName } : {}),
      operationType: opType,
      variables,
    };
  } catch {
    return undefined;
  }
}

export function buildObservedApiEvent(input: {
  origin: string;
  url: string;
  method?: string;
  status: number;
  headerNames?: readonly string[];
  requestBody?: string | null;
  responseBody?: string | null;
  now?: number;
}): ObservedApiEvent | null {
  let parsed: URL;
  try {
    parsed = new URL(input.url, input.origin);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  const method = normalizeHttpMethod(input.method);
  const path = `${parsed.pathname}${parsed.search}`.slice(0, 300) || '/';
  const graphql = parseGraphqlPayload(input.requestBody);
  const opSuffix = graphql ? `:${graphql.operationType}:${graphql.operationName ?? 'anon'}` : '';
  const id = `${input.origin}|${method}|${path}${opSuffix}`;

  return {
    id,
    origin: input.origin,
    method,
    path,
    status: Number.isFinite(input.status) ? input.status : 0,
    authHeaders: extractAuthHeaderNames(input.headerNames ?? []),
    requestKeys: extractJsonShapeKeys(input.requestBody),
    responseKeys: extractJsonShapeKeys(input.responseBody),
    ...(graphql ? { graphql } : {}),
    count: 1,
    lastSeen: input.now ?? Date.now(),
  };
}

export function mergeObservedApiEvent(
  existing: ObservedApiEvent | undefined,
  incoming: ObservedApiEvent,
): ObservedApiEvent {
  if (!existing) return incoming;
  return {
    ...existing,
    status: incoming.status || existing.status,
    authHeaders: [...new Set([...existing.authHeaders, ...incoming.authHeaders])].sort(),
    requestKeys: [...new Set([...existing.requestKeys, ...incoming.requestKeys])]
      .slice(0, 32)
      .sort(),
    responseKeys: [...new Set([...existing.responseKeys, ...incoming.responseKeys])]
      .slice(0, 32)
      .sort(),
    graphql: incoming.graphql ?? existing.graphql,
    count: existing.count + incoming.count,
    lastSeen: Math.max(existing.lastSeen, incoming.lastSeen),
  };
}

export function observedEventsToEndpoints(events: readonly ObservedApiEvent[]): EndpointHit[] {
  const byPath = new Map<string, EndpointHit>();
  for (const ev of events) {
    const existing = byPath.get(ev.path);
    const category = ev.graphql ? 'graphql' : (classifyPath(ev.path) ?? 'api');
    if (existing) {
      if (!existing.methods.includes(ev.method)) existing.methods.push(ev.method);
      existing.liveObserved = true;
    } else {
      byPath.set(ev.path, {
        value: ev.path,
        category,
        methods: [ev.method],
        dynamic: false,
        liveObserved: true,
        locations: [
          {
            file: ev.graphql
              ? `live:graphql:${ev.graphql.operationName ?? ev.graphql.operationType}`
              : `live:${ev.status || 'xhr'}`,
            line: 1,
            column: 0,
            kind: 'bundle',
            scriptUrl: `${ev.origin}${ev.path}`,
          },
        ],
      });
    }
  }
  return [...byPath.values()];
}
