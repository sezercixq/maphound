import { getDb } from '@/core/db';
import { exportSourceZip } from '@/engine/zip/export';

export type ExportRequest = {
  type: 'export';
  origin: string;
  generator: string;
  includeSecrets: boolean;
};
export type ExportMessage =
  | { type: 'data'; chunk: Uint8Array; final: boolean }
  | { type: 'progress'; done: number; total: number; url?: string }
  | {
      type: 'done';
      maps: number;
      files: number;
      bytes: number;
      skippedMaps: number;
      findings: number;
    }
  | { type: 'error'; error: string };

const post = (message: ExportMessage, transfer: Transferable[] = []) =>
  self.postMessage(message, { transfer });

/** Builds the ZIP off the side panel's main thread and streams it back in chunks. */
self.onmessage = async (event: MessageEvent<ExportRequest>) => {
  const { origin, generator, includeSecrets } = event.data;
  try {
    const db = await getDb();
    const site = await db.get('sites', origin);
    if (!site) throw new Error(`site not enabled: ${origin}`);
    const [maps, scripts, jobs, findings] = await Promise.all([
      db.getAllFromIndex('maps', 'by-origin', origin),
      db.getAllFromIndex('scripts', 'by-origin', origin),
      db.getAllFromIndex('jobs', 'by-origin', origin),
      db.getAllFromIndex('findings', 'by-origin', origin),
    ]);
    const stats = await exportSourceZip(
      {
        site,
        maps,
        scripts,
        jobs,
        findings,
        readBlob: async (hash) => (await db.get('blobs', hash))?.blob,
      },
      {
        generator,
        includeSecrets,
        onData: (chunk, final) => {
          // fflate may reuse buffers: copy before transferring ownership.
          const copy = chunk.slice();
          post({ type: 'data', chunk: copy, final }, [copy.buffer]);
        },
        onProgress: (progress) => post({ type: 'progress', ...progress }),
      },
    );
    post({ type: 'done', ...stats });
  } catch (error) {
    post({ type: 'error', error: error instanceof Error ? error.message : String(error) });
  }
};
