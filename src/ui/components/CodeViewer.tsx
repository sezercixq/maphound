import { useSignal } from '@preact/signals';
import { useEffect, useLayoutEffect, useRef } from 'preact/hooks';
import type { LoadedSourceFile } from '@/engine/search/source-search';
import { formatBytes } from '../format';
import { t } from '../i18n';
import { loadSourceFileForViewer } from '../search-client';
import { closeCodeViewer, viewerTarget } from '../state';
import { Badge } from './primitives';

const LARGE_FILE_LINES = 1_500;
const WINDOW_RADIUS = 300;
const EXPAND_STEP = 400;

type LoadState =
  | { kind: 'loading' }
  | { kind: 'ready'; file: LoadedSourceFile; lines: string[] }
  | { kind: 'missing' }
  | { kind: 'error'; message: string };

function renderHighlightedLine(
  lineText: string,
  column: number | undefined,
  length: number | undefined,
) {
  if (
    column === undefined ||
    length === undefined ||
    length <= 0 ||
    column < 0 ||
    column >= lineText.length
  ) {
    return lineText || ' ';
  }
  const end = Math.min(lineText.length, column + length);
  return (
    <>
      {lineText.slice(0, column)}
      <mark class="rounded bg-amber-400/30 px-0.5 text-amber-100">
        {lineText.slice(column, end)}
      </mark>
      {lineText.slice(end)}
    </>
  );
}

