import type {
  FindingRecord,
  MaphoundHandle,
  MapRecord,
  PageIntelRecord,
  ScriptIntelRecord,
  ScriptRecord,
} from '@/core/db';
import { sha256Hex } from '@/core/hash';
import { combineSiteIntel } from '@/engine/zip/endpoints-report';
import type {
  SiteSnapshotRecord,
  SnapshotFileEntry,
  SnapshotFindingEntry,
  SnapshotSinkEntry,
} from './types';

export const MAX_SNAPSHOTS_PER_ORIGIN = 10;
export const SNAPSHOT_MERGE_WINDOW_MS = 30_000;

export interface BuildSnapshotInput {
  origin: string;
  maps: readonly MapRecord[];
  scripts: readonly ScriptRecord[];
  findings: readonly FindingRecord[];
  intel: readonly ScriptIntelRecord[];
  pages: readonly PageIntelRecord[];
  now?: number;
  frozen?: boolean;
}

export async function buildSiteSnapshot(input: BuildSnapshotInput): Promise<SiteSnapshotRecord> {
  const now = input.now ?? Date.now();
  const scriptHashes = [...new Set(input.scripts.map((s) => s.hash))].sort();

  const fileMap = new Map<string, SnapshotFileEntry>();
  const sortedMaps = [...input.maps].sort((a, b) => a.url.localeCompare(b.url));
  for (const map of sortedMaps) {
    for (const file of map.files) {
      if (file.vendor || file.omitted) continue;
      if (!fileMap.has(file.path)) {
        fileMap.set(file.path, {
          path: file.path,
          hash: `${map.hash.slice(0, 12)}:${file.size}`,
          size: file.size,
        });
      }
    }
  }
  const files = [...fileMap.values()].sort((a, b) => a.path.localeCompare(b.path));

  const mergedIntel = combineSiteIntel(input.intel, input.pages);
  const endpoints = mergedIntel.endpoints.map((ep) => ep.value).sort();
  const routes = mergedIntel.routes.map((r) => r.path).sort();

  const findings: SnapshotFindingEntry[] = input.findings
    .map((f) => ({
      key: `${f.ruleId}|${f.secretHash}`,
      ruleId: f.ruleId,
      ruleName: f.ruleName,
      severity: f.severity,
      file: f.file,
      line: f.line,
    }))
    .sort((a, b) => a.key.localeCompare(b.key));

  const sinks: SnapshotSinkEntry[] = mergedIntel.sinks
    .map((s) => ({
      key: `${s.ruleId}|${s.location.file}:${s.location.line}`,
      ruleId: s.ruleId,
      title: s.title,
      category: s.category,
      level: s.level,
      file: s.location.file,
      line: s.location.line,
    }))
    .sort((a, b) => a.key.localeCompare(b.key));

  const canonical = JSON.stringify({
    scriptHashes,
    files,
    endpoints,
    routes,
    findings,
    sinks,
  });
  const signature = await sha256Hex(new TextEncoder().encode(canonical));

  return {
    id: `${input.origin}|${now}`,
    origin: input.origin,
    createdAt: now,
    signature,
    ...(input.frozen ? { frozen: true } : {}),
    scriptHashes,
    files,
    endpoints,
    routes,
    findings,
    sinks,
  };
}

export async function recordSiteSnapshot(
  db: MaphoundHandle,
  origin: string,
  options: { now?: number; forceNew?: boolean; freezeLatest?: boolean } = {},
): Promise<SiteSnapshotRecord | null> {
  const now = options.now ?? Date.now();
  const existing = (await db.getAllFromIndex('snapshots', 'by-origin', origin)).sort(
    (a, b) => a.createdAt - b.createdAt,
  );
  const latest = existing[existing.length - 1];

  if (options.freezeLatest) {
    if (!latest) return null;
    if (!latest.frozen) {
      const updated = { ...latest, frozen: true };
      await db.put('snapshots', updated);
      return updated;
    }
    return latest;
  }

  const [maps, scripts, findings, intel, pages] = await Promise.all([
    db.getAllFromIndex('maps', 'by-origin', origin),
    db.getAllFromIndex('scripts', 'by-origin', origin),
    db.getAllFromIndex('findings', 'by-origin', origin),
    db.getAllFromIndex('intel', 'by-origin', origin),
    db.getAllFromIndex('pages', 'by-origin', origin),
  ]);

  if (scripts.length === 0 && maps.length === 0 && findings.length === 0 && intel.length === 0) {
    return null;
  }

  const next = await buildSiteSnapshot({
    origin,
    maps,
    scripts,
    findings,
    intel,
    pages,
    now,
    frozen: options.forceNew,
  });

  if (latest && latest.signature === next.signature) {
    if (options.forceNew && !latest.frozen) {
      const frozenLatest = { ...latest, frozen: true };
      await db.put('snapshots', frozenLatest);
      return frozenLatest;
    }
    return latest;
  }

  if (
    !options.forceNew &&
    latest &&
    !latest.frozen &&
    now - latest.createdAt < SNAPSHOT_MERGE_WINDOW_MS
  ) {
    const updated: SiteSnapshotRecord = { ...next, id: latest.id };
    await db.put('snapshots', updated);
    return updated;
  }

  // Ensure unique primary key if two forced snapshots happen in the same ms.
  let id = next.id;
  if (existing.some((snap) => snap.id === id)) {
    id = `${origin}|${now}|${existing.length}`;
  }
  const stored: SiteSnapshotRecord = { ...next, id };
  await db.put('snapshots', stored);

  if (existing.length + 1 > MAX_SNAPSHOTS_PER_ORIGIN) {
    const excess = existing.slice(0, existing.length + 1 - MAX_SNAPSHOTS_PER_ORIGIN);
    for (const old of excess) {
      await db.delete('snapshots', old.id);
    }
  }

  return stored;
}
