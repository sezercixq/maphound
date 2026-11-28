import { useSignal } from '@preact/signals';
import type { AuditRecord, Severity } from '@/core/db';
import type {
  AuditCategory,
  AuditFinding,
  HeaderStatus,
  StackHint,
  StackHintCategory,
} from '@/engine/audit';
import { draftAuditReport } from '@/engine/export';
import { AUDIT_CATEGORY_KEYS, SEVERITY_KEYS } from '../format';
import { type MessageKey, t } from '../i18n';
import { Badge, CopyDraftButton, Section } from './primitives';

const STACK_CATEGORY_KEYS: Record<StackHintCategory, MessageKey> = {
  server: 'stackCatServer',
  runtime: 'stackCatRuntime',
  database: 'stackCatDatabase',
  cloud: 'stackCatCloud',
  api: 'stackCatApi',
  'build-os': 'stackCatBuildOs',
};

const STACK_CATEGORY_TONES: Record<StackHintCategory, string> = {
  server: 'bg-sky-500/15 text-sky-300',
  runtime: 'bg-violet-500/15 text-violet-300',
  database: 'bg-emerald-500/15 text-emerald-300',
  cloud: 'bg-cyan-500/15 text-cyan-300',
  api: 'bg-amber-500/15 text-amber-200',
  'build-os': 'bg-zinc-800 text-zinc-300',
};

const SEVERITY_STYLE: Record<Severity, { bar: string; badge: string }> = {
  critical: { bar: 'bg-red-500', badge: 'bg-red-500/15 text-red-300' },
  high: { bar: 'bg-orange-400', badge: 'bg-orange-400/15 text-orange-300' },
  medium: { bar: 'bg-amber-300', badge: 'bg-amber-300/15 text-amber-200' },
  low: { bar: 'bg-sky-400', badge: 'bg-sky-400/15 text-sky-300' },
  info: { bar: 'bg-zinc-600', badge: 'bg-zinc-800 text-zinc-400' },
};

const MATRIX_TONE: Record<HeaderStatus, 'ok' | 'warn' | 'error' | 'muted'> = {
  ok: 'ok',
  weak: 'warn',
  missing: 'error',
  info: 'muted',
};

const MATRIX_KEY: Record<
  HeaderStatus,
  'auditStatusOk' | 'auditStatusWeak' | 'auditStatusMissing' | 'auditStatusInfo'
> = {
  ok: 'auditStatusOk',
  weak: 'auditStatusWeak',
  missing: 'auditStatusMissing',
  info: 'auditStatusInfo',
};

const CATEGORIES: readonly AuditCategory[] = ['headers', 'cookie', 'storage'];

