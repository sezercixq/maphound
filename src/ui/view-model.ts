import type {
  AuditRecord,
  FindingRecord,
  JobRecord,
  MapRecord,
  PageIntelRecord,
  ScriptIntelRecord,
  ScriptRecord,
  Severity,
  SiteRecord,
  ThirdPartyKind,
} from '@/core/db';
import { isRelatedDomain } from '@/core/scope';
import {
  AUDIT_SEVERITY_ORDER,
  type AuditFinding,
  extractStackHints,
  type StackHint,
} from '@/engine/audit';
import { diffSnapshots, type SiteSnapshotRecord, type SnapshotDiff } from '@/engine/diff';
import { type ArchitectureGraph, buildArchitectureGraph, type ScriptIntel } from '@/engine/intel';
import { combineSiteIntel } from '@/engine/zip/endpoints-report';
import { countBySeverity, sortFindings } from '@/engine/zip/findings-report';
import { fileName, hostOf } from './format';

export interface ScriptRow {
  job: JobRecord;
  name: string;
  host: string;
  size: number | null;
  thirdParty: boolean;
  /** Map jobs this script referenced. */
  maps: JobRecord[];
}

export interface MapRow {
  job: JobRecord;
  name: string;
  host: string;
  record: MapRecord | null;
}

/** Not-scanned scripts and maps of one third-party origin. */
export interface ThirdPartyGroup {
  origin: string;
  host: string;
  scripts: number;
  maps: number;
  kind: ThirdPartyKind;
  /** Same brand under another registrable domain (`airbnb.com` for `airbnb.com.tr`). */
  related: boolean;
}

/** An extra origin the user allowed for the site, with how many scripts came from it. */
export interface AllowedOrigin {
  origin: string;
  host: string;
  scripts: number;
}

export interface Stats {
  scripts: number;
  thirdParty: number;
  maps: number;
  files: number;
  /** Whether there is anything with content to put in a ZIP. */
  exportable: boolean;
}

export interface ViewModel {
  scripts: ScriptRow[];
  maps: MapRow[];
  /** Most severe first. */
  findings: FindingRecord[];
  findingCounts: Record<Severity, number>;
  /** Extracted endpoints, routes, developer notes and static code sinks. */
  intel: ScriptIntel;
  /** Module dependency graph, SDKs and API data flows. */
  architecture: ArchitectureGraph;
  /** Parsed Next.js `__NEXT_DATA__` summaries per visited page. */
  pages: PageIntelRecord[];
  /** HTTP header, cookie and Web Storage audits per visited page. */
  audits: AuditRecord[];
  auditFindings: AuditFinding[];
  auditCounts: Record<Severity, number>;
  /** Passive server, runtime, cloud, database & build-OS hints. */
  stackHints: StackHint[];
  /** Version snapshots and latest diff. */
  snapshots: SiteSnapshotRecord[];
  diff: SnapshotDiff | null;
  endpointCount: number;
  hintCount: number;
  osintCount: number;
  auditCount: number;
  /** Scripts still waiting to be downloaded or scanned. */
  scanning: boolean;
  /** Related domains first, then by script count. */
  thirdParty: ThirdPartyGroup[];
  allowedOrigins: AllowedOrigin[];
  stats: Stats;
}

