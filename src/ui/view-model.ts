import type { JobRecord, MapRecord, ScriptRecord } from '@/core/db';
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
  stats: Stats;
}

/** Turn raw IndexedDB records of one site into rows for the side panel. Pure. */
export function buildViewModel(
  jobs: readonly JobRecord[],
  scripts: readonly ScriptRecord[],
  maps: readonly MapRecord[],
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

  const files = maps.reduce((sum, map) => sum + map.withContent, 0);
  return {
    scripts: scriptRows,
    maps: mapRows,
    stats: {
      scripts: scriptRows.filter((row) => !row.thirdParty).length,
      thirdParty: scriptRows.filter((row) => row.thirdParty).length,
      maps: maps.length,
      files,
      exportable: files > 0,
    },
  };
}
