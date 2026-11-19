import { Zip, ZipDeflate } from 'fflate';
import type { JobRecord, MapRecord, ScriptRecord, SiteRecord } from '@/core/db';
import { parseSourceMap, rebuildSourceTree } from '@/engine/sourcemap';
import { PathAllocator, sanitizeSegment } from '@/engine/sourcemap/sanitize-path';

export interface ExportSource {
  site: Pick<SiteRecord, 'origin' | 'scope'>;
  maps: readonly MapRecord[];
  scripts: readonly ScriptRecord[];
  jobs: readonly JobRecord[];
  readBlob(hash: string): Promise<Blob | undefined>;
}

export interface ExportProgress {
  done: number;
  total: number;
  /** Map currently being packed. */
  url?: string;
}

export interface ExportOptions {
  /** e.g. `MapHound 0.1.0`, recorded in manifest.json. */
  generator: string;
  now?: Date;
  /** Receives the ZIP as it is produced; `final` marks the last chunk. */
  onData(chunk: Uint8Array, final: boolean): void;
  onProgress?(progress: ExportProgress): void;
  signal?: AbortSignal;
  level?: 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9;
}

export interface ExportStats {
  maps: number;
  files: number;
  bytes: number;
  skippedMaps: number;
}

interface ManifestMap {
  url: string;
  sha256: string;
  via?: string;
  folder: string | null;
  files: number;
  filesWithContent: number;
  vendorFiles: number;
  missingContent: string[];
  partial: boolean;
  partialReasons: string[];
  error?: string;
}

/** `maphound-example.com-2026-11-20.zip` */
export function exportFileName(origin: string, now: Date = new Date()): string {
  const host = sanitizeSegment(new URL(origin).host) || 'site';
  return `maphound-${host}-${now.toISOString().slice(0, 10)}.zip`;
}

function scriptUrlFor(map: MapRecord, scripts: Map<string, ScriptRecord>): string {
  const url = scripts.get(map.scriptHash)?.urls[0];
  return url ?? map.url.replace(/#inline-map$/, '');
}

/** `source/<host>/<script>` folder for a map, unique within the archive. */
function folderFor(scriptUrl: string, folders: PathAllocator): string {
  let host = 'unknown-host';
  let name = 'script';
  try {
    const url = new URL(scriptUrl);
    host = sanitizeSegment(url.host) || host;
    name = sanitizeSegment(url.pathname.split('/').filter(Boolean).pop() ?? '') || 'index';
  } catch {
    // keep defaults
  }
  return folders.allocate(`${host}/${name}`);
}

/**
 * Stream a ZIP of every rebuilt source tree of a site:
 *
 *     manifest.json
 *     source/<host>/<script>/src/...      first-party files
 *     source/<host>/<script>/_vendor/...  node_modules and ignoreList files
 *
 * Contents come from the map blobs in IndexedDB and are rebuilt with the same deterministic
 * code that produced the stored index. Every entry name is built from sanitized segments.
 * No secrets or findings are included.
 */
export async function exportSourceZip(
  source: ExportSource,
  options: ExportOptions,
): Promise<ExportStats> {
  const now = options.now ?? new Date();
  const level = options.level ?? 6;
  const scripts = new Map(source.scripts.map((script) => [script.hash, script]));
  const maps = [...source.maps].sort((a, b) => a.url.localeCompare(b.url));
  const folders = new PathAllocator();
  const stats: ExportStats = { maps: 0, files: 0, bytes: 0, skippedMaps: 0 };
  const encoder = new TextEncoder();

  let failure: Error | null = null;
  let finished!: () => void;
  const done = new Promise<void>((resolve) => {
    finished = resolve;
  });
  const zip = new Zip((error, chunk, final) => {
    if (error) {
      failure = error;
      finished();
      return;
    }
    options.onData(chunk, final);
    if (final) finished();
  });
  const add = (name: string, data: Uint8Array) => {
    const entry = new ZipDeflate(name, { level });
    entry.mtime = now;
    zip.add(entry);
    entry.push(data, true);
  };

  const manifestMaps: ManifestMap[] = [];
  const manifestScripts = new Map<
    string,
    { url: string; urls: string[]; sha256: string; size: number; maps: ManifestMap[] }
  >();

  for (const [index, map] of maps.entries()) {
    if (options.signal?.aborted) throw options.signal.reason ?? new Error('export aborted');
    options.onProgress?.({ done: index, total: maps.length, url: map.url });
    const entry: ManifestMap = {
      url: map.url,
      sha256: map.hash,
      via: map.via,
      folder: null,
      files: 0,
      filesWithContent: 0,
      vendorFiles: 0,
      missingContent: [],
      partial: map.partial,
      partialReasons: map.partialReasons,
    };
    manifestMaps.push(entry);

    const scriptUrl = scriptUrlFor(map, scripts);
    const script = scripts.get(map.scriptHash);
    const scriptEntry = manifestScripts.get(map.scriptHash) ?? {
      url: scriptUrl,
      urls: script?.urls ?? [scriptUrl],
      sha256: map.scriptHash,
      size: script?.size ?? 0,
      maps: [],
    };
    scriptEntry.maps.push(entry);
    manifestScripts.set(map.scriptHash, scriptEntry);

    const blob = await source.readBlob(map.hash);
    if (!blob) {
      entry.error = 'map blob missing';
      stats.skippedMaps++;
      continue;
    }
    let rebuilt: ReturnType<typeof rebuildSourceTree>;
    try {
      rebuilt = rebuildSourceTree(parseSourceMap(await blob.text()), { includeContent: true });
    } catch (error) {
      entry.error = error instanceof Error ? error.message : String(error);
      stats.skippedMaps++;
      continue;
    }
    if (rebuilt.withContent === 0) {
      entry.files = rebuilt.files.length;
      entry.missingContent = rebuilt.files.map((file) => file.path);
      continue;
    }

    const folder = folderFor(scriptUrl, folders);
    entry.folder = `source/${folder}`;
    entry.files = rebuilt.files.length;
    entry.vendorFiles = rebuilt.vendorCount;
    entry.partial = rebuilt.partial;
    entry.partialReasons = rebuilt.partialReasons;
    for (const file of rebuilt.files) {
      if (file.content === undefined) {
        entry.missingContent.push(file.path);
        continue;
      }
      const data = encoder.encode(file.content);
      add(`source/${folder}/${file.path}`, data);
      entry.filesWithContent++;
      stats.files++;
      stats.bytes += data.byteLength;
    }
    stats.maps++;
  }
  options.onProgress?.({ done: maps.length, total: maps.length });

  const notScanned = source.jobs
    .filter((job) => job.state === 'skipped' || job.state === 'failed')
    .map((job) => ({
      url: job.url,
      kind: job.kind,
      reason: job.state === 'failed' ? `failed: ${job.error ?? 'unknown error'}` : job.skipReason,
      ...(job.thirdParty ? { thirdParty: job.thirdParty } : {}),
    }));

  const manifest = {
    generator: options.generator,
    exportedAt: now.toISOString(),
    site: { origin: source.site.origin, scope: source.site.scope },
    summary: {
      scripts: manifestScripts.size,
      maps: maps.length,
      mapsExported: stats.maps,
      files: stats.files,
      bytes: stats.bytes,
    },
    scripts: [...manifestScripts.values()],
    notScanned,
    note: 'Rebuilt from public source maps. Contains no findings or secrets.',
  };
  add('manifest.json', encoder.encode(`${JSON.stringify(manifest, null, 2)}\n`));
  zip.end();
  await done;
  if (failure) throw failure;
  return stats;
}
