import { auditSourceCrypto } from '@/engine/audit/crypto-audit';
import { auditOAuthSource } from '@/engine/audit/oauth-audit';
import { detectSkimmerPatterns } from '@/engine/audit/supply-chain';
import { extractModuleSummary, MAX_MODULES_PER_SITE } from './architecture';
import { extractAuthzSurface } from './authz-surface';
import {
  extractComments,
  extractEndpoints,
  extractFileArtifacts,
  extractRoutes,
} from './endpoints';
import { LineIndex, lex } from './lexer';
import { extractOsint, sortOsintHits } from './osint';
import { extractSinks } from './sinks';
import { extractTaintFlows } from './taint';
import {
  type CommentHit,
  ENDPOINT_CATEGORIES,
  type EndpointHit,
  HINT_LEVELS,
  HTTP_METHODS,
  type IntelLocation,
  type ModuleSummary,
  type OsintHit,
  type RouteHit,
  type RouteKind,
  type ScriptIntel,
  type SinkHit,
} from './types';

export const MAX_SOURCE_SCAN_CHARS = 5_000_000;
export const MAX_BUNDLE_SCAN_CHARS = 2_000_000;

export interface IntelLimits {
  endpoints: number;
  routes: number;
  comments: number;
  sinks: number;
  modules: number;
  osint: number;
  locationsPerItem: number;
}

export const DEFAULT_INTEL_LIMITS: IntelLimits = {
  endpoints: 300,
  routes: 200,
  comments: 150,
  sinks: 200,
  modules: MAX_MODULES_PER_SITE,
  osint: 200,
  locationsPerItem: 10,
};

const ROUTE_KIND_PRIORITY: Record<RouteKind, number> = {
  definition: 4,
  file: 3,
  manifest: 2,
  navigation: 1,
};

const EMPTY_INTEL: ScriptIntel = {
  endpoints: [],
  routes: [],
  comments: [],
  sinks: [],
  modules: [],
  osint: [],
  truncated: false,
};

export function analyzeSourceFile(
  content: string,
  location: Omit<IntelLocation, 'line' | 'column'>,
  options: { vendor?: boolean; isBundle?: boolean; siteOrigin?: string } = {},
): ScriptIntel {
  if (options.vendor) return EMPTY_INTEL;
  const isBundle = options.isBundle ?? false;
  const maxChars = isBundle ? MAX_BUNDLE_SCAN_CHARS : MAX_SOURCE_SCAN_CHARS;
  const truncated = content.length > maxChars;
  const slice = truncated ? content.slice(0, maxChars) : content;

  const lexed = lex(slice, { needCode: !isBundle });
  const lines = new LineIndex(slice);

  const endpoints = extractEndpoints(slice, lexed, lines, location);
  const routes = extractRoutes(slice, lexed, lines, location);
  const comments = isBundle ? [] : extractComments(slice, lexed, lines, location);
  const sinks = isBundle
    ? [
        ...detectSkimmerPatterns(slice, lines, location, options.siteOrigin),
        ...auditOAuthSource(slice, lines, location),
      ]
    : [
        ...extractTaintFlows(slice, lexed, lines, location),
        ...extractSinks(slice, lexed, lines, location),
        ...extractAuthzSurface(slice, lexed, lines, location, endpoints),
        ...auditSourceCrypto(slice, lexed, lines, location),
        ...detectSkimmerPatterns(slice, lines, location, options.siteOrigin),
        ...auditOAuthSource(slice, lines, location),
      ];
  const osint = extractOsint(slice, lexed, lines, location, { siteOrigin: options.siteOrigin });

  if (!isBundle) {
    const fileArtifacts = extractFileArtifacts(location.file, location.scriptUrl, location.mapUrl);
    if (fileArtifacts.endpoint) endpoints.push(fileArtifacts.endpoint);
    if (fileArtifacts.route) routes.push(fileArtifacts.route);
  }

  const modules = isBundle ? [] : [extractModuleSummary(slice, lexed, lines, location, endpoints)];

  return {
    endpoints,
    routes,
    comments,
    sinks,
    modules,
    osint,
    truncated,
  };
}

function mergeLocations(
  target: IntelLocation[],
  incoming: readonly IntelLocation[],
  maxLocations: number,
): void {
  for (const loc of incoming) {
    if (
      target.some(
        (existing) =>
          existing.file === loc.file &&
          existing.line === loc.line &&
          existing.column === loc.column &&
          existing.scriptUrl === loc.scriptUrl,
      )
    ) {
      continue;
    }
    target.push(loc);
  }
  target.sort(
    (a, b) =>
      Number(b.kind === 'source') - Number(a.kind === 'source') ||
      a.file.localeCompare(b.file) ||
      a.line - b.line,
  );
  if (target.length > maxLocations) target.length = maxLocations;
}

