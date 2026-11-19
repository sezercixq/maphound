import { browser } from 'wxt/browser';
import { exportFileName } from '@/engine/zip/export';
import type { ExportMessage, ExportRequest } from '@/workers/export.worker';
import ExportWorker from '@/workers/export.worker?worker';

export interface ExportOutcome {
  files: number;
  maps: number;
  bytes: number;
}

/** Save a Blob with `<a download>`: no `downloads` permission needed. */
export function saveBlob(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.rel = 'noopener';
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

/** Build the ZIP in a worker, collect the streamed chunks and save it. */
export function downloadSourcesZip(
  origin: string,
  onProgress: (done: number, total: number) => void,
): Promise<ExportOutcome> {
  const worker = new ExportWorker();
  const parts: Uint8Array<ArrayBuffer>[] = [];
  return new Promise<ExportOutcome>((resolve, reject) => {
    const fail = (error: Error) => {
      worker.terminate();
      reject(error);
    };
    worker.onmessage = (event: MessageEvent<ExportMessage>) => {
      const message = event.data;
      switch (message.type) {
        case 'data':
          parts.push(message.chunk as Uint8Array<ArrayBuffer>);
          break;
        case 'progress':
          onProgress(message.done, message.total);
          break;
        case 'done':
          worker.terminate();
          saveBlob(new Blob(parts, { type: 'application/zip' }), exportFileName(origin));
          resolve({ files: message.files, maps: message.maps, bytes: message.bytes });
          break;
        case 'error':
          fail(new Error(message.error));
          break;
      }
    };
    worker.onerror = (event) => fail(new Error(event.message || 'export worker crashed'));
    const request: ExportRequest = {
      type: 'export',
      origin,
      generator: `MapHound ${browser.runtime.getManifest().version}`,
    };
    worker.postMessage(request);
  });
}
