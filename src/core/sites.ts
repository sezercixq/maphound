import { notifyDbChanged } from './channel';
import { getDb, type MaphoundHandle, type Scope, type SiteRecord, type SiteSettings } from './db';
import {
  collectorScriptId,
  hasSitePermission,
  injectIntoOpenTabs,
  registerCollector,
  registeredCollectorIds,
  revokePatterns,
  unregisterCollector,
  unregisterCollectorIds,
} from './permissions';
import { effectiveScope, parseOrigin, patternsToRevoke } from './scope';

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
    settings: previous?.settings ?? DEFAULT_SETTINGS,
  });
  await registerCollector(origin, finalScope);
  const injected = await injectIntoOpenTabs(origin, finalScope);
  notifyDbChanged({ store: 'sites', origin });
  return { ok: true, injected };
}

async function purgeOrigin(handle: MaphoundHandle, origin: string): Promise<void> {
  for (const store of ['scripts', 'findings', 'jobs'] as const) {
    const tx = handle.transaction(store, 'readwrite');
    for (const key of await tx.store.index('by-origin').getAllKeys(origin)) {
      await tx.store.delete(key);
    }
    await tx.done;
  }
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
    const id = collectorScriptId(site.origin);
    wanted.add(id);
    if (!registered.has(id)) await registerCollector(site.origin, site.scope);
  }

  await unregisterCollectorIds([...registered].filter((id) => !wanted.has(id)));
  if (disabled.length > 0) notifyDbChanged({ store: 'sites' });
  return { disabled };
}
