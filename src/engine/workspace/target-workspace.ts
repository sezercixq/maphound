import { parse as parseDomain } from 'tldts';
import type {
  AuditRecord,
  FindingRecord,
  JobRecord,
  MapRecord,
  PageIntelRecord,
  ScriptIntelRecord,
  ScriptRecord,
  SiteRecord,
} from '@/core/db';
import { openApiJson } from '@/engine/export/openapi';
import { mergeScriptIntel, type ScriptIntel } from '@/engine/intel';
import {
  type ObservedApiEvent,
  observedEventsToEndpoints,
  type RuntimeDomEvent,
} from '@/engine/runtime';
import { combineSiteIntel } from '@/engine/zip/endpoints-report';
import { sortFindings } from '@/engine/zip/findings-report';

/** Extract the registrable root domain (e.g. `app.shop.example.com` -> `example.com`). */
export function registrableDomainFor(originOrUrl: string): string {
  let hostname = originOrUrl.trim().toLowerCase();
  try {
    hostname = new URL(originOrUrl).hostname.toLowerCase();
  } catch {
    // Allow bare hostnames as input.
    hostname = hostname.replace(/^https?:\/\//, '').split('/')[0] ?? hostname;
    hostname = hostname.split(':')[0] ?? hostname;
  }
  if (!hostname) return '';
  if (hostname === 'localhost' || /^\d+\.\d+\.\d+\.\d+$/.test(hostname) || hostname.includes(':')) {
    return hostname;
  }
  const parsed = parseDomain(hostname);
  return parsed.domain ?? hostname;
}

/** Return every enabled site that belongs to the same registrable domain as `origin`. */
export function sitesInWorkspace(allSites: readonly SiteRecord[], origin: string): SiteRecord[] {
  const root = registrableDomainFor(origin);
  if (!root) return [];
  return allSites
    .filter((s) => registrableDomainFor(s.origin) === root)
    .sort((a, b) => a.origin.localeCompare(b.origin));
}

export interface WorkspaceMergeInput {
  domain: string;
  origins: readonly string[];
  jobs: readonly JobRecord[];
  scripts: readonly ScriptRecord[];
  maps: readonly MapRecord[];
  findings: readonly FindingRecord[];
  intel: readonly ScriptIntelRecord[];
  pages: readonly PageIntelRecord[];
  audits: readonly AuditRecord[];
  runtimeApi: readonly ObservedApiEvent[];
  runtimeDom: readonly RuntimeDomEvent[];
}

export interface MergedWorkspaceState {
  domain: string;
  origins: string[];
  visitedPages: string[];
  pageCount: number;
  jobs: JobRecord[];
  scripts: ScriptRecord[];
  maps: MapRecord[];
  findings: FindingRecord[];
  intel: ScriptIntel;
  pages: PageIntelRecord[];
  audits: AuditRecord[];
  runtimeApi: ObservedApiEvent[];
  runtimeDom: RuntimeDomEvent[];
}

function normalizePageUrl(raw: string): string | null {
  try {
    const u = new URL(raw);
    return `${u.origin}${u.pathname}`;
  } catch {
    return null;
  }
}

/**
 * Deduplicate and merge findings, endpoints, taint flows, OSINT hits, runtime API traffic,
 * and visited pages collected across multiple routes and subdomains of one registrable domain.
 */
export function mergeWorkspaceState(input: WorkspaceMergeInput): MergedWorkspaceState {
  const originSet = new Set<string>(input.origins);
  const visitedSet = new Set<string>();

  for (const audit of input.audits) {
    originSet.add(audit.origin);
    const norm = normalizePageUrl(audit.pageUrl);
    if (norm) visitedSet.add(norm);
  }
  for (const page of input.pages) {
    originSet.add(page.origin);
    const norm = normalizePageUrl(page.pageUrl);
    if (norm) visitedSet.add(norm);
  }
  for (const job of input.jobs) {
    originSet.add(job.origin);
    if (job.pageUrl) {
      const norm = normalizePageUrl(job.pageUrl);
      if (norm) visitedSet.add(norm);
    }
  }

  // Deduplicate scripts by hash
  const scriptsByHash = new Map<string, ScriptRecord>();
  for (const script of input.scripts) {
    const existing = scriptsByHash.get(script.hash);
    if (!existing) {
      scriptsByHash.set(script.hash, { ...script, urls: [...script.urls] });
    } else {
      const urls = new Set([...existing.urls, ...script.urls]);
      existing.urls = [...urls];
      existing.lastAccess = Math.max(existing.lastAccess, script.lastAccess);
    }
  }

  // Deduplicate maps by hash + url
  const mapsByKey = new Map<string, MapRecord>();
  for (const map of input.maps) {
    const key = `${map.hash}|${map.url}`;
    if (!mapsByKey.has(key)) mapsByKey.set(key, map);
  }

  // Deduplicate jobs by id
  const jobsById = new Map<string, JobRecord>();
  for (const job of input.jobs) {
    if (!jobsById.has(job.id)) jobsById.set(job.id, job);
  }

  // Deduplicate secret findings across subdomains by ruleId + secretHash
  const findingsByKey = new Map<string, FindingRecord>();
  for (const finding of input.findings) {
    const key = `${finding.ruleId}|${finding.secretHash}`;
    const existing = findingsByKey.get(key);
    if (!existing) {
      findingsByKey.set(key, { ...finding, locations: [...finding.locations] });
    } else {
      const locs = [...existing.locations];
      for (const loc of finding.locations) {
        if (
          !locs.some(
            (l) =>
              l.file === loc.file &&
              l.line === loc.line &&
              l.column === loc.column &&
              l.scriptUrl === loc.scriptUrl,
          )
        ) {
          locs.push(loc);
        }
      }
      existing.locations = locs.slice(0, 25);
      existing.occurrences += finding.occurrences;
      existing.updatedAt = Math.max(existing.updatedAt, finding.updatedAt);
    }
  }

  // Deduplicate pages & audits by normalized pageUrl (keep newest)
  const pagesByUrl = new Map<string, PageIntelRecord>();
  for (const page of input.pages) {
    const key = normalizePageUrl(page.pageUrl) ?? page.id;
    const existing = pagesByUrl.get(key);
    if (!existing || page.updatedAt > existing.updatedAt) {
      pagesByUrl.set(key, page);
    }
  }

  const auditsByUrl = new Map<string, AuditRecord>();
  for (const audit of input.audits) {
    const key = normalizePageUrl(audit.pageUrl) ?? audit.id;
    const existing = auditsByUrl.get(key);
    if (!existing || audit.updatedAt > existing.updatedAt) {
      auditsByUrl.set(key, audit);
    }
  }

  // Deduplicate runtime API events across origins by method + path + graphql op
  const apiByKey = new Map<string, ObservedApiEvent>();
  for (const ev of input.runtimeApi) {
    const key = `${ev.method}|${ev.path}|${ev.graphql?.operationName ?? ''}`;
    const existing = apiByKey.get(key);
    if (!existing) {
      apiByKey.set(key, {
        ...ev,
        authHeaders: [...ev.authHeaders],
        requestKeys: [...ev.requestKeys],
        responseKeys: [...ev.responseKeys],
      });
    } else {
      existing.count += ev.count;
      existing.lastSeen = Math.max(existing.lastSeen, ev.lastSeen);
      if (ev.status > 0) existing.status = ev.status;
      existing.authHeaders = [...new Set([...existing.authHeaders, ...ev.authHeaders])].sort();
      existing.requestKeys = [...new Set([...existing.requestKeys, ...ev.requestKeys])]
        .sort()
        .slice(0, 40);
      existing.responseKeys = [...new Set([...existing.responseKeys, ...ev.responseKeys])]
        .sort()
        .slice(0, 40);
    }
  }

  // Deduplicate runtime DOM events by kind + detail
  const domByKey = new Map<string, RuntimeDomEvent>();
  for (const ev of input.runtimeDom) {
    const key = `${ev.kind}|${ev.detail}`;
    const existing = domByKey.get(key);
    if (!existing) {
      domByKey.set(key, { ...ev });
    } else {
      existing.count += ev.count;
      existing.lastSeen = Math.max(existing.lastSeen, ev.lastSeen);
    }
  }

  const mergedPages = [...pagesByUrl.values()].sort((a, b) => a.pageUrl.localeCompare(b.pageUrl));
  const mergedAudits = [...auditsByUrl.values()].sort((a, b) => a.pageUrl.localeCompare(b.pageUrl));
  const mergedApi = [...apiByKey.values()].sort((a, b) => b.lastSeen - a.lastSeen);
  const mergedDom = [...domByKey.values()].sort((a, b) => b.lastSeen - a.lastSeen);

  const staticIntel = combineSiteIntel(input.intel, mergedPages);
  const liveEndpoints = observedEventsToEndpoints(mergedApi);
  const intel =
    liveEndpoints.length > 0
      ? mergeScriptIntel([
          staticIntel,
          { endpoints: liveEndpoints, routes: [], comments: [], sinks: [], truncated: false },
        ])
      : staticIntel;

  const visitedPages = [...visitedSet].sort();
  const origins = [...originSet].sort();

  return {
    domain: input.domain,
    origins,
    visitedPages,
    pageCount: Math.max(visitedPages.length, origins.length),
    jobs: [...jobsById.values()],
    scripts: [...scriptsByHash.values()],
    maps: [...mapsByKey.values()],
    findings: sortFindings([...findingsByKey.values()]),
    intel,
    pages: mergedPages,
    audits: mergedAudits,
    runtimeApi: mergedApi,
    runtimeDom: mergedDom,
  };
}

/** Build a unified OpenAPI 3.0.3 JSON document for a merged target workspace. */
export function buildWorkspaceOpenApi(
  workspace: Pick<MergedWorkspaceState, 'domain' | 'origins' | 'intel' | 'runtimeApi'>,
  version: string,
): string {
  const baseOrigin = workspace.origins[0] ?? `https://${workspace.domain}`;
  return openApiJson({
    origin: baseOrigin,
    endpoints: workspace.intel.endpoints,
    observedApi: workspace.runtimeApi,
    version,
  });
}
