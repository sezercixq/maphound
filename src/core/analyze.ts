import { parseSourceMap, rebuildSourceTree, SourceMapParseError } from '@/engine/sourcemap';
import type { JobRecord, MaphoundHandle, MapRecord } from './db';

export interface MapAnalysisRequest {
  jobId: string;
  blobKey: string;
  scriptHash: string;
  origin: string;
  url: string;
  via?: JobRecord['via'];
}

export type MapAnalysisResult =
  | {
      ok: true;
      summary: Pick<MapRecord, 'fileCount' | 'withContent' | 'missingContent' | 'partial'>;
    }
  | { ok: false; permanent: boolean; error: string };

/**
 * Parse a stored map and record its rebuilt file index. Runs in the scan worker. Contents are
 * not copied: the export rebuilds them from the same blob, deterministically.
 */
export async function analyzeMap(
  db: MaphoundHandle,
  request: MapAnalysisRequest,
  now: number = Date.now(),
): Promise<MapAnalysisResult> {
  const blob = await db.get('blobs', request.blobKey);
  if (!blob) return { ok: false, permanent: false, error: `blob not found: ${request.blobKey}` };
  let parsed: ReturnType<typeof parseSourceMap>;
  try {
    parsed = parseSourceMap(await blob.blob.text());
  } catch (error) {
    if (error instanceof SourceMapParseError)
      return { ok: false, permanent: true, error: error.message };
    throw error;
  }
  const rebuilt = rebuildSourceTree(parsed);
  const record: MapRecord = {
    id: request.jobId,
    hash: request.blobKey,
    scriptHash: request.scriptHash,
    origin: request.origin,
    url: request.url,
    via: request.via,
    indexed: parsed.indexed,
    sourceCount: rebuilt.sourceCount,
    fileCount: rebuilt.files.length,
    withContent: rebuilt.withContent,
    missingContent: rebuilt.missingContent,
    vendorCount: rebuilt.vendorCount,
    totalBytes: rebuilt.totalBytes,
    hasSourcesContent: rebuilt.withContent > 0,
    partial: rebuilt.partial,
    partialReasons: rebuilt.partialReasons,
    warnings: parsed.warnings.slice(0, 20),
    files: rebuilt.files.map((file) => ({
      path: file.path,
      size: file.size,
      vendor: file.vendor,
      ...(file.omitted ? { omitted: file.omitted } : {}),
    })),
    createdAt: now,
  };
  await db.put('maps', record);
  await db.put('blobs', { ...blob, lastAccess: now });
  return {
    ok: true,
    summary: {
      fileCount: record.fileCount,
      withContent: record.withContent,
      missingContent: record.missingContent,
      partial: record.partial,
    },
  };
}

/**
 * Delete blobs nothing refers to any more (after a purge). Blobs are content addressed and may
 * be shared between sites, so only unreferenced ones go.
 */
export async function collectGarbage(db: MaphoundHandle): Promise<number> {
  const referenced = new Set<string>();
  for (const job of await db.getAll('jobs')) if (job.hash) referenced.add(job.hash);
  for (const key of await db.getAllKeys('scripts')) referenced.add(key);
  for (const map of await db.getAll('maps')) referenced.add(map.hash);
  const tx = db.transaction('blobs', 'readwrite');
  let removed = 0;
  for (const key of await tx.store.getAllKeys()) {
    if (!referenced.has(key)) {
      await tx.store.delete(key);
      removed++;
    }
  }
  await tx.done;
  return removed;
}
