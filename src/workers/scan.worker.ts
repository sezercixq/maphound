import { getDb } from '@/core/db';
import type { WorkerRequest, WorkerResponse } from './protocol';

async function sha256Hex(buffer: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', buffer);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function handle(request: WorkerRequest): Promise<WorkerResponse> {
  try {
    if (request.type === 'ping') {
      return { id: request.id, ok: true, result: { type: 'ping', echo: request.text } };
    }
    const db = await getDb();
    const record = await db.get('blobs', request.blobKey);
    if (!record) throw new Error(`blob not found: ${request.blobKey}`);
    const buffer = await record.blob.arrayBuffer();
    return {
      id: request.id,
      ok: true,
      result: { type: 'scan', bytes: buffer.byteLength, sha256: await sha256Hex(buffer) },
    };
  } catch (error) {
    return {
      id: request.id,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

self.onmessage = async (event: MessageEvent<WorkerRequest>) => {
  self.postMessage(await handle(event.data));
};
