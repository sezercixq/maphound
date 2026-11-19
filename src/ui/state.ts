import { batch, computed, signal } from '@preact/signals';
import { browser } from 'wxt/browser';
import { onDbChanged } from '@/core/channel';
import {
  getDb,
  type JobRecord,
  type MapRecord,
  type ScriptRecord,
  type SiteRecord,
} from '@/core/db';
import { getActiveTabOrigin } from '@/core/permissions';
import { parseOrigin, siteForUrl } from '@/core/scope';
import { buildViewModel } from './view-model';

/** Origin of the active tab, when Chrome lets us read it. */
export const tabOrigin = signal<string | null>(null);
/** Origin typed by the user when the tab cannot be read. Cleared when the tab changes. */
export const manualOrigin = signal<string | null>(null);
export const origin = computed(() => manualOrigin.value ?? tabOrigin.value);

export const sites = signal<SiteRecord[]>([]);
export const site = computed(() =>
  origin.value ? (siteForUrl(sites.value, origin.value) ?? null) : null,
);

const jobs = signal<JobRecord[]>([]);
const scripts = signal<ScriptRecord[]>([]);
const maps = signal<MapRecord[]>([]);
export const loaded = signal(false);

export const view = computed(() => buildViewModel(jobs.value, scripts.value, maps.value));

/** Re-read everything for the current site. The channel only says "something changed". */
export async function refresh(): Promise<void> {
  const db = await getDb();
  const allSites = await db.getAll('sites');
  const current = origin.peek();
  const active = current ? siteForUrl(allSites, current) : undefined;
  const [siteJobs, siteScripts, siteMaps] = active
    ? await Promise.all([
        db.getAllFromIndex('jobs', 'by-origin', active.origin),
        db.getAllFromIndex('scripts', 'by-origin', active.origin),
        db.getAllFromIndex('maps', 'by-origin', active.origin),
      ])
    : [[], [], []];
  batch(() => {
    sites.value = allSites;
    jobs.value = siteJobs;
    scripts.value = siteScripts;
    maps.value = siteMaps;
    loaded.value = true;
  });
}

export async function refreshTab(): Promise<void> {
  const next = await getActiveTabOrigin().catch(() => null);
  if (next !== tabOrigin.peek()) {
    batch(() => {
      tabOrigin.value = next;
      if (next) manualOrigin.value = null;
    });
    await refresh();
  }
}

export function useManualOrigin(input: string): boolean {
  const parsed = parseOrigin(input);
  if (!parsed) return false;
  manualOrigin.value = parsed;
  void refresh();
  return true;
}

/** Wire up live updates. Returns a disposer. */
export function startState(): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const schedule = () => {
    if (timer !== undefined) return;
    // Coalesce bursts (a page load produces dozens of job updates).
    timer = setTimeout(() => {
      timer = undefined;
      void refresh();
    }, 150);
  };
  const stopChannel = onDbChanged(schedule);
  const onTab = () => void refreshTab();
  const onUpdated = (_id: number, info: { url?: string; status?: string }) => {
    if (info.url || info.status === 'complete') onTab();
  };
  browser.tabs.onActivated.addListener(onTab);
  browser.tabs.onUpdated.addListener(onUpdated);
  browser.windows.onFocusChanged.addListener(onTab);
  void refreshTab().then(refresh);
  return () => {
    stopChannel();
    browser.tabs.onActivated.removeListener(onTab);
    browser.tabs.onUpdated.removeListener(onUpdated);
    browser.windows.onFocusChanged.removeListener(onTab);
    if (timer !== undefined) clearTimeout(timer);
  };
}
