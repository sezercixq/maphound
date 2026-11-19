export type WorkerRequest =
  | { id: number; type: 'ping'; text: string }
  | { id: number; type: 'scan'; blobKey: string };

export type WorkerResult =
  | { type: 'ping'; echo: string }
  | { type: 'scan'; bytes: number; sha256: string };

export type WorkerResponse =
  | { id: number; ok: true; result: WorkerResult }
  | { id: number; ok: false; error: string };
