import { browser } from 'wxt/browser';
import { notifyDbChanged } from '@/core/channel';
import { getDb } from '@/core/db';
import { resumeJobs } from '@/core/jobs';
import { onMessage, type PingResult, sendMessage } from '@/core/messaging';
import { ensureOffscreen } from '@/core/offscreen';

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

const DEFAULT_SETTINGS = { aggressiveMapProbing: false, useCredentials: false };

export default defineBackground(() => {
  // All listeners are registered synchronously so wake-up events are never missed.
  browser.sidePanel?.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
  browser.runtime.onInstalled.addListener(() => void resumeJobs());
  browser.runtime.onStartup.addListener(() => void resumeJobs());
  browser.alarms.create('mh-resume', { periodInMinutes: 1 });
  browser.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === 'mh-resume') void resumeJobs();
  });

  onMessage('scripts:discovered', () => {
    // Job creation arrives with the fetch pipeline.
  });

  onMessage('site:enable', async ({ data }) => {
    const db = await getDb();
    await db.put('sites', {
      origin: data.origin,
      scope: data.scope,
      enabledAt: Date.now(),
      settings: DEFAULT_SETTINGS,
    });
    notifyDbChanged({ store: 'sites', origin: data.origin });
    return { ok: true };
  });

  onMessage('site:disable', async ({ data }) => {
    const db = await getDb();
    await db.delete('sites', data.origin);
    if (data.purge) {
      for (const store of ['scripts', 'findings', 'jobs'] as const) {
        const tx = db.transaction(store, 'readwrite');
        for (const key of await tx.store.index('by-origin').getAllKeys(data.origin)) {
          await tx.store.delete(key);
        }
        await tx.done;
      }
    }
    notifyDbChanged({ store: 'sites', origin: data.origin });
    return { ok: true };
  });

  onMessage('scan:rescan', () => ({ queued: 0 }));

  // End-to-end builds only (VITE_MH_E2E=1): lets a test drive the pipeline from the worker context.
  if (import.meta.env.VITE_MH_E2E === '1') {
    const g = globalThis as Record<string, unknown>;
    g.__mhPing = pingPipeline;
    g.__mhScan = scanBlobForTest;
  }
});
