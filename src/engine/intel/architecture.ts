import type { LexResult, LineIndex } from './lexer';
import {
  DYNAMIC_IMPORT_BEFORE,
  EXPORT_DECLARATION,
  EXPORT_DEFAULT_ANON,
  EXPORT_LIST,
  IMPORT_FROM_BEFORE,
} from './patterns';
import {
  type EndpointCategory,
  type EndpointHit,
  HTTP_METHODS,
  type HttpMethod,
  type IntelLocation,
  type ModuleEndpointRef,
  type ModuleSummary,
  type SdkCategory,
  type SdkMatch,
} from './types';

export const MAX_IMPORTS_PER_FILE = 80;
export const MAX_EXPORTS_PER_FILE = 80;
export const MAX_MODULES_PER_SITE = 1_000;

interface SdkRule {
  name: string;
  category: SdkCategory;
  packages: readonly string[];
  globals?: readonly string[];
  requireToken?: string;
}

export const SDK_CATALOG: readonly SdkRule[] = [
  {
    name: 'Stripe',
    category: 'payment',
    packages: ['@stripe/', 'stripe'],
    globals: ['loadStripe(', 'window.Stripe('],
  },
  {
    name: 'Firebase',
    category: 'backend',
    packages: ['firebase', '@firebase/'],
    globals: ['initializeApp(', 'getFirestore(', 'getAuth('],
  },
  {
    name: 'Sentry',
    category: 'monitoring',
    packages: ['@sentry/'],
    globals: ['Sentry.init('],
  },
  {
    name: 'Auth0',
    category: 'auth',
    packages: ['@auth0/'],
    globals: ['Auth0Provider', 'createAuth0Client('],
  },
  {
    name: 'Supabase',
    category: 'backend',
    packages: ['@supabase/'],
    globals: ['createBrowserClient('],
    requireToken: 'supabase',
  },
  {
    name: 'Segment',
    category: 'analytics',
    packages: ['@segment/'],
    globals: ['analytics.track(', 'analytics.identify('],
  },
  {
    name: 'PostHog',
    category: 'analytics',
    packages: ['posthog-js', 'posthog-node'],
    globals: ['posthog.init(', 'posthog.capture('],
  },
  {
    name: 'Mixpanel',
    category: 'analytics',
    packages: ['mixpanel-browser', 'mixpanel'],
    globals: ['mixpanel.init('],
  },
  {
    name: 'Amplitude',
    category: 'analytics',
    packages: ['@amplitude/', 'amplitude-js'],
    globals: ['amplitude.init('],
  },
  {
    name: 'Datadog',
    category: 'monitoring',
    packages: ['@datadog/'],
    globals: ['DD_RUM'],
  },
  {
    name: 'Clerk',
    category: 'auth',
    packages: ['@clerk/'],
    globals: ['ClerkProvider'],
  },
  {
    name: 'LaunchDarkly',
    category: 'backend',
    packages: ['launchdarkly-'],
  },
  {
    name: 'AWS SDK',
    category: 'cloud',
    packages: ['aws-amplify', '@aws-sdk/'],
  },
  {
    name: 'OpenAI',
    category: 'ai',
    packages: ['openai'],
  },
  {
    name: 'Anthropic',
    category: 'ai',
    packages: ['@anthropic-ai/'],
  },
  {
    name: 'GraphQL Client',
    category: 'backend',
    packages: ['@apollo/client', 'graphql-request', 'urql'],
  },
  {
    name: 'Realtime WS',
    category: 'realtime',
    packages: ['socket.io-client', 'pusher-js'],
  },
];

export interface ArchitectureNode {
  file: string;
  scriptUrl: string;
  mapUrl?: string;
  imports: string[];
  internalDeps: string[];
  importedBy: string[];
  packages: string[];
  exports: string[];
  endpoints: ModuleEndpointRef[];
  sdks: SdkMatch[];
}

export interface ArchitectureEdge {
  from: string;
  to: string;
}

export interface DataFlowLink {
  file: string;
  endpoint: string;
  methods: HttpMethod[];
  category: EndpointCategory;
  line: number;
}

export interface SdkUsageSummary {
  name: string;
  category: SdkCategory;
  files: string[];
}

