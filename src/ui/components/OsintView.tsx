import { useSignal } from '@preact/signals';
import { checkDiscoveryFilesFromUi } from '@/core/site-client';
import type { DiscoveryFilesRecord } from '@/engine/audit';
import {
  buildOsintLinks,
  OSINT_CATEGORIES,
  type OsintCategory,
  type OsintHit,
  type OsintLinkId,
} from '@/engine/intel';
import { type MessageKey, t } from '../i18n';
import { openCodeViewer, refresh } from '../state';
import { Badge, Section } from './primitives';

const CATEGORY_KEYS: Record<OsintCategory, MessageKey> = {
  cloud: 'osintCatCloud',
  subdomain: 'osintCatSubdomain',
  'internal-ip': 'osintCatInternalIp',
  'build-path': 'osintCatBuildPath',
  attribution: 'osintCatAttribution',
  telemetry: 'osintCatTelemetry',
};

const CATEGORY_TONES: Record<OsintCategory, string> = {
  cloud: 'bg-sky-500/15 text-sky-300',
  subdomain: 'bg-emerald-500/15 text-emerald-300',
  'internal-ip': 'bg-red-500/15 text-red-300',
  'build-path': 'bg-amber-500/15 text-amber-200',
  attribution: 'bg-violet-500/15 text-violet-300',
  telemetry: 'bg-zinc-800 text-zinc-300',
};

const LINK_LABELS: Record<OsintLinkId, MessageKey> = {
  crtsh: 'osintLinkCrtsh',
  wayback: 'osintLinkWayback',
  urlscan: 'osintLinkUrlscan',
  'dork-config': 'osintDorkConfig',
  'dork-api': 'osintDorkApi',
  'dork-auth': 'osintDorkAuth',
  'dork-docs': 'osintDorkDocs',
};

