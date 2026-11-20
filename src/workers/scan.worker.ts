import { analyzeMap } from '@/core/analyze';
import { getDb } from '@/core/db';
import { scanScript } from '@/core/scan-job';
import { Scanner } from '@/engine/scan/scanner';
import type { RuleSet } from '@/engine/scan/types';
import rules from '@/generated/rules.json';
import type { WorkerRequest, WorkerResponse } from './protocol';

async function sha256Hex(buffer: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', buffer);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

let scanner: Scanner | undefined;
/** Rules are compiled at build time; the automaton is built once per worker. */
const getScanner = () => {
  scanner ??= new Scanner(rules as RuleSet);
  return scanner;
};

async function handle(request: WorkerRequest): Promise<WorkerResponse> {
  try {
    if (request.type === 'ping') {
      return { id: request.id, ok: true, result: { type: 'ping', echo: request.text } };
    }
    const db = await getDb();
    if (request.type === 'scan-script') {
      return {
        id: request.id,
        ok: true,
        result: {
          type: 'scan-script',
          result: await scanScript(db, getScanner(), request.request),
        },
      };
    }
    if (request.type === 'analyze-map') {
      return {
        id: request.id,
        ok: true,
        result: { type: 'analyze-map', result: await analyzeMap(db, request.request) },
      };
    }
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