export interface ArchitectureTreeNode {
  name: string;
  path: string;
  kind: 'folder' | 'file';
  fileCount: number;
  endpointCount: number;
  sdkCount: number;
  children: ArchitectureTreeNode[];
  module?: ArchitectureNode;
}

export interface ArchitectureGraph {
  nodes: ArchitectureNode[];
  edges: ArchitectureEdge[];
  dataFlows: DataFlowLink[];
  sdks: SdkUsageSummary[];
  tree: ArchitectureTreeNode[];
}

function canonicalPackage(specifier: string): string | null {
  if (!specifier || specifier.startsWith('.') || specifier.startsWith('/')) return null;
  if (/^[a-z][a-z0-9+.-]*:/i.test(specifier)) return null;
  const parts = specifier.split('/');
  if (specifier.startsWith('@') && parts.length >= 2) {
    return `${parts[0]}/${parts[1]}`;
  }
  return parts[0] || null;
}

function matchesPackagePrefix(specifier: string, prefix: string): boolean {
  if (prefix.endsWith('/') || prefix.endsWith('-')) return specifier.startsWith(prefix);
  return specifier === prefix || specifier.startsWith(`${prefix}/`);
}

function detectSdks(imports: readonly string[], code: string): SdkMatch[] {
  const found = new Map<string, SdkMatch>();
  const lowerCode = code.toLowerCase();

  for (const rule of SDK_CATALOG) {
    const imported = imports.some((spec) =>
      rule.packages.some((prefix) => matchesPackagePrefix(spec, prefix)),
    );
    if (imported) {
      found.set(rule.name, { name: rule.name, category: rule.category, source: 'import' });
      continue;
    }
    if (rule.globals && (!rule.requireToken || lowerCode.includes(rule.requireToken))) {
      if (rule.globals.some((marker) => code.includes(marker))) {
        found.set(rule.name, { name: rule.name, category: rule.category, source: 'global' });
      }
    }
  }
  return [...found.values()];
}

export function extractModuleSummary(
  text: string,
  lexed: LexResult,
  _lines: LineIndex,
  base: Omit<IntelLocation, 'line' | 'column'>,
  endpoints: readonly EndpointHit[],
): ModuleSummary {
  const imports = new Set<string>();
  for (const tok of lexed.strings) {
    if (imports.size >= MAX_IMPORTS_PER_FILE) break;
    const spec = tok.value.trim();
    if (!spec || spec.length > 220 || /[\s\r\n]/.test(spec)) continue;
    const before = text.slice(Math.max(0, tok.start - 200), tok.start);
    if (IMPORT_FROM_BEFORE.test(before) || DYNAMIC_IMPORT_BEFORE.test(before)) {
      imports.add(spec);
    }
  }

  const exportsSet = new Set<string>();
  const code = lexed.code;
  if (code) {
    EXPORT_DECLARATION.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = EXPORT_DECLARATION.exec(code)) !== null) {
      if (exportsSet.size >= MAX_EXPORTS_PER_FILE) break;
      const name = match[1];
      if (name) exportsSet.add(name);
    }

    EXPORT_LIST.lastIndex = 0;
    while ((match = EXPORT_LIST.exec(code)) !== null) {
      if (exportsSet.size >= MAX_EXPORTS_PER_FILE) break;
      const body = match[1] ?? '';
      for (const rawPart of body.split(',')) {
        const cleaned = rawPart.replace(/\btype\s+/, '').trim();
        if (!cleaned) continue;
        const asParts = cleaned.split(/\s+as\s+/);
        const exported = (asParts[1] ?? asParts[0] ?? '').trim();
        if (/^[A-Za-z_$][\w$]{0,60}$/.test(exported)) {
          exportsSet.add(exported);
          if (exportsSet.size >= MAX_EXPORTS_PER_FILE) break;
        }
      }
    }

    if (exportsSet.size < MAX_EXPORTS_PER_FILE) {
      EXPORT_DEFAULT_ANON.lastIndex = 0;
      if (EXPORT_DEFAULT_ANON.test(code)) exportsSet.add('default');
    }
  }

  const importList = [...imports];
  const endpointRefs: ModuleEndpointRef[] = endpoints.map((ep) => ({
    value: ep.value,
    methods: [...ep.methods],
    category: ep.category,
    line: ep.locations[0]?.line ?? 1,
  }));

  return {
    file: base.file,
    scriptUrl: base.scriptUrl,
    ...(base.mapUrl ? { mapUrl: base.mapUrl } : {}),
    imports: importList,
    exports: [...exportsSet].sort(),
    endpoints: endpointRefs,
    sdks: detectSdks(importList, code),
  };
}