export function mergeScriptIntel(
  items: readonly ScriptIntel[],
  overrides: Partial<IntelLimits> = {},
): ScriptIntel {
  const limits = { ...DEFAULT_INTEL_LIMITS, ...overrides };
  const endpointsMap = new Map<string, EndpointHit>();
  const routesMap = new Map<string, RouteHit>();
  const commentsMap = new Map<string, CommentHit>();
  const sinksMap = new Map<string, SinkHit>();
  const modulesMap = new Map<string, ModuleSummary>();
  const osintMap = new Map<string, OsintHit>();
  let truncated = false;

  for (const item of items) {
    if (item.truncated) truncated = true;

    for (const ep of item.endpoints) {
      const existing = endpointsMap.get(ep.value);
      if (existing) {
        for (const m of ep.methods) {
          if (!existing.methods.includes(m)) existing.methods.push(m);
        }
        existing.methods.sort((a, b) => HTTP_METHODS.indexOf(a) - HTTP_METHODS.indexOf(b));
        if (
          ENDPOINT_CATEGORIES.indexOf(ep.category) < ENDPOINT_CATEGORIES.indexOf(existing.category)
        ) {
          existing.category = ep.category;
        }
        existing.dynamic ||= ep.dynamic;
        mergeLocations(existing.locations, ep.locations, limits.locationsPerItem);
      } else {
        const copy: EndpointHit = {
          ...ep,
          methods: [...ep.methods],
          locations: [],
        };
        mergeLocations(copy.locations, ep.locations, limits.locationsPerItem);
        endpointsMap.set(ep.value, copy);
      }
    }

    for (const route of item.routes) {
      const existing = routesMap.get(route.path);
      if (existing) {
        if (ROUTE_KIND_PRIORITY[route.kind] > ROUTE_KIND_PRIORITY[existing.kind]) {
          existing.kind = route.kind;
        }
        mergeLocations(existing.locations, route.locations, limits.locationsPerItem);
      } else {
        const copy: RouteHit = { ...route, locations: [] };
        mergeLocations(copy.locations, route.locations, limits.locationsPerItem);
        routesMap.set(route.path, copy);
      }
    }

    for (const comment of item.comments) {
      const key = `${comment.location.file}:${comment.location.line}:${comment.marker}`;
      if (!commentsMap.has(key)) commentsMap.set(key, comment);
    }

    for (const sink of item.sinks) {
      const key = `${sink.ruleId}:${sink.location.file}:${sink.location.line}`;
      const existing = sinksMap.get(key);
      if (!existing || HINT_LEVELS.indexOf(sink.level) < HINT_LEVELS.indexOf(existing.level)) {
        sinksMap.set(key, sink);
      }
    }

    for (const mod of item.modules ?? []) {
      const existing = modulesMap.get(mod.file);
      if (!existing) {
        modulesMap.set(mod.file, {
          ...mod,
          imports: [...mod.imports],
          exports: [...mod.exports],
          endpoints: [...mod.endpoints],
          sdks: [...mod.sdks],
        });
      } else {
        for (const imp of mod.imports)
          if (!existing.imports.includes(imp)) existing.imports.push(imp);
        for (const exp of mod.exports)
          if (!existing.exports.includes(exp)) existing.exports.push(exp);
        for (const ep of mod.endpoints) {
          if (!existing.endpoints.some((x) => x.value === ep.value && x.line === ep.line)) {
            existing.endpoints.push(ep);
          }
        }
        for (const sdk of mod.sdks) {
          if (!existing.sdks.some((x) => x.name === sdk.name)) existing.sdks.push(sdk);
        }
      }
    }

    for (const hit of item.osint ?? []) {
      const key = `${hit.category}\u0000${hit.kind}\u0000${hit.value}`;
      const existing = osintMap.get(key);
      if (existing) {
        if (!existing.detail && hit.detail) existing.detail = hit.detail;
        mergeLocations(existing.locations, hit.locations, limits.locationsPerItem);
      } else {
        const copy: OsintHit = { ...hit, locations: [] };
        mergeLocations(copy.locations, hit.locations, limits.locationsPerItem);
        osintMap.set(key, copy);
      }
    }
  }

  const endpoints = [...endpointsMap.values()].sort(
    (a, b) =>
      ENDPOINT_CATEGORIES.indexOf(a.category) - ENDPOINT_CATEGORIES.indexOf(b.category) ||
      a.value.localeCompare(b.value),
  );
  const routes = [...routesMap.values()].sort(
    (a, b) =>
      ROUTE_KIND_PRIORITY[b.kind] - ROUTE_KIND_PRIORITY[a.kind] || a.path.localeCompare(b.path),
  );
  const comments = [...commentsMap.values()].sort(
    (a, b) =>
      HINT_LEVELS.indexOf(a.level) - HINT_LEVELS.indexOf(b.level) ||
      a.location.file.localeCompare(b.location.file) ||
      a.location.line - b.location.line,
  );
  const sinks = [...sinksMap.values()].sort(
    (a, b) =>
      HINT_LEVELS.indexOf(a.level) - HINT_LEVELS.indexOf(b.level) ||
      a.location.file.localeCompare(b.location.file) ||
      a.location.line - b.location.line,
  );

  const modules = [...modulesMap.values()].sort((a, b) => a.file.localeCompare(b.file));
  const osint = sortOsintHits([...osintMap.values()]);

  if (
    endpoints.length > limits.endpoints ||
    routes.length > limits.routes ||
    comments.length > limits.comments ||
    sinks.length > limits.sinks ||
    modules.length > limits.modules ||
    osint.length > limits.osint
  ) {
    truncated = true;
  }

  return {
    endpoints: endpoints.slice(0, limits.endpoints),
    routes: routes.slice(0, limits.routes),
    comments: comments.slice(0, limits.comments),
    sinks: sinks.slice(0, limits.sinks),
    modules: modules.slice(0, limits.modules),
    osint: osint.slice(0, limits.osint),
    truncated,
  };
}
