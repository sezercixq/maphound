import { useSignal } from '@preact/signals';
import { draftEndpointReport, openApiJson } from '@/engine/export';
import {
  ENDPOINT_CATEGORIES,
  type EndpointCategory,
  type HintLevel,
  type ScriptIntel,
} from '@/engine/intel';
import type { ObservedApiEvent } from '@/engine/runtime';
import { sanitizeSegment } from '@/engine/sourcemap/sanitize-path';
import { generateCurlSnippet, generatePythonRequestsSnippet } from '@/engine/verify';
import { endpointsJson, endpointsText } from '@/engine/zip/endpoints-report';
import { saveBlob } from '../export-client';
import { ENDPOINT_CATEGORY_KEYS, HINT_LEVEL_KEYS, ROUTE_KIND_KEYS } from '../format';
import { t } from '../i18n';
import { openCodeViewer } from '../state';
import { Badge, CopyDraftButton, Section } from './primitives';

const CATEGORY_TONES: Record<EndpointCategory, string> = {
  admin: 'bg-red-500/15 text-red-300',
  graphql: 'bg-fuchsia-500/15 text-fuchsia-300',
  auth: 'bg-amber-500/15 text-amber-200',
  api: 'bg-emerald-500/15 text-emerald-300',
  'next-data': 'bg-sky-500/15 text-sky-300',
  websocket: 'bg-violet-500/15 text-violet-300',
  external: 'bg-zinc-800 text-zinc-400',
};

const LEVEL_BADGE: Record<HintLevel, string> = {
  high: 'bg-orange-400/15 text-orange-300',
  medium: 'bg-amber-300/15 text-amber-200',
  low: 'bg-sky-400/15 text-sky-300',
  info: 'bg-zinc-800 text-zinc-400',
};

const PAGE_LIMIT = 80;

function hostSlug(origin: string): string {
  try {
    return sanitizeSegment(new URL(origin).host) || 'site';
  } catch {
    return 'site';
  }
}

function LocationButton({
  file,
  line,
  column,
  kind,
  scriptUrl,
  mapUrl,
  origin,
  label,
}: {
  file: string;
  line: number;
  column: number;
  kind: 'source' | 'bundle';
  scriptUrl: string;
  mapUrl?: string;
  origin: string;
  label: string;
}) {
  const shortName = file.split('/').pop() ?? file;
  if (file === '__NEXT_DATA__') {
    return <span class="truncate font-mono text-[10px] text-zinc-500">__NEXT_DATA__</span>;
  }
  return (
    <button
      type="button"
      title={`${t('openInViewer')}: ${file}:${line}`}
      onClick={() =>
        openCodeViewer({
          origin,
          file,
          line,
          column,
          kind,
          scriptUrl,
          mapUrl,
          label,
        })
      }
      class="min-w-0 truncate text-left font-mono text-[10px] text-zinc-500 hover:text-emerald-300 hover:underline"
    >
      {shortName}:{line}
    </button>
  );
}

