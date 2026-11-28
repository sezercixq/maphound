import { useSignal } from '@preact/signals';
import type { Severity } from '@/core/db';
import { saveTriageFromUi } from '@/core/site-client';
import {
  generateSingleBountyReport,
  generateTriageReportMarkdown,
  registrableDomainFor,
  TRIAGE_STATUSES,
  type TriageFindingKind,
  type TriageRecord,
  type TriageStatus,
} from '@/engine/workspace';
import { type MessageKey, t } from '../i18n';
import { refresh } from '../state';

const STATUS_LABEL: Record<TriageStatus, MessageKey> = {
  unreviewed: 'triageStatusUnreviewed',
  confirmed: 'triageStatusConfirmed',
  investigating: 'triageStatusInvestigating',
  false_positive: 'triageStatusFalsePositive',
};

const STATUS_STYLE: Record<TriageStatus, string> = {
  unreviewed: 'border-white/[0.08] bg-white/[0.03] text-zinc-400',
  confirmed: 'border-emerald-500/40 bg-emerald-500/15 text-emerald-300',
  investigating: 'border-amber-400/40 bg-amber-400/15 text-amber-200',
  false_positive: 'border-zinc-700 bg-zinc-800/80 text-zinc-500 line-through',
};

export function TriageBar({
  triageId,
  origin,
  kind,
  title,
  severity,
  asset,
  evidence,
  record,
}: {
  triageId: string;
  origin: string;
  kind: TriageFindingKind;
  title: string;
  severity: Severity;
  asset?: string;
  evidence?: string;
  record?: TriageRecord;
}) {
  const noteOpen = useSignal(false);
  const draftNote = useSignal(record?.note ?? '');
  const copied = useSignal(false);
  const status: TriageStatus = record?.status ?? 'unreviewed';

  const persist = async (nextStatus: TriageStatus, nextNote: string) => {
    const rec: TriageRecord = {
      id: triageId,
      origin,
      domain: registrableDomainFor(origin),
      kind,
      title,
      severity,
      status: nextStatus,
      note: nextNote,
      ...(asset ? { asset } : {}),
      ...(evidence ? { evidence } : {}),
      updatedAt: Date.now(),
    };
    await saveTriageFromUi(rec);
    await refresh();
  };

  const copyBounty = async () => {
    const rec: TriageRecord = record ?? {
      id: triageId,
      origin,
      domain: registrableDomainFor(origin),
      kind,
      title,
      severity,
      status,
      note: draftNote.value,
      ...(asset ? { asset } : {}),
      ...(evidence ? { evidence } : {}),
      updatedAt: Date.now(),
    };
    const md = generateSingleBountyReport(rec, {
      target: origin,
      generator: 'MapHound 0.8.0',
      exportedAt: new Date().toISOString(),
    });
    try {
      await navigator.clipboard.writeText(md);
      copied.value = true;
      setTimeout(() => {
        copied.value = false;
      }, 1600);
    } catch {
      // Clipboard needs focus.
    }
  };

  return (
    <div class="mt-1.5 space-y-1" data-testid="triage-bar" data-triage-status={status}>
      <div class="flex flex-wrap items-center gap-1">
        <select
          aria-label={t('triageStatusLabel')}
          data-testid="triage-status-select"
          value={status}
          onChange={(e) => {
            const next = e.currentTarget.value as TriageStatus;
            void persist(next, record?.note ?? draftNote.value);
          }}
          class={`rounded border px-1.5 py-0.5 text-[10px] font-medium outline-none ${STATUS_STYLE[status]}`}
        >
          {TRIAGE_STATUSES.map((s) => (
            <option key={s} value={s} class="bg-zinc-950 text-zinc-200">
              {t(STATUS_LABEL[s])}
            </option>
          ))}
        </select>

        <button
          type="button"
          data-testid="triage-note-toggle"
          onClick={() => {
            draftNote.value = record?.note ?? '';
            noteOpen.value = !noteOpen.value;
          }}
          class="rounded border border-white/[0.08] bg-white/[0.02] px-1.5 py-0.5 text-[10px] text-zinc-400 hover:text-zinc-200"
        >
          {record?.note ? t('triageEditNote') : t('triageAddNote')}
        </button>

        {status === 'confirmed' && (
          <button
            type="button"
            data-testid="triage-copy-bounty"
            onClick={() => void copyBounty()}
            class="rounded border border-emerald-500/30 bg-emerald-500/10 px-1.5 py-0.5 text-[10px] font-medium text-emerald-300 hover:bg-emerald-500/20"
          >
            {copied.value ? t('copied') : t('triageCopyBounty')}
          </button>
        )}
      </div>

      {record?.note && !noteOpen.value && (
        <p class="truncate text-[10px] text-zinc-400 italic" data-testid="triage-note-preview">
          {record.note}
        </p>
      )}

      {noteOpen.value && (
        <div class="flex items-center gap-1">
          <input
            type="text"
            data-testid="triage-note-input"
            value={draftNote.value}
            placeholder={t('triageNotePlaceholder')}
            onInput={(e) => {
              draftNote.value = e.currentTarget.value;
            }}
            class="min-w-0 flex-1 rounded border border-white/[0.1] bg-black/40 px-2 py-0.5 text-[11px] text-zinc-200 placeholder-zinc-600 outline-none focus:border-emerald-500/50"
          />
          <button
            type="button"
            data-testid="triage-note-save"
            onClick={() => {
              noteOpen.value = false;
              void persist(status, draftNote.value);
            }}
            class="rounded bg-emerald-500/20 px-2 py-0.5 text-[10px] font-medium text-emerald-300 hover:bg-emerald-500/30"
          >
            {t('triageSaveNote')}
          </button>
        </div>
      )}
    </div>
  );
}