/** Turn raw IndexedDB records of one site into rows for the side panel. Pure. */
export function buildViewModel(
  jobs: readonly JobRecord[],
  scripts: readonly ScriptRecord[],
  maps: readonly MapRecord[],
  findings: readonly FindingRecord[] = [],
  site: Pick<SiteRecord, 'origin' | 'extraOrigins'> | null = null,
  intelRecords: readonly ScriptIntelRecord[] = [],
  pages: readonly PageIntelRecord[] = [],
  audits: readonly AuditRecord[] = [],
  snapshots: readonly SiteSnapshotRecord[] = [],
): ViewModel {
  const scriptByHash = new Map(scripts.map((s) => [s.hash, s]));
  const mapById = new Map(maps.map((m) => [m.id, m]));
  const mapJobsByParent = new Map<string, JobRecord[]>();
  for (const job of jobs) {
    if (job.kind !== 'map' || !job.parentHash) continue;
    const list = mapJobsByParent.get(job.parentHash) ?? [];
    list.push(job);
    mapJobsByParent.set(job.parentHash, list);
  }

  const byCreation = (a: JobRecord, b: JobRecord) =>
    a.createdAt - b.createdAt || a.url.localeCompare(b.url);
  const scriptRows: ScriptRow[] = jobs
    .filter((job) => job.kind === 'script')
    .map((job) => ({
      job,
      name: fileName(job.url),
      host: hostOf(job.url),
      size: job.hash ? (scriptByHash.get(job.hash)?.size ?? null) : null,
      thirdParty: job.skipReason === 'third-party',
      maps: job.hash ? (mapJobsByParent.get(job.hash) ?? []) : [],
    }))
    .sort((a, b) => Number(a.thirdParty) - Number(b.thirdParty) || byCreation(a.job, b.job));

  const mapRows: MapRow[] = jobs
    .filter((job) => job.kind === 'map')
    .sort(byCreation)
    .map((job) => ({
      job,
      name: fileName(job.url),
      host: hostOf(job.url),
      record: mapById.get(job.id) ?? null,
    }));

  const siteHost = site ? hostOf(site.origin) : '';
  const groups = new Map<string, ThirdPartyGroup>();
  for (const job of jobs) {
    if (job.state !== 'skipped' || job.skipReason !== 'third-party') continue;
    let origin: string;
    try {
      origin = new URL(job.url).origin;
    } catch {
      continue;
    }
    const host = hostOf(job.url);
    const group = groups.get(origin) ?? {
      origin,
      host,
      scripts: 0,
      maps: 0,
      kind: job.thirdParty ?? 'other',
      related:
        siteHost !== '' &&
        isRelatedDomain(new URL(site?.origin ?? origin).hostname, new URL(origin).hostname),
    };
    if (job.kind === 'script') group.scripts++;
    else group.maps++;
    groups.set(origin, group);
  }
  const thirdParty = [...groups.values()].sort(
    (a, b) =>
      Number(b.related) - Number(a.related) ||
      b.scripts - a.scripts ||
      a.host.localeCompare(b.host),
  );
  const allowedOrigins: AllowedOrigin[] = (site?.extraOrigins ?? []).map((origin) => ({
    origin,
    host: hostOf(origin),
    scripts: jobs.filter((job) => job.kind === 'script' && job.url.startsWith(`${origin}/`)).length,
  }));

  const files = maps.reduce((sum, map) => sum + map.withContent, 0);
  const intel = combineSiteIntel(intelRecords, pages);
  const architecture = buildArchitectureGraph(intel.modules ?? []);
  const sortedPages = [...pages].sort((a, b) => a.pageUrl.localeCompare(b.pageUrl));
  const sortedAudits = [...audits].sort((a, b) => a.pageUrl.localeCompare(b.pageUrl));
  const auditFindingsMap = new Map<string, AuditFinding>();
  for (const audit of sortedAudits) {
    for (const f of audit.findings) {
      if (!auditFindingsMap.has(f.id)) auditFindingsMap.set(f.id, f);
    }
  }
  const auditFindings = [...auditFindingsMap.values()].sort(
    (a, b) =>
      AUDIT_SEVERITY_ORDER[b.severity] - AUDIT_SEVERITY_ORDER[a.severity] ||
      a.category.localeCompare(b.category) ||
      a.subject.localeCompare(b.subject),
  );
  const auditCounts: Record<Severity, number> = {
    critical: 0,
    high: 0,
    medium: 0,
    low: 0,
    info: 0,
  };
  for (const f of auditFindings) auditCounts[f.severity]++;

  const sortedSnapshots = [...snapshots].sort((a, b) => a.createdAt - b.createdAt);
  const diff =
    sortedSnapshots.length >= 2
      ? diffSnapshots(
          sortedSnapshots[sortedSnapshots.length - 2]!,
          sortedSnapshots[sortedSnapshots.length - 1]!,
        )
      : null;

  const endpointCount = intel.endpoints.length + intel.routes.length;
  const hintCount =
    intel.sinks.length + sortedPages.reduce((sum, p) => sum + p.nextData.sensitive.length, 0);
  const osintCount = intel.osint?.length ?? 0;
  const stackHints = extractStackHints({ audits: sortedAudits, intel, architecture });
  return {
    scripts: scriptRows,
    maps: mapRows,
    findings: sortFindings(findings),
    findingCounts: countBySeverity(findings),
    intel,
    architecture,
    pages: sortedPages,
    audits: sortedAudits,
    auditFindings,
    auditCounts,
    stackHints,
    snapshots: sortedSnapshots,
    diff,
    endpointCount,
    hintCount,
    osintCount,
    auditCount: auditFindings.length,
    thirdParty,
    allowedOrigins,
    scanning: jobs.some(
      (job) =>
        job.kind === 'script' &&
        (job.state === 'queued' ||
          job.state === 'fetching' ||
          job.state === 'fetched' ||
          job.state === 'scanning'),
    ),
    stats: {
      scripts: scriptRows.filter((row) => !row.thirdParty).length,
      thirdParty: scriptRows.filter((row) => row.thirdParty).length,
      maps: maps.length,
      files,
      exportable: files > 0,
    },
  };
}
