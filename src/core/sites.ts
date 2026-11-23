import { collectGarbage } from './analyze';
import { notifyDbChanged } from './channel';
import { getDb, type MaphoundHandle, type Scope, type SiteRecord, type SiteSettings } from './db';
import {
  collectorScriptId,
  hasOriginPermission,
  hasSitePermission,
  injectIntoOpenTabs,
  registerCollector,
  registeredCollectorIds,
  revokePatterns,
  unregisterCollector,
  unregisterCollectorIds,
} from './permissions';
import { requeueThirdParty } from './queue';
import {
  effectiveScope,
  extraOriginPatternsToRevoke,
  isInSiteScope,
  parseOrigin,
  patternsToRevoke,
} from './scope';

export const DEFAULT_SETTINGS: SiteSettings = {
  aggressiveMapProbing: false,
  useCredentials: false,
};

export type EnableResult =
  | { ok: true; injected: number }
  | { ok: false; reason: 'invalid-origin' | 'permission-missing' };

/**
 * Service worker side of enabling a site. The side panel has already obtained the host
 * permission; this verifies it, stores the site, registers the collector and injects it into
 * tabs that are already open. Re-enabling keeps existing settings.
 */
export async function enableSite(
  input: string,
  scope: Scope,
  db?: MaphoundHandle,
  settings: Partial<SiteSettings> = {},
): Promise<EnableResult> {
  const origin = parseOrigin(input);
  if (!origin) return { ok: false, reason: 'invalid-origin' };
  const finalScope = effectiveScope(origin, scope);
  if (!(await hasSitePermission(origin, finalScope))) {
    return { ok: false, reason: 'permission-missing' };
  }
  const handle = db ?? (await getDb());
  const previous = await handle.get('sites', origin);
  await handle.put('sites', {
    origin,
    scope: finalScope,
    enabledAt: previous?.enabledAt ?? Date.now(),
    settings: { ...DEFAULT_SETTINGS, ...previous?.settings, ...settings },
    extraOrigins: previous?.extraOrigins ?? [],
  });
  await registerCollector(origin, finalScope);
  const injected = await injectIntoOpenTabs(origin, finalScope);
  notifyDbChanged({ store: 'sites', origin });
  return { ok: true, injected };
}

async function purgeOrigin(handle: MaphoundHandle, origin: string): Promise<void> {
  for (const store of ['scripts', 'maps', 'findings', 'intel', 'pages', 'jobs'] as const) {
    const tx = handle.transaction(store, 'readwrite');
    for (const key of await tx.store.index('by-origin').getAllKeys(origin)) {
      await tx.store.delete(key);
    }
    await tx.done;
  }
  await collectGarbage(handle);
}

/** Change a site's settings. Takes effect for scripts fetched from now on. */
export async function updateSiteSettings(
  origin: string,
  patch: Partial<SiteSettings>,
  db?: MaphoundHandle,
): Promise<{ ok: boolean }> {
  const handle = db ?? (await getDb());
  const site = await handle.get('sites', origin);
  if (!site) return { ok: false };
  const settings: SiteSettings = {
    aggressiveMapProbing: patch.aggressiveMapProbing ?? site.settings.aggressiveMapProbing,
    useCredentials: patch.useCredentials ?? site.settings.useCredentials,
  };
  await handle.put('sites', { ...site, settings });
  notifyDbChanged({ store: 'sites', origin });
  return { ok: true };
}

/**
 * Stop collecting on a site: unregister the collector, delete the site and revoke host
 * patterns that no other enabled site still needs. `purge` also deletes its stored results.
 */
export async function disableSite(
  origin: string,
  purge: boolean,
  db?: MaphoundHandle,
): Promise<{ ok: boolean; revoked: string[] }> {
  const handle = db ?? (await getDb());
  const site = await handle.get('sites', origin);
  await unregisterCollector(origin);
  await handle.delete('sites', origin);
  if (purge) await purgeOrigin(handle, origin);
  let revoked: string[] = [];
  if (site) {
    const candidates = patternsToRevoke(site, await handle.getAll('sites'));
    if (await revokePatterns(candidates)) revoked = candidates;
  }
  notifyDbChanged({ store: 'sites', origin });
  return { ok: true, revoked };
}

/**
 * Reconcile after the user revokes access in chrome://extensions, and after updates or
 * restarts: sites without permission are disabled (data kept), registrations are repaired.
 */