export function CodeViewer() {
  const target = viewerTarget.value;
  const loadState = useSignal<LoadState>({ kind: 'loading' });
  const range = useSignal<{ start: number; end: number }>({ start: 1, end: LARGE_FILE_LINES });
  const copied = useSignal(false);
  const highlightRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!target) return;
    let cancelled = false;
    loadState.value = { kind: 'loading' };
    void loadSourceFileForViewer(target.origin, {
      file: target.file,
      mapHash: target.mapHash,
      mapUrl: target.mapUrl,
      scriptUrl: target.scriptUrl,
      kind: target.kind,
    })
      .then((file) => {
        if (cancelled) return;
        if (!file) {
          loadState.value = { kind: 'missing' };
          return;
        }
        const lines = file.content.split(/\r?\n/);
        const total = lines.length;
        if (total <= LARGE_FILE_LINES) {
          range.value = { start: 1, end: total };
        } else {
          range.value = {
            start: Math.max(1, target.line - WINDOW_RADIUS),
            end: Math.min(total, target.line + WINDOW_RADIUS),
          };
        }
        loadState.value = { kind: 'ready', file, lines };
      })
      .catch((error) => {
        if (cancelled) return;
        loadState.value = {
          kind: 'error',
          message: error instanceof Error ? error.message : String(error),
        };
      });
    return () => {
      cancelled = true;
    };
  }, [target]);

  useLayoutEffect(() => {
    if (!target) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        closeCodeViewer();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [target]);

  const current = loadState.value;
  useEffect(() => {
    if (current.kind === 'ready' && highlightRef.current) {
      highlightRef.current.scrollIntoView({ block: 'center' });
    }
  }, [current, target?.line]);

  if (!target) return null;

  const copyPath = async () => {
    try {
      await navigator.clipboard.writeText(`${target.file}:${target.line}`);
      copied.value = true;
      setTimeout(() => {
        copied.value = false;
      }, 1500);
    } catch {
      // Clipboard may require focus.
    }
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={target.file}
      data-testid="code-viewer"
      class="fixed inset-0 z-50 flex flex-col bg-[#0b0d11]/98 backdrop-blur"
    >
      <header class="flex items-center gap-2 border-b border-white/[0.08] bg-white/[0.02] px-3 py-2.5">
        <div class="min-w-0 flex-1">
          <div class="flex items-center gap-1.5">
            <p
              class="truncate font-mono text-[12px] font-medium text-zinc-100"
              data-testid="code-viewer-path"
              title={`${target.file}:${target.line}`}
            >
              {target.file}
            </p>
            <span class="shrink-0 rounded bg-emerald-500/15 px-1.5 py-px font-mono text-[10px] text-emerald-300">
              :{target.line}
            </span>
          </div>
          <div class="mt-0.5 flex flex-wrap items-center gap-1.5 text-[11px] text-zinc-500">
            {target.label && <span class="truncate text-zinc-400">{target.label}</span>}
            {current.kind === 'ready' && (
              <>
                <span>· {formatBytes(current.file.size)}</span>
                {current.file.kind === 'bundle' && (
                  <Badge tone="warn">{t('viewerBundleNote')}</Badge>
                )}
              </>
            )}
          </div>
        </div>
        <button
          type="button"
          onClick={() => void copyPath()}
          class="shrink-0 rounded border border-white/[0.08] px-2 py-1 text-[11px] text-zinc-300 hover:bg-white/[0.06]"
        >
          {copied.value ? t('copied') : t('copyPath')}
        </button>
        <button
          type="button"
          data-testid="code-viewer-close"
          aria-label={t('viewerClose')}
          title={t('viewerClose')}
          onClick={closeCodeViewer}
          class="grid size-7 shrink-0 place-items-center rounded text-zinc-400 hover:bg-white/[0.08] hover:text-zinc-100"
        >
          <svg
            viewBox="0 0 20 20"
            class="size-4"
            fill="none"
            stroke="currentColor"
            stroke-width="1.8"
            aria-hidden="true"
          >
            <path d="M5 5l10 10M15 5L5 15" stroke-linecap="round" />
          </svg>
        </button>
      </header>

      <div class="min-h-0 flex-1 overflow-auto font-mono text-[11px] leading-5">
        {current.kind === 'loading' && (
          <p class="p-4 text-center text-[12px] text-zinc-400">{t('viewerLoading')}</p>
        )}
        {current.kind === 'missing' && (
          <p class="p-4 text-center text-[12px] text-zinc-500">{t('viewerNotFound')}</p>
        )}
        {current.kind === 'error' && (
          <p class="p-4 text-center text-[12px] text-red-300">{current.message}</p>
        )}
        {current.kind === 'ready' && (
          <div class="py-2">
            {range.value.start > 1 && (
              <button
                type="button"
                onClick={() => {
                  range.value = {
                    ...range.value,
                    start: Math.max(1, range.value.start - EXPAND_STEP),
                  };
                }}
                class="w-full border-y border-white/[0.05] bg-white/[0.02] py-1 text-center text-[11px] text-zinc-400 hover:text-zinc-200"
              >
                {t('viewerShowBefore', Math.min(EXPAND_STEP, range.value.start - 1))}
              </button>
            )}
            {current.lines.slice(range.value.start - 1, range.value.end).map((lineText, idx) => {
              const lineNum = range.value.start + idx;
              const isTarget = lineNum === target.line;
              return (
                <div
                  key={lineNum}
                  ref={isTarget ? highlightRef : undefined}
                  data-testid="code-viewer-line"
                  data-line={lineNum}
                  data-highlighted={isTarget ? 'true' : 'false'}
                  class={`flex px-2 ${
                    isTarget
                      ? 'border-l-2 border-emerald-400 bg-emerald-500/15 text-zinc-100'
                      : 'border-l-2 border-transparent text-zinc-400 hover:bg-white/[0.03]'
                  }`}
                >
                  <span
                    class={`w-11 shrink-0 pr-3 text-right select-none tabular-nums ${
                      isTarget ? 'font-semibold text-emerald-300' : 'text-zinc-600'
                    }`}
                  >
                    {lineNum}
                  </span>
                  <pre class="min-w-0 flex-1 whitespace-pre-wrap break-all">
                    {isTarget
                      ? renderHighlightedLine(lineText, target.column, target.length)
                      : lineText || ' '}
                  </pre>
                </div>
              );
            })}
            {range.value.end < current.lines.length && (
              <button
                type="button"
                onClick={() => {
                  range.value = {
                    ...range.value,
                    end: Math.min(current.lines.length, range.value.end + EXPAND_STEP),
                  };
                }}
                class="w-full border-y border-white/[0.05] bg-white/[0.02] py-1 text-center text-[11px] text-zinc-400 hover:text-zinc-200"
              >
                {t(
                  'viewerShowAfter',
                  Math.min(EXPAND_STEP, current.lines.length - range.value.end),
                )}
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
