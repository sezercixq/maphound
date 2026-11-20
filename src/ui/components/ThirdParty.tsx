import { useSignal } from '@preact/signals';
import { allowOriginsFromUi, removeOriginFromUi } from '@/core/site-client';
import { THIRD_PARTY_KEYS } from '../format';
import { t } from '../i18n';
import { refresh } from '../state';
import type { AllowedOrigin, ThirdPartyGroup } from '../view-model';
import { Badge, Section } from './primitives';

function counts(group: ThirdPartyGroup): string {
  const parts: string[] = [];
  if (group.scripts > 0)
    parts.push(group.scripts === 1 ? t('originScriptsOne') : t('originScripts', group.scripts));
  if (group.maps > 0)
    parts.push(group.maps === 1 ? t('originMapsOne') : t('originMaps', group.maps));
  return parts.join(' · ');
}

/** Pick the origins a bulk "Allow & scan all" covers. Pure, exported for tests. */
export function bulkCandidates(
  groups: readonly ThirdPartyGroup[],
  includeAnalytics: boolean,
): string[] {
  return groups
    .filter((group) => includeAnalytics || group.kind !== 'analytics')
    .map((group) => group.origin);
}

export function ThirdPartyOrigins({
  siteOrigin,
  groups,
  allowed,
}: {
  siteOrigin: string;
  groups: ThirdPartyGroup[];
  allowed: AllowedOrigin[];
}) {
  const includeAnalytics = useSignal(false);
  const busy = useSignal<string | null>(null);
  const error = useSignal<string | null>(null);

  if (groups.length === 0 && allowed.length === 0) return null;
  const analytics = groups.filter((group) => group.kind === 'analytics').length;
  const candidates = bulkCandidates(groups, includeAnalytics.value);

  const allow = async (origins: string[], key: string) => {
    busy.value = key;
    error.value = null;
    try {
      // First await in the click handler: Chrome only prompts inside the user gesture.
      const result = await allowOriginsFromUi(siteOrigin, origins);
      if (!result.ok) error.value = t('permissionDenied');
    } catch (cause) {
      error.value = t('enableFailed', cause instanceof Error ? cause.message : String(cause));
    } finally {
      busy.value = null;
      await refresh();
    }
  };

  return (
    <Section title={t('sectionThirdParty')} count={groups.length}>
      {groups.length > 0 && (
        <div
          class="space-y-2 rounded-lg border border-amber-400/15 bg-amber-400/[0.03] p-2"
          data-testid="third-party"
        >
          <p class="px-1 text-[11px] leading-4 text-zinc-400">{t('thirdPartyHint')}</p>
          {groups.length >= 2 && (
            <div class="space-y-1.5">
              <button
                type="button"
                data-testid="allow-all"
                disabled={busy.value !== null || candidates.length === 0}
                onClick={() => void allow(candidates, 'all')}
                class="w-full rounded-md bg-amber-400 px-3 py-1.5 text-[12px] font-semibold text-zinc-950 hover:bg-amber-300 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {busy.value === 'all' ? t('enabling') : t('allowScanAll', candidates.length)}
              </button>
              {analytics > 0 && (
                <label class="flex cursor-pointer items-center gap-2 px-1 text-[11px] text-zinc-400">
                  <input
                    type="checkbox"
                    data-testid="include-analytics"
                    class="accent-amber-400"
                    checked={includeAnalytics.value}
                    onChange={(event) => {
                      includeAnalytics.value = event.currentTarget.checked;
                    }}
                  />
                  {t('includeAnalytics', analytics)}
                </label>
              )}
            </div>
          )}
          <ul class="divide-y divide-white/[0.04] overflow-hidden rounded-md border border-white/[0.06] bg-[#0b0d11]">
            {groups.map((group) => (
              <li
                key={group.origin}
                class="flex items-center gap-2 px-2 py-1.5"
                data-testid="third-party-row"
                title={group.origin}
              >
                <div class="min-w-0 flex-1">
                  <p class="truncate font-mono text-[12px] text-zinc-200">{group.host}</p>
                  <p class="flex items-center gap-1.5 truncate text-[11px] text-zinc-500">
                    {counts(group)}
                    <Badge tone="muted">{t(THIRD_PARTY_KEYS[group.kind])}</Badge>
                    {group.related && <Badge tone="ok">{t('relatedDomain')}</Badge>}
                  </p>
                </div>
                <button
                  type="button"
                  data-testid="allow-origin"
                  disabled={busy.value !== null}
                  onClick={() => void allow([group.origin], group.origin)}
                  class="shrink-0 rounded-md border border-amber-400/40 px-2 py-1 text-[11px] font-medium text-amber-200 hover:bg-amber-400/10 disabled:opacity-50"
                >
                  {busy.value === group.origin ? t('enabling') : t('allowScan')}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
      {allowed.length > 0 && (
        <div class="space-y-1 px-1" data-testid="allowed-origins">
          <p class="text-[11px] text-zinc-500">{t('allowedOrigins')}</p>
          {allowed.map((origin) => (
            <div
              key={origin.origin}
              class="flex items-center gap-2 text-[11px]"
              data-testid="allowed-origin"
            >
              <span class="size-1.5 rounded-full bg-emerald-400" />
              <span class="min-w-0 flex-1 truncate font-mono text-zinc-300">{origin.host}</span>
              <span class="text-zinc-500">
                {origin.scripts === 1 ? t('originScriptsOne') : t('originScripts', origin.scripts)}
              </span>
              <button
                type="button"
                data-testid="remove-origin"
                title={t('removeOrigin', origin.host)}
                aria-label={t('removeOrigin', origin.host)}
                onClick={() => {
                  void removeOriginFromUi(siteOrigin, origin.origin).then(refresh);
                }}
                class="grid size-5 place-items-center rounded text-zinc-500 hover:bg-white/[0.06] hover:text-red-300"
              >
                ×
              </button>
            </div>
          ))}
        </div>
      )}
      {error.value && (
        <p class="px-1 text-[12px] text-red-300" data-testid="third-party-error">
          {error.value}
        </p>
      )}
    </Section>
  );
}
