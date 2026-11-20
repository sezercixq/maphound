import { useSignal } from '@preact/signals';
import { useEffect } from 'preact/hooks';
import { FindingList } from './components/Findings';
import { MapList, ScriptList } from './components/Lists';
import { SiteCard } from './components/SiteCard';
import { ThirdPartyOrigins } from './components/ThirdParty';
import { downloadSourcesZip } from './export-client';
import { t } from './i18n';
import { site, startState, view } from './state';
import type { Stats } from './view-model';

function Logo() {
  return (
    <svg
      viewBox="0 0 24 24"
      class="size-6 text-emerald-400"
      fill="none"
      stroke="currentColor"
      stroke-width="1.8"
      aria-hidden="true"
    >
      <path
        d="M4 7l4-3 4 3 4-3 4 3v13l-4-3-4 3-4-3-4 3z"
        stroke-linejoin="round"
        class="text-zinc-600"
        stroke="currentColor"
      />
      <circle cx="12" cy="11.5" r="3.2" />
      <path d="M14.4 13.9L17 16.5" stroke-linecap="round" />
    </svg>
  );
}

function StatsRow({ stats }: { stats: Stats }) {
  const tiles: [string, number, string][] = [
    [t('statScripts'), stats.scripts, 'stat-scripts'],
    [t('statMaps'), stats.maps, 'stat-maps'],
    [t('statFiles'), stats.files, 'stat-files'],
    [t('statThirdParty'), stats.thirdParty, 'stat-third-party'],
  ];
  return (
    <div class="grid grid-cols-4 gap-1.5">
      {tiles.map(([label, value, id]) => (
        <div key={id} class="rounded-md border border-white/[0.06] bg-white/[0.02] px-2 py-1.5">
          <p class="font-mono text-[15px] leading-5 text-zinc-100 tabular-nums" data-testid={id}>
            {value}
          </p>
          <p class="truncate text-[10px] tracking-wide text-zinc-500 uppercase">{label}</p>
        </div>
      ))}
    </div>
  );
}

type ExportState =
  | { kind: 'idle' }
  | { kind: 'busy'; done: number; total: number }
  | { kind: 'done'; files: number }
  | { kind: 'error'; message: string };

function ExportBar({ origin, exportable }: { origin: string; exportable: boolean }) {
  const state = useSignal<ExportState>({ kind: 'idle' });
  const includeSecrets = useSignal(false);
  const current = state.value;
  const run = async () => {
    state.value = { kind: 'busy', done: 0, total: 0 };
    try {
      const outcome = await downloadSourcesZip(
        origin,
        (done, total) => {
          state.value = { kind: 'busy', done, total };
        },
        includeSecrets.value,
      );
      state.value = { kind: 'done', files: outcome.files };
    } catch (error) {
      state.value = {
        kind: 'error',
        message: error instanceof Error ? error.message : String(error),
      };
    }
  };
  return (
    <div class="sticky bottom-0 -mx-3 border-t border-white/[0.06] bg-[#0b0d11]/95 px-3 py-3 backdrop-blur">
      <label class="mb-2 flex cursor-pointer items-start gap-2 text-[11px] text-zinc-400">
        <input
          type="checkbox"
          data-testid="include-secrets"
          class="mt-0.5 accent-red-500"
          checked={includeSecrets.value}
          onChange={(event) => {
            includeSecrets.value = event.currentTarget.checked;
          }}
        />
        <span>
          {t('includeSecrets')}
          {includeSecrets.value && (
            <span class="block text-red-300">{t('includeSecretsWarning')}</span>
          )}
        </span>
      </label>
      <button
        type="button"
        data-testid="download-zip"
        disabled={!exportable || current.kind === 'busy'}
        onClick={() => void run()}
        class="flex w-full items-center justify-center gap-2 rounded-md bg-emerald-500 px-3 py-2 font-semibold text-zinc-950 transition-colors hover:bg-emerald-400 disabled:cursor-not-allowed disabled:bg-zinc-800 disabled:text-zinc-500"
      >
        <svg viewBox="0 0 20 20" class="size-4" fill="currentColor" aria-hidden="true">
          <path d="M10 3a1 1 0 011 1v7.59l2.3-2.3a1 1 0 111.4 1.42l-4 4a1 1 0 01-1.4 0l-4-4a1 1 0 111.4-1.42L9 11.6V4a1 1 0 011-1zM4 15a1 1 0 011 1v1h10v-1a1 1 0 112 0v2a1 1 0 01-1 1H4a1 1 0 01-1-1v-2a1 1 0 011-1z" />
        </svg>
        {current.kind === 'busy' && current.total > 0
          ? t('downloadPreparing', current.done, current.total)
          : t('downloadZip')}
      </button>
      <p class="mt-1.5 text-center text-[11px] text-zinc-500" data-testid="download-status">
        {!exportable && current.kind === 'idle' && t('downloadNothing')}
        {current.kind === 'done' && (
          <span class="text-emerald-300">{t('downloadDone', current.files)}</span>
        )}
        {current.kind === 'error' && (
          <span class="text-red-300">{t('downloadFailed', current.message)}</span>
        )}
      </p>
    </div>
  );
}

export function App() {
  useEffect(() => startState(), []);
  const enabled = site.value;
  const model = view.value;
  return (
    <div class="flex min-h-screen flex-col gap-4 px-3 pt-3">
      <header class="flex items-center gap-2.5">
        <Logo />
        <div class="min-w-0">
          <h1 class="text-[15px] leading-5 font-semibold tracking-tight text-zinc-100">MapHound</h1>
          <p class="text-[11px] text-zinc-500">{t('tagline')}</p>
        </div>
      </header>
      <SiteCard />
      {enabled && (
        <>
          <StatsRow stats={model.stats} />
          <FindingList
            findings={model.findings}
            counts={model.findingCounts}
            scanning={model.scanning}
            origin={enabled.origin}
          />
          <ThirdPartyOrigins
            siteOrigin={enabled.origin}
            groups={model.thirdParty}
            allowed={model.allowedOrigins}
          />
          <ScriptList rows={model.scripts} />
          <MapList rows={model.maps} />
          <div class="flex-1" />
          <ExportBar origin={enabled.origin} exportable={model.stats.exportable} />
        </>
      )}
    </div>
  );
}
