import type {
  FileLoadTarget,
  LoadedSourceFile,
  SearchQuery,
  SearchResult,
} from '@/engine/search/source-search';
import type { SearchWorkerRequest, SearchWorkerResponse } from '@/workers/search.worker';
import SearchWorker from '@/workers/search.worker?worker';

type Pending = {
  resolve: (response: Extract<SearchWorkerResponse, { ok: true }>) => void;
  reject: (error: Error) => void;
};

const pending = new Map<number, Pending>();
let nextId = 1;
let worker: Worker | undefined;

function getWorker(): Worker {
  if (worker) return worker;
  const created = new SearchWorker();
  created.onmessage = (event: MessageEvent<SearchWorkerResponse>) => {
    const response = event.data;
    const entry = pending.get(response.id);
    if (!entry) return;
    pending.delete(response.id);
    if (response.ok) entry.resolve(response);
    else entry.reject(new Error(response.error));
  };
  created.onerror = (event) => {
    for (const entry of pending.values()) {
      entry.reject(new Error(event.message || 'search worker crashed'));
    }
    pending.clear();
    created.terminate();
    worker = undefined;
  };
  worker = created;
  return created;
}

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

function call(
  request: DistributiveOmit<SearchWorkerRequest, 'id'>,
): Promise<Extract<SearchWorkerResponse, { ok: true }>> {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    getWorker().postMessage({ ...request, id } as SearchWorkerRequest);
  });
}

export async function searchSources(origin: string, query: SearchQuery): Promise<SearchResult> {
  const response = await call({ type: 'search', origin, query });
  if (response.type !== 'search') throw new Error('unexpected search worker response');
  return response.result;
}

export async function loadSourceFileForViewer(
  origin: string,
  target: FileLoadTarget,
): Promise<LoadedSourceFile | null> {
  const response = await call({ type: 'load-file', origin, target });
  if (response.type !== 'load-file') throw new Error('unexpected search worker response');
  return response.file;
}

export function clearSearchCache(): void {
  if (!worker) return;
  void call({ type: 'clear-cache' }).catch(() => {});
}
