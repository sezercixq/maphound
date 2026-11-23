import { useSignal } from '@preact/signals';
import type { PageIntelRecord } from '@/core/db';
import { draftSinkReport } from '@/engine/export';
import type { HintLevel, SinkCategory, SinkHit } from '@/engine/intel';
import { formatBytes, HINT_LEVEL_KEYS, NEXT_DATA_REASON_KEYS, SINK_CATEGORY_KEYS } from '../format';
import { t } from '../i18n';
import { openCodeViewer } from '../state';
import { Badge, CopyDraftButton, Section } from './primitives';

const SINK_CATEGORIES: readonly SinkCategory[] = [
  'dom-xss',
  'code-injection',
  'messaging',
  'redirect',
  'framework',
];

const SINK_LEVELS: readonly HintLevel[] = ['high', 'medium', 'low', 'info'];

const LEVEL_STYLE: Record<HintLevel, { bar: string; badge: string }> = {
  high: { bar: 'bg-orange-400', badge: 'bg-orange-400/15 text-orange-300' },
  medium: { bar: 'bg-amber-300', badge: 'bg-amber-300/15 text-amber-200' },
  low: { bar: 'bg-sky-400', badge: 'bg-sky-400/15 text-sky-300' },
  info: { bar: 'bg-zinc-600', badge: 'bg-zinc-800 text-zinc-400' },
};

const PAGE_LIMIT = 80;

