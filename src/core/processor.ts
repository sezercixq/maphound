import type { MapAnalysisRequest, MapAnalysisResult } from './analyze';
import type { DbChanged } from './channel';
import type { JobRecord, MaphoundHandle } from './db';
import { LEASE_MS, MAX_ATTEMPTS } from './jobs';

export const RETRY_BASE_MS = 2_000;

export interface ProcessorDeps {
  db: () => Promise<MaphoundHandle>;
  /** Runs the analysis in the offscreen scan worker. */
  analyze: (request: MapAnalysisRequest) => Promise<MapAnalysisResult>;
  now?: () => number;
  notify?: (message: DbChanged) => void;
  schedule?: (callback: () => void, ms: number) => void;
}

/**
 * Moves fetched map jobs through `scanning` to `done`, one at a time: a map can be tens of MB
 * of JSON, and the worker is single threaded anyway. Same lease rules as the fetcher.
 */
export class Processor {
  private running: Promise<void> | null = null;
  private again = false;

  constructor(private readonly deps: ProcessorDeps) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  pump(): Promise<void> {
    if (this.running) {
      this.again = true;
      return this.running;
    }
    this.running = (async () => {
      try {
        do {
          this.again = false;
          while (await this.step()) {
            // keep draining
          }
        } while (this.again);
      } finally {
        this.running = null;
      }
    })();
    return this.running;
  }

  async idle(): Promise<void> {
    while (this.running) await this.running;
  }

  /** Process one job. Returns false when nothing is ready. */
  private async step(): Promise<boolean> {
    const db = await this.deps.db();
    const now = this.now();
    const ready = (await db.getAllFromIndex('jobs', 'by-state', 'fetched'))
      .filter((job) => job.kind === 'map')
      .sort((a, b) => a.createdAt - b.createdAt);
    let nextRetry = Number.POSITIVE_INFINITY;
    for (const candidate of ready) {
      if (candidate.leasedUntil > now) {
        nextRetry = Math.min(nextRetry, candidate.leasedUntil);
        continue;
      }
      const job = await this.claim(db, candidate.id, now);
      if (!job) continue;
      await this.run(db, job);
      return true;
    }
    if (Number.isFinite(nextRetry)) this.deps.schedule?.(() => void this.pump(), nextRetry - now);
    return false;
  }

  private async claim(db: MaphoundHandle, id: string, now: number): Promise<JobRecord | null> {
    const tx = db.transaction('jobs', 'readwrite');
    const job = await tx.store.get(id);
    if (!job || job.state !== 'fetched' || job.leasedUntil > now || !job.hash) {
      await tx.done;
      return null;
    }
    const leased: JobRecord = {
      ...job,
      state: 'scanning',
      attempts: job.attempts + 1,
      leasedUntil: now + LEASE_MS,
      updatedAt: now,
    };
    await tx.store.put(leased);
    await tx.done;
    return leased;
  }

  private async finish(
    db: MaphoundHandle,
    job: JobRecord,
    patch: Partial<JobRecord>,
  ): Promise<void> {
    const tx = db.transaction('jobs', 'readwrite');
    const current = await tx.store.get(job.id);
    if (current)
      await tx.store.put({ ...current, leasedUntil: 0, ...patch, updatedAt: this.now() });
    await tx.done;
    this.deps.notify?.({ store: 'jobs', origin: job.origin });
  }

  private async run(db: MaphoundHandle, job: JobRecord): Promise<void> {
    let result: MapAnalysisResult;
    try {
      result = await this.deps.analyze({
        jobId: job.id,
        blobKey: job.hash as string,
        scriptHash: job.parentHash ?? '',
        origin: job.origin,
        url: job.url,
        via: job.via,
      });
    } catch (error) {
      result = {
        ok: false,
        permanent: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
    if (result.ok) {
      this.deps.notify?.({ store: 'maps', origin: job.origin });
      return this.finish(db, job, { state: 'done', error: undefined });
    }
    if (result.permanent || job.attempts >= MAX_ATTEMPTS) {
      return this.finish(db, job, { state: 'failed', error: result.error });
    }
    const backoff = RETRY_BASE_MS * 4 ** (job.attempts - 1);
    return this.finish(db, job, {
      state: 'fetched',
      error: result.error,
      leasedUntil: this.now() + backoff,
    });
  }
}
