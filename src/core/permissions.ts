import { browser } from 'wxt/browser';
import type { Scope } from './db';
import { originPatterns, parseOrigin } from './scope';

/** Output path of `src/entrypoints/collector.content.ts`. */
export const COLLECTOR_FILE = '/content-scripts/collector.js' as const;
const COLLECTOR_PREFIX = 'mh-collector-';

/** Stable content script id for a site. Ids may not start with `_`. */
export function collectorScriptId(origin: string): string {
  return (
    COLLECTOR_PREFIX + origin.replace(/[^a-z0-9]/gi, (c) => `_${c.charCodeAt(0).toString(16)}`)
  );
}

export function isCollectorScriptId(id: string): boolean {
  return id.startsWith(COLLECTOR_PREFIX);
}

/**
 * Origin of the active tab, or null for non-web pages. `tab.url` is visible through
 * `activeTab` after the toolbar click that opens the side panel, or once the site is granted;
 * otherwise the UI falls back to manual origin entry.
 */
export async function getActiveTabOrigin(): Promise<string | null> {
  const [tab] = await browser.tabs.query({ active: true, lastFocusedWindow: true });
  return tab?.url ? parseOrigin(tab.url) : null;
}

export function hasSitePermission(origin: string, scope: Scope): Promise<boolean> {
  return browser.permissions.contains({ origins: originPatterns(origin, scope) });
}

/**
 * Ask Chrome for host access to one site. Must run in an extension page (the side panel)
 * inside a user gesture; the service worker cannot show the prompt.
 */
export function requestSitePermission(origin: string, scope: Scope): Promise<boolean> {
  return browser.permissions.request({ origins: originPatterns(origin, scope) });
}

/** Exact-origin access, as granted for a site's extra origins. */
export function hasOriginPermission(origin: string): Promise<boolean> {
  return browser.permissions.contains({ origins: originPatterns(origin, 'origin') });
}

/**
 * Ask for several extra origins in one prompt (side panel, inside a user gesture). Chrome
 * grants all of them or none.
 */
export function requestOriginsPermission(origins: readonly string[]): Promise<boolean> {
  const patterns = [...new Set(origins.flatMap((origin) => originPatterns(origin, 'origin')))];
  return browser.permissions.request({ origins: patterns });
}

/**
 * Revoke host patterns. Callers pass only patterns no other enabled site needs. Never throws:
 * Chrome refuses to remove required (manifest) host permissions, and disabling must still work.
 */
export async function revokePatterns(patterns: string[]): Promise<boolean> {
  if (patterns.length === 0) return true;
  try {
    return await browser.permissions.remove({ origins: patterns });
  } catch {
    return false;
  }
}

/** Persistently register the collector for a site. Replaces an existing registration. */
export async function registerCollector(origin: string, scope: Scope): Promise<void> {
  const id = collectorScriptId(origin);
  await unregisterCollector(origin);
  await browser.scripting.registerContentScripts([
    {
      id,
      matches: originPatterns(origin, scope),
      js: [COLLECTOR_FILE],
      runAt: 'document_idle',
      world: 'ISOLATED',
      allFrames: false,
      persistAcrossSessions: true,
    },
  ]);
}

export async function unregisterCollector(origin: string): Promise<void> {
  const id = collectorScriptId(origin);
  const existing = await browser.scripting.getRegisteredContentScripts({ ids: [id] });
  if (existing.length > 0) await browser.scripting.unregisterContentScripts({ ids: [id] });
}

export async function unregisterCollectorIds(ids: string[]): Promise<void> {
  if (ids.length > 0) await browser.scripting.unregisterContentScripts({ ids });
}

export async function registeredCollectorIds(): Promise<string[]> {
  const scripts = await browser.scripting.getRegisteredContentScripts();
  return scripts.map((script) => script.id).filter(isCollectorScriptId);
}

/**
 * Inject the collector into tabs that were already open when the site was enabled.
 * The registered script only covers future navigations. Returns how many tabs got it.
 */
export async function injectIntoOpenTabs(origin: string, scope: Scope): Promise<number> {
  const tabs = await browser.tabs.query({ url: originPatterns(origin, scope) });
  let injected = 0;
  for (const tab of tabs) {
    if (tab.id === undefined) continue;
    try {
      await browser.scripting.executeScript({
        target: { tabId: tab.id },
        files: [COLLECTOR_FILE],
        world: 'ISOLATED',
      });
      injected++;
    } catch {
      // Discarded, crashed or navigated-away tabs: the registered script covers the next load.
    }
  }
  return injected;
}