export function EndpointsView({
  intel,
  runtimeApi = [],
  origin,
}: {
  intel: ScriptIntel;
  runtimeApi?: readonly ObservedApiEvent[];
  origin: string;
}) {
  const activeCategory = useSignal<EndpointCategory | 'all'>('all');
  const copiedAll = useSignal(false);
  const copiedItem = useSignal<string | null>(null);
  const endpointLimit = useSignal(PAGE_LIMIT);
  const routeLimit = useSignal(PAGE_LIMIT);

  const presentCategories = ENDPOINT_CATEGORIES.filter((cat) =>
    intel.endpoints.some((ep) => ep.category === cat),
  );
  const filteredEndpoints =
    activeCategory.value === 'all'
      ? intel.endpoints
      : intel.endpoints.filter((ep) => ep.category === activeCategory.value);

  const visibleEndpoints = filteredEndpoints.slice(0, endpointLimit.value);
  const visibleRoutes = intel.routes.slice(0, routeLimit.value);

  const copyText = async (value: string, key: string) => {
    try {
      await navigator.clipboard.writeText(value);
      if (key === '__all__') {
        copiedAll.value = true;
        setTimeout(() => {
          copiedAll.value = false;
        }, 1500);
      } else {
        copiedItem.value = key;
        setTimeout(() => {
          if (copiedItem.value === key) copiedItem.value = null;
        }, 1500);
      }
    } catch {
      // Clipboard may require focus.
    }
  };

  const downloadTxt = () => {
    saveBlob(
      new Blob([endpointsText(intel)], { type: 'text/plain;charset=utf-8' }),
      `maphound-${hostSlug(origin)}-endpoints.txt`,
    );
  };

  const downloadJson = () => {
    saveBlob(
      new Blob([endpointsJson(intel, origin)], { type: 'application/json;charset=utf-8' }),
      `maphound-${hostSlug(origin)}-endpoints.json`,
    );
  };

  const downloadOpenApi = () => {
    saveBlob(
      new Blob([openApiJson({ origin, endpoints: intel.endpoints, observedApi: runtimeApi })], {
        type: 'application/json;charset=utf-8',
      }),
      `maphound-${hostSlug(origin)}-openapi.json`,
    );
  };

  const hasAny = intel.endpoints.length > 0 || intel.routes.length > 0 || intel.comments.length > 0;

  return (
    <div class="space-y-4">
      <div class="flex flex-wrap items-center gap-1.5">
        <button
          type="button"
          data-testid="endpoints-copy-all"
          disabled={!hasAny}
          onClick={() => void copyText(endpointsText(intel), '__all__')}
          class="rounded border border-white/[0.08] bg-white/[0.03] px-2.5 py-1 text-[11px] font-medium text-zinc-200 hover:bg-white/[0.07] disabled:cursor-not-allowed disabled:opacity-40"
        >
          {copiedAll.value ? t('copied') : t('endpointsCopyAll')}
        </button>
        <button
          type="button"
          data-testid="endpoints-export-txt"
          disabled={!hasAny}
          onClick={downloadTxt}
          class="rounded border border-white/[0.08] bg-white/[0.03] px-2.5 py-1 font-mono text-[11px] text-zinc-300 hover:bg-white/[0.07] disabled:cursor-not-allowed disabled:opacity-40"
        >
          {t('endpointsExportTxt')}
        </button>
        <button
          type="button"
          data-testid="endpoints-export-json"
          disabled={!hasAny}
          onClick={downloadJson}
          class="rounded border border-white/[0.08] bg-white/[0.03] px-2.5 py-1 font-mono text-[11px] text-zinc-300 hover:bg-white/[0.07] disabled:cursor-not-allowed disabled:opacity-40"
        >
          {t('endpointsExportJson')}
        </button>
        <button
          type="button"
          data-testid="endpoints-export-openapi"
          disabled={intel.endpoints.length === 0}
          onClick={downloadOpenApi}
          class="rounded border border-emerald-500/30 bg-emerald-500/10 px-2.5 py-1 font-mono text-[11px] text-emerald-300 hover:bg-emerald-500/20 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {t('endpointsExportOpenApi')}
        </button>
        <button
          type="button"
          data-testid="endpoints-copy-openapi"
          disabled={intel.endpoints.length === 0}
          onClick={() =>
            void copyText(
              openApiJson({ origin, endpoints: intel.endpoints, observedApi: runtimeApi }),
              '__openapi__',
            )
          }
          class="rounded border border-white/[0.08] bg-white/[0.03] px-2 py-1 text-[11px] text-zinc-300 hover:bg-white/[0.07] disabled:cursor-not-allowed disabled:opacity-40"
        >
          {copiedItem.value === '__openapi__' ? t('copied') : t('endpointsCopyOpenApi')}
        </button>
      </div>

      {!hasAny && <p class="px-1 text-[12px] text-zinc-500">{t('endpointsEmpty')}</p>}

      {intel.endpoints.length > 0 && (
        <Section title={t('endpointsSectionApi')} count={filteredEndpoints.length}>
          {presentCategories.length > 1 && (
            <div class="flex flex-wrap gap-1 px-0.5">
              <button
                type="button"
                onClick={() => {
                  activeCategory.value = 'all';
                }}
                class={`rounded px-2 py-0.5 text-[10px] font-medium ${
                  activeCategory.value === 'all'
                    ? 'bg-emerald-500/20 text-emerald-300'
                    : 'bg-zinc-900 text-zinc-400 hover:text-zinc-200'
                }`}
              >
                {t('filterAll')} ({intel.endpoints.length})
              </button>
              {presentCategories.map((cat) => (
                <button
                  key={cat}
                  type="button"
                  onClick={() => {
                    activeCategory.value = cat;
                  }}
                  class={`rounded px-2 py-0.5 text-[10px] font-medium ${
                    activeCategory.value === cat
                      ? 'bg-emerald-500/20 text-emerald-300'
                      : 'bg-zinc-900 text-zinc-400 hover:text-zinc-200'
                  }`}
                >
                  {t(ENDPOINT_CATEGORY_KEYS[cat])}
                </button>
              ))}
            </div>
          )}
          <div class="overflow-hidden rounded-lg border border-white/[0.06]">
            <ul class="divide-y divide-white/[0.04]" data-testid="endpoint-list">
              {visibleEndpoints.map((ep) => {
                const loc = ep.locations[0];
                const isCopied = copiedItem.value === `ep:${ep.value}`;
                return (
                  <li
                    key={ep.value}
                    data-testid="endpoint-row"
                    data-category={ep.category}
                    class="space-y-1 px-2.5 py-2"
                  >
                    <div class="flex items-center gap-1.5">
                      <span
                        class={`shrink-0 rounded px-1.5 py-px text-[10px] font-semibold ${CATEGORY_TONES[ep.category]}`}
                      >
                        {t(ENDPOINT_CATEGORY_KEYS[ep.category])}
                      </span>
                      {ep.liveObserved && <Badge tone="ok">{t('endpointsLiveObserved')}</Badge>}
                      {ep.methods.map((method) => (
                        <span
                          key={method}
                          class="shrink-0 rounded bg-zinc-800 px-1 py-px font-mono text-[9px] font-semibold text-zinc-300"
                        >
                          {method}
                        </span>
                      ))}
                      <div class="flex-1" />
                      <CopyDraftButton
                        testId="endpoint-draft"
                        buildDraft={() => draftEndpointReport(ep, origin)}
                      />
                      <button
                        type="button"
                        data-testid="endpoint-curl"
                        onClick={() =>
                          void copyText(generateCurlSnippet(ep, origin), `curl:${ep.value}`)
                        }
                        class="shrink-0 rounded px-1.5 py-0.5 font-mono text-[10px] text-zinc-400 hover:bg-white/[0.06] hover:text-zinc-200"
                      >
                        {copiedItem.value === `curl:${ep.value}` ? t('copied') : 'cURL'}
                      </button>
                      <button
                        type="button"
                        data-testid="endpoint-python"
                        onClick={() =>
                          void copyText(generatePythonRequestsSnippet(ep, origin), `py:${ep.value}`)
                        }
                        class="shrink-0 rounded px-1.5 py-0.5 font-mono text-[10px] text-zinc-400 hover:bg-white/[0.06] hover:text-zinc-200"
                      >
                        {copiedItem.value === `py:${ep.value}` ? t('copied') : 'Py'}
                      </button>
                      <button
                        type="button"
                        data-testid="endpoint-copy"
                        title={t('copyEndpoint')}
                        onClick={() => void copyText(ep.value, `ep:${ep.value}`)}
                        class="rounded px-1.5 py-0.5 text-[10px] text-zinc-500 hover:bg-white/[0.06] hover:text-zinc-200"
                      >
                        {isCopied ? t('copied') : t('copyEndpoint')}
                      </button>
                    </div>
                    <p class="truncate font-mono text-[11px] text-zinc-100" title={ep.value}>
                      {ep.value}
                    </p>
                    {loc && (
                      <div class="flex items-center gap-1.5">
                        <LocationButton
                          file={loc.file}
                          line={loc.line}
                          column={loc.column}
                          kind={loc.kind}
                          scriptUrl={loc.scriptUrl}
                          mapUrl={loc.mapUrl}
                          origin={origin}
                          label={ep.value}
                        />
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
            {filteredEndpoints.length > visibleEndpoints.length && (
              <button
                type="button"
                class="w-full border-t border-white/[0.04] py-1.5 text-[12px] text-zinc-500 hover:text-zinc-300"
                onClick={() => {
                  endpointLimit.value += PAGE_LIMIT * 2;
                }}
              >
                {t('showMore', filteredEndpoints.length - visibleEndpoints.length)}
              </button>
            )}
          </div>
        </Section>
      )}

      {intel.routes.length > 0 && (
        <Section title={t('endpointsSectionRoutes')} count={intel.routes.length}>
          <div class="overflow-hidden rounded-lg border border-white/[0.06]">
            <ul class="divide-y divide-white/[0.04]" data-testid="route-list">
              {visibleRoutes.map((route) => {
                const loc = route.locations[0];
                return (
                  <li
                    key={route.path}
                    data-testid="route-row"
                    class="flex items-center gap-2 px-2.5 py-1.5"
                  >
                    <Badge tone="neutral">{t(ROUTE_KIND_KEYS[route.kind])}</Badge>
                    <p
                      class="min-w-0 flex-1 truncate font-mono text-[11px] text-zinc-100"
                      title={route.path}
                    >
                      {route.path}
                    </p>
                    {loc && (
                      <LocationButton
                        file={loc.file}
                        line={loc.line}
                        column={loc.column}
                        kind={loc.kind}
                        scriptUrl={loc.scriptUrl}
                        mapUrl={loc.mapUrl}
                        origin={origin}
                        label={route.path}
                      />
                    )}
                  </li>
                );
              })}
            </ul>
            {intel.routes.length > visibleRoutes.length && (
              <button
                type="button"
                class="w-full border-t border-white/[0.04] py-1.5 text-[12px] text-zinc-500 hover:text-zinc-300"
                onClick={() => {
                  routeLimit.value += PAGE_LIMIT * 2;
                }}
              >
                {t('showMore', intel.routes.length - visibleRoutes.length)}
              </button>
            )}
          </div>
        </Section>
      )}

      <Section title={t('endpointsSectionComments')} count={intel.comments.length}>
        {intel.comments.length === 0 ? (
          <p class="px-1 text-[12px] text-zinc-600">{t('endpointsNoNotes')}</p>
        ) : (
          <div class="overflow-hidden rounded-lg border border-white/[0.06]">
            <ul class="divide-y divide-white/[0.04]" data-testid="comment-list">
              {intel.comments.map((comment) => (
                <li
                  key={`${comment.location.file}:${comment.location.line}:${comment.marker}`}
                  data-testid="comment-row"
                  class="space-y-1 px-2.5 py-2"
                >
                  <div class="flex items-center gap-1.5">
                    <span
                      class={`rounded px-1.5 py-px font-mono text-[10px] font-semibold ${LEVEL_BADGE[comment.level]}`}
                    >
                      {comment.marker}
                    </span>
                    <span class="text-[10px] text-zinc-500">
                      {t(HINT_LEVEL_KEYS[comment.level])}
                    </span>
                    <div class="flex-1" />
                    <LocationButton
                      file={comment.location.file}
                      line={comment.location.line}
                      column={comment.location.column}
                      kind={comment.location.kind}
                      scriptUrl={comment.location.scriptUrl}
                      mapUrl={comment.location.mapUrl}
                      origin={origin}
                      label={comment.marker}
                    />
                  </div>
                  <p class="text-[11px] leading-4 text-zinc-300">{comment.text}</p>
                </li>
              ))}
            </ul>
          </div>
        )}
      </Section>
    </div>
  );
}
