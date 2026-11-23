import { useSignal } from '@preact/signals';
import { captureSnapshotFromUi } from '@/core/site-client';
import type { SiteSnapshotRecord, SnapshotDiff } from '@/engine/diff';
import { t } from '../i18n';
import { openCodeViewer, refresh } from '../state';
import { Badge, Section } from './primitives';

function shortTime(ts: number): string {
  return new Date(ts).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

export function DiffView({
  snapshots,
  diff,
  origin,
}: {
  snapshots: SiteSnapshotRecord[];
  diff: SnapshotDiff | null;
  origin: string;
}) {
  const busy = useSignal(false);

  const capture = async () => {
    busy.value = true;
    try {
      await captureSnapshotFromUi(origin);
      await refresh();
    } finally {
      busy.value = false;
    }
  };

  return (
    <div class="space-y-4">
      <div class="flex items-center gap-2 rounded-lg border border-white/[0.06] bg-white/[0.02] px-2.5 py-2">
        <div class="min-w-0 flex-1">
          <p class="text-[11px] font-medium text-zinc-200">
            {t('diffSnapshotsCount', snapshots.length)}
          </p>
          {diff && (
            <p class="truncate font-mono text-[10px] text-zinc-500">
              {t(
                'diffComparedLabel',
                shortTime(diff.previous.createdAt),
                shortTime(diff.current.createdAt),
              )}
            </p>
          )}
        </div>
        <button
          type="button"
          data-testid="save-snapshot"
          disabled={busy.value}
          onClick={() => void capture()}
          class="shrink-0 rounded border border-emerald-500/40 bg-emerald-500/15 px-2.5 py-1 text-[11px] font-medium text-emerald-300 hover:bg-emerald-500/25 disabled:opacity-50"
        >
          {t('diffSaveSnapshot')}
        </button>
      </div>

      {!diff ? (
        <p class="px-1 text-[12px] text-zinc-500">{t('diffNeedTwo')}</p>
      ) : !diff.hasChanges ? (
        <p class="px-1 text-[12px] text-zinc-500">{t('diffNoChanges')}</p>
      ) : (
        <>
          {(diff.files.added.length > 0 ||
            diff.files.modified.length > 0 ||
            diff.files.removed.length > 0) && (
            <Section
              title={t('diffFilesSection')}
              count={
                diff.files.added.length + diff.files.modified.length + diff.files.removed.length
              }
            >
              <div
                data-testid="diff-files"
                class="divide-y divide-white/[0.04] overflow-hidden rounded-lg border border-white/[0.06]"
              >
                {diff.files.added.map((f) => (
                  <button
                    key={`add:${f.path}`}
                    type="button"
                    onClick={() =>
                      openCodeViewer({ origin, file: f.path, line: 1, kind: 'source' })
                    }
                    class="flex w-full items-center gap-2 px-2.5 py-1.5 text-left hover:bg-white/[0.03]"
                  >
                    <Badge tone="ok">+ {t('diffAddedLabel')}</Badge>
                    <span class="min-w-0 flex-1 truncate font-mono text-[11px] text-zinc-200">
                      {f.path}
                    </span>
                  </button>
                ))}
                {diff.files.modified.map((f) => (
                  <button
                    key={`mod:${f.path}`}
                    type="button"
                    onClick={() =>
                      openCodeViewer({ origin, file: f.path, line: 1, kind: 'source' })
                    }
                    class="flex w-full items-center gap-2 px-2.5 py-1.5 text-left hover:bg-white/[0.03]"
                  >
                    <Badge tone="warn">~ {t('diffModifiedLabel')}</Badge>
                    <span class="min-w-0 flex-1 truncate font-mono text-[11px] text-zinc-200">
                      {f.path}
                    </span>
                  </button>
                ))}
                {diff.files.removed.map((f) => (
                  <div key={`rem:${f.path}`} class="flex items-center gap-2 px-2.5 py-1.5">
                    <Badge tone="error">- {t('diffRemovedLabel')}</Badge>
                    <span class="min-w-0 flex-1 truncate font-mono text-[11px] text-zinc-400">
                      {f.path}
                    </span>
                  </div>
                ))}
              </div>
            </Section>
          )}

          {(diff.endpoints.added.length > 0 ||
            diff.endpoints.removed.length > 0 ||
            diff.routes.added.length > 0 ||
            diff.routes.removed.length > 0) && (
            <Section
              title={t('diffEndpointsSection')}
              count={
                diff.endpoints.added.length +
                diff.endpoints.removed.length +
                diff.routes.added.length +
                diff.routes.removed.length
              }
            >
              <div
                data-testid="diff-endpoints"
                class="divide-y divide-white/[0.04] overflow-hidden rounded-lg border border-white/[0.06]"
              >
                {diff.endpoints.added.map((ep) => (
                  <div key={`ep+:${ep}`} class="flex items-center gap-2 px-2.5 py-1.5">
                    <Badge tone="ok">+ {t('diffAddedLabel')}</Badge>
                    <span class="min-w-0 flex-1 truncate font-mono text-[11px] text-zinc-200">
                      {ep}
                    </span>
                  </div>
                ))}
                {diff.endpoints.removed.map((ep) => (
                  <div key={`ep-:${ep}`} class="flex items-center gap-2 px-2.5 py-1.5">
                    <Badge tone="error">- {t('diffRemovedLabel')}</Badge>
                    <span class="min-w-0 flex-1 truncate font-mono text-[11px] text-zinc-400">
                      {ep}
                    </span>
                  </div>
                ))}
                {diff.routes.added.map((r) => (
                  <div key={`rt+:${r}`} class="flex items-center gap-2 px-2.5 py-1.5">
                    <Badge tone="ok">+ {t('diffAddedLabel')}</Badge>
                    <span class="min-w-0 flex-1 truncate font-mono text-[11px] text-zinc-200">
                      {r}
                    </span>
                  </div>
                ))}
                {diff.routes.removed.map((r) => (
                  <div key={`rt-:${r}`} class="flex items-center gap-2 px-2.5 py-1.5">
                    <Badge tone="error">- {t('diffRemovedLabel')}</Badge>
                    <span class="min-w-0 flex-1 truncate font-mono text-[11px] text-zinc-400">
                      {r}
                    </span>
                  </div>
                ))}
              </div>
            </Section>
          )}

          {(diff.findings.added.length > 0 || diff.findings.resolved.length > 0) && (
            <Section
              title={t('diffFindingsSection')}
              count={diff.findings.added.length + diff.findings.resolved.length}
            >
              <div
                data-testid="diff-findings"
                class="divide-y divide-white/[0.04] overflow-hidden rounded-lg border border-white/[0.06]"
              >
                {diff.findings.added.map((f) => (
                  <div key={`f+:${f.key}`} class="flex items-center gap-2 px-2.5 py-1.5">
                    <Badge tone="error">+ {t('diffAddedLabel')}</Badge>
                    <span class="min-w-0 flex-1 truncate text-[11px] text-zinc-200">
                      {f.ruleName}{' '}
                      <span class="font-mono text-zinc-500">
                        ({f.file}:{f.line})
                      </span>
                    </span>
                  </div>
                ))}
                {diff.findings.resolved.map((f) => (
                  <div key={`f-:${f.key}`} class="flex items-center gap-2 px-2.5 py-1.5">
                    <Badge tone="ok">- {t('diffResolvedLabel')}</Badge>
                    <span class="min-w-0 flex-1 truncate text-[11px] text-zinc-400">
                      {f.ruleName}{' '}
                      <span class="font-mono text-zinc-500">
                        ({f.file}:{f.line})
                      </span>
                    </span>
                  </div>
                ))}
              </div>
            </Section>
          )}

          {(diff.sinks.added.length > 0 || diff.sinks.resolved.length > 0) && (
            <Section
              title={t('diffSinksSection')}
              count={diff.sinks.added.length + diff.sinks.resolved.length}
            >
              <div
                data-testid="diff-sinks"
                class="divide-y divide-white/[0.04] overflow-hidden rounded-lg border border-white/[0.06]"
              >
                {diff.sinks.added.map((s) => (
                  <div key={`s+:${s.key}`} class="flex items-center gap-2 px-2.5 py-1.5">
                    <Badge tone="warn">+ {t('diffAddedLabel')}</Badge>
                    <span class="min-w-0 flex-1 truncate text-[11px] text-zinc-200">
                      {s.title}{' '}
                      <span class="font-mono text-zinc-500">
                        ({s.file}:{s.line})
                      </span>
                    </span>
                  </div>
                ))}
                {diff.sinks.resolved.map((s) => (
                  <div key={`s-:${s.key}`} class="flex items-center gap-2 px-2.5 py-1.5">
                    <Badge tone="ok">- {t('diffResolvedLabel')}</Badge>
                    <span class="min-w-0 flex-1 truncate text-[11px] text-zinc-400">
                      {s.title}{' '}
                      <span class="font-mono text-zinc-500">
                        ({s.file}:{s.line})
                      </span>
                    </span>
                  </div>
                ))}
              </div>
            </Section>
          )}
        </>
      )}
    </div>
  );
}
