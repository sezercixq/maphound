import { batch, computed, signal } from '@preact/signals';
import { browser } from 'wxt/browser';
import { onDbChanged } from '@/core/channel';
import {
  type AuditRecord,
  type FindingRecord,
  getDb,
  type JobRecord,
  type MapRecord,
  type PageIntelRecord,
  type ScriptIntelRecord,
  type ScriptRecord,
  type SiteRecord,
} from '@/core/db';
import { getActiveTabOrigin } from '@/core/permissions';
import { parseOrigin, siteForUrl } from '@/core/scope';
import type { SiteSnapshotRecord } from '@/engine/diff';
import type { CustomRuleRecord } from '@/engine/rules';
import type { ObservedApiEvent, RuntimeDomEvent } from '@/engine/runtime';
import type { FileLoadTarget } from '@/engine/search/source-search';
import {
  mergeWorkspaceState,
  registrableDomainFor,
  sitesInWorkspace,
  type TriageRecord,
} from '@/engine/workspace';
import { clearSearchCache } from './search-client';
import { buildViewModel } from './view-model';

export interface ViewerTarget extends FileLoadTarget {
  origin: string;
  line: number;
  column?: number;
  length?: number;
  label?: string;
}

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
const findings = signal<FindingRecord[]>([]);
const intel = signal<ScriptIntelRecord[]>([]);
const pages = signal<PageIntelRecord[]>([]);
const audits = signal<AuditRecord[]>([]);
const snapshots = signal<SiteSnapshotRecord[]>([]);
const runtimeApi = signal<ObservedApiEvent[]>([]);
const runtimeDom = signal<RuntimeDomEvent[]>([]);
const customRules = signal<CustomRuleRecord[]>([]);
const triage = signal<TriageRecord[]>([]);
export const workspaceMode = signal<'page' | 'workspace'>('page');
export const workspaceMeta = signal<{ domain: string; pageCount: number; originCount: number }>({
  domain: '',
  pageCount: 0,
  originCount: 0,
});
export const viewerTarget = signal<ViewerTarget | null>(null);
export const loaded = signal(false);

export function setWorkspaceMode(mode: 'page' | 'workspace'): void {
  if (workspaceMode.value === mode) return;
  workspaceMode.value = mode;
  void refresh();
}

export function openCodeViewer(target: ViewerTarget): void {
  viewerTarget.value = target;
}

export function closeCodeViewer(): void {
  viewerTarget.value = null;
}

export const view = computed(() =>
  buildViewModel(
    jobs.value,
    scripts.value,
    maps.value,
    findings.value,
    site.value,
    intel.value,
    pages.value,
    audits.value,
    snapshots.value,
    runtimeApi.value,
    runtimeDom.value,
    customRules.value,
    triage.value,
  ),
);

let lastActiveOrigin: string | undefined;

/** Re-read everything for the current site. The channel only says "something changed". */
export async function refresh(): Promise<void> {
  const db = await getDb();
  const allSites = await db.getAll('sites');
  const current = origin.peek();
  const active = current ? siteForUrl(allSites, current) : undefined;
  if (active?.origin !== lastActiveOrigin) {
    lastActiveOrigin = active?.origin;
    viewerTarget.value = null;
    clearSearchCache();
  }
  const allCustomRules = await db.getAll('customRules');
  const domain = active ? registrableDomainFor(active.origin) : '';
  const wsSites = active ? sitesInWorkspace(allSites, active.origin) : [];
  const targetOrigins =
    active && workspaceMode.peek() === 'workspace' && wsSites.length > 0
      ? wsSites.map((s) => s.origin)
      : active
        ? [active.origin]
        : [];

  const perOrigin = await Promise.all(
    targetOrigins.map(async (o) => {
      const [
        siteJobs,
        siteScripts,
        siteMaps,
        siteFindings,
        siteIntel,
        sitePages,
        siteAudits,
        siteSnapshots,
        siteRuntimeApi,
        siteRuntimeDom,
      ] = await Promise.all([
        db.getAllFromIndex('jobs', 'by-origin', o),
        db.getAllFromIndex('scripts', 'by-origin', o),
        db.getAllFromIndex('maps', 'by-origin', o),
        db.getAllFromIndex('findings', 'by-origin', o),
        db.getAllFromIndex('intel', 'by-origin', o),
        db.getAllFromIndex('pages', 'by-origin', o),
        db.getAllFromIndex('audits', 'by-origin', o),
        db.getAllFromIndex('snapshots', 'by-origin', o),
        db.getAllFromIndex('runtimeApi', 'by-origin', o),
        db.getAllFromIndex('runtimeDom', 'by-origin', o),
      ]);
      return {
        siteJobs,
        siteScripts,
        siteMaps,
        siteFindings,
        siteIntel,
        sitePages,
        siteAudits,
        siteSnapshots,
        siteRuntimeApi,
        siteRuntimeDom,
      };
    }),
  );

  const siteTriage = active
    ? workspaceMode.peek() === 'workspace' && domain
      ? await db.getAllFromIndex('triage', 'by-domain', domain)
      : await db.getAllFromIndex('triage', 'by-origin', active.origin)
    : [];

  const merged = active
    ? mergeWorkspaceState({
        domain,
        origins: targetOrigins,
        jobs: perOrigin.flatMap((x) => x.siteJobs),
        scripts: perOrigin.flatMap((x) => x.siteScripts),
        maps: perOrigin.flatMap((x) => x.siteMaps),
        findings: perOrigin.flatMap((x) => x.siteFindings),
        intel: perOrigin.flatMap((x) => x.siteIntel),
        pages: perOrigin.flatMap((x) => x.sitePages),
        audits: perOrigin.flatMap((x) => x.siteAudits),
        runtimeApi: perOrigin.flatMap((x) => x.siteRuntimeApi),
        runtimeDom: perOrigin.flatMap((x) => x.siteRuntimeDom),
      })
    : null;

  batch(() => {
    sites.value = allSites;
    jobs.value = merged ? merged.jobs : [];
    scripts.value = merged ? merged.scripts : [];
    maps.value = merged ? merged.maps : [];
    findings.value = merged ? merged.findings : [];
    intel.value = perOrigin.flatMap((x) => x.siteIntel);
    pages.value = merged ? merged.pages : [];
    audits.value = merged ? merged.audits : [];
    snapshots.value = perOrigin.flatMap((x) => x.siteSnapshots);
    runtimeApi.value = merged ? merged.runtimeApi : [];
    runtimeDom.value = merged ? merged.runtimeDom : [];
    customRules.value = allCustomRules;
    triage.value = siteTriage;
    workspaceMeta.value = {
      domain,
      pageCount: merged?.pageCount ?? 0,
      originCount: wsSites.length,
    };
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
