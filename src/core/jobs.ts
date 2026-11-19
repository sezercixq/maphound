import { getDb, type JobRecord, type MaphoundHandle } from './db';

export const LEASE_MS = 60_000;
export const MAX_ATTEMPTS = 3;

/**
 * Return jobs whose lease expired (service worker died mid-flight) to `queued`,
 * or mark them failed after too many attempts. Idempotent; safe to call on every wake-up.
 */
export async function resumeJobs(
  db?: MaphoundHandle,
  now: number = Date.now(),
): Promise<{ requeued: number; failed: number }> {
  const handle = db ?? (await getDb());
  const tx = handle.transaction('jobs', 'readwrite');
  let requeued = 0;
  let failed = 0;

  for (const state of ['fetching', 'scanning'] as const) {
    const jobs: JobRecord[] = await tx.store.index('by-state').getAll(state);
    for (const job of jobs) {
      if (job.leasedUntil > now) continue;
      if (job.attempts >= MAX_ATTEMPTS) {
        await tx.store.put({
          ...job,
          state: 'failed',
          error: 'lease expired too many times',
          updatedAt: now,
        });
        failed++;
      } else {
        await tx.store.put({ ...job, state: 'queued', leasedUntil: 0, updatedAt: now });
        requeued++;
      }
    }
  }

  await tx.done;
  return { requeued, failed };
}
