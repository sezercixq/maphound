import { getDb } from '@/core/db';
import {
  type FileLoadTarget,
  type LoadedSourceFile,
  loadSourceFile,
  type MapCache,
  type SearchQuery,
  type SearchResult,
  searchSiteMaps,
} from '@/engine/search/source-search';
import type { RebuiltFile } from '@/engine/sourcemap';

const MAX_CACHED_MAPS = 8;

export type SearchWorkerRequest =
  | { id: number; type: 'search'; origin: string; query: SearchQuery }
  | { id: number; type: 'load-file'; origin: string; target: FileLoadTarget }
  | { id: number; type: 'clear-cache' };

export type SearchWorkerResponse =
  | { id: number; ok: true; type: 'search'; result: SearchResult }
  | { id: number; ok: true; type: 'load-file'; file: LoadedSourceFile | null }
  | { id: number; ok: true; type: 'clear-cache' }
  | { id: number; ok: false; error: string };

/** Bounded LRU cache of rebuilt map files, evicted oldest-first when exceeding MAX_CACHED_MAPS. */
const mapCache = new Map<string, RebuiltFile[]>();

function setCached(hash: string, files: RebuiltFile[]): void {
  if (mapCache.has(hash)) mapCache.delete(hash);
  mapCache.set(hash, files);
  while (mapCache.size > MAX_CACHED_MAPS) {
    const oldest = mapCache.keys().next().value;
    if (oldest !== undefined) mapCache.delete(oldest);
    else break;
  }
}

const lruCache: MapCache = {
  get: (key) => {
    const hit = mapCache.get(key);
    if (hit) {
      mapCache.delete(key);
      mapCache.set(key, hit);
    }
    return hit;
  },
  set: (key, value) => {
    setCached(key, value);
  },
};

async function handle(request: SearchWorkerRequest): Promise<SearchWorkerResponse> {
  try {
    if (request.type === 'clear-cache') {
      mapCache.clear();
      return { id: request.id, ok: true, type: 'clear-cache' };
    }
    const db = await getDb();
    const [maps, scripts] = await Promise.all([
      db.getAllFromIndex('maps', 'by-origin', request.origin),
      db.getAllFromIndex('scripts', 'by-origin', request.origin),
    ]);
    const readBlob = async (hash: string) => (await db.get('blobs', hash))?.blob;

    if (request.type === 'search') {
      const result = await searchSiteMaps(maps, scripts, readBlob, request.query, lruCache);
      return { id: request.id, ok: true, type: 'search', result };
    }

    const file = await loadSourceFile(maps, scripts, readBlob, request.target, lruCache);
    return { id: request.id, ok: true, type: 'load-file', file };
  } catch (error) {
    return {
      id: request.id,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

self.onmessage = async (event: MessageEvent<SearchWorkerRequest>) => {
  self.postMessage(await handle(event.data));
};