const RESOLVE_EXTENSIONS = [
  '',
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.mjs',
  '.vue',
  '.svelte',
  '/index.ts',
  '/index.tsx',
  '/index.js',
  '/index.jsx',
];

function normalizePosix(segments: string[]): string {
  const stack: string[] = [];
  for (const part of segments) {
    if (!part || part === '.') continue;
    if (part === '..') {
      if (stack.length > 0) stack.pop();
    } else {
      stack.push(part);
    }
  }
  return stack.join('/');
}

/** Resolve a relative import (`./api`, `../shared/auth`) against known first-party files. */
export function resolveInternalImport(
  fromFile: string,
  specifier: string,
  knownFiles: ReadonlySet<string>,
): string | null {
  if (!specifier.startsWith('./') && !specifier.startsWith('../')) return null;
  const dirParts = fromFile.split('/');
  dirParts.pop();
  const base = normalizePosix([...dirParts, ...specifier.split('/')]);
  if (!base) return null;
  for (const ext of RESOLVE_EXTENSIONS) {
    const candidate = `${base}${ext}`;
    if (knownFiles.has(candidate) && candidate !== fromFile) return candidate;
  }
  return null;
}

interface MutableFolder {
  name: string;
  path: string;
  folders: Map<string, MutableFolder>;
  files: ArchitectureNode[];
}

function toTree(folder: MutableFolder): ArchitectureTreeNode[] {
  const nodes: ArchitectureTreeNode[] = [];
  const subFolders = [...folder.folders.values()].sort((a, b) => a.name.localeCompare(b.name));
  for (const sub of subFolders) {
    const children = toTree(sub);
    const fileCount = children.reduce((n, c) => n + c.fileCount, 0);
    const endpointCount = children.reduce((n, c) => n + c.endpointCount, 0);
    const sdkCount = children.reduce((n, c) => n + c.sdkCount, 0);
    nodes.push({
      name: sub.name,
      path: sub.path,
      kind: 'folder',
      fileCount,
      endpointCount,
      sdkCount,
      children,
    });
  }
  const files = [...folder.files].sort((a, b) => a.file.localeCompare(b.file));
  for (const mod of files) {
    const name = mod.file.split('/').pop() ?? mod.file;
    nodes.push({
      name,
      path: mod.file,
      kind: 'file',
      fileCount: 1,
      endpointCount: mod.endpoints.length,
      sdkCount: mod.sdks.length,
      children: [],
      module: mod,
    });
  }
  return nodes;
}

