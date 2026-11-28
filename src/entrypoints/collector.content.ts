import { createUrlBatcher, isScriptResource, normalizeScriptUrl } from '@/core/collect';
import { sendMessage } from '@/core/messaging';
import {
  auditCookies,
  auditHtmlMetadata,
  auditOAuthPage,
  auditStorageEntries,
  auditSubresourceIntegrity,
  type ClientCookieInput,
  type ExternalResourceTag,
} from '@/engine/audit';
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

    void collectClientAudit(pageUrl);

    // Bridge passive MAIN-world runtime-hook events (API traffic & opt-in DOM Guard)
    const onRuntimeMessage = (event: MessageEvent) => {
      if (event.source !== window || event.origin !== window.location.origin) return;
      const msg = event.data as {
        __mhRuntime?: boolean;
        kind?: 'api' | 'dom';
        payload?: Record<string, unknown>;
      } | null;
      if (!msg?.__mhRuntime || !msg.payload) return;
      if (msg.kind === 'api') {
        sendMessage('runtime:api', {
          pageUrl,
          url: String(msg.payload.url ?? ''),
          method: String(msg.payload.method ?? 'GET'),
          status: Number(msg.payload.status ?? 0),
          headerNames: Array.isArray(msg.payload.headerNames)
            ? msg.payload.headerNames.map(String)
            : [],
          requestBody: typeof msg.payload.requestBody === 'string' ? msg.payload.requestBody : null,
          responseBody:
            typeof msg.payload.responseBody === 'string' ? msg.payload.responseBody : null,
        }).catch(() => {});
      } else if (msg.kind === 'dom') {
        sendMessage('runtime:dom', {
          pageUrl,
          kind: msg.payload.kind as 'postMessage' | 'innerHTML' | 'eval' | 'Function' | 'cookie',
          detail: String(msg.payload.detail ?? ''),
          ...(typeof msg.payload.senderOrigin === 'string'
            ? { senderOrigin: msg.payload.senderOrigin }
            : {}),
          ...(typeof msg.payload.hasListener === 'boolean'
            ? { hasListener: msg.payload.hasListener }
            : {}),
          ...(typeof msg.payload.rawStack === 'string' ? { rawStack: msg.payload.rawStack } : {}),
        }).catch(() => {});
      }
    };
    window.addEventListener('message', onRuntimeMessage);

    void sendMessage('runtime:guard-status', { pageUrl })
      .then((res) => {
        if (res?.enabled) {
          window.postMessage({ __mhControl: 'dom-guard', enabled: true }, window.location.origin);
        }
      })
      .catch(() => {});

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
      window.removeEventListener('message', onRuntimeMessage);
      perf.disconnect();
      mutations.disconnect();
      batcher.dispose();
      scope[INSTALLED] = false;
    });
  },
});

function readStorageEntries(storage: Storage): { key: string; value: string }[] {
  const entries: { key: string; value: string }[] = [];
  for (let i = 0; i < storage.length && i < 200; i++) {
    const key = storage.key(i);
    if (!key) continue;
    const value = storage.getItem(key);
    if (value !== null) entries.push({ key, value });
  }
  return entries;
}

async function collectClientAudit(pageUrl: string): Promise<void> {
  let localEntries: { key: string; value: string }[] = [];
  let sessionEntries: { key: string; value: string }[] = [];
  try {
    localEntries = readStorageEntries(localStorage);
  } catch {
    // Storage access denied.
  }
  try {
    sessionEntries = readStorageEntries(sessionStorage);
  } catch {
    // Storage access denied.
  }
  const storageFindings = [
    ...auditStorageEntries(localEntries, 'localStorage'),
    ...auditStorageEntries(sessionEntries, 'sessionStorage'),
  ];

  const cookieInputs: ClientCookieInput[] = [];
  const seenNames = new Set<string>();
  const store = (
    globalThis as {
      cookieStore?: {
        getAll?: () => Promise<
          Array<{
            name: string;
            value?: string;
            sameSite?: string;
            domain?: string | null;
            path?: string;
          }>
        >;
      };
    }
  ).cookieStore;
  if (store && typeof store.getAll === 'function') {
    try {
      const list = await store.getAll();
      for (const c of list.slice(0, 150)) {
        if (!c.name) continue;
        seenNames.add(c.name);
        cookieInputs.push({
          name: c.name,
          value: c.value,
          httpOnly: false,
          sameSite: c.sameSite,
          domain: c.domain ?? undefined,
          path: c.path,
          fromDocumentCookie: false,
        });
      }
    } catch {
      // cookieStore unavailable.
    }
  }
  try {
    const raw = document.cookie;
    if (raw) {
      for (const part of raw.split(';')) {
        const trimmed = part.trim();
        const eq = trimmed.indexOf('=');
        const name = (eq < 0 ? trimmed : trimmed.slice(0, eq)).trim();
        const value = eq < 0 ? '' : trimmed.slice(eq + 1).trim();
        if (!name || seenNames.has(name)) continue;
        seenNames.add(name);
        cookieInputs.push({
          name,
          value,
          httpOnly: false,
          fromDocumentCookie: true,
        });
      }
    }
  } catch {
    // document.cookie unavailable.
  }

  const rawComments: string[] = [];
  try {
    const walker = document.createTreeWalker(document.documentElement, NodeFilter.SHOW_COMMENT);
    let node = walker.nextNode();
    while (node && rawComments.length < 300) {
      if (node.nodeValue) rawComments.push(node.nodeValue.slice(0, 500));
      node = walker.nextNode();
    }
  } catch {
    // DOM traversal unavailable.
  }

  const rawMetas: { name: string; content: string }[] = [];
  try {
    for (const meta of Array.from(document.querySelectorAll('meta[name][content]')).slice(0, 100)) {
      const name = meta.getAttribute('name') ?? '';
      const content = meta.getAttribute('content') ?? '';
      if (name && content) rawMetas.push({ name, content });
    }
  } catch {
    // Meta traversal unavailable.
  }

  const externalResources: ExternalResourceTag[] = [];
  try {
    for (const s of Array.from(document.querySelectorAll<HTMLScriptElement>('script[src]')).slice(
      0,
      150,
    )) {
      const url = normalizeScriptUrl(s.src, document.baseURI);
      if (url) {
        externalResources.push({
          tag: 'script',
          url,
          integrity: s.getAttribute('integrity') ?? undefined,
          crossOrigin: s.getAttribute('crossorigin'),
        });
      }
    }
    for (const l of Array.from(
      document.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"][href]'),
    ).slice(0, 150)) {
      const url = normalizeScriptUrl(l.href, document.baseURI);
      if (url) {
        externalResources.push({
          tag: 'stylesheet',
          url,
          integrity: l.getAttribute('integrity') ?? undefined,
          crossOrigin: l.getAttribute('crossorigin'),
        });
      }
    }
  } catch {
    // DOM resource traversal unavailable.
  }

  const supplyChainFindings = auditSubresourceIntegrity(pageUrl, externalResources);
  const oauthFindings = auditOAuthPage(pageUrl);
  const htmlAudit = auditHtmlMetadata(rawComments, rawMetas);

  const cookieFindings = auditCookies(cookieInputs, pageUrl);
  await sendMessage('page:audit', {
    pageUrl,
    storageFindings,
    cookieFindings,
    supplyChainFindings,
    oauthFindings,
    externalResources,
    cookieNames: [...seenNames],
    htmlAudit,
    storageKeysChecked: localEntries.length + sessionEntries.length,
    cookiesChecked: cookieInputs.length,
  }).catch(() => {});
}
