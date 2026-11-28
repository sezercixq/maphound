import type { EndpointCategory, EndpointHit } from '@/engine/intel';

export interface OpenApiParameter {
  name: string;
  in: 'path' | 'query';
  required: boolean;
  schema: { type: 'string' };
}

export interface OpenApiOperation {
  summary: string;
  tags: string[];
  parameters?: OpenApiParameter[];
  requestBody?: {
    required: false;
    content: {
      'application/json': {
        schema: { type: 'object'; additionalProperties: true };
      };
    };
  };
  security?: Record<string, string[]>[];
  responses: {
    '200': { description: string };
  };
  'x-maphound-locations'?: string[];
}

export interface OpenApiDocument {
  openapi: '3.0.3';
  info: {
    title: string;
    version: string;
    description: string;
  };
  servers: { url: string }[];
  components: {
    securitySchemes: {
      BearerAuth: { type: 'http'; scheme: 'bearer'; bearerFormat: 'JWT' };
      ApiKeyAuth: { type: 'apiKey'; in: 'header'; name: 'X-API-Key' };
    };
  };
  paths: Record<string, Record<string, OpenApiOperation>>;
}

const AUTH_CATEGORIES = new Set<EndpointCategory>(['admin', 'auth', 'api', 'graphql']);

function normalizeEndpointPath(
  raw: string,
  origin: string,
): {
  path: string;
  pathParams: string[];
  queryParams: string[];
} | null {
  let pathname = raw.trim();
  let search = '';
  if (!pathname) return null;

  if (/^wss?:\/\//i.test(pathname)) return null;

  if (/^https?:\/\//i.test(pathname)) {
    try {
      const parsed = new URL(pathname);
      if (parsed.origin !== origin) return null;
      pathname = parsed.pathname;
      search = parsed.search;
    } catch {
      return null;
    }
  } else {
    const qIdx = pathname.indexOf('?');
    if (qIdx >= 0) {
      search = pathname.slice(qIdx);
      pathname = pathname.slice(0, qIdx);
    }
    const hIdx = pathname.indexOf('#');
    if (hIdx >= 0) pathname = pathname.slice(0, hIdx);
    if (!pathname.startsWith('/')) pathname = `/${pathname}`;
  }

  // Normalize `:param` -> `{param}` for OpenAPI 3.0.3 path templates
  const pathParams: string[] = [];
  const normalizedPath = pathname.replace(
    /\/:([A-Za-z_][A-Za-z0-9_]{0,40})|\{([A-Za-z_][A-Za-z0-9_]{0,40})\}/g,
    (full, colonName: string | undefined, braceName: string | undefined) => {
      const name = colonName ?? braceName ?? 'param';
      if (!pathParams.includes(name)) pathParams.push(name);
      return colonName ? `/{${name}}` : full;
    },
  );

  const queryParams: string[] = [];
  if (search.length > 1) {
    const sp = new URLSearchParams(search.slice(1));
    for (const key of sp.keys()) {
      if (key && !queryParams.includes(key)) queryParams.push(key);
    }
  }

  return { path: normalizedPath || '/', pathParams, queryParams };
}

/**
 * Converts discovered endpoints into a Burp Suite / Postman compatible OpenAPI 3.0.3 document.
 */
export function buildOpenApiSpec(input: {
  origin: string;
  endpoints: readonly EndpointHit[];
  version?: string;
}): OpenApiDocument {
  const paths: Record<string, Record<string, OpenApiOperation>> = {};

  for (const ep of input.endpoints) {
    const parsed = normalizeEndpointPath(ep.value, input.origin);
    if (!parsed) continue;

    const methods = ep.methods.length > 0 ? ep.methods : (['GET'] as const);
    const pathItem = paths[parsed.path] ?? {};

    const parameters: OpenApiParameter[] = [
      ...parsed.pathParams.map(
        (name): OpenApiParameter => ({
          name,
          in: 'path',
          required: true,
          schema: { type: 'string' },
        }),
      ),
      ...parsed.queryParams.map(
        (name): OpenApiParameter => ({
          name,
          in: 'query',
          required: false,
          schema: { type: 'string' },
        }),
      ),
    ];

    const locations = ep.locations.slice(0, 5).map((l) => `${l.file}:${l.line}`);

    for (const rawMethod of methods) {
      const method = rawMethod.toLowerCase();
      if (pathItem[method]) continue;

      const hasBody = method === 'post' || method === 'put' || method === 'patch';
      const op: OpenApiOperation = {
        summary: `${rawMethod} ${parsed.path}`,
        tags: [ep.category],
        ...(parameters.length > 0 ? { parameters } : {}),
        ...(hasBody
          ? {
              requestBody: {
                required: false,
                content: {
                  'application/json': {
                    schema: { type: 'object', additionalProperties: true },
                  },
                },
              },
            }
          : {}),
        ...(AUTH_CATEGORIES.has(ep.category)
          ? { security: [{ BearerAuth: [] }, { ApiKeyAuth: [] }] }
          : {}),
        responses: { '200': { description: 'Observed client-side endpoint' } },
        ...(locations.length > 0 ? { 'x-maphound-locations': locations } : {}),
      };
      pathItem[method] = op;
    }

    paths[parsed.path] = pathItem;
  }

  return {
    openapi: '3.0.3',
    info: {
      title: `MapHound Discovered API — ${input.origin}`,
      version: input.version ?? '0.6.0',
      description:
        'Auto-generated offline from client-side JavaScript bundles and source maps by MapHound. Compatible with Burp Suite and Postman.',
    },
    servers: [{ url: input.origin }],
    components: {
      securitySchemes: {
        BearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
        ApiKeyAuth: { type: 'apiKey', in: 'header', name: 'X-API-Key' },
      },
    },
    paths,
  };
}

export function openApiJson(input: {
  origin: string;
  endpoints: readonly EndpointHit[];
  version?: string;
}): string {
  return `${JSON.stringify(buildOpenApiSpec(input), null, 2)}\n`;
}
