import { browser } from 'wxt/browser';
import { notifyDbChanged } from '@/core/channel';
import { getDb, type Scope, type SiteSettings } from '@/core/db';
import { Fetcher } from '@/core/fetcher';
import { resumeJobs } from '@/core/jobs';
import { onMessage, type PingResult, sendMessage } from '@/core/messaging';
import { ensureOffscreen } from '@/core/offscreen';
import { registeredCollectorIds } from '@/core/permissions';
import { Processor } from '@/core/processor';
import { enqueueDiscovered } from '@/core/queue';
import { siteForUrl } from '@/core/scope';
import {
  addExtraOrigins,
  disableSite,
  enableSite,
  removeExtraOrigin,
  rescanSite,
  syncSites,
  updateSiteSettings,
} from '@/core/sites';
import { auditHeaders, auditSetCookieHeaders, mergeAuditFindings } from '@/engine/audit';
import { recordSiteSnapshot } from '@/engine/diff';

/** Background to offscreen to worker round trip. */
export async function pingPipeline(text: string): Promise<PingResult> {
  await ensureOffscreen();
  const result = await sendMessage('spike:ping', { text });
  return { echo: result.echo, via: ['background', ...result.via] };
}

/** Test helper: store a blob, then have the worker read it back and hash it. */
async function scanBlobForTest(text: string) {
  const db = await getDb();
  const blob = new Blob([text]);
  const hash = `e2e-${Date.now()}`;
  await db.put('blobs', { hash, kind: 'script', blob, size: blob.size, lastAccess: Date.now() });
  await ensureOffscreen();
  return sendMessage('scan:request', { jobId: 'e2e', blobKey: hash, kind: 'script' });
}

const processor = new Processor({
  db: getDb,
  analyze: async (request) => {
    await ensureOffscreen();
    return sendMessage('map:analyze', request);
  },
  scan: async (request) => {
    await ensureOffscreen();
    return sendMessage('script:scan', request);
  },
  notify: notifyDbChanged,
  schedule: (callback, ms) => setTimeout(callback, ms),
  onOriginSettled: async (origin) => {
    try {
      const snap = await recordSiteSnapshot(await getDb(), origin);
      if (snap) notifyDbChanged({ store: 'snapshots', origin });
    } catch {
      // Snapshot capture must never fail job completion.
    }
  },
});

const fetcher = new Fetcher({
  db: getDb,
  fetch: (input, init) => fetch(input, init),
  notify: notifyDbChanged,
  schedule: (callback, ms) => setTimeout(callback, ms),
  onSettled: () => void processor.pump(),
});

/** Requeue expired leases, then continue downloading and analysing. Runs on every wake-up. */
async function resume(): Promise<void> {
  await resumeJobs();
  await Promise.all([fetcher.pump(), processor.pump()]);
}