export function buildArchitectureGraph(modules: readonly ModuleSummary[]): ArchitectureGraph {
  const byFile = new Map<string, ModuleSummary>();
  for (const mod of modules) {
    const existing = byFile.get(mod.file);
    if (!existing) {
      byFile.set(mod.file, {
        ...mod,
        imports: [...mod.imports],
        exports: [...mod.exports],
        endpoints: [...mod.endpoints],
        sdks: [...mod.sdks],
      });
    } else {
      for (const imp of mod.imports)
        if (!existing.imports.includes(imp)) existing.imports.push(imp);
      for (const exp of mod.exports)
        if (!existing.exports.includes(exp)) existing.exports.push(exp);
      for (const ep of mod.endpoints) {
        if (!existing.endpoints.some((x) => x.value === ep.value && x.line === ep.line)) {
          existing.endpoints.push(ep);
        }
      }
      for (const sdk of mod.sdks) {
        if (!existing.sdks.some((x) => x.name === sdk.name)) existing.sdks.push(sdk);
      }
    }
  }

  const knownFiles = new Set(byFile.keys());
  const importedByMap = new Map<string, Set<string>>();
  for (const file of knownFiles) importedByMap.set(file, new Set());

  const edges: ArchitectureEdge[] = [];
  const dataFlows: DataFlowLink[] = [];
  const sdkFilesMap = new Map<string, { category: SdkCategory; files: Set<string> }>();
  const nodesMap = new Map<string, ArchitectureNode>();

  for (const mod of [...byFile.values()].sort((a, b) => a.file.localeCompare(b.file))) {
    const internalDeps = new Set<string>();
    const packages = new Set<string>();

    for (const spec of mod.imports) {
      const resolved = resolveInternalImport(mod.file, spec, knownFiles);
      if (resolved) {
        internalDeps.add(resolved);
        importedByMap.get(resolved)?.add(mod.file);
        edges.push({ from: mod.file, to: resolved });
      } else {
        const pkg = canonicalPackage(spec);
        if (pkg) packages.add(pkg);
      }
    }

    for (const ep of mod.endpoints) {
      dataFlows.push({
        file: mod.file,
        endpoint: ep.value,
        methods: [...ep.methods],
        category: ep.category,
        line: ep.line,
      });
    }

    for (const sdk of mod.sdks) {
      const entry = sdkFilesMap.get(sdk.name) ?? { category: sdk.category, files: new Set() };
      entry.files.add(mod.file);
      sdkFilesMap.set(sdk.name, entry);
    }

    nodesMap.set(mod.file, {
      file: mod.file,
      scriptUrl: mod.scriptUrl,
      ...(mod.mapUrl ? { mapUrl: mod.mapUrl } : {}),
      imports: [...mod.imports].sort(),
      internalDeps: [...internalDeps].sort(),
      importedBy: [],
      packages: [...packages].sort(),
      exports: [...mod.exports].sort(),
      endpoints: [...mod.endpoints].sort((a, b) => a.value.localeCompare(b.value)),
      sdks: [...mod.sdks].sort((a, b) => a.name.localeCompare(b.name)),
    });
  }

  for (const [file, callers] of importedByMap.entries()) {
    const node = nodesMap.get(file);
    if (node) node.importedBy = [...callers].sort();
  }

  const nodes = [...nodesMap.values()];
  const sdks: SdkUsageSummary[] = [...sdkFilesMap.entries()]
    .map(([name, info]) => ({
      name,
      category: info.category,
      files: [...info.files].sort(),
    }))
    .sort((a, b) => b.files.length - a.files.length || a.name.localeCompare(b.name));

  dataFlows.sort((a, b) => a.file.localeCompare(b.file) || a.endpoint.localeCompare(b.endpoint));

  // Build hierarchical folder tree.
  const root: MutableFolder = { name: '', path: '', folders: new Map(), files: [] };
  for (const node of nodes) {
    const segments = node.file.split('/').filter(Boolean);
    if (segments.length <= 1) {
      root.files.push(node);
      continue;
    }
    let cursor = root;
    let prefix = '';
    for (let i = 0; i < segments.length - 1; i++) {
      const seg = segments[i] as string;
      prefix = prefix ? `${prefix}/${seg}` : seg;
      let child = cursor.folders.get(seg);
      if (!child) {
        child = { name: seg, path: prefix, folders: new Map(), files: [] };
        cursor.folders.set(seg, child);
      }
      cursor = child;
    }
    cursor.files.push(node);
  }

  return {
    nodes,
    edges,
    dataFlows,
    sdks,
    tree: toTree(root),
  };
}

