import type { DbChanged } from './channel';
import { MAX_URLS_PER_MESSAGE, normalizeScriptUrl } from './collect';
import type { JobKind, JobRecord, MaphoundHandle, SiteRecord } from './db';
import { classifyThirdParty, isInScope, siteForUrl } from './scope';

/** Deterministic id, so the same URL is never queued (or downloaded) twice. */
export function jobId(kind: JobKind, url: string): string {
  return `${kind}:${url}`;
}

export function inlineMapJobId(scriptHash: string): string {
  return `map:inline:${scriptHash}`;
}

function newJob(
  fields: Pick<JobRecord, 'id' | 'kind' | 'url' | 'origin'> & Partial<JobRecord>,
  now: number,
): JobRecord {
  return {
    state: 'queued',
    attempts: 0,
    leasedUntil: 0,
    createdAt: now,
    updatedAt: now,
    ...fields,
  };
}

export interface EnqueueResult {
  /** Site the page belongs to, or null if the page is not on an enabled site. */
  origin: string | null;
  queued: number;
  thirdParty: number;
  duplicate: number;
  invalid: number;
}

/**
 * Turn collector reports into jobs. In-scope scripts are queued; out-of-scope ones are recorded
 * as `skipped: third-party` so the UI can list them as "third party (not scanned)".
 * `pageUrl` must come from the message sender (Chrome), not from the page.
 */
export async function enqueueDiscovered(
  db: MaphoundHandle,
  pageUrl: string,
  urls: readonly string[],
  now: number = Date.now(),
  notify?: (message: DbChanged) => void,
): Promise<EnqueueResult> {
  const result: EnqueueResult = {
    origin: null,
    queued: 0,
    thirdParty: 0,
    duplicate: 0,
    invalid: 0,
  };
  const sites: SiteRecord[] = await db.getAll('sites');
  const site = siteForUrl(sites, pageUrl);
  if (!site) return result;
  result.origin = site.origin;

  const tx = db.transaction('jobs', 'readwrite');
  for (const raw of urls.slice(0, MAX_URLS_PER_MESSAGE)) {
    const url = normalizeScriptUrl(raw, pageUrl);
    if (!url) {
      result.invalid++;
      continue;
    }
    const id = jobId('script', url);
    if (await tx.store.get(id)) {
      result.duplicate++;
      continue;
    }
    if (isInScope(url, site)) {
      await tx.store.put(newJob({ id, kind: 'script', url, origin: site.origin, pageUrl }, now));
      result.queued++;
    } else {
      await tx.store.put(
        newJob(
          {
            id,
            kind: 'script',
            url,
            origin: site.origin,
            pageUrl,
            state: 'skipped',
            skipReason: 'third-party',
            thirdParty: classifyThirdParty(url),
          },
          now,
        ),
      );
      result.thirdParty++;
    }
  }
  await tx.done;
  if (result.queued + result.thirdParty > 0) notify?.({ store: 'jobs', origin: site.origin });
  return result;
}

/** Queue a map referenced by a script. Out-of-scope maps are recorded but never fetched. */
export async function enqueueMapUrl(
  db: MaphoundHandle,
  site: Pick<SiteRecord, 'origin' | 'scope'>,
  url: string,
  parentHash: string,
  via: 'header' | 'comment' | 'probe',
  now: number,
): Promise<'queued' | 'third-party' | 'duplicate'> {
  const id = jobId('map', url);
  const tx = db.transaction('jobs', 'readwrite');
  if (await tx.store.get(id)) {
    await tx.done;
    return 'duplicate';
  }
  const inScope = isInScope(url, site);
  await tx.store.put(
    newJob(
      inScope
        ? { id, kind: 'map', url, origin: site.origin, parentHash, via }
        : {
            id,
            kind: 'map',
            url,
            origin: site.origin,
            parentHash,
            via,
            state: 'skipped',
            skipReason: 'third-party',
            thirdParty: classifyThirdParty(url),
          },
      now,
    ),
  );
  await tx.done;
  return inScope ? 'queued' : 'third-party';
}

/**
 * After the user allowed extra origins: put that site's skipped third-party scripts and maps
 * hosted there back in the queue. Returns how many jobs were requeued.
 */
export async function requeueThirdParty(
  db: MaphoundHandle,
  siteOrigin: string,
  origins: readonly string[],
  now: number = Date.now(),
): Promise<number> {
  if (origins.length === 0) return 0;
  const allowed = new Set(origins);
  const tx = db.transaction('jobs', 'readwrite');
  let requeued = 0;
  for (const job of await tx.store.index('by-origin').getAll(siteOrigin)) {
    if (job.state !== 'skipped' || job.skipReason !== 'third-party') continue;
    let origin: string;
    try {
      origin = new URL(job.url).origin;
    } catch {
      continue;
    }
    if (!allowed.has(origin)) continue;
    const { skipReason: _skip, thirdParty: _kind, error: _error, ...rest } = job;
    await tx.store.put({ ...rest, state: 'queued', attempts: 0, leasedUntil: 0, updatedAt: now });
    requeued++;
  }
  await tx.done;
  return requeued;
}
