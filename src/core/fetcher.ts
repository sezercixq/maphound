import type { DbChanged } from './channel';
import type { BlobRecord, JobRecord, MaphoundHandle, ScriptRecord, SiteRecord } from './db';
import { sha256Hex } from './hash';
import { LEASE_MS, MAX_ATTEMPTS } from './jobs';
import { enqueueMapUrl, inlineMapJobId } from './queue';
import { isInScope } from './scope';
import { discoverSourceMap, looksLikeSourceMap } from './sourcemap-discovery';

export const FETCH_TIMEOUT_MS = 10_000;
export const MAX_SCRIPT_BYTES = 5 * 1024 * 1024;
/** Maps are routinely several times larger than their bundle. */
export const MAX_MAP_BYTES = 25 * 1024 * 1024;
export const PER_ORIGIN_CONCURRENCY = 4;
export const MAX_CONCURRENCY = 12;
/** Retry backoff after a network error, 5xx or 429: 2 s, then 8 s. */
export const RETRY_BASE_MS = 2_000;

export type FetchOutcome =
  | { kind: 'ok'; bytes: Uint8Array; headers: Headers; finalUrl: string }
  | { kind: 'http'; status: number }
  | { kind: 'too-large' };

/**
 * GET with a hard timeout covering the whole download and a byte cap enforced while streaming
 * (Content-Length can be missing or describe the compressed size). Network errors and timeouts
 * reject.
 */
