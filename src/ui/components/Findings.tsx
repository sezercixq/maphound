import { useSignal } from '@preact/signals';
import type { FindingRecord, Severity } from '@/core/db';
import { rescanSiteFromUi } from '@/core/site-client';
import { draftSecretReport } from '@/engine/export';
import { CONFIDENCE_KEYS, isUrgent, SEVERITY_KEYS, type Tone } from '../format';
import { t } from '../i18n';
import { openCodeViewer } from '../state';
import { Badge, CopyDraftButton, Section } from './primitives';

const SEVERITY_STYLE: Record<Severity, { bar: string; badge: string }> = {
  critical: { bar: 'bg-red-500', badge: 'bg-red-500/15 text-red-300' },
  high: { bar: 'bg-orange-400', badge: 'bg-orange-400/15 text-orange-300' },
  medium: { bar: 'bg-amber-300', badge: 'bg-amber-300/15 text-amber-200' },
  low: { bar: 'bg-sky-400', badge: 'bg-sky-400/15 text-sky-300' },
  info: { bar: 'bg-zinc-600', badge: 'bg-zinc-800 text-zinc-400' },
};

const CONFIDENCE_TONE: Record<FindingRecord['confidence'], Tone> = {
  'verified-format': 'ok',
  high: 'neutral',
  medium: 'muted',
  low: 'muted',
};

function SeverityBadge({ severity }: { severity: Severity }) {
  return (
    <span
      class={`inline-flex shrink-0 items-center rounded px-1.5 py-px text-[10px] leading-4 font-semibold tracking-wide uppercase ${SEVERITY_STYLE[severity].badge}`}
    >
      {t(SEVERITY_KEYS[severity])}
    </span>
  );
}

function IconButton({
  label,
  onClick,
  children,
  testId,
}: {
  label: string;
  onClick: () => void;
  children: preact.ComponentChildren;
  testId?: string;
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      data-testid={testId}
      onClick={onClick}
      class="grid size-6 shrink-0 place-items-center rounded text-zinc-500 hover:bg-white/[0.06] hover:text-zinc-200"
    >
      {children}
    </button>
  );
}

function FindingItem({ finding, origin }: { finding: FindingRecord; origin: string }) {
  const revealed = useSignal(false);
  const copied = useSignal(false);
  const fileName = finding.file.split('/').pop() ?? finding.file;
  const location = finding.locations[0];
  const where =
    finding.locationKind === 'bundle-mapped'
      ? t('locationMapped')
      : finding.locationKind === 'bundle'
        ? t('locationBundle')
        : undefined;
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(finding.secret);
      copied.value = true;
      setTimeout(() => {
        copied.value = false;
      }, 1500);
    } catch {
      // Clipboard needs focus; nothing else to do.
    }
  };
  return (
    <li class="relative py-2 pr-2 pl-3" data-testid="finding-row" data-severity={finding.severity}>
      <span
        class={`absolute inset-y-2 left-0 w-0.5 rounded-full ${SEVERITY_STYLE[finding.severity].bar}`}
      />
      <div class="flex items-center gap-1.5">
        <SeverityBadge severity={finding.severity} />
        <p
          class="min-w-0 flex-1 truncate text-[12px] font-medium text-zinc-100"
          title={finding.ruleName}
        >
          {finding.ruleName}
        </p>
        <CopyDraftButton
          testId="finding-draft"
          buildDraft={() => draftSecretReport(finding, origin)}
        />
      </div>
      <div class="mt-1 flex items-center gap-2">
        <button
          type="button"
          class="min-w-0 flex-1 truncate text-left font-mono text-[11px] text-zinc-400 hover:text-emerald-300"
          title={`${t('openInViewer')}: ${finding.file}:${finding.line}:${finding.column + 1}${location ? `\n${location.scriptUrl}` : ''}`}
          data-testid="finding-location"
          onClick={() =>
            openCodeViewer({
              origin,
              file: finding.file,
              line: finding.line,
              column: finding.column,
              length: finding.secret.length,
              scriptUrl: location?.scriptUrl,
              mapUrl: location?.mapUrl,
              kind: finding.locationKind === 'bundle' ? 'bundle' : 'source',
              label: finding.ruleName,
            })
          }
        >
          <span class="text-zinc-200">{fileName}</span>:{finding.line}
          <span class="text-zinc-600"> · {finding.file}</span>
        </button>
        <Badge tone={CONFIDENCE_TONE[finding.confidence]}>
          {t(CONFIDENCE_KEYS[finding.confidence])}
        </Badge>
      </div>
      {where && <p class="text-[10px] text-zinc-600">{where}</p>}
      <div class="mt-1 flex items-center gap-1 rounded bg-black/30 py-0.5 pr-0.5 pl-2">
        <code
          class="min-w-0 flex-1 truncate font-mono text-[11px] text-zinc-300"
          data-testid="finding-secret"
        >
          {revealed.value ? finding.secret : finding.preview}
        </code>
        {finding.occurrences > 1 && (
          <span class="text-[10px] text-zinc-500">{t('occurrences', finding.occurrences)}</span>
        )}
        <IconButton
          label={revealed.value ? t('hide') : t('reveal')}
          testId="finding-reveal"
          onClick={() => {
            revealed.value = !revealed.value;
          }}
        >
          <svg
            viewBox="0 0 20 20"
            class="size-3.5"
            fill="none"
            stroke="currentColor"
            stroke-width="1.6"
            aria-hidden="true"
          >
            <path d="M1.5 10S4.5 4 10 4s8.5 6 8.5 6-3 6-8.5 6-8.5-6-8.5-6z" />
            <circle cx="10" cy="10" r="2.5" />
            {revealed.value && <path d="M3 3l14 14" stroke-linecap="round" />}
          </svg>
        </IconButton>
        <IconButton
          label={copied.value ? t('copied') : t('copy')}
          testId="finding-copy"
          onClick={() => void copy()}
        >
          {copied.value ? (
            <svg
              viewBox="0 0 20 20"
              class="size-3.5 text-emerald-300"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              aria-hidden="true"
            >
              <path d="M4 10.5l4 4 8-9" stroke-linecap="round" stroke-linejoin="round" />
            </svg>
          ) : (
            <svg
              viewBox="0 0 20 20"
              class="size-3.5"
              fill="none"
              stroke="currentColor"
              stroke-width="1.6"
              aria-hidden="true"
            >
              <rect x="7" y="7" width="10" height="10" rx="1.5" />
              <path d="M13 4.5V4a1 1 0 00-1-1H4a1 1 0 00-1 1v8a1 1 0 001 1h.5" />
            </svg>
          )}
        </IconButton>
      </div>
    </li>
  );
}