function NextDataCard({ page }: { page: PageIntelRecord }) {
  const showOutline = useSignal(false);
  const nd = page.nextData;
  let pathLabel = page.pageUrl;
  try {
    pathLabel = new URL(page.pageUrl).pathname || '/';
  } catch {
    // keep raw
  }

  return (
    <div
      data-testid="next-data-card"
      class="space-y-2 rounded-lg border border-white/[0.06] bg-white/[0.02] p-2.5"
    >
      <div class="flex flex-wrap items-center gap-1.5">
        <p class="min-w-0 flex-1 truncate font-mono text-[12px] font-medium text-zinc-100">
          {nd.page ?? pathLabel}
        </p>
        {nd.buildId && <Badge tone="neutral">{t('nextDataBuild', nd.buildId)}</Badge>}
        <span class="font-mono text-[10px] text-zinc-500">{formatBytes(nd.bytes)}</span>
      </div>

      {nd.dataFetching.length > 0 && (
        <div class="flex flex-wrap gap-1">
          {nd.dataFetching.map((mode) => (
            <Badge key={mode} tone="warn">
              {mode}
            </Badge>
          ))}
        </div>
      )}

      {nd.pageProps.length > 0 && (
        <div class="space-y-1">
          <p class="text-[10px] tracking-wide text-zinc-500 uppercase">{t('nextDataPageProps')}</p>
          <div class="flex flex-wrap gap-1">
            {nd.pageProps.slice(0, 16).map((prop) => (
              <span
                key={prop}
                class="rounded bg-zinc-900 px-1.5 py-px font-mono text-[10px] text-zinc-300"
              >
                {prop}
              </span>
            ))}
          </div>
        </div>
      )}

      {nd.sensitive.length > 0 && (
        <div class="space-y-1">
          <p class="text-[10px] font-semibold tracking-wide text-amber-300 uppercase">
            {t('nextDataSensitive', nd.sensitive.length)}
          </p>
          <ul class="divide-y divide-white/[0.04] rounded border border-amber-500/20 bg-black/25">
            {nd.sensitive.map((item) => (
              <li
                key={item.path}
                data-testid="next-data-sensitive"
                class="flex items-center gap-1.5 px-2 py-1 text-[11px]"
              >
                <Badge tone={item.reason === 'credential' ? 'error' : 'warn'}>
                  {t(
                    NEXT_DATA_REASON_KEYS[item.reason as 'credential' | 'privilege' | 'pii'] ??
                      'nextDataReasonPrivilege',
                  )}
                </Badge>
                <span class="min-w-0 flex-1 truncate font-mono text-zinc-200" title={item.path}>
                  {item.path}
                </span>
                {item.preview && (
                  <code class="shrink-0 font-mono text-[10px] text-zinc-400">{item.preview}</code>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      {nd.outline.length > 0 && (
        <div>
          <button
            type="button"
            class="text-[11px] text-zinc-400 hover:text-zinc-200"
            onClick={() => {
              showOutline.value = !showOutline.value;
            }}
          >
            {showOutline.value ? t('nextDataHideOutline') : t('nextDataOutline', nd.outline.length)}
          </button>
          {showOutline.value && (
            <ul class="mt-1.5 max-h-48 space-y-0.5 overflow-auto rounded border border-white/[0.05] bg-black/30 p-2 font-mono text-[10px] text-zinc-400">
              {nd.outline.map((entry) => (
                <li key={entry.path} class="flex justify-between gap-2">
                  <span class="truncate text-zinc-300">{entry.path}</span>
                  <span class="shrink-0 text-zinc-500">{entry.type}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

export function CodeHintsView({
  sinks,
  pages,
  origin,
}: {
  sinks: SinkHit[];
  pages: PageIntelRecord[];
  origin: string;
}) {
  const activeCategory = useSignal<SinkCategory | 'all'>('all');
  const activeLevel = useSignal<HintLevel | 'all'>('all');
  const limit = useSignal(PAGE_LIMIT);

  const presentCategories = SINK_CATEGORIES.filter((cat) =>
    sinks.some((sink) => sink.category === cat),
  );
  const presentLevels = SINK_LEVELS.filter((lvl) => sinks.some((sink) => sink.level === lvl));
  const filtered = sinks.filter(
    (sink) =>
      (activeCategory.value === 'all' || sink.category === activeCategory.value) &&
      (activeLevel.value === 'all' || sink.level === activeLevel.value),
  );
  const visible = filtered.slice(0, limit.value);

  return (
    <div class="space-y-4">
      <p class="rounded-md border border-white/[0.06] bg-white/[0.02] px-2.5 py-2 text-[11px] leading-4 text-zinc-400">
        {t('hintsNotice')}
      </p>

      {pages.length > 0 && (
        <Section title={t('nextDataSection')} count={pages.length}>
          <div class="space-y-2">
            {pages.map((page) => (
              <NextDataCard key={page.id} page={page} />
            ))}
          </div>
        </Section>
      )}

      <Section title={t('hintsSectionSinks')} count={filtered.length}>
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
              {t('filterAll')} ({sinks.length})
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
                {t(SINK_CATEGORY_KEYS[cat])}
              </button>
            ))}
          </div>
        )}
        {presentLevels.length > 1 && (
          <div class="flex flex-wrap gap-1 px-0.5">
            <button
              type="button"
              onClick={() => {
                activeLevel.value = 'all';
              }}
              class={`rounded px-2 py-0.5 text-[10px] font-medium ${
                activeLevel.value === 'all'
                  ? 'bg-emerald-500/20 text-emerald-300'
                  : 'bg-zinc-900 text-zinc-400 hover:text-zinc-200'
              }`}
            >
              {t('filterAll')}
            </button>
            {presentLevels.map((lvl) => (
              <button
                key={lvl}
                type="button"
                onClick={() => {
                  activeLevel.value = lvl;
                }}
                class={`rounded px-2 py-0.5 text-[10px] font-medium uppercase ${
                  activeLevel.value === lvl
                    ? 'bg-emerald-500/20 text-emerald-300'
                    : 'bg-zinc-900 text-zinc-400 hover:text-zinc-200'
                }`}
              >
                {t(HINT_LEVEL_KEYS[lvl])}
              </button>
            ))}
          </div>
        )}

        {filtered.length === 0 ? (
          <p class="px-1 text-[12px] text-zinc-500">{t('hintsEmpty')}</p>
        ) : (
          <div class="overflow-hidden rounded-lg border border-white/[0.06]">
            <ul class="divide-y divide-white/[0.04]" data-testid="sink-list">
              {visible.map((sink) => {
                const fileName = sink.location.file.split('/').pop() ?? sink.location.file;
                return (
                  <li
                    key={`${sink.ruleId}:${sink.location.file}:${sink.location.line}`}
                    data-testid="sink-row"
                    data-level={sink.level}
                    data-category={sink.category}
                    class="relative space-y-1 py-2 pr-2.5 pl-3"
                  >
                    <span
                      class={`absolute inset-y-2 left-0 w-0.5 rounded-full ${LEVEL_STYLE[sink.level].bar}`}
                    />
                    <div class="flex items-center gap-1.5">
                      <span
                        class={`shrink-0 rounded px-1.5 py-px text-[10px] font-semibold uppercase ${LEVEL_STYLE[sink.level].badge}`}
                      >
                        {t(HINT_LEVEL_KEYS[sink.level])}
                      </span>
                      <Badge tone="neutral">{t(SINK_CATEGORY_KEYS[sink.category])}</Badge>
                      <p class="min-w-0 flex-1 truncate text-[12px] font-medium text-zinc-100">
                        {sink.title}
                      </p>
                      <CopyDraftButton
                        testId="sink-draft"
                        buildDraft={() => draftSinkReport(sink, origin)}
                      />
                    </div>
                    <button
                      type="button"
                      data-testid="sink-location"
                      title={`${t('openInViewer')}: ${sink.location.file}:${sink.location.line}`}
                      onClick={() =>
                        openCodeViewer({
                          origin,
                          file: sink.location.file,
                          line: sink.location.line,
                          column: sink.location.column,
                          kind: sink.location.kind,
                          scriptUrl: sink.location.scriptUrl,
                          mapUrl: sink.location.mapUrl,
                          label: sink.title,
                        })
                      }
                      class="block w-full truncate text-left font-mono text-[11px] text-zinc-400 hover:text-emerald-300"
                    >
                      <span class="text-zinc-200">{fileName}</span>:{sink.location.line}
                      <span class="text-zinc-600"> · {sink.location.file}</span>
                    </button>
                    <pre class="overflow-hidden truncate rounded bg-black/30 px-2 py-1 font-mono text-[10px] text-zinc-300">
                      {sink.snippet}
                    </pre>
                  </li>
                );
              })}
            </ul>
            {filtered.length > visible.length && (
              <button
                type="button"
                class="w-full border-t border-white/[0.04] py-1.5 text-[12px] text-zinc-500 hover:text-zinc-300"
                onClick={() => {
                  limit.value += PAGE_LIMIT * 2;
                }}
              >
                {t('showMore', filtered.length - visible.length)}
              </button>
            )}
          </div>
        )}
      </Section>
    </div>
  );
}