function mermaidLabel(value: string): string {
  return value.replace(/["<>[\](){}]/g, '').replace(/\r?\n/g, ' ');
}

function cell(value: string): string {
  return value.replace(/\r?\n/g, ' ').replace(/\|/g, '\\|');
}

function code(value: string): string {
  const text = value.replace(/\r?\n/g, ' ').replace(/\|/g, '\\|');
  return text.includes('`') ? `\`\` ${text} \`\`` : `\`${text}\``;
}

export function architectureMarkdown(
  graph: ArchitectureGraph,
  context: { origin: string; generator: string; exportedAt: string },
): string {
  const lines: string[] = [
    `# MapHound architecture & data flow: ${context.origin}`,
    '',
    `Generated ${context.exportedAt} by ${context.generator}.`,
    '',
    `- **First-party modules:** ${graph.nodes.length}`,
    `- **Internal dependency edges:** ${graph.edges.length}`,
    `- **Third-party SDKs detected:** ${graph.sdks.length}`,
    `- **Module → API data flows:** ${graph.dataFlows.length}`,
    '',
  ];

  if (graph.nodes.length === 0) {
    lines.push('No first-party source modules were rebuilt for this site.', '');
    return lines.join('\n');
  }

  // Prioritize modules that participate in internal edges, API calls, or SDK usage.
  const ranked = [...graph.nodes]
    .sort(
      (a, b) =>
        b.endpoints.length * 3 +
          b.sdks.length * 2 +
          b.internalDeps.length +
          b.importedBy.length -
          (a.endpoints.length * 3 +
            a.sdks.length * 2 +
            a.internalDeps.length +
            a.importedBy.length) || a.file.localeCompare(b.file),
    )
    .slice(0, 35);

  lines.push('## Dependency & Data-Flow Diagram', '', '```mermaid', 'flowchart LR');
  const modIds = new Map<string, string>();
  const epIds = new Map<string, string>();
  const sdkIds = new Map<string, string>();
  let epSeq = 0;
  let sdkSeq = 0;

  for (const [idx, node] of ranked.entries()) {
    const id = `M${idx}`;
    modIds.set(node.file, id);
    lines.push(`  ${id}["${mermaidLabel(node.file)}"]`);
  }

  for (const edge of graph.edges) {
    const fromId = modIds.get(edge.from);
    const toId = modIds.get(edge.to);
    if (fromId && toId) lines.push(`  ${fromId} --> ${toId}`);
  }

  for (const node of ranked) {
    const fromId = modIds.get(node.file);
    if (!fromId) continue;
    for (const ep of node.endpoints.slice(0, 6)) {
      let eid = epIds.get(ep.value);
      if (!eid && epSeq < 40) {
        eid = `E${epSeq++}`;
        epIds.set(ep.value, eid);
        lines.push(`  ${eid}(("${mermaidLabel(ep.value)}"))`);
      }
      if (eid) {
        const verb = ep.methods.length > 0 ? ep.methods.join(',') : 'API';
        lines.push(`  ${fromId} -->|${mermaidLabel(verb)}| ${eid}`);
      }
    }
    for (const sdk of node.sdks) {
      let sid = sdkIds.get(sdk.name);
      if (!sid) {
        sid = `S${sdkSeq++}`;
        sdkIds.set(sdk.name, sid);
        lines.push(`  ${sid}[["SDK: ${mermaidLabel(sdk.name)}"]]`);
      }
      lines.push(`  ${fromId} -.-> ${sid}`);
    }
  }

  lines.push('```', '');

  if (graph.sdks.length > 0) {
    lines.push(`## Third-Party SDK Usage (${graph.sdks.length})`, '');
    lines.push('| SDK | Category | Files |', '| --- | --- | --- |');
    for (const sdk of graph.sdks) {
      const fileList = sdk.files.slice(0, 8).map(code).join(', ');
      const extra = sdk.files.length > 8 ? ` (+${sdk.files.length - 8} more)` : '';
      lines.push(`| ${cell(sdk.name)} | ${cell(sdk.category)} | ${fileList}${extra} |`);
    }
    lines.push('');
  }

  if (graph.dataFlows.length > 0) {
    lines.push(`## File → Endpoint Data Flows (${graph.dataFlows.length})`, '');
    lines.push('| File | Endpoint | Methods |', '| --- | --- | --- |');
    for (const flow of graph.dataFlows) {
      const methods =
        flow.methods.length > 0
          ? [...flow.methods]
              .sort((a, b) => HTTP_METHODS.indexOf(a) - HTTP_METHODS.indexOf(b))
              .join(', ')
          : '–';
      lines.push(
        `| ${code(`${flow.file}:${flow.line}`)} | ${code(flow.endpoint)} | ${cell(methods)} |`,
      );
    }
    lines.push('');
  }

  lines.push(`## Module Inventory (${graph.nodes.length})`, '');
  lines.push(
    '| Module | Exports | Internal Imports | External Packages |',
    '| --- | --- | --- | --- |',
  );
  for (const node of graph.nodes.slice(0, 250)) {
    const exportsList =
      node.exports.length > 0 ? node.exports.slice(0, 8).map(code).join(', ') : '–';
    const depsList =
      node.internalDeps.length > 0 ? node.internalDeps.slice(0, 6).map(code).join(', ') : '–';
    const pkgList = node.packages.length > 0 ? node.packages.slice(0, 6).map(code).join(', ') : '–';
    lines.push(`| ${code(node.file)} | ${exportsList} | ${depsList} | ${pkgList} |`);
  }
  lines.push('');

  return lines.join('\n');
}