export async function syncSites(db?: MaphoundHandle): Promise<{ disabled: string[] }> {
  const handle = db ?? (await getDb());
  const sites: SiteRecord[] = await handle.getAll('sites');
  const disabled: string[] = [];
  const registered = new Set(await registeredCollectorIds());
  const wanted = new Set<string>();

  for (const site of sites) {
    if (!(await hasSitePermission(site.origin, site.scope))) {
      await unregisterCollector(site.origin);
      await handle.delete('sites', site.origin);
      disabled.push(site.origin);
      continue;
    }
    // An extra origin revoked in Chrome drops out of the site; the site itself stays.
    const extras = site.extraOrigins ?? [];
    const kept: string[] = [];
    for (const extra of extras) if (await hasOriginPermission(extra)) kept.push(extra);
    if (kept.length !== extras.length) await handle.put('sites', { ...site, extraOrigins: kept });
    const id = collectorScriptId(site.origin);
    wanted.add(id);
    if (!registered.has(id)) await registerCollector(site.origin, site.scope);
  }

  await unregisterCollectorIds([...registered].filter((id) => !wanted.has(id)));
  notifyDbChanged({ store: 'sites' });
  return { disabled };
}

/**
 * Scan a site's scripts again (after a rules update): findings are deleted and scanned scripts
 * go back to `fetched`. Downloads and map analyses are kept.
 */
export async function rescanSite(origin: string, db?: MaphoundHandle): Promise<{ queued: number }> {
  const handle = db ?? (await getDb());
  for (const store of ['findings', 'intel'] as const) {
    const tx = handle.transaction(store, 'readwrite');
    for (const key of await tx.store.index('by-origin').getAllKeys(origin))
      await tx.store.delete(key);
    await tx.done;
  }
  const tx = handle.transaction('jobs', 'readwrite');
  let queued = 0;
  for (const job of await tx.store.index('by-origin').getAll(origin)) {
    if (job.kind !== 'script' || job.state !== 'done' || !job.hash) continue;
    await tx.store.put({
      ...job,
      state: 'fetched',
      attempts: 0,
      leasedUntil: 0,
      updatedAt: Date.now(),
    });
    queued++;
  }
  await tx.done;
  notifyDbChanged({ store: 'findings', origin });
  return { queued };
}

export type AddOriginsResult =
  | { ok: true; added: string[]; requeued: number }
  | { ok: false; reason: 'site-not-enabled' | 'permission-missing' };

/**
 * Service worker side of "Allow & scan": the side panel already obtained host access to the
 * origins. Each one is verified, added to the site and its skipped scripts and maps requeued.
 */
export async function addExtraOrigins(
  siteOrigin: string,
  inputs: readonly string[],
  db?: MaphoundHandle,
): Promise<AddOriginsResult> {
  const handle = db ?? (await getDb());
  const site = await handle.get('sites', siteOrigin);
  if (!site) return { ok: false, reason: 'site-not-enabled' };
  const current = new Set(site.extraOrigins ?? []);
  const added: string[] = [];
  for (const input of inputs) {
    const origin = parseOrigin(input);
    if (!origin || current.has(origin) || isInSiteScope(origin, site)) continue;
    if (!(await hasOriginPermission(origin))) continue;
    current.add(origin);
    added.push(origin);
  }
  if (added.length === 0 && inputs.length > 0) return { ok: false, reason: 'permission-missing' };
  await handle.put('sites', { ...site, extraOrigins: [...current].sort() });
  const requeued = await requeueThirdParty(handle, site.origin, added);
  notifyDbChanged({ store: 'sites', origin: site.origin });
  if (requeued > 0) notifyDbChanged({ store: 'jobs', origin: site.origin });
  return { ok: true, added, requeued };
}

/**
 * Stop scanning one extra origin: remove it from the site and revoke its pattern unless another
 * site (or this site's own scope) still needs it. Already downloaded data is kept; new scripts
 * from there are listed as third party again.
 */
export async function removeExtraOrigin(
  siteOrigin: string,
  extra: string,
  db?: MaphoundHandle,
): Promise<{ ok: boolean; revoked: string[] }> {
  const handle = db ?? (await getDb());
  const site = await handle.get('sites', siteOrigin);
  if (!site?.extraOrigins?.includes(extra)) return { ok: false, revoked: [] };
  const others = (await handle.getAll('sites')).filter((s) => s.origin !== site.origin);
  const candidates = extraOriginPatternsToRevoke(extra, site, others);
  await handle.put('sites', {
    ...site,
    extraOrigins: site.extraOrigins.filter((o) => o !== extra),
  });
  const revoked = (await revokePatterns(candidates)) ? candidates : [];
  notifyDbChanged({ store: 'sites', origin: site.origin });
  return { ok: true, revoked };
}
