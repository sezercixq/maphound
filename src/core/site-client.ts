import type { Scope, SiteSettings } from './db';
import { sendMessage } from './messaging';
import { requestSitePermission } from './permissions';
import { effectiveScope, parseOrigin } from './scope';
import type { EnableResult } from './sites';

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
