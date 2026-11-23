import { createUrlBatcher, isScriptResource, normalizeScriptUrl } from '@/core/collect';
import { sendMessage } from '@/core/messaging';
import { parseNextData } from '@/engine/intel/next-data';

const INSTALLED = Symbol.for('maphound.collector');

/**
 * Passive collector. Runs headless in the ISOLATED world, is registered per enabled site at
 * runtime (never in the manifest) and only reports script URLs; it never reads page content.
 */
export default defineContentScript({
  registration: 'runtime',
  world: 'ISOLATED',
  runAt: 'document_idle',
  main(ctx) {
    // A tab can receive both the registered script and an `executeScript` injection.
    const scope = globalThis as unknown as Record<symbol, boolean>;
    if (scope[INSTALLED]) return;
    scope[INSTALLED] = true;

    const pageUrl = location.href;
    const batcher = createUrlBatcher((urls) => {
      sendMessage('scripts:discovered', { pageUrl, urls }).catch(() => {
        // Extension reloaded or service worker unavailable: nothing useful to do here.
      });
    });

    const fromScripts = () => {
      const urls: string[] = [];
      for (const script of Array.from(document.scripts)) {
        const url = normalizeScriptUrl(script.src, document.baseURI);
        if (url) urls.push(url);
      }
      for (const link of Array.from(
        document.querySelectorAll<HTMLLinkElement>(
          'link[rel="modulepreload"], link[rel="preload"][as="script"]',
        ),
      )) {
        const url = normalizeScriptUrl(link.href, document.baseURI);
        if (url) urls.push(url);
      }
      return urls;
    };

    const fromEntries = (entries: PerformanceEntryList) => {
      const urls: string[] = [];
      for (const entry of entries) {
        const resource = entry as PerformanceResourceTiming;
        if (!isScriptResource(resource)) continue;
        const url = normalizeScriptUrl(resource.name, document.baseURI);
        if (url) urls.push(url);
      }
      return urls;
    };

    batcher.add(fromScripts());
    batcher.add(fromEntries(performance.getEntriesByType('resource')));

    const nextEl = document.getElementById('__NEXT_DATA__');
    if (nextEl instanceof HTMLScriptElement && nextEl.textContent) {
      const summary = parseNextData(nextEl.textContent);
      if (summary) sendMessage('page:next-data', { pageUrl, summary }).catch(() => {});
    }

    // Lazy chunks: dynamic import(), injected <script> tags and preloads.
    const perf = new PerformanceObserver((list) => batcher.add(fromEntries(list.getEntries())));
    perf.observe({ type: 'resource', buffered: true });

    const mutations = new MutationObserver((records) => {
      const urls: string[] = [];
      for (const record of records) {
        for (const node of Array.from(record.addedNodes)) {
          if (node instanceof HTMLScriptElement) {
            const url = normalizeScriptUrl(node.src, document.baseURI);
            if (url) urls.push(url);
          } else if (node instanceof HTMLLinkElement && /preload/i.test(node.rel)) {
            const url = normalizeScriptUrl(node.href, document.baseURI);
            if (url && (node.rel === 'modulepreload' || node.as === 'script')) urls.push(url);
          }
        }
      }
      if (urls.length > 0) batcher.add(urls);
    });
    mutations.observe(document.documentElement, { childList: true, subtree: true });

    // The observer keeps receiving entries after the page's timing buffer is full, so the
    // collector never needs to touch (and change) the page's own buffer.
    window.addEventListener('pagehide', () => batcher.flush());
    ctx.onInvalidated(() => {
      perf.disconnect();
      mutations.disconnect();
      batcher.dispose();
      scope[INSTALLED] = false;
    });
  },
});
