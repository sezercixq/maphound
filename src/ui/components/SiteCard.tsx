import { useSignal } from '@preact/signals';
import { effectiveScope, scopeBaseHost } from '@/core/scope';
import { disableSiteFromUi, enableSiteFromUi, updateSiteSettingsFromUi } from '@/core/site-client';
import { type MessageKey, t } from '../i18n';
import { origin, refresh, site, useManualOrigin } from '../state';
import { Toggle } from './primitives';

const REASONS: Record<string, MessageKey> = {
  'permission-denied': 'permissionDenied',
  'permission-missing': 'permissionDenied',
  'invalid-origin': 'originInvalid',
};

function OriginForm({ onDone }: { onDone?: () => void }) {
  const input = useSignal(origin.value ?? '');
  const invalid = useSignal(false);
  return (
    <form
      class="space-y-1.5"
      onSubmit={(event) => {
        event.preventDefault();
        if (useManualOrigin(input.value)) {
          invalid.value = false;
          onDone?.();
        } else invalid.value = true;
      }}
    >
      <div class="flex gap-1.5">
        <input
          data-testid="origin-input"
          class="min-w-0 flex-1 rounded-md border border-zinc-700 bg-zinc-900 px-2 py-1.5 font-mono text-[12px] text-zinc-100 placeholder:text-zinc-600 focus:border-emerald-500 focus:outline-none"
          placeholder={t('originPlaceholder')}
          value={input.value}
          onInput={(event) => {
            input.value = event.currentTarget.value;
          }}
          spellcheck={false}
          autocomplete="off"
        />
        <button
          type="submit"
          data-testid="origin-submit"
          class="rounded-md bg-zinc-800 px-3 text-zinc-200 hover:bg-zinc-700"
        >
          {t('originUse')}
        </button>
      </div>
      {invalid.value && <p class="text-[11px] text-red-300">{t('originInvalid')}</p>}
    </form>
  );
}

export function SiteCard() {
  const subdomains = useSignal(false);
  const probing = useSignal(false);
  const busy = useSignal(false);
  const error = useSignal<string | null>(null);
  const editing = useSignal(false);
  const confirming = useSignal(false);

  const current = origin.value;
  const enabled = site.value;

  const enable = async () => {
    if (!current) return;
    busy.value = true;
    error.value = null;
    try {
      // First await in the click handler: Chrome only prompts inside the user gesture.
      const result = await enableSiteFromUi(current, subdomains.value ? 'subdomains' : 'origin', {
        aggressiveMapProbing: probing.value,
      });
      if (!result.ok) error.value = t(REASONS[result.reason] ?? 'permissionDenied');
    } catch (cause) {
      error.value = t('enableFailed', cause instanceof Error ? cause.message : String(cause));
    } finally {
      busy.value = false;
      await refresh();
    }
  };

  const disable = async () => {
    if (!enabled) return;
    busy.value = true;
    try {
      await disableSiteFromUi(enabled.origin, true);
    } finally {
      busy.value = false;
      confirming.value = false;
      await refresh();
    }
  };

  return (
    <div
      class="space-y-3 rounded-lg border border-white/[0.06] bg-white/[0.02] p-3"
      data-testid="site-card"
    >
      <div class="space-y-1">
        <div class="flex items-center justify-between text-[11px] font-semibold tracking-wider text-zinc-500 uppercase">
          {t('originLabel')}
          {current && !editing.value && (
            <button
              type="button"
              class="font-normal tracking-normal text-zinc-500 normal-case hover:text-zinc-300"
              onClick={() => {
                editing.value = true;
              }}
            >
              {t('originChange')}
            </button>
          )}
        </div>
        {!current || editing.value ? (
          <>
            {!current && <p class="text-[12px] text-zinc-400">{t('originUnavailable')}</p>}
            <OriginForm
              onDone={() => {
                editing.value = false;
              }}
            />
          </>
        ) : (
          <p
            class="truncate font-mono text-[13px] text-zinc-100"
            data-testid="origin"
            title={current}
          >
            {current}
          </p>
        )}
      </div>

      {current && enabled && (
        <div class="space-y-2">
          <p class="flex items-center gap-2 text-[12px] text-emerald-300" data-testid="site-status">
            <span class="size-2 rounded-full bg-emerald-400 shadow-[0_0_8px] shadow-emerald-400/60" />
            {t(enabled.scope === 'subdomains' ? 'enabledScopeSubdomains' : 'enabledScopeOrigin')}
          </p>
          {enabled.origin !== current && (
            <p class="font-mono text-[11px] text-zinc-500">{t('enabledVia', enabled.origin)}</p>
          )}
          <Toggle
            label={t('optionProbing')}
            hint={t('optionProbingHint')}
            checked={enabled.settings.aggressiveMapProbing}
            testId="toggle-probing"
            onChange={(value) => {
              void updateSiteSettingsFromUi(enabled.origin, { aggressiveMapProbing: value }).then(
                refresh,
              );
            }}
          />
          {confirming.value ? (
            <div class="space-y-2 rounded-md border border-red-500/30 bg-red-500/5 p-2">
              <p class="text-[12px] text-red-200">{t('disableConfirm')}</p>
              <div class="flex gap-2">
                <button
                  type="button"
                  data-testid="disable-confirm"
                  disabled={busy.value}
                  onClick={() => void disable()}
                  class="rounded-md bg-red-500 px-3 py-1 font-medium text-zinc-950 hover:bg-red-400 disabled:opacity-50"
                >
                  {t('confirmDelete')}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    confirming.value = false;
                  }}
                  class="rounded-md px-3 py-1 text-zinc-400 hover:text-zinc-200"
                >
                  {t('cancel')}
                </button>
              </div>
            </div>
          ) : (
            <button
              type="button"
              data-testid="disable"
              onClick={() => {
                confirming.value = true;
              }}
              class="text-[12px] text-zinc-500 underline-offset-2 hover:text-red-300 hover:underline"
            >
              {t('disable')}
            </button>
          )}
        </div>
      )}

      {current && !enabled && (
        <div class="space-y-1">
          <Toggle
            label={t('optionSubdomains')}
            hint={
              effectiveScope(current, 'subdomains') === 'subdomains'
                ? t('optionSubdomainsHint', scopeBaseHost(current, 'subdomains'))
                : undefined
            }
            checked={subdomains.value && effectiveScope(current, 'subdomains') === 'subdomains'}
            disabled={effectiveScope(current, 'subdomains') === 'origin'}
            testId="toggle-subdomains"
            onChange={(value) => {
              subdomains.value = value;
            }}
          />
          <Toggle
            label={t('optionProbing')}
            hint={t('optionProbingHint')}
            checked={probing.value}
            testId="toggle-probing"
            onChange={(value) => {
              probing.value = value;
            }}
          />
          <button
            type="button"
            data-testid="enable"
            disabled={busy.value}
            onClick={() => void enable()}
            class="mt-2 w-full rounded-md bg-emerald-500 px-3 py-2 font-semibold text-zinc-950 transition-colors hover:bg-emerald-400 disabled:opacity-60"
          >
            {busy.value ? t('enabling') : t('enable')}
          </button>
          <p class="pt-1 text-[11px] leading-4 text-zinc-500">{t('privacyNote')}</p>
        </div>
      )}

      {error.value && (
        <p class="text-[12px] text-red-300" data-testid="site-error">
          {error.value}
        </p>
      )}
    </div>
  );
}
