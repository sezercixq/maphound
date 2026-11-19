import { useSignal } from '@preact/signals';
import { formatBytes, statusOf, THIRD_PARTY_KEYS, VIA_KEYS } from '../format';
import { t } from '../i18n';
import type { MapRow, ScriptRow } from '../view-model';
import { Badge, Section } from './primitives';

const PAGE = 60;

function useLimit<T>(rows: T[]) {
  const limit = useSignal(PAGE);
  const visible = rows.slice(0, limit.value);
  const more = rows.length - visible.length;
  const button =
    more > 0 ? (
      <button
        type="button"
        class="w-full py-1.5 text-[12px] text-zinc-500 hover:text-zinc-300"
        onClick={() => {
          limit.value += PAGE * 4;
        }}
      >
        {t('showMore', more)}
      </button>
    ) : null;
  return { visible, button };
}

function ScriptItem({ row }: { row: ScriptRow }) {
  const status = statusOf(row.job);
  const map = row.maps[0];
  return (
    <li class="flex items-center gap-2 px-2 py-1.5" data-testid="script-row" title={row.job.url}>
      <div class="min-w-0 flex-1">
        <p
          class={`truncate font-mono text-[12px] ${row.thirdParty ? 'text-zinc-500' : 'text-zinc-200'}`}
        >
          {row.name}
        </p>
        <p class="truncate text-[11px] text-zinc-600">
          {row.host}
          {row.size !== null && <> · {formatBytes(row.size)}</>}
        </p>
      </div>
      {row.job.thirdParty && <Badge tone="muted">{t(THIRD_PARTY_KEYS[row.job.thirdParty])}</Badge>}
      {map && <Badge tone={statusOf(map).tone === 'error' ? 'error' : 'ok'}>.map</Badge>}
      <Badge tone={status.tone} title={row.job.error}>
        {t(status.key)}
      </Badge>
    </li>
  );
}

export function ScriptList({ rows }: { rows: ScriptRow[] }) {
  const { visible, button } = useLimit(rows);
  return (
    <Section title={t('sectionScripts')} count={rows.length}>
      {rows.length === 0 ? (
        <p class="px-1 text-[12px] text-zinc-600">{t('emptyScripts')}</p>
      ) : (
        <div class="overflow-hidden rounded-lg border border-white/[0.06]">
          <ul class="divide-y divide-white/[0.04]" data-testid="script-list">
            {visible.map((row) => (
              <ScriptItem key={row.job.id} row={row} />
            ))}
          </ul>
          {button}
        </div>
      )}
    </Section>
  );
}

function MapItem({ row }: { row: MapRow }) {
  const { job, record } = row;
  const status = statusOf(job);
  return (
    <li class="space-y-1 px-2 py-2" data-testid="map-row" title={job.url}>
      <div class="flex items-center gap-2">
        <p class="min-w-0 flex-1 truncate font-mono text-[12px] text-zinc-200">{row.name}</p>
        {job.via && <Badge tone="muted">{t(VIA_KEYS[job.via])}</Badge>}
        {!record && (
          <Badge tone={status.tone} title={job.error}>
            {t(status.key)}
          </Badge>
        )}
      </div>
      {record && (
        <div class="flex flex-wrap items-center gap-1.5 text-[11px] text-zinc-500">
          <span class="font-mono text-zinc-300" data-testid="map-files">
            {t('mapFiles', record.withContent)}
          </span>
          {record.vendorCount > 0 && <span>· {t('mapVendor', record.vendorCount)}</span>}
          {record.missingContent > 0 && <span>· {t('mapMissing', record.missingContent)}</span>}
          <span class="ml-auto flex gap-1">
            {record.partial && <Badge tone="warn">{t('mapPartial')}</Badge>}
            <Badge tone={record.hasSourcesContent ? 'ok' : 'muted'}>
              {t(record.hasSourcesContent ? 'mapSourcesIncluded' : 'mapNoSources')}
            </Badge>
          </span>
        </div>
      )}
    </li>
  );
}

export function MapList({ rows }: { rows: MapRow[] }) {
  const { visible, button } = useLimit(rows);
  return (
    <Section title={t('sectionMaps')} count={rows.length}>
      {rows.length === 0 ? (
        <p class="px-1 text-[12px] text-zinc-600">{t('emptyMaps')}</p>
      ) : (
        <div class="overflow-hidden rounded-lg border border-white/[0.06]">
          <ul class="divide-y divide-white/[0.04]" data-testid="map-list">
            {visible.map((row) => (
              <MapItem key={row.job.id} row={row} />
            ))}
          </ul>
          {button}
        </div>
      )}
    </Section>
  );
}
