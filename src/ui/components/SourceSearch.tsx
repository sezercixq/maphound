import { useSignal } from '@preact/signals';
import { useEffect, useRef } from 'preact/hooks';
import {
  DEFAULT_MAX_SEARCH_RESULTS,
  type SearchMatch,
  type SearchResult,
} from '@/engine/search/source-search';
import { t } from '../i18n';
import { searchSources } from '../search-client';
import { openCodeViewer } from '../state';
import { Badge } from './primitives';

function renderHighlightedExcerpt(match: SearchMatch) {
  const { lineText, previewStart, previewLength } = match;
  if (previewLength <= 0 || previewStart < 0 || previewStart >= lineText.length) {
    return lineText;
  }
  const end = Math.min(lineText.length, previewStart + previewLength);
  return (
    <>
      {lineText.slice(0, previewStart)}
      <mark class="rounded bg-emerald-400/25 px-0.5 text-emerald-200">
        {lineText.slice(previewStart, end)}
      </mark>
      {lineText.slice(end)}
    </>
  );
}

export function SourceSearchView({ origin, hasMaps }: { origin: string; hasMaps: boolean }) {
  const query = useSignal('');
  const useRegex = useSignal(false);
  const caseSensitive = useSignal(false);
  const includeVendor = useSignal(false);
  const busy = useSignal(false);
  const result = useSignal<SearchResult | null>(null);
  const requestSeq = useRef(0);

  useEffect(() => {
    const trimmed = query.value;
    if (!hasMaps || !trimmed || trimmed.trim().length === 0) {
      busy.value = false;
      result.value = null;
      return;
    }

    const seq = ++requestSeq.current;
    busy.value = true;
    const timer = setTimeout(() => {
      void searchSources(origin, {
        query: trimmed,
        regex: useRegex.value,
        caseSensitive: caseSensitive.value,
        includeVendor: includeVendor.value,
        maxResults: DEFAULT_MAX_SEARCH_RESULTS,
      })
        .then((res) => {
          if (requestSeq.current !== seq) return;
          result.value = res;
          busy.value = false;
        })
        .catch((error) => {
          if (requestSeq.current !== seq) return;
          result.value = {
            matches: [],
            filesSearched: 0,
            filesMatched: 0,
            truncated: false,
            error: error instanceof Error ? error.message : String(error),
          };
          busy.value = false;
        });
    }, 180);

    return () => clearTimeout(timer);
  }, [origin, hasMaps, query.value, useRegex.value, caseSensitive.value, includeVendor.value]);

  const current = result.value;

  return (
    <div class="space-y-3">
      <div class="space-y-2">
        <div class="flex gap-1.5">
          <input
            type="search"
            data-testid="source-search-input"
            value={query.value}
            disabled={!hasMaps}
            placeholder={t('searchPlaceholder')}
            spellcheck={false}
            autocomplete="off"
            onInput={(event) => {
              query.value = event.currentTarget.value;
            }}
            class="min-w-0 flex-1 rounded-md border border-zinc-700 bg-zinc-900 px-2.5 py-1.5 font-mono text-[12px] text-zinc-100 placeholder:text-zinc-600 focus:border-emerald-500 focus:outline-none disabled:opacity-50"
          />
          <button
            type="button"
            data-testid="source-search-regex"
            aria-pressed={useRegex.value}
            onClick={() => {
              useRegex.value = !useRegex.value;
            }}
            class={`rounded-md border px-2 py-1 font-mono text-[11px] ${
              useRegex.value
                ? 'border-emerald-500/60 bg-emerald-500/15 text-emerald-300'
                : 'border-zinc-700 bg-zinc-900 text-zinc-400 hover:text-zinc-200'
            }`}
          >
            {t('searchRegex')}
          </button>
          <button
            type="button"
            data-testid="source-search-case"
            aria-pressed={caseSensitive.value}
            onClick={() => {
              caseSensitive.value = !caseSensitive.value;
            }}
            class={`rounded-md border px-2 py-1 font-mono text-[11px] ${
              caseSensitive.value
                ? 'border-emerald-500/60 bg-emerald-500/15 text-emerald-300'
                : 'border-zinc-700 bg-zinc-900 text-zinc-400 hover:text-zinc-200'
            }`}
          >
            {t('searchCase')}
          </button>
        </div>

        <label class="flex cursor-pointer items-center gap-2 px-0.5 text-[11px] text-zinc-400">
          <input
            type="checkbox"
            data-testid="source-search-vendor"
            checked={includeVendor.value}
            onChange={(event) => {
              includeVendor.value = event.currentTarget.checked;
            }}
            class="accent-emerald-500"
          />
          <span>{t('searchIncludeVendor')}</span>
        </label>
      </div>

      {!hasMaps ? (
        <p class="px-1 text-[12px] text-zinc-500">{t('searchNoMaps')}</p>
      ) : query.value.trim().length === 0 ? (
        <p class="px-1 text-[12px] text-zinc-500">{t('searchPrompt')}</p>
      ) : (
        <>
          <div
            class="flex flex-wrap items-center gap-2 px-1 text-[11px]"
            data-testid="source-search-status"
          >
            {busy.value ? (
              <Badge tone="busy">{t('searchSearching')}</Badge>
            ) : current?.error ? (
              <span class="text-red-300">{current.error}</span>
            ) : current ? (
              <>
                <span class="text-zinc-400">
                  {current.matches.length === 0
                    ? t('searchEmpty')
                    : t(
                        'searchStats',
                        current.matches.length,
                        current.filesMatched,
                        current.filesSearched,
                      )}
                </span>
                {current.truncated && (
                  <span class="text-amber-300">{t('searchTruncated', current.matches.length)}</span>
                )}
              </>
            ) : null}
          </div>

          {current && current.matches.length > 0 && (
            <div class="overflow-hidden rounded-lg border border-white/[0.06]">
              <ul class="divide-y divide-white/[0.04]" data-testid="source-search-results">
                {current.matches.map((match) => (
                  <li key={`${match.mapId}:${match.file}:${match.line}:${match.column}`}>
                    <button
                      type="button"
                      data-testid="source-search-result"
                      onClick={() =>
                        openCodeViewer({
                          origin,
                          file: match.file,
                          line: match.line,
                          column: match.column,
                          length: match.length,
                          mapHash: match.mapHash,
                          mapUrl: match.mapUrl,
                          scriptUrl: match.scriptUrl,
                          kind: 'source',
                        })
                      }
                      class="block w-full space-y-1 px-2.5 py-2 text-left hover:bg-white/[0.04]"
                    >
                      <div class="flex items-center gap-1.5 font-mono text-[11px]">
                        <span class="min-w-0 flex-1 truncate text-zinc-200">{match.file}</span>
                        <span class="shrink-0 text-emerald-300">:{match.line}</span>
                      </div>
                      <pre class="overflow-hidden truncate rounded bg-black/30 px-2 py-0.5 font-mono text-[10px] text-zinc-400">
                        {renderHighlightedExcerpt(match)}
                      </pre>
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </>
      )}
    </div>
  );
}
