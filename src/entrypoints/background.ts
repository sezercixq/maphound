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
import { disableSite, enableSite, syncSites, updateSiteSettings } from '@/core/sites';

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
  notify: notifyDbChanged,
  schedule: (callback, ms) => setTimeout(callback, ms),
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

  onMessage('site:enable', ({ data }) =>
    enableSite(data.origin, data.scope, undefined, data.settings),
  );
  onMessage('site:settings', ({ data }) => updateSiteSettings(data.origin, data.patch));
  onMessage('site:disable', ({ data }) => disableSite(data.origin, data.purge));
  onMessage('scan:rescan', () => ({ queued: 0 }));

  // End-to-end builds only (VITE_MH_E2E=1): lets a test drive the pipeline from the worker context.
  if (import.meta.env.VITE_MH_E2E === '1') {
    const g = globalThis as Record<string, unknown>;
    g.__mhPing = pingPipeline;
    g.__mhScan = scanBlobForTest;
    g.__mhEnableSite = (origin: string, scope: Scope) => enableSite(origin, scope);
    g.__mhDisableSite = (origin: string, purge: boolean) => disableSite(origin, purge);
    g.__mhRegistered = registeredCollectorIds;
    g.__mhJobs = async () => (await getDb()).getAll('jobs');
    g.__mhScripts = async () => (await getDb()).getAll('scripts');
    g.__mhMaps = async () => (await getDb()).getAll('maps');
    g.__mhSetSettings = async (origin: string, patch: Partial<SiteSettings>) => {
      const db = await getDb();
      const site = await db.get('sites', origin);
      if (site) await db.put('sites', { ...site, settings: { ...site.settings, ...patch } });
    };
  }
});
