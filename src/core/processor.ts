import type { MapAnalysisRequest, MapAnalysisResult } from './analyze';
import type { DbChanged } from './channel';
import type { JobRecord, MaphoundHandle } from './db';
import { LEASE_MS, MAX_ATTEMPTS } from './jobs';
import type { ScriptScanRequest, ScriptScanResult } from './scan-job';

export const RETRY_BASE_MS = 2_000;

export interface ProcessorDeps {
  db: () => Promise<MaphoundHandle>;
  /** Parses a fetched map in the offscreen scan worker. */
  analyze: (request: MapAnalysisRequest) => Promise<MapAnalysisResult>;
  /** Runs the secret scan for a fetched script in the offscreen scan worker. */
  scan: (request: ScriptScanRequest) => Promise<ScriptScanResult>;
  now?: () => number;
  notify?: (message: DbChanged) => void;
  schedule?: (callback: () => void, ms: number) => void;
  /** Called once a site's queued/fetching/fetched/scanning jobs have all settled. */
  onOriginSettled?: (origin: string) => void | Promise<void>;
}

/**
 * Moves fetched jobs through `scanning` to `done`, one at a time (a map can be tens of MB of
 * JSON, and the worker is single threaded anyway). Maps go first; a script is scanned only
 * once all of its maps are settled, so its findings can point at original files and lines.
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
    const ready = (await db.getAllFromIndex('jobs', 'by-state', 'fetched')).sort(
      (a, b) =>
        Number(a.kind === 'script') - Number(b.kind === 'script') || a.createdAt - b.createdAt,
    );
    let nextRetry = Number.POSITIVE_INFINITY;
    const siteJobs = new Map<string, JobRecord[]>();
    for (const candidate of ready) {
      if (candidate.leasedUntil > now) {
        nextRetry = Math.min(nextRetry, candidate.leasedUntil);
        continue;
      }
      if (candidate.kind === 'script' && (await this.hasPendingMaps(db, candidate, siteJobs)))
        continue;
      const job = await this.claim(db, candidate.id, now);
      if (!job) continue;
      await this.run(db, job);
      return true;
    }
    if (Number.isFinite(nextRetry)) this.deps.schedule?.(() => void this.pump(), nextRetry - now);
    return false;
  }

  private async hasPendingMaps(
    db: MaphoundHandle,
    script: JobRecord,
    cache: Map<string, JobRecord[]>,
  ): Promise<boolean> {
    let jobs = cache.get(script.origin);
    if (!jobs) {
      jobs = await db.getAllFromIndex('jobs', 'by-origin', script.origin);
      cache.set(script.origin, jobs);
    }
    return jobs.some(
      (job) =>
        job.kind === 'map' &&
        job.parentHash === script.hash &&
        (job.state === 'queued' ||
          job.state === 'fetching' ||
          job.state === 'fetched' ||
          job.state === 'scanning'),
    );
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
    if ((patch.state === 'done' || patch.state === 'failed') && this.deps.onOriginSettled) {
      const siteJobs = await db.getAllFromIndex('jobs', 'by-origin', job.origin);
      const pending = siteJobs.some(
        (j) =>
          j.state === 'queued' ||
          j.state === 'fetching' ||
          j.state === 'fetched' ||
          j.state === 'scanning',
      );
      if (!pending) await this.deps.onOriginSettled(job.origin);
    }
  }

  private async run(db: MaphoundHandle, job: JobRecord): Promise<void> {
    let result: MapAnalysisResult | ScriptScanResult;
    try {
      result =
        job.kind === 'map'
          ? await this.deps.analyze({
              jobId: job.id,
              blobKey: job.hash as string,
              scriptHash: job.parentHash ?? '',
              origin: job.origin,
              url: job.url,
              via: job.via,
            })
          : await this.deps.scan({
              jobId: job.id,
              scriptHash: job.hash as string,
              origin: job.origin,
              url: job.url,
            });
    } catch (error) {
      result = {
        ok: false,
        permanent: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
    // No handler answered (offscreen document gone or not ready): retry like a crash.
    result ??= { ok: false, permanent: false, error: 'no response from the scan worker' };
    if (result.ok) {
      this.deps.notify?.({ store: job.kind === 'map' ? 'maps' : 'findings', origin: job.origin });
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
