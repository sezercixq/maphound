/** Pure helpers for the collector content script, kept separate so they can be unit tested. */

export const DEBOUNCE_MS = 500;
/** Upper bound on how long a constant stream of lazy chunks can delay a report. */
export const MAX_WAIT_MS = 2_000;
export const MAX_URLS_PER_MESSAGE = 200;
/** Hard cap per page, so a hostile page cannot flood the queue. */
export const MAX_URLS_PER_PAGE = 5_000;

const JS_PATH = /\.(?:m?js|cjs)$/i;

/** Absolute http(s) URL without fragment, or null for inline, blob:, data: and other schemes. */
export function normalizeScriptUrl(raw: string | null | undefined, base: string): string | null {
  if (!raw) return null;
  let url: URL;
  try {
    url = new URL(raw, base);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  url.hash = '';
  return url.href;
}

/** Whether a resource timing entry is a script: loaded as one, or a `.js`/`.mjs` path. */
export function isScriptResource(entry: { name: string; initiatorType: string }): boolean {
  if (entry.initiatorType === 'script') return true;
  try {
    return JS_PATH.test(new URL(entry.name).pathname);
  } catch {
    return false;
  }
}

export interface UrlBatcher {
  add(urls: Iterable<string>): void;
  flush(): void;
  readonly seen: number;
  dispose(): void;
}

interface BatcherOptions {
  debounceMs?: number;
  maxWaitMs?: number;
  maxPerMessage?: number;
  maxTotal?: number;
}

/**
 * Deduplicates URLs for the lifetime of the page and reports new ones after a quiet period
 * of `debounceMs` (or at most `maxWaitMs` after the first pending URL), split into messages
 * of at most `maxPerMessage` URLs.
 */
export function createUrlBatcher(
  send: (urls: string[]) => void,
  {
    debounceMs = DEBOUNCE_MS,
    maxWaitMs = MAX_WAIT_MS,
    maxPerMessage = MAX_URLS_PER_MESSAGE,
    maxTotal = MAX_URLS_PER_PAGE,
  }: BatcherOptions = {},
): UrlBatcher {
  const seen = new Set<string>();
  let pending: string[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  let firstPendingAt = 0;

  const flush = () => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    const batch = pending;
    pending = [];
    for (let i = 0; i < batch.length; i += maxPerMessage) {
      send(batch.slice(i, i + maxPerMessage));
    }
  };

  return {
    add(urls) {
      for (const url of urls) {
        if (seen.size >= maxTotal) break;
        if (seen.has(url)) continue;
        seen.add(url);
        pending.push(url);
      }
      if (pending.length === 0) return;
      const now = Date.now();
      if (timer === undefined) firstPendingAt = now;
      else clearTimeout(timer);
      const wait = Math.max(0, Math.min(debounceMs, firstPendingAt + maxWaitMs - now));
      timer = setTimeout(flush, wait);
    },
    flush,
    get seen() {
      return seen.size;
    },
    dispose() {
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
      pending = [];
    },
  };
}