export function SecurityAuditView({
  audits,
  findings,
  counts,
  stackHints = [],
  origin,
}: {
  audits: AuditRecord[];
  findings: AuditFinding[];
  counts: Record<Severity, number>;
  stackHints?: readonly StackHint[];
  origin: string;
}) {
  const activeCategory = useSignal<AuditCategory | 'all'>('all');
  const selectedAuditId = useSignal<string | null>(null);
  const rawOpen = useSignal(false);
  const rawCopied = useSignal(false);

  if (audits.length === 0 && stackHints.length === 0) {
    return <p class="px-1 text-[12px] text-zinc-500">{t('auditEmpty')}</p>;
  }

  const currentAudit = audits.find((a) => a.id === selectedAuditId.value) ?? audits[0];
  const filtered =
    activeCategory.value === 'all'
      ? findings
      : findings.filter((f) => f.category === activeCategory.value);

  return (
    <div class="space-y-4">
      {stackHints.length > 0 && (
        <Section title={t('stackHintsTitle')} count={stackHints.length}>
          <ul
            data-testid="stack-hints-card"
            class="divide-y divide-white/[0.05] overflow-hidden rounded-lg border border-white/[0.06] bg-white/[0.02]"
          >
            {stackHints.map((hint) => (
              <li
                key={`${hint.category}:${hint.name}`}
                data-testid="stack-hint-row"
                class="flex flex-wrap items-center justify-between gap-1.5 px-2.5 py-2"
              >
                <div class="flex min-w-0 items-center gap-1.5">
                  <span
                    class={`shrink-0 rounded px-1.5 py-0.5 text-[9px] font-semibold uppercase ${STACK_CATEGORY_TONES[hint.category]}`}
                  >
                    {t(STACK_CATEGORY_KEYS[hint.category])}
                  </span>
                  <span class="truncate text-[12px] font-medium text-zinc-100">{hint.name}</span>
                  {hint.version && (
                    <span class="rounded bg-amber-400/15 px-1 font-mono text-[10px] text-amber-200">
                      {hint.version}
                    </span>
                  )}
                </div>
                <Badge tone="neutral">{hint.evidence}</Badge>
              </li>
            ))}
          </ul>
        </Section>
      )}
      {currentAudit && (
        <Section title={t('auditHeadersTitle')} count={audits.length}>
          {audits.length > 1 && (
            <select
              value={currentAudit.id}
              onChange={(event) => {
                selectedAuditId.value = event.currentTarget.value;
              }}
              class="w-full rounded-md border border-zinc-700 bg-zinc-900 px-2 py-1 font-mono text-[11px] text-zinc-200"
            >
              {audits.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.pageUrl}
                </option>
              ))}
            </select>
          )}

          <div
            data-testid="audit-headers"
            class="divide-y divide-white/[0.04] overflow-hidden rounded-lg border border-white/[0.06]"
          >
            {currentAudit.matrix.map((row) => (
              <div key={row.header} class="flex items-center gap-2 px-2.5 py-1.5">
                <div class="min-w-0 flex-1">
                  <p class="truncate font-mono text-[11px] text-zinc-200">{row.header}</p>
                  {row.value && (
                    <p class="truncate font-mono text-[10px] text-zinc-500" title={row.value}>
                      {row.value}
                    </p>
                  )}
                </div>
                <Badge tone={MATRIX_TONE[row.status]}>{t(MATRIX_KEY[row.status])}</Badge>
              </div>
            ))}
            <p class="bg-white/[0.01] px-2.5 py-1 text-[10px] text-zinc-500">
              {t(
                'auditStorageScanned',
                currentAudit.storageKeysChecked,
                currentAudit.cookiesChecked,
              )}
            </p>
          </div>

          {currentAudit.rawHeaders && currentAudit.rawHeaders.length > 0 && (
            <div class="rounded-lg border border-white/[0.06] bg-white/[0.02]">
              <div class="flex items-center justify-between gap-2 px-2.5 py-1.5">
                <button
                  type="button"
                  data-testid="raw-headers-toggle"
                  onClick={() => {
                    rawOpen.value = !rawOpen.value;
                  }}
                  class="flex items-center gap-1.5 text-[11px] font-medium text-zinc-300 hover:text-zinc-100"
                >
                  <span class="font-mono text-[10px] text-zinc-500">
                    {rawOpen.value ? '▾' : '▸'}
                  </span>
                  <span>{t('rawHeadersTitle')}</span>
                  <span class="font-mono text-[10px] text-zinc-500">
                    ({currentAudit.rawHeaders.length})
                  </span>
                </button>
                <button
                  type="button"
                  data-testid="raw-headers-copy"
                  onClick={() => {
                    const text = (currentAudit.rawHeaders ?? [])
                      .map((h) => `${h.name}: ${h.value}`)
                      .join('\n');
                    void navigator.clipboard
                      .writeText(text)
                      .then(() => {
                        rawCopied.value = true;
                        setTimeout(() => {
                          rawCopied.value = false;
                        }, 1500);
                      })
                      .catch(() => {});
                  }}
                  class="rounded px-1.5 py-0.5 text-[10px] text-zinc-400 hover:bg-white/[0.06] hover:text-zinc-200"
                >
                  {rawCopied.value ? t('osintCopiedValue') : t('rawHeadersCopy')}
                </button>
              </div>
              {rawOpen.value && (
                <div
                  data-testid="raw-headers-table"
                  class="max-h-56 divide-y divide-white/[0.04] overflow-auto border-t border-white/[0.06]"
                >
                  {currentAudit.rawHeaders.map((h) => (
                    <div
                      key={h.name}
                      class="flex items-start gap-2 px-2.5 py-1 font-mono text-[10px]"
                    >
                      <span class="w-36 shrink-0 truncate text-emerald-300/90" title={h.name}>
                        {h.name}
                      </span>
                      <span class="min-w-0 flex-1 break-all text-zinc-400">{h.value}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </Section>
      )}

      {currentAudit?.htmlAudit &&
        (currentAudit.htmlAudit.metas.length > 0 || currentAudit.htmlAudit.comments.length > 0) && (
          <Section
            title={t('htmlAuditTitle')}
            count={currentAudit.htmlAudit.metas.length + currentAudit.htmlAudit.comments.length}
          >
            <div
              data-testid="html-audit-card"
              class="space-y-2.5 rounded-lg border border-white/[0.06] bg-white/[0.02] p-2.5"
            >
              {currentAudit.htmlAudit.metas.length > 0 && (
                <div class="space-y-1">
                  <p class="text-[10px] font-medium tracking-wider text-zinc-500 uppercase">
                    {t('htmlMetaHeading')}
                  </p>
                  <ul class="space-y-1">
                    {currentAudit.htmlAudit.metas.map((m) => (
                      <li
                        key={`${m.name}:${m.content}`}
                        class="flex items-center gap-2 font-mono text-[11px]"
                      >
                        <Badge tone="neutral">{m.name}</Badge>
                        <span class="truncate text-zinc-200">{m.content}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {currentAudit.htmlAudit.comments.length > 0 && (
                <div class="space-y-1">
                  <p class="text-[10px] font-medium tracking-wider text-zinc-500 uppercase">
                    {t('htmlCommentsHeading')}
                  </p>
                  <ul class="divide-y divide-white/[0.05] overflow-hidden rounded border border-white/[0.05] bg-black/20">
                    {currentAudit.htmlAudit.comments.map((c) => (
                      <li key={c.text} class="space-y-1 px-2 py-1.5">
                        <div class="flex flex-wrap gap-1">
                          {c.tags.map((tag) => (
                            <span
                              key={tag}
                              class={`rounded px-1.5 py-px text-[9px] font-semibold uppercase ${
                                c.level === 'high'
                                  ? 'bg-orange-400/15 text-orange-300'
                                  : c.level === 'medium'
                                    ? 'bg-amber-300/15 text-amber-200'
                                    : 'bg-zinc-800 text-zinc-300'
                              }`}
                            >
                              {tag}
                            </span>
                          ))}
                        </div>
                        <p class="font-mono text-[10.5px] break-all text-zinc-300">{c.text}</p>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          </Section>
        )}

      <Section title={t('auditFindingsTitle')} count={filtered.length}>
        <div class="flex flex-wrap items-center gap-1 px-0.5">
          {(['critical', 'high', 'medium', 'low', 'info'] as const)
            .filter((sev) => counts[sev] > 0)
            .map((sev) => (
              <span
                key={sev}
                class={`rounded px-1.5 py-px font-mono text-[10px] ${SEVERITY_STYLE[sev].badge}`}
              >
                {counts[sev]} {t(SEVERITY_KEYS[sev])}
              </span>
            ))}
        </div>

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
            {t('filterAll')} ({findings.length})
          </button>
          {CATEGORIES.map((cat) => (
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
              {t(AUDIT_CATEGORY_KEYS[cat])}
            </button>
          ))}
        </div>

        {filtered.length === 0 ? (
          <p class="px-1 text-[12px] text-zinc-500">{t('auditNoFindings')}</p>
        ) : (
          <div class="overflow-hidden rounded-lg border border-white/[0.06]">
            <ul class="divide-y divide-white/[0.04]" data-testid="audit-list">
              {filtered.map((finding) => (
                <li
                  key={finding.id}
                  data-testid="audit-row"
                  data-severity={finding.severity}
                  data-category={finding.category}
                  class="relative space-y-1 py-2 pr-2.5 pl-3"
                >
                  <span
                    class={`absolute inset-y-2 left-0 w-0.5 rounded-full ${SEVERITY_STYLE[finding.severity].bar}`}
                  />
                  <div class="flex items-center gap-1.5">
                    <span
                      class={`shrink-0 rounded px-1.5 py-px text-[10px] font-semibold uppercase ${SEVERITY_STYLE[finding.severity].badge}`}
                    >
                      {t(SEVERITY_KEYS[finding.severity])}
                    </span>
                    <Badge tone="neutral">{t(AUDIT_CATEGORY_KEYS[finding.category])}</Badge>
                    <div class="flex-1" />
                    <CopyDraftButton
                      testId="audit-draft"
                      buildDraft={() => draftAuditReport(finding, origin)}
                    />
                  </div>
                  <p class="text-[12px] font-medium text-zinc-100">{finding.title}</p>
                  <div class="flex items-center gap-1.5 font-mono text-[10px] text-zinc-400">
                    <span class="truncate">{finding.subject}</span>
                    {finding.preview && (
                      <code class="shrink-0 rounded bg-black/40 px-1 text-amber-200">
                        {finding.preview}
                      </code>
                    )}
                  </div>
                  <p class="text-[11px] leading-4 text-zinc-400">{finding.detail}</p>
                  <p class="text-[10px] leading-4 text-zinc-500">{finding.recommendation}</p>
                </li>
              ))}
            </ul>
          </div>
        )}
      </Section>
    </div>
  );
}