export function FindingList({
  findings,
  counts,
  scanning,
  origin,
}: {
  findings: FindingRecord[];
  counts: Record<Severity, number>;
  scanning: boolean;
  origin: string;
}) {
  const showAll = useSignal(false);
  const urgent = findings.filter((f) => isUrgent(f.severity));
  const lower = findings.length - urgent.length;
  const visible = showAll.value ? findings : urgent;
  return (
    <Section title={t('sectionFindings')} count={findings.length}>
      <div class="flex flex-wrap items-center gap-1 px-1" data-testid="finding-counts">
        {(['critical', 'high', 'medium', 'low', 'info'] as const)
          .filter((severity) => counts[severity] > 0)
          .map((severity) => (
            <span
              key={severity}
              class={`rounded px-1.5 py-px font-mono text-[10px] ${SEVERITY_STYLE[severity].badge}`}
            >
              {counts[severity]} {t(SEVERITY_KEYS[severity])}
            </span>
          ))}
        {scanning && <Badge tone="busy">{t('findingsScanning')}</Badge>}
        <button
          type="button"
          data-testid="rescan"
          class="ml-auto text-[11px] text-zinc-500 hover:text-zinc-300"
          onClick={() => void rescanSiteFromUi(origin)}
        >
          {t('rescan')}
        </button>
      </div>
      {findings.length === 0 ? (
        !scanning && <p class="px-1 text-[12px] text-zinc-500">{t('findingsNone')}</p>
      ) : (
        <div class="overflow-hidden rounded-lg border border-white/[0.06]">
          {visible.length > 0 ? (
            <ul class="divide-y divide-white/[0.04]" data-testid="finding-list">
              {visible.map((finding) => (
                <FindingItem key={finding.id} finding={finding} origin={origin} />
              ))}
            </ul>
          ) : (
            <p class="px-2 py-2 text-[12px] text-zinc-500">{t('findingsOnlyLower', lower)}</p>
          )}
          {lower > 0 && (
            <button
              type="button"
              data-testid="findings-toggle"
              class="w-full border-t border-white/[0.04] py-1.5 text-[12px] text-zinc-500 hover:text-zinc-300"
              onClick={() => {
                showAll.value = !showAll.value;
              }}
            >
              {showAll.value ? t('findingsHideLower') : t('findingsShowLower', lower)}
            </button>
          )}
        </div>
      )}
    </Section>
  );
}