function OsintLauncher({ origin }: { origin: string }) {
  const { domain, links } = buildOsintLinks(origin);
  const reconLinks = links.filter((l) => l.group === 'recon');
  const dorkLinks = links.filter((l) => l.group === 'dorks');

  return (
    <Section title={t('osintLauncherTitle')}>
      <div
        data-testid="osint-launcher"
        class="space-y-3 rounded-lg border border-white/[0.06] bg-white/[0.02] p-2.5"
      >
        <p class="text-[11px] leading-relaxed text-zinc-400">{t('osintLauncherPrivacy')}</p>
        {!domain ? (
          <p class="text-[11px] text-zinc-500" data-testid="osint-domain-unavailable">
            {t('osintDomainUnavailable')}
          </p>
        ) : (
          <>
            <div class="space-y-1.5">
              <p class="text-[10px] font-medium tracking-wider text-zinc-500 uppercase">
                {t('osintReconHeading')}
              </p>
              <div class="flex flex-wrap gap-1.5">
                {reconLinks.map((link) => (
                  <a
                    key={link.id}
                    href={link.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    data-testid={`osint-link-${link.id}`}
                    class="inline-flex items-center gap-1 rounded-md border border-white/[0.08] bg-white/[0.03] px-2 py-1 text-[11px] font-medium text-emerald-300 transition-colors hover:border-emerald-500/40 hover:bg-emerald-500/10"
                  >
                    <span>{t(LINK_LABELS[link.id])}</span>
                    <span aria-hidden="true" class="text-[10px] text-zinc-500">
                      ↗
                    </span>
                  </a>
                ))}
              </div>
            </div>
            <div class="space-y-1.5">
              <p class="text-[10px] font-medium tracking-wider text-zinc-500 uppercase">
                {t('osintDorksHeading')}
              </p>
              <div class="grid grid-cols-1 gap-1.5">
                {dorkLinks.map((link) => (
                  <a
                    key={link.id}
                    href={link.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    title={link.queryPreview}
                    data-testid={`osint-link-${link.id}`}
                    class="flex items-center justify-between gap-2 rounded-md border border-white/[0.06] bg-black/20 px-2.5 py-1.5 text-left transition-colors hover:border-emerald-500/30 hover:bg-emerald-500/10"
                  >
                    <span class="min-w-0">
                      <span class="block text-[11px] font-medium text-zinc-200">
                        {t(LINK_LABELS[link.id])}
                      </span>
                      {link.queryPreview && (
                        <span class="block truncate font-mono text-[10px] text-zinc-500">
                          {link.queryPreview}
                        </span>
                      )}
                    </span>
                    <span aria-hidden="true" class="shrink-0 text-[10px] text-zinc-500">
                      ↗
                    </span>
                  </a>
                ))}
              </div>
            </div>
          </>
        )}
      </div>
    </Section>
  );
}

function DiscoveryFilesSection({
  origin,
  discovery,
}: {
  origin: string;
  discovery?: DiscoveryFilesRecord;
}) {
  const busy = useSignal(false);
  const runCheck = async () => {
    busy.value = true;
    try {
      await checkDiscoveryFilesFromUi(origin);
      await refresh();
    } finally {
      busy.value = false;
    }
  };

  const hasEntries =
    discovery &&
    (discovery.robots.disallow.length > 0 ||
      discovery.robots.allow.length > 0 ||
      discovery.robots.sitemaps.length > 0 ||
      discovery.sitemap.urls.length > 0);

  return (
    <Section title={t('discoveryTitle')}>
      <div
        data-testid="discovery-section"
        class="space-y-2.5 rounded-lg border border-white/[0.06] bg-white/[0.02] p-2.5"
      >
        <p class="text-[11px] leading-relaxed text-zinc-400">{t('discoveryHint')}</p>
        <button
          type="button"
          data-testid="check-discovery-btn"
          disabled={busy.value}
          onClick={() => void runCheck()}
          class="w-full rounded-md border border-emerald-500/30 bg-emerald-500/10 px-2.5 py-1.5 text-[11px] font-medium text-emerald-300 transition-colors hover:bg-emerald-500/20 disabled:opacity-50"
        >
          {busy.value ? t('discoveryChecking') : t('discoveryCheckBtn')}
        </button>

        {discovery && !hasEntries && (
          <p class="text-[11px] text-zinc-500" data-testid="discovery-empty">
            {t('discoveryNoneFound')}
          </p>
        )}

        {discovery && hasEntries && (
          <div class="space-y-2.5 pt-1">
            {discovery.robots.disallow.length > 0 && (
              <div class="space-y-1" data-testid="discovery-disallow">
                <p class="text-[10px] font-medium tracking-wider text-zinc-500 uppercase">
                  {t('discoveryDisallowHeading')} ({discovery.robots.disallow.length})
                </p>
                <ul class="max-h-36 space-y-0.5 overflow-auto rounded border border-white/[0.05] bg-black/20 p-1.5 font-mono text-[10.5px]">
                  {discovery.robots.disallow.slice(0, 60).map((path) => (
                    <li key={path} class="truncate">
                      {path.startsWith('/') ? (
                        <a
                          href={`${origin}${path}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          class="text-amber-200 hover:underline"
                        >
                          {path}
                        </a>
                      ) : (
                        <span class="text-zinc-300">{path}</span>
                      )}
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {discovery.robots.allow.length > 0 && (
              <div class="space-y-1" data-testid="discovery-allow">
                <p class="text-[10px] font-medium tracking-wider text-zinc-500 uppercase">
                  {t('discoveryAllowHeading')} ({discovery.robots.allow.length})
                </p>
                <ul class="max-h-28 space-y-0.5 overflow-auto rounded border border-white/[0.05] bg-black/20 p-1.5 font-mono text-[10.5px]">
                  {discovery.robots.allow.slice(0, 40).map((path) => (
                    <li key={path} class="truncate">
                      {path.startsWith('/') ? (
                        <a
                          href={`${origin}${path}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          class="text-emerald-300 hover:underline"
                        >
                          {path}
                        </a>
                      ) : (
                        <span class="text-zinc-300">{path}</span>
                      )}
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {discovery.robots.sitemaps.length > 0 && (
              <div class="space-y-1" data-testid="discovery-sitemaps">
                <p class="text-[10px] font-medium tracking-wider text-zinc-500 uppercase">
                  {t('discoverySitemapsHeading')} ({discovery.robots.sitemaps.length})
                </p>
                <ul class="space-y-0.5 font-mono text-[10.5px]">
                  {discovery.robots.sitemaps.map((url) => (
                    <li key={url} class="truncate">
                      <a
                        href={url}
                        target="_blank"
                        rel="noopener noreferrer"
                        class="text-sky-300 hover:underline"
                      >
                        {url}
                      </a>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {discovery.sitemap.urls.length > 0 && (
              <div class="space-y-1" data-testid="discovery-sitemap-urls">
                <p class="text-[10px] font-medium tracking-wider text-zinc-500 uppercase">
                  {t('discoverySitemapUrlsHeading')} ({discovery.sitemap.urls.length})
                </p>
                <ul class="max-h-36 space-y-0.5 overflow-auto rounded border border-white/[0.05] bg-black/20 p-1.5 font-mono text-[10.5px]">
                  {discovery.sitemap.urls.slice(0, 60).map((url) => (
                    <li key={url} class="truncate">
                      <a
                        href={url}
                        target="_blank"
                        rel="noopener noreferrer"
                        class="text-zinc-300 hover:text-emerald-300 hover:underline"
                      >
                        {url}
                      </a>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}
      </div>
    </Section>
  );
}

export function OsintView({
  hits,
  discovery,
  origin,
}: {
  hits: readonly OsintHit[];
  discovery?: DiscoveryFilesRecord;
  origin: string;
}) {
  const activeCategory = useSignal<OsintCategory | 'all'>('all');
  const copiedKey = useSignal<string | null>(null);

  const presentCategories = OSINT_CATEGORIES.filter((cat) => hits.some((h) => h.category === cat));
  const filtered =
    activeCategory.value === 'all' ? hits : hits.filter((h) => h.category === activeCategory.value);

  const copyValue = async (value: string, key: string) => {
    try {
      await navigator.clipboard.writeText(value);
      copiedKey.value = key;
      setTimeout(() => {
        if (copiedKey.value === key) copiedKey.value = null;
      }, 1500);
    } catch {
      // ignore clipboard errors
    }
  };

  return (
    <div class="space-y-4">
      <Section title={t('osintOfflineTitle')} count={hits.length}>
        {presentCategories.length > 0 && (
          <div class="flex flex-wrap gap-1" data-testid="osint-filters">
            <button
              type="button"
              onClick={() => {
                activeCategory.value = 'all';
              }}
              class={`rounded px-2 py-0.5 text-[10px] font-medium transition-colors ${
                activeCategory.value === 'all'
                  ? 'bg-emerald-500/20 text-emerald-300'
                  : 'bg-white/[0.04] text-zinc-400 hover:text-zinc-200'
              }`}
            >
              {t('osintFilterAll', hits.length)}
            </button>
            {presentCategories.map((cat) => (
              <button
                key={cat}
                type="button"
                onClick={() => {
                  activeCategory.value = cat;
                }}
                class={`rounded px-2 py-0.5 text-[10px] font-medium transition-colors ${
                  activeCategory.value === cat
                    ? 'bg-emerald-500/20 text-emerald-300'
                    : 'bg-white/[0.04] text-zinc-400 hover:text-zinc-200'
                }`}
              >
                {t(CATEGORY_KEYS[cat])}
              </button>
            ))}
          </div>
        )}
        {filtered.length === 0 ? (
          <p
            data-testid="osint-empty"
            class="rounded-lg border border-white/[0.06] bg-white/[0.02] px-3 py-4 text-center text-[12px] text-zinc-500"
          >
            {t('osintEmpty')}
          </p>
        ) : (
          <ul
            data-testid="osint-list"
            class="divide-y divide-white/[0.05] overflow-hidden rounded-lg border border-white/[0.06] bg-white/[0.02]"
          >
            {filtered.map((hit) => {
              const key = `${hit.category}:${hit.kind}:${hit.value}`;
              const loc = hit.locations[0];
              const canOpen = loc && loc.file !== 'sourcemap.sources';
              const shortFile = loc ? (loc.file.split('/').pop() ?? loc.file) : '';
              return (
                <li key={key} data-testid="osint-item" class="space-y-1 px-2.5 py-2">
                  <div class="flex items-start justify-between gap-2">
                    <div class="min-w-0 space-y-1">
                      <div class="flex flex-wrap items-center gap-1.5">
                        <span
                          class={`rounded px-1.5 py-0.5 text-[9px] font-semibold uppercase ${CATEGORY_TONES[hit.category]}`}
                        >
                          {hit.kind}
                        </span>
                        {hit.detail && <Badge tone="neutral">{hit.detail}</Badge>}
                      </div>
                      <p class="font-mono text-[11px] break-all text-zinc-100">{hit.value}</p>
                    </div>
                    <button
                      type="button"
                      onClick={() => void copyValue(hit.value, key)}
                      class="shrink-0 rounded px-1.5 py-0.5 text-[10px] text-zinc-400 transition-colors hover:bg-white/[0.06] hover:text-zinc-200"
                    >
                      {copiedKey.value === key ? t('osintCopiedValue') : t('osintCopyValue')}
                    </button>
                  </div>
                  {loc && (
                    <div class="flex items-center gap-2 text-[10px] text-zinc-500">
                      {canOpen ? (
                        <button
                          type="button"
                          onClick={() =>
                            openCodeViewer({
                              origin,
                              file: loc.file,
                              line: loc.line,
                              column: loc.column,
                              kind: loc.kind,
                              scriptUrl: loc.scriptUrl,
                              mapUrl: loc.mapUrl,
                              label: hit.kind,
                            })
                          }
                          class="truncate font-mono hover:text-emerald-300 hover:underline"
                        >
                          {shortFile}:{loc.line}
                        </button>
                      ) : (
                        <span class="truncate font-mono">{loc.file}</span>
                      )}
                      {hit.locations.length > 1 && (
                        <span class="shrink-0 font-mono text-zinc-600">
                          +{hit.locations.length - 1}
                        </span>
                      )}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </Section>
      <DiscoveryFilesSection origin={origin} discovery={discovery} />
      <OsintLauncher origin={origin} />
    </div>
  );
}
