import { useSignal } from '@preact/signals';
import type { Severity } from '@/core/db';
import {
  deleteCustomRuleFromUi,
  saveCustomRuleFromUi,
  toggleCustomRuleFromUi,
} from '@/core/site-client';
import {
  type CustomRuleRecord,
  type CustomRuleScope,
  testCustomRule,
  validateCustomRegex,
} from '@/engine/rules';
import { t } from '../i18n';
import { refresh } from '../state';
import { Badge, Section } from './primitives';

export function CustomRulesView({ rules }: { rules: readonly CustomRuleRecord[] }) {
  const name = useSignal('');
  const pattern = useSignal('');
  const flags = useSignal('i');
  const severity = useSignal<Severity>('high');
  const scope = useSignal<CustomRuleScope>('both');
  const sampleText = useSignal('');
  const saveError = useSignal<string | null>(null);
  const saving = useSignal(false);

  const safety = pattern.value.trim() ? validateCustomRegex(pattern.value, flags.value) : null;
  const playground =
    pattern.value.trim() && sampleText.value.trim()
      ? testCustomRule(pattern.value, flags.value, sampleText.value)
      : null;

  const handleSave = async (event: Event) => {
    event.preventDefault();
    saveError.value = null;
    if (!name.value.trim() || !pattern.value.trim()) {
      saveError.value = t('customRulesMissingFields');
      return;
    }
    saving.value = true;
    try {
      const id = `rule-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
      const res = await saveCustomRuleFromUi({
        id,
        name: name.value.trim().slice(0, 60),
        pattern: pattern.value.trim(),
        flags: flags.value.trim(),
        severity: severity.value,
        scope: scope.value,
        enabled: true,
        createdAt: Date.now(),
      });
      if (!res.ok) {
        saveError.value = res.error ?? t('customRulesUnsafe');
        return;
      }
      name.value = '';
      pattern.value = '';
      sampleText.value = '';
      await refresh();
    } finally {
      saving.value = false;
    }
  };

  return (
    <div class="space-y-4" data-testid="custom-rules-view">
      <Section title={t('customRulesStudioTitle')}>
        <form
          onSubmit={(e) => void handleSave(e)}
          class="space-y-2 rounded-lg border border-white/[0.06] bg-white/[0.02] p-2.5"
        >
          <input
            type="text"
            data-testid="custom-rule-name"
            placeholder={t('customRulesNamePlaceholder')}
            value={name.value}
            onInput={(e) => {
              name.value = e.currentTarget.value;
            }}
            class="w-full rounded border border-zinc-700 bg-zinc-900 px-2 py-1 text-[11px] text-zinc-100 placeholder:text-zinc-500 focus:border-emerald-500 focus:outline-none"
          />
          <div class="flex gap-1.5">
            <input
              type="text"
              data-testid="custom-rule-pattern"
              placeholder={t('customRulesPatternPlaceholder')}
              value={pattern.value}
              onInput={(e) => {
                pattern.value = e.currentTarget.value;
              }}
              spellcheck={false}
              class="min-w-0 flex-1 rounded border border-zinc-700 bg-zinc-900 px-2 py-1 font-mono text-[11px] text-zinc-100 placeholder:text-zinc-500 focus:border-emerald-500 focus:outline-none"
            />
            <input
              type="text"
              data-testid="custom-rule-flags"
              value={flags.value}
              onInput={(e) => {
                flags.value = e.currentTarget.value;
              }}
              maxLength={4}
              aria-label="flags"
              class="w-12 rounded border border-zinc-700 bg-zinc-900 px-1.5 py-1 text-center font-mono text-[11px] text-zinc-200 focus:border-emerald-500 focus:outline-none"
            />
          </div>
          <div class="flex gap-1.5">
            <select
              value={severity.value}
              onChange={(e) => {
                severity.value = e.currentTarget.value as Severity;
              }}
              class="flex-1 rounded border border-zinc-700 bg-zinc-900 px-2 py-1 text-[11px] text-zinc-200"
            >
              <option value="critical">critical</option>
              <option value="high">high</option>
              <option value="medium">medium</option>
              <option value="low">low</option>
              <option value="info">info</option>
            </select>
            <select
              value={scope.value}
              onChange={(e) => {
                scope.value = e.currentTarget.value as CustomRuleScope;
              }}
              class="flex-1 rounded border border-zinc-700 bg-zinc-900 px-2 py-1 text-[11px] text-zinc-200"
            >
              <option value="both">{t('customRulesScopeBoth')}</option>
              <option value="code">{t('customRulesScopeCode')}</option>
              <option value="html">{t('customRulesScopeHtml')}</option>
            </select>
          </div>

          {safety && (
            <div data-testid="custom-rule-safety" class="flex items-center gap-1.5 text-[10px]">
              <Badge tone={safety.safe ? 'ok' : 'error'}>
                {safety.safe ? t('customRulesRedosSafe') : t('customRulesRedosUnsafe')}
              </Badge>
              <span class="truncate text-zinc-400">
                {safety.safe ? `${safety.probeMs} ms` : safety.reason}
              </span>
            </div>
          )}

          <textarea
            rows={2}
            data-testid="custom-rule-sample"
            placeholder={t('customRulesPlaygroundPlaceholder')}
            value={sampleText.value}
            onInput={(e) => {
              sampleText.value = e.currentTarget.value;
            }}
            spellcheck={false}
            class="w-full rounded border border-zinc-700 bg-zinc-950 px-2 py-1 font-mono text-[10.5px] text-zinc-200 placeholder:text-zinc-600 focus:border-emerald-500 focus:outline-none"
          />

          {playground && (
            <div
              data-testid="custom-rule-playground-result"
              class="rounded border border-white/[0.06] bg-black/30 px-2 py-1.5 text-[10.5px]"
            >
              <p class="font-mono text-zinc-400">
                {t('customRulesMatchesCount', playground.matches.length)} ({playground.elapsedMs}{' '}
                ms)
              </p>
              {playground.matches.slice(0, 5).map((m) => (
                <p key={`${m.line}:${m.column}`} class="truncate font-mono text-emerald-300">
                  L{m.line}:{m.column} · {m.preview}
                </p>
              ))}
            </div>
          )}

          {saveError.value && <p class="text-[11px] text-red-300">{saveError.value}</p>}

          <button
            type="submit"
            data-testid="custom-rule-save"
            disabled={saving.value || Boolean(safety && !safety.safe)}
            class="w-full rounded-md bg-emerald-500/20 px-2.5 py-1.5 text-[11px] font-semibold text-emerald-300 transition-colors hover:bg-emerald-500/30 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {t('customRulesSaveBtn')}
          </button>
        </form>
      </Section>

      <Section title={t('customRulesListTitle')} count={rules.length}>
        {rules.length === 0 ? (
          <p class="px-1 text-[11px] text-zinc-500">{t('customRulesEmpty')}</p>
        ) : (
          <ul
            data-testid="custom-rules-list"
            class="divide-y divide-white/[0.05] overflow-hidden rounded-lg border border-white/[0.06] bg-white/[0.02]"
          >
            {rules.map((rule) => (
              <li key={rule.id} data-testid="custom-rule-item" class="space-y-1 px-2.5 py-2">
                <div class="flex items-center justify-between gap-2">
                  <div class="flex min-w-0 items-center gap-1.5">
                    <input
                      type="checkbox"
                      checked={rule.enabled}
                      onChange={(e) => {
                        void toggleCustomRuleFromUi(rule.id, e.currentTarget.checked).then(refresh);
                      }}
                      class="accent-emerald-500"
                    />
                    <span class="truncate text-[12px] font-medium text-zinc-100">{rule.name}</span>
                    <Badge tone="neutral">{rule.severity}</Badge>
                  </div>
                  <button
                    type="button"
                    data-testid="custom-rule-delete"
                    onClick={() => void deleteCustomRuleFromUi(rule.id).then(refresh)}
                    class="rounded px-1.5 py-0.5 text-[10px] text-zinc-500 hover:bg-red-500/15 hover:text-red-300"
                  >
                    {t('customRulesDelete')}
                  </button>
                </div>
                <p class="truncate font-mono text-[10.5px] text-zinc-400">
                  /{rule.pattern}/{rule.flags} · {rule.scope}
                </p>
              </li>
            ))}
          </ul>
        )}
      </Section>
    </div>
  );
}