export default defineBackground(() => {
  // All listeners are registered synchronously so wake-up events are never missed.
  browser.sidePanel?.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
  browser.runtime.onInstalled.addListener(() => {
    void syncSites().then(resume);
  });
  browser.runtime.onStartup.addListener(() => {
    void syncSites().then(resume);
  });
  // Access revoked from chrome://extensions or the site's permission menu.
  browser.permissions.onRemoved.addListener(() => void syncSites());
  browser.alarms.create('mh-resume', { periodInMinutes: 1 });
  browser.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === 'mh-resume') void resume();
  });

  onMessage('scripts:discovered', async ({ data, sender }) => {
    // Only content scripts in a tab report scripts; the page URL comes from Chrome, not the page.
    const pageUrl = sender.tab ? (sender.url ?? sender.tab.url) : undefined;
    if (!pageUrl || !Array.isArray(data.urls)) return;
    const urls = data.urls.filter((url): url is string => typeof url === 'string');
    const result = await enqueueDiscovered(
      await getDb(),
      pageUrl,
      urls,
      Date.now(),
      notifyDbChanged,
    );
    if (result.queued > 0) void fetcher.pump();
  });

  onMessage('page:next-data', async ({ data, sender }) => {
    const pageUrl = sender.tab ? (sender.url ?? sender.tab.url) : undefined;
    if (!pageUrl || !data?.summary) return;
    const db = await getDb();
    const active = siteForUrl(await db.getAll('sites'), pageUrl);
    if (!active) return;
    let pathname = '/';
    try {
      pathname = new URL(pageUrl).pathname;
    } catch {
      return;
    }
    const id = `${active.origin}|${pathname}`;
    const existing = await db.get('pages', id);
    if (!existing) {
      const count = await db.countFromIndex('pages', 'by-origin', active.origin);
      if (count >= 50) return;
    }
    await db.put('pages', {
      id,
      origin: active.origin,
      pageUrl,
      nextData: data.summary,
      updatedAt: Date.now(),
    });
    notifyDbChanged({ store: 'pages', origin: active.origin });
  });

  onMessage('page:audit', async ({ data, sender }) => {
    const pageUrl = sender.tab ? (sender.url ?? sender.tab.url) : undefined;
    if (!pageUrl) return;
    const db = await getDb();
    const active = siteForUrl(await db.getAll('sites'), pageUrl);
    if (!active) return;
    let pathname = '/';
    try {
      pathname = new URL(pageUrl).pathname;
    } catch {
      return;
    }
    const id = `${active.origin}|${pathname}`;
    const existing = await db.get('audits', id);
    if (!existing) {
      const count = await db.countFromIndex('audits', 'by-origin', active.origin);
      if (count >= 50) return;
    }

    let headerSummary: Record<string, string | null> = {};
    let matrix: ReturnType<typeof auditHeaders>['matrix'] = [];
    let headerFindings: ReturnType<typeof auditHeaders>['findings'] = [];
    let setCookieFindings: ReturnType<typeof auditSetCookieHeaders> = [];

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5_000);
    try {
      const response = await fetch(pageUrl, {
        credentials: active.settings.useCredentials ? 'include' : 'omit',
        signal: controller.signal,
        redirect: 'follow',
      });
      const headerOut = auditHeaders(response.headers, pageUrl);
      headerSummary = headerOut.summary;
      matrix = headerOut.matrix;
      headerFindings = headerOut.findings;

      const withGetSetCookie = response.headers as Headers & { getSetCookie?: () => string[] };
      const setCookies =
        typeof withGetSetCookie.getSetCookie === 'function'
          ? withGetSetCookie.getSetCookie()
          : response.headers.get('set-cookie')
            ? [response.headers.get('set-cookie') as string]
            : [];
      setCookieFindings = auditSetCookieHeaders(setCookies, pageUrl);
      void response.body?.cancel().catch(() => {});
    } catch {
      // Network failure during header probe: still store client storage/cookie findings.
    } finally {
      clearTimeout(timer);
    }

    const findings = mergeAuditFindings(
      headerFindings,
      setCookieFindings,
      data.cookieFindings ?? [],
      data.storageFindings ?? [],
    );

    await db.put('audits', {
      id,
      origin: active.origin,
      pageUrl,
      headers: headerSummary,
      matrix,
      findings,
      storageKeysChecked: data.storageKeysChecked ?? 0,
      cookiesChecked: data.cookiesChecked ?? 0,
      updatedAt: Date.now(),
    });
    notifyDbChanged({ store: 'audits', origin: active.origin });
  });

  onMessage('snapshot:capture', async ({ data }) => {
    const snap = await recordSiteSnapshot(await getDb(), data.origin, { forceNew: true });
    if (snap) {
      notifyDbChanged({ store: 'snapshots', origin: data.origin });
      return { ok: true, id: snap.id };
    }
    return { ok: false };
  });

  onMessage('site:enable', ({ data }) =>
    enableSite(data.origin, data.scope, undefined, data.settings),
  );
  onMessage('site:settings', ({ data }) => updateSiteSettings(data.origin, data.patch));
  onMessage('site:disable', ({ data }) => disableSite(data.origin, data.purge));
  onMessage('site:add-origins', async ({ data }) => {
    const result = await addExtraOrigins(data.origin, data.origins);
    if (result.ok && result.requeued > 0) void fetcher.pump();
    return result;
  });
  onMessage('site:remove-origin', ({ data }) => removeExtraOrigin(data.origin, data.extraOrigin));
  onMessage('scan:rescan', async ({ data }) => {
    const result = await rescanSite(data.origin);
    void processor.pump();
    return result;
  });

  // End-to-end builds only (VITE_MH_E2E=1): lets a test drive the pipeline from the worker context.
  if (import.meta.env.VITE_MH_E2E === '1') {
    const g = globalThis as Record<string, unknown>;
    g.__mhPing = pingPipeline;
    g.__mhScan = scanBlobForTest;
    g.__mhEnableSite = (origin: string, scope: Scope) => enableSite(origin, scope);
    g.__mhDisableSite = (origin: string, purge: boolean) => disableSite(origin, purge);
    g.__mhSites = async () => (await getDb()).getAll('sites');
    g.__mhRegistered = registeredCollectorIds;
    g.__mhJobs = async () => (await getDb()).getAll('jobs');
    g.__mhScripts = async () => (await getDb()).getAll('scripts');
    g.__mhMaps = async () => (await getDb()).getAll('maps');
    g.__mhFindings = async () => (await getDb()).getAll('findings');
    g.__mhIntel = async () => (await getDb()).getAll('intel');
    g.__mhPages = async () => (await getDb()).getAll('pages');
    g.__mhAudits = async () => (await getDb()).getAll('audits');
    g.__mhSnapshots = async () => (await getDb()).getAll('snapshots');
    g.__mhCaptureSnapshot = async (origin: string) =>
      recordSiteSnapshot(await getDb(), origin, { forceNew: true });
    g.__mhSetSettings = async (origin: string, patch: Partial<SiteSettings>) => {
      const db = await getDb();
      const site = await db.get('sites', origin);
      if (site) await db.put('sites', { ...site, settings: { ...site.settings, ...patch } });
    };
  }
});