export async function fetchLimited(
  fetchFn: typeof fetch,
  url: string,
  {
    credentials,
    timeoutMs,
    maxBytes,
  }: { credentials: RequestCredentials; timeoutMs: number; maxBytes: number },
): Promise<FetchOutcome> {
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new Error(`timeout after ${timeoutMs} ms`)),
    timeoutMs,
  );
  try {
    const response = await fetchFn(url, {
      credentials,
      signal: controller.signal,
      redirect: 'follow',
    });
    if (!response.ok) {
      discard(response.body);
      return { kind: 'http', status: response.status };
    }
    const declared = Number(response.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > maxBytes) {
      discard(response.body);
      return { kind: 'too-large' };
    }
    const chunks: Uint8Array[] = [];
    let total = 0;
    const reader = response.body?.getReader();
    if (reader) {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > maxBytes) {
          void reader.cancel().catch(() => {});
          return { kind: 'too-large' };
        }
        chunks.push(value);
      }
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return { kind: 'ok', bytes, headers: response.headers, finalUrl: response.url || url };
  } catch (error) {
    if (controller.signal.aborted) throw controller.signal.reason ?? error;
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

/** Drop an unread body without waiting: cancel() on a tee'd stream waits for the other branch. */
function discard(body: ReadableStream<Uint8Array> | null): void {
  body?.cancel().catch(() => {});
}

export interface FetcherDeps {
  db: () => Promise<MaphoundHandle>;
  fetch: typeof fetch;
  now?: () => number;
  notify?: (message: DbChanged) => void;
  /** Re-run the pump later (retry backoff). The resume alarm is the fallback if the SW dies. */
  schedule?: (callback: () => void, ms: number) => void;
  timeoutMs?: number;
  maxScriptBytes?: number;
  maxMapBytes?: number;
  perOriginConcurrency?: number;
  maxConcurrency?: number;
  /** Called after every job settles, e.g. to start analysing fetched maps. */
  onSettled?: (job: JobRecord) => void;
}

type JobPatch = Partial<Omit<JobRecord, 'id'>>;

function hostOrigin(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return url;
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Drains `queued` jobs from IndexedDB with per-origin and global concurrency limits.
 * Every job is leased first, so a service worker shutdown mid-download only delays it:
 * `resumeJobs` returns expired leases to the queue.
 */
export class Fetcher {
  private readonly active = new Map<string, number>();
  private readonly running = new Set<Promise<void>>();
  private pumping = false;
  private again = false;
  private retryAt = Number.POSITIVE_INFINITY;

  constructor(private readonly deps: FetcherDeps) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  /** Start as many queued jobs as the limits allow. Cheap to call often. */
  async pump(): Promise<void> {
    if (this.pumping) {
      this.again = true;
      return;
    }
    this.pumping = true;
    try {
      do {
        this.again = false;
        await this.claimBatch();
      } while (this.again);
    } finally {
      this.pumping = false;
    }
  }

  /** Resolves once nothing is in flight. Jobs waiting on a retry backoff do not count. */
  async idle(): Promise<void> {
    while (this.running.size > 0 || this.pumping) {
      await Promise.all([...this.running]);
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }

  get inFlight(): number {
    return this.running.size;
  }

  private async claimBatch(): Promise<void> {
    const db = await this.deps.db();
    const now = this.now();
    const perOrigin = this.deps.perOriginConcurrency ?? PER_ORIGIN_CONCURRENCY;
    const global = this.deps.maxConcurrency ?? MAX_CONCURRENCY;
    const queued = await db.getAllFromIndex('jobs', 'by-state', 'queued');
    queued.sort((a, b) => a.createdAt - b.createdAt);
    let nextRetry = Number.POSITIVE_INFINITY;

    for (const candidate of queued) {
      if (this.running.size >= global) break;
      if (candidate.leasedUntil > now) {
        nextRetry = Math.min(nextRetry, candidate.leasedUntil);
        continue;
      }
      const key = hostOrigin(candidate.url);
      if ((this.active.get(key) ?? 0) >= perOrigin) continue;
      const job = await this.claim(db, candidate.id, now);
      if (!job) continue;
      this.active.set(key, (this.active.get(key) ?? 0) + 1);
      const task: Promise<void> = this.run(job)
        .catch(() => {})
        .finally(() => {
          this.deps.onSettled?.(job);
          this.active.set(key, (this.active.get(key) ?? 1) - 1);
          this.running.delete(task);
          void this.pump();
        });
      this.running.add(task);
    }

    if (Number.isFinite(nextRetry) && nextRetry < this.retryAt && this.deps.schedule) {
      this.retryAt = nextRetry;
      this.deps.schedule(
        () => {
          this.retryAt = Number.POSITIVE_INFINITY;
          void this.pump();
        },
        Math.max(0, nextRetry - now),
      );
    }
  }

  /** Atomically move a job from `queued` to `fetching` with a lease. */
  private async claim(db: MaphoundHandle, id: string, now: number): Promise<JobRecord | null> {
    const tx = db.transaction('jobs', 'readwrite');
    const job = await tx.store.get(id);
    if (!job || job.state !== 'queued' || job.leasedUntil > now) {
      await tx.done;
      return null;
    }
    const leased: JobRecord = {
      ...job,
      state: 'fetching',
      attempts: job.attempts + 1,
      leasedUntil: now + LEASE_MS,
      updatedAt: now,
    };
    await tx.store.put(leased);
    await tx.done;
    return leased;
  }

  /** Write the job's final state, unless it was deleted meanwhile (site purged). */
  private async finish(db: MaphoundHandle, job: JobRecord, patch: JobPatch): Promise<void> {
    const tx = db.transaction('jobs', 'readwrite');
    const current = await tx.store.get(job.id);
    if (current) {
      await tx.store.put({ ...current, leasedUntil: 0, ...patch, updatedAt: this.now() });
    }
    await tx.done;
    this.deps.notify?.({ store: 'jobs', origin: job.origin });
  }

  private retryOrFail(db: MaphoundHandle, job: JobRecord, error: string): Promise<void> {
    if (job.attempts >= MAX_ATTEMPTS) return this.finish(db, job, { state: 'failed', error });
    const backoff = RETRY_BASE_MS * 4 ** (job.attempts - 1);
    return this.finish(db, job, { state: 'queued', error, leasedUntil: this.now() + backoff });
  }

  private async run(job: JobRecord): Promise<void> {
    const db = await this.deps.db();
    const site = await db.get('sites', job.origin);
    if (!site) return this.finish(db, job, { state: 'skipped', skipReason: 'site-disabled' });
    if (!isInScope(job.url, site)) {
      return this.finish(db, job, { state: 'skipped', skipReason: 'third-party' });
    }

    const credentials: RequestCredentials =
      site.settings.useCredentials && hostOrigin(job.url) === site.origin ? 'include' : 'omit';
    const maxBytes =
      job.kind === 'map'
        ? (this.deps.maxMapBytes ?? MAX_MAP_BYTES)
        : (this.deps.maxScriptBytes ?? MAX_SCRIPT_BYTES);

    let outcome: FetchOutcome;
    try {
      outcome = await fetchLimited(this.deps.fetch, job.url, {
        credentials,
        timeoutMs: this.deps.timeoutMs ?? FETCH_TIMEOUT_MS,
        maxBytes,
      });
    } catch (error) {
      return this.retryOrFail(db, job, describe(error));
    }

    if (outcome.kind === 'too-large') {
      return this.finish(db, job, { state: 'skipped', skipReason: 'too-large' });
    }
    if (outcome.kind === 'http') {
      const { status } = outcome;
      if (job.via === 'probe' && (status === 404 || status === 410)) {
        return this.finish(db, job, { state: 'skipped', skipReason: 'not-found' });
      }
      if (status >= 500 || status === 429) return this.retryOrFail(db, job, `HTTP ${status}`);
      return this.finish(db, job, { state: 'failed', error: `HTTP ${status}` });
    }
    if (!isInScope(outcome.finalUrl, site)) {
      // Redirected off-site: discard the body.
      return this.finish(db, job, { state: 'skipped', skipReason: 'third-party' });
    }
    return job.kind === 'script'
      ? this.handleScript(db, job, site, outcome)
      : this.handleMap(db, job, outcome);
  }

  private async storeBlob(
    db: MaphoundHandle,
    hash: string,
    kind: BlobRecord['kind'],
    bytes: Uint8Array,
  ): Promise<void> {
    const now = this.now();
    const tx = db.transaction('blobs', 'readwrite');
    const existing = await tx.store.get(hash);
    if (existing) {
      // Content-addressed: identical bytes are stored once.
      await tx.store.put({ ...existing, lastAccess: now });
    } else {
      const blob = new Blob([bytes as Uint8Array<ArrayBuffer>], {
        type: kind === 'map' ? 'application/json' : 'text/javascript',
      });
      await tx.store.put({ hash, kind, blob, size: bytes.byteLength, lastAccess: now });
    }
    await tx.done;
  }

  private async handleScript(
    db: MaphoundHandle,
    job: JobRecord,
    site: SiteRecord,
    outcome: Extract<FetchOutcome, { kind: 'ok' }>,
  ): Promise<void> {
    const now = this.now();
    const hash = await sha256Hex(outcome.bytes);
    await this.storeBlob(db, hash, 'script', outcome.bytes);

    const text = new TextDecoder().decode(outcome.bytes);
    const ref = discoverSourceMap(outcome.finalUrl, outcome.headers, text, {
      probe: site.settings.aggressiveMapProbing,
      maxBytes: this.deps.maxMapBytes ?? MAX_MAP_BYTES,
    });

    let sourceMapRef: string | null = null;
    if (ref?.type === 'url') {
      sourceMapRef = ref.url;
      await enqueueMapUrl(db, site, ref.url, hash, ref.via, now);
    } else if (ref?.type === 'inline') {
      sourceMapRef = 'data:';
      await this.storeInlineMap(db, job, hash, ref.bytes);
    }

    const tx = db.transaction('scripts', 'readwrite');
    const existing: ScriptRecord | undefined = await tx.store.get(hash);
    const urls = new Set(existing?.urls ?? []);
    urls.add(job.url);
    if (outcome.finalUrl !== job.url) urls.add(outcome.finalUrl);
    await tx.store.put({
      hash,
      urls: [...urls],
      origin: job.origin,
      size: outcome.bytes.byteLength,
      sourceMapRef: sourceMapRef ?? existing?.sourceMapRef ?? null,
      status: existing?.status === 'scanned' ? 'scanned' : 'fetched',
      lastAccess: now,
    });
    await tx.done;
    this.deps.notify?.({ store: 'scripts', origin: job.origin });

    await this.finish(db, job, { state: 'fetched', hash, attempts: 0, error: undefined });
  }

  private async storeInlineMap(
    db: MaphoundHandle,
    scriptJob: JobRecord,
    scriptHash: string,
    bytes: Uint8Array,
  ): Promise<void> {
    const now = this.now();
    const id = inlineMapJobId(scriptHash);
    if (await db.get('jobs', id)) return;
    const base = {
      id,
      kind: 'map' as const,
      url: `${scriptJob.url}#inline-map`,
      origin: scriptJob.origin,
      parentHash: scriptHash,
      via: 'data-uri' as const,
      attempts: 0,
      leasedUntil: 0,
      createdAt: now,
      updatedAt: now,
    };
    if (!looksLikeSourceMap(new TextDecoder().decode(bytes))) {
      await db.put('jobs', { ...base, state: 'skipped', skipReason: 'not-a-map' });
      return;
    }
    const hash = await sha256Hex(bytes);
    await this.storeBlob(db, hash, 'map', bytes);
    await db.put('jobs', { ...base, state: 'fetched', hash });
  }

  private async handleMap(
    db: MaphoundHandle,
    job: JobRecord,
    outcome: Extract<FetchOutcome, { kind: 'ok' }>,
  ): Promise<void> {
    if (!looksLikeSourceMap(new TextDecoder().decode(outcome.bytes))) {
      return this.finish(db, job, { state: 'skipped', skipReason: 'not-a-map' });
    }
    const hash = await sha256Hex(outcome.bytes);
    await this.storeBlob(db, hash, 'map', outcome.bytes);
    return this.finish(db, job, { state: 'fetched', hash, attempts: 0, error: undefined });
  }
}
