import { onMessage } from '@/core/messaging';
import type { WorkerRequest, WorkerResponse, WorkerResult } from '@/workers/protocol';
import ScanWorker from '@/workers/scan.worker?worker';

type Pending = { resolve: (r: WorkerResult) => void; reject: (e: Error) => void };

const pending = new Map<number, Pending>();
let nextId = 1;
let worker: Worker | undefined;

function getWorker(): Worker {
  if (worker) return worker;
  const created = new ScanWorker();
  created.onmessage = (event: MessageEvent<WorkerResponse>) => {
    const response = event.data;
    const entry = pending.get(response.id);
    if (!entry) return;
    pending.delete(response.id);
    if (response.ok) entry.resolve(response.result);
    else entry.reject(new Error(response.error));
  };
  created.onerror = (event) => {
    for (const entry of pending.values()) entry.reject(new Error(event.message));
    pending.clear();
    created.terminate();
    worker = undefined;
  };
  worker = created;
  return created;
}

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

function call(request: DistributiveOmit<WorkerRequest, 'id'>): Promise<WorkerResult> {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    getWorker().postMessage({ ...request, id } as WorkerRequest);
  });
}

onMessage('spike:ping', async ({ data }) => {
  const result = await call({ type: 'ping', text: data.text });
  if (result.type !== 'ping') throw new Error('unexpected worker result');
  return { echo: result.echo, via: ['offscreen', 'worker'] };
});

onMessage('scan:request', async ({ data }) => {
  const result = await call({ type: 'scan', blobKey: data.blobKey });
  if (result.type !== 'scan') throw new Error('unexpected worker result');
  return { jobId: data.jobId, bytes: result.bytes, sha256: result.sha256 };
});

onMessage('map:analyze', async ({ data }) => {
  const result = await call({ type: 'analyze-map', request: data });
  if (result.type !== 'analyze-map') throw new Error('unexpected worker result');
  return result.result;
});