/** Compact summary banner to copy the full HackerOne/Bugcrowd report for all confirmed items. */
export function TriageSummaryBar({
  records,
  target,
  dismissedCount,
  showDismissed,
  onToggleDismissed,
}: {
  records: readonly TriageRecord[];
  target: string;
  dismissedCount: number;
  showDismissed: boolean;
  onToggleDismissed: () => void;
}) {
  const copied = useSignal(false);
  const confirmed = records.filter((r) => r.status === 'confirmed');
  if (confirmed.length === 0 && dismissedCount === 0) return null;

  const copyAll = async () => {
    const md = generateTriageReportMarkdown(confirmed, {
      target,
      generator: 'MapHound 0.8.0',
      exportedAt: new Date().toISOString(),
    });
    try {
      await navigator.clipboard.writeText(md);
      copied.value = true;
      setTimeout(() => {
        copied.value = false;
      }, 1800);
    } catch {
      // Clipboard needs focus.
    }
  };

  return (
    <div
      data-testid="triage-summary-bar"
      class="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-white/[0.06] bg-white/[0.02] px-2.5 py-1.5 text-[11px]"
    >
      <div class="flex items-center gap-2">
        {confirmed.length > 0 && (
          <button
            type="button"
            data-testid="copy-triage-report"
            onClick={() => void copyAll()}
            class="rounded border border-emerald-500/30 bg-emerald-500/15 px-2 py-0.5 text-[10px] font-medium text-emerald-300 hover:bg-emerald-500/25"
          >
            {copied.value ? t('copied') : t('triageCopyFullReport', confirmed.length)}
          </button>
        )}
      </div>
      {dismissedCount > 0 && (
        <button
          type="button"
          data-testid="toggle-dismissed"
          onClick={onToggleDismissed}
          class="text-[10px] text-zinc-400 underline decoration-zinc-700 hover:text-zinc-200"
        >
          {showDismissed
            ? t('triageHideDismissed', dismissedCount)
            : t('triageShowDismissed', dismissedCount)}
        </button>
      )}
    </div>
  );
}
