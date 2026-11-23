import type { Scope, SiteSettings } from './db';
import { sendMessage } from './messaging';
import { requestOriginsPermission, requestSitePermission } from './permissions';
import { effectiveScope, parseOrigin } from './scope';
import type { AddOriginsResult, EnableResult } from './sites';

export type EnableFromUiResult = EnableResult | { ok: false; reason: 'permission-denied' };

/**
 * Side panel entry point. Call directly from a click handler: Chrome only shows the host
 * permission prompt inside a user gesture, so nothing may be awaited before the request.
 */
export async function enableSiteFromUi(
  input: string,
  scope: Scope,
  settings: Partial<SiteSettings> = {},
): Promise<EnableFromUiResult> {
  const origin = parseOrigin(input);
  if (!origin) return { ok: false, reason: 'invalid-origin' };
  const finalScope = effectiveScope(origin, scope);
  if (!(await requestSitePermission(origin, finalScope))) {
    return { ok: false, reason: 'permission-denied' };
  }
  return sendMessage('site:enable', { origin, scope: finalScope, settings });
}

export function disableSiteFromUi(origin: string, purge: boolean) {
  return sendMessage('site:disable', { origin, purge });
}

export function updateSiteSettingsFromUi(origin: string, patch: Partial<SiteSettings>) {
  return sendMessage('site:settings', { origin, patch });
}

export function rescanSiteFromUi(origin: string) {
  return sendMessage('scan:rescan', { origin });
}

export function captureSnapshotFromUi(origin: string) {
  return sendMessage('snapshot:capture', { origin });
}

export type AllowOriginsResult = AddOriginsResult | { ok: false; reason: 'permission-denied' };

/**
 * "Allow & scan" for one or many third-party origins. Call straight from a click handler: the
 * permission prompt must be the first thing awaited. One prompt covers all origins.
 */
export async function allowOriginsFromUi(
  siteOrigin: string,
  origins: readonly string[],
): Promise<AllowOriginsResult> {
  if (!(await requestOriginsPermission(origins))) return { ok: false, reason: 'permission-denied' };
  return sendMessage('site:add-origins', { origin: siteOrigin, origins: [...origins] });
}

export function removeOriginFromUi(siteOrigin: string, extraOrigin: string) {
  return sendMessage('site:remove-origin', { origin: siteOrigin, extraOrigin });
}
