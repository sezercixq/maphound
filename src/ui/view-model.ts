import type {
  FindingRecord,
  JobRecord,
  MapRecord,
  ScriptRecord,
  Severity,
  SiteRecord,
  ThirdPartyKind,
} from '@/core/db';
import { isRelatedDomain } from '@/core/scope';
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
  return {
    scripts: scriptRows,
    maps: mapRows,
    findings: sortFindings(findings),
    findingCounts: countBySeverity(findings),
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
