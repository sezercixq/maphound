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
import {
  auditHeaders,
  auditSetCookieHeaders,
  type DiscoveryFilesRecord,
  mergeAuditFindings,
  parseRobotsTxt,
  parseSitemapXml,
} from '@/engine/audit';
import { recordSiteSnapshot } from '@/engine/diff';
import { scanWithCustomRules, validateCustomRegex } from '@/engine/rules';
import {
  buildObservedApiEvent,
  buildRuntimeDomEvent,
  MAX_OBSERVED_API_EVENTS,
  mergeObservedApiEvent,
  mergeRuntimeDomEvent,
} from '@/engine/runtime';
import { runSafeVerificationChecks } from '@/engine/verify';

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
    let rawHeaders: ReturnType<typeof auditHeaders>['rawHeaders'] = [];
    let matrix: ReturnType<typeof auditHeaders>['matrix'] = [];
    let headerFindings: ReturnType<typeof auditHeaders>['findings'] = [];
    let setCookieFindings: ReturnType<typeof auditSetCookieHeaders> = [];
    const headerCookieNames: string[] = [];

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
      rawHeaders = headerOut.rawHeaders;
      matrix = headerOut.matrix;
      headerFindings = headerOut.findings;

      const withGetSetCookie = response.headers as Headers & { getSetCookie?: () => string[] };
      const setCookies =
        typeof withGetSetCookie.getSetCookie === 'function'
          ? withGetSetCookie.getSetCookie()
          : response.headers.get('set-cookie')
            ? [response.headers.get('set-cookie') as string]
            : [];
      for (const rawCookie of setCookies) {
        const eq = rawCookie.indexOf('=');
        const name = eq > 0 ? rawCookie.slice(0, eq).trim() : '';
        if (name) headerCookieNames.push(name);
      }
      setCookieFindings = auditSetCookieHeaders(setCookies, pageUrl);
      void response.body?.cancel().catch(() => {});
    } catch {
      // Network failure during header probe: still store client storage/cookie findings.
    } finally {
      clearTimeout(timer);
    }

    // Apply enabled HTML-scoped custom rules to captured HTML comments & meta values
    const htmlCustomRules = (await db.getAll('customRules')).filter(
      (r) => r.enabled && (r.scope === 'html' || r.scope === 'both'),
    );
    const htmlCustomFindings =
      htmlCustomRules.length > 0 && data.htmlAudit
        ? scanWithCustomRules(
            [
              ...data.htmlAudit.comments.map((c) => c.text),
              ...data.htmlAudit.metas.map((m) => `${m.name}: ${m.content}`),
            ].join('\n'),
            htmlCustomRules,
            'html',
          ).map((hit) => ({
            id: `html-custom:${hit.ruleId}:${hit.line}`,
            category: 'headers' as const,
            ruleId: hit.ruleId,
            title: hit.ruleName,
            severity: hit.severity,
            subject: 'HTML',
            preview: hit.preview,
            detail: hit.snippet,
            recommendation: 'Review custom rule match in page HTML comments or meta tags.',
          }))
        : [];

    const findings = mergeAuditFindings(
      headerFindings,
      setCookieFindings,
      data.cookieFindings ?? [],
      data.storageFindings ?? [],
      htmlCustomFindings,
    );
    const cookieNames = [
      ...new Set([...(data.cookieNames ?? []), ...headerCookieNames].filter(Boolean)),
    ].slice(0, 150);

    await db.put('audits', {
      id,
      origin: active.origin,
      pageUrl,
      headers: headerSummary,
      rawHeaders,
      matrix,
      findings,
      cookieNames,
      ...(data.htmlAudit ? { htmlAudit: data.htmlAudit } : {}),
      storageKeysChecked: data.storageKeysChecked ?? 0,
      cookiesChecked: Math.max(data.cookiesChecked ?? 0, cookieNames.length),
      updatedAt: Date.now(),
    });
    notifyDbChanged({ store: 'audits', origin: active.origin });
  });

  onMessage('site:check-discovery', async ({ data }) => {
    const db = await getDb();
    const active = await db.get('sites', data.origin);
    if (!active) return { ok: false, error: 'site-not-enabled' };

    const fetchText = async (
      path: string,
    ): Promise<{ ok: boolean; status: number; text: string }> => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 5_000);
      try {
        const res = await fetch(`${active.origin}${path}`, {
          credentials: active.settings.useCredentials ? 'include' : 'omit',
          signal: controller.signal,
          redirect: 'follow',
        });
        if (!res.ok) {
          void res.body?.cancel().catch(() => {});
          return { ok: false, status: res.status, text: '' };
        }
        const text = (await res.text()).slice(0, 512_000);
        return { ok: true, status: res.status, text };
      } catch {
        return { ok: false, status: 0, text: '' };
      } finally {
        clearTimeout(timer);
      }
    };

    const [robotsRes, sitemapRes] = await Promise.all([
      fetchText('/robots.txt'),
      fetchText('/sitemap.xml'),
    ]);

    const robotsParsed = robotsRes.ok
      ? parseRobotsTxt(robotsRes.text, active.origin)
      : { disallow: [], allow: [], sitemaps: [] };
    const sitemapParsed = sitemapRes.ok
      ? parseSitemapXml(sitemapRes.text, active.origin)
      : { urls: [] };

    const discovery: DiscoveryFilesRecord = {
      origin: active.origin,
      checkedAt: Date.now(),
      robots: { found: robotsRes.ok, status: robotsRes.status, ...robotsParsed },
      sitemap: { found: sitemapRes.ok, status: sitemapRes.status, ...sitemapParsed },
    };

    await db.put('sites', { ...active, discovery });
    notifyDbChanged({ store: 'sites', origin: active.origin });
    return { ok: true, discovery };
  });

  onMessage('site:run-safe-checks', async ({ data }) => {
    const db = await getDb();
    const active = await db.get('sites', data.origin);
    if (!active) return { ok: false, error: 'site-not-enabled' };
    const report = await runSafeVerificationChecks(active.origin);
    await db.put('sites', { ...active, safeChecks: report });
    notifyDbChanged({ store: 'sites', origin: active.origin });
    return { ok: true, report };
  });

  onMessage('runtime:api', async ({ data, sender }) => {
    const pageUrl = sender.tab ? (sender.url ?? sender.tab.url) : data.pageUrl;
    if (!pageUrl) return;
    const db = await getDb();
    const active = siteForUrl(await db.getAll('sites'), pageUrl);
    if (!active) return;
    const event = buildObservedApiEvent({
      origin: active.origin,
      url: data.url,
      method: data.method,
      status: data.status,
      headerNames: data.headerNames,
      requestBody: data.requestBody,
      responseBody: data.responseBody,
    });
    if (!event) return;
    const existing = await db.get('runtimeApi', event.id);
    if (!existing) {
      const count = await db.countFromIndex('runtimeApi', 'by-origin', active.origin);
      if (count >= MAX_OBSERVED_API_EVENTS) return;
    }
    await db.put('runtimeApi', mergeObservedApiEvent(existing, event));
    notifyDbChanged({ store: 'runtimeApi', origin: active.origin });
  });

  onMessage('runtime:dom', async ({ data, sender }) => {
    const pageUrl = sender.tab ? (sender.url ?? sender.tab.url) : data.pageUrl;
    if (!pageUrl) return;
    const db = await getDb();
    const active = siteForUrl(await db.getAll('sites'), pageUrl);
    if (!active || !active.settings.runtimeGuard) return;
    const event = buildRuntimeDomEvent({
      origin: active.origin,
      kind: data.kind,
      detail: data.detail,
      senderOrigin: data.senderOrigin,
      hasListener: data.hasListener,
      rawStack: data.rawStack,
    });
    const existing = await db.get('runtimeDom', event.id);
    if (!existing) {
      const count = await db.countFromIndex('runtimeDom', 'by-origin', active.origin);
      if (count >= 100) return;
    }
    await db.put('runtimeDom', mergeRuntimeDomEvent(existing, event));
    notifyDbChanged({ store: 'runtimeDom', origin: active.origin });
  });

  onMessage('runtime:guard-status', async ({ data, sender }) => {
    const pageUrl = sender.tab ? (sender.url ?? sender.tab.url) : data.pageUrl;
    if (!pageUrl) return { enabled: false };
    const db = await getDb();
    const active = siteForUrl(await db.getAll('sites'), pageUrl);
    return { enabled: Boolean(active?.settings.runtimeGuard) };
  });

  onMessage('rules:save', async ({ data }) => {
    const safety = validateCustomRegex(data.rule.pattern, data.rule.flags);
    if (!safety.safe) return { ok: false, error: safety.reason ?? 'Unsafe regex pattern' };
    const db = await getDb();
    await db.put('customRules', data.rule);
    notifyDbChanged({ store: 'customRules' });
    return { ok: true };
  });

  onMessage('rules:delete', async ({ data }) => {
    const db = await getDb();
    await db.delete('customRules', data.id);
    notifyDbChanged({ store: 'customRules' });
    return { ok: true };
  });

  onMessage('rules:toggle', async ({ data }) => {
    const db = await getDb();
    const existing = await db.get('customRules', data.id);
    if (!existing) return { ok: false };
    await db.put('customRules', { ...existing, enabled: data.enabled });
    notifyDbChanged({ store: 'customRules' });
    return { ok: true };
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
