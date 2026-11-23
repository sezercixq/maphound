import { useSignal } from '@preact/signals';
import type {
  ArchitectureGraph,
  ArchitectureNode,
  ArchitectureTreeNode,
  SdkUsageSummary,
} from '@/engine/intel';
import { SDK_CATEGORY_KEYS } from '../format';
import { t } from '../i18n';
import { openCodeViewer } from '../state';
import { Badge, Section } from './primitives';

function SdkRow({
  sdk,
  origin,
  nodeMap,
}: {
  sdk: SdkUsageSummary;
  origin: string;
  nodeMap: Map<string, ArchitectureNode>;
}) {
  const expanded = useSignal(false);
  return (
    <li data-testid="arch-sdk-row" class="space-y-1.5 px-2.5 py-2">
      <button
        type="button"
        onClick={() => {
          expanded.value = !expanded.value;
        }}
        class="flex w-full items-center gap-1.5 text-left"
      >
        <span class="font-mono text-[10px] text-zinc-500">{expanded.value ? '▾' : '▸'}</span>
        <span class="text-[12px] font-medium text-zinc-100">{sdk.name}</span>
        <Badge tone="neutral">{t(SDK_CATEGORY_KEYS[sdk.category])}</Badge>
        <span class="ml-auto font-mono text-[10px] text-zinc-500">
          {t('archFilesCount', sdk.files.length)}
        </span>
      </button>
      {expanded.value && (
        <ul class="space-y-0.5 pl-4">
          {sdk.files.map((file) => {
            const mod = nodeMap.get(file);
            return (
              <li key={file}>
                <button
                  type="button"
                  onClick={() =>
                    openCodeViewer({
                      origin,
                      file,
                      line: 1,
                      kind: 'source',
                      scriptUrl: mod?.scriptUrl,
                      mapUrl: mod?.mapUrl,
                      label: sdk.name,
                    })
                  }
                  class="truncate font-mono text-[11px] text-zinc-400 hover:text-emerald-300 hover:underline"
                >
                  {file}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </li>
  );
}

function FileRow({
  node,
  origin,
  depth,
}: {
  node: ArchitectureNode;
  origin: string;
  depth: number;
}) {
  const expanded = useSignal(false);
  const fileName = node.file.split('/').pop() ?? node.file;
  const hasDetails =
    node.internalDeps.length > 0 ||
    node.importedBy.length > 0 ||
    node.exports.length > 0 ||
    node.endpoints.length > 0 ||
    node.packages.length > 0;

  return (
    <div
      data-testid="arch-file"
      class="space-y-1 py-1 pr-2"
      style={{ paddingLeft: `${depth * 12 + 8}px` }}
    >
      <div class="flex items-center gap-1.5">
        {hasDetails ? (
          <button
            type="button"
            aria-label={fileName}
            onClick={() => {
              expanded.value = !expanded.value;
            }}
            class="grid size-4 shrink-0 place-items-center text-[10px] text-zinc-500 hover:text-zinc-200"
          >
            {expanded.value ? '▾' : '▸'}
          </button>
        ) : (
          <span class="size-4 shrink-0" />
        )}
        <button
          type="button"
          title={`${t('openInViewer')}: ${node.file}`}
          onClick={() =>
            openCodeViewer({
              origin,
              file: node.file,
              line: node.endpoints[0]?.line ?? 1,
              kind: 'source',
              scriptUrl: node.scriptUrl,
              mapUrl: node.mapUrl,
              label: node.file,
            })
          }
          class="min-w-0 flex-1 truncate text-left font-mono text-[11px] text-zinc-200 hover:text-emerald-300 hover:underline"
        >
          {fileName}
        </button>
        {node.sdks.map((sdk) => (
          <Badge key={sdk.name} tone="busy">
            {sdk.name}
          </Badge>
        ))}
        {node.endpoints.length > 0 && <Badge tone="ok">{node.endpoints.length} API</Badge>}
      </div>

      {expanded.value && (
        <div class="space-y-1 rounded border border-white/[0.05] bg-black/25 p-2 text-[10px]">
          {node.endpoints.length > 0 && (
            <div>
              <p class="font-semibold text-zinc-500 uppercase">{t('archEndpoints')}</p>
              <ul class="mt-0.5 space-y-0.5 font-mono text-emerald-300">
                {node.endpoints.map((ep) => (
                  <li key={`${ep.value}:${ep.line}`} class="truncate">
                    {ep.methods.length > 0 ? `${ep.methods.join(',')} ` : ''}
                    {ep.value}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {node.exports.length > 0 && (
            <p class="font-mono text-zinc-400">
              <span class="font-sans font-semibold text-zinc-500">{t('archExports')}: </span>
              {node.exports.join(', ')}
            </p>
          )}
          {node.internalDeps.length > 0 && (
            <p class="font-mono text-zinc-400">
              <span class="font-sans font-semibold text-zinc-500">{t('archImports')}: </span>
              {node.internalDeps.join(', ')}
            </p>
          )}
          {node.importedBy.length > 0 && (
            <p class="font-mono text-zinc-400">
              <span class="font-sans font-semibold text-zinc-500">{t('archUsedBy')}: </span>
              {node.importedBy.join(', ')}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

function TreeBranch({
  item,
  origin,
  depth,
}: {
  item: ArchitectureTreeNode;
  origin: string;
  depth: number;
}) {
  const open = useSignal(depth < 3);
  if (item.kind === 'file' && item.module) {
    return <FileRow node={item.module} origin={origin} depth={depth} />;
  }
  return (
    <div data-testid="arch-folder">
      <button
        type="button"
        onClick={() => {
          open.value = !open.value;
        }}
        style={{ paddingLeft: `${depth * 12 + 8}px` }}
        class="flex w-full items-center gap-1.5 py-1 pr-2 text-left hover:bg-white/[0.03]"
      >
        <span class="text-[10px] text-zinc-500">{open.value ? '▾' : '▸'}</span>
        <span class="font-mono text-[11px] font-medium text-zinc-300">{item.name}/</span>
        <span class="ml-auto flex items-center gap-1.5 font-mono text-[10px] text-zinc-500">
          <span>{item.fileCount}</span>
          {item.endpointCount > 0 && (
            <span class="rounded bg-emerald-500/15 px-1 text-emerald-300">
              {item.endpointCount} API
            </span>
          )}
        </span>
      </button>
      {open.value && (
        <div>
          {item.children.map((child) => (
            <TreeBranch key={child.path} item={child} origin={origin} depth={depth + 1} />
          ))}
        </div>
      )}
    </div>
  );
}

export function ArchitectureView({ graph, origin }: { graph: ArchitectureGraph; origin: string }) {
  if (graph.nodes.length === 0) {
    return <p class="px-1 text-[12px] text-zinc-500">{t('archEmpty')}</p>;
  }

  const nodeMap = new Map(graph.nodes.map((n) => [n.file, n]));
  const statsTiles: [string, number][] = [
    [t('archModules'), graph.nodes.length],
    [t('archEdges'), graph.edges.length],
    [t('archSdks'), graph.sdks.length],
    [t('archFlows'), graph.dataFlows.length],
  ];

  return (
    <div class="space-y-4">
      <div class="grid grid-cols-4 gap-1.5">
        {statsTiles.map(([label, value]) => (
          <div
            key={label}
            class="rounded-md border border-white/[0.06] bg-white/[0.02] px-2 py-1.5"
          >
            <p class="font-mono text-[14px] leading-5 text-zinc-100 tabular-nums">{value}</p>
            <p class="truncate text-[9px] tracking-wide text-zinc-500 uppercase">{label}</p>
          </div>
        ))}
      </div>

      {graph.sdks.length > 0 && (
        <Section title={t('archSdks')} count={graph.sdks.length}>
          <div class="overflow-hidden rounded-lg border border-white/[0.06]">
            <ul class="divide-y divide-white/[0.04]" data-testid="arch-sdk-list">
              {graph.sdks.map((sdk) => (
                <SdkRow key={sdk.name} sdk={sdk} origin={origin} nodeMap={nodeMap} />
              ))}
            </ul>
          </div>
        </Section>
      )}

      <Section title={t('archTreeTitle')} count={graph.nodes.length}>
        <div
          data-testid="arch-tree"
          class="divide-y divide-white/[0.03] overflow-hidden rounded-lg border border-white/[0.06] py-1"
        >
          {graph.tree.map((branch) => (
            <TreeBranch key={branch.path} item={branch} origin={origin} depth={0} />
          ))}
        </div>
      </Section>
    </div>
  );
}
