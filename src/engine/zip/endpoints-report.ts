import type { PageIntelRecord, ScriptIntelRecord } from '@/core/db';
import {
  classifyPath,
  ENDPOINT_CATEGORIES,
  type EndpointCategory,
  type EndpointHit,
  mergeScriptIntel,
  type ScriptIntel,
} from '@/engine/intel';

export interface EndpointsReportContext {
  origin: string;
  generator: string;
  exportedAt: string;
}

const CATEGORY_LABELS: Record<EndpointCategory, string> = {
  admin: 'Admin & Internal',
  graphql: 'GraphQL',
  auth: 'Authentication',
  api: 'API',
  'next-data': 'Next.js Data',
  websocket: 'WebSocket',
  external: 'External',
};

const ROUTE_KIND_LABELS: Record<string, string> = {
  definition: 'router definition',
  file: 'file-system route',
  manifest: 'Next.js build manifest',
  navigation: 'navigation',
};

function code(value: string): string {
  const text = value.replace(/\r?\n/g, ' ').replace(/\|/g, '\\|');
  return text.includes('`') ? `\`\` ${text} \`\`` : `\`${text}\``;
}

function cell(value: string): string {
  return value.replace(/\r?\n/g, ' ').replace(/\|/g, '\\|');
}

export function endpointsFromPages(pages: readonly PageIntelRecord[]): EndpointHit[] {
  const hits: EndpointHit[] = [];
  for (const page of pages) {
    for (const value of page.nextData.endpoints) {
      let category: EndpointCategory = 'api';
      if (value.startsWith('ws://') || value.startsWith('wss://')) {
        category = 'websocket';
      } else {
        try {
          const path = value.startsWith('/') ? value : new URL(value).pathname;
          category = classifyPath(path) ?? (value.startsWith('/') ? 'api' : 'external');
        } catch {
          category = 'external';
        }
      }
      hits.push({
        value,
        category,
        methods: [],
        dynamic: false,
        locations: [
          {
            file: '__NEXT_DATA__',
            line: 1,
            column: 0,
            kind: 'source',
            scriptUrl: page.pageUrl,
          },
        ],
      });
    }
  }
  return hits;
}

export function combineSiteIntel(
  intelRecords: readonly ScriptIntelRecord[],
  pages: readonly PageIntelRecord[] = [],
): ScriptIntel {
  const items: ScriptIntel[] = intelRecords.map((record) => ({
    endpoints: record.endpoints,
    routes: record.routes,
    comments: record.comments,
    sinks: record.sinks,
    modules: record.modules ?? [],
    osint: record.osint ?? [],
    truncated: record.truncated,
  }));
  const pageEndpoints = endpointsFromPages(pages);
  if (pageEndpoints.length > 0) {
    items.push({
      endpoints: pageEndpoints,
      routes: [],
      comments: [],
      sinks: [],
      truncated: false,
    });
  }
  return mergeScriptIntel(items);
}

export function endpointsMarkdown(
  intel: ScriptIntel,
  pages: readonly PageIntelRecord[],
  context: EndpointsReportContext,
): string {
  const lines: string[] = [
    `# MapHound attack surface: ${context.origin}`,
    '',
    `Generated ${context.exportedAt} by ${context.generator}.`,
    '',
    `- **Endpoints:** ${intel.endpoints.length}`,
    `- **Frontend routes:** ${intel.routes.length}`,
    `- **Developer notes:** ${intel.comments.length}`,
    `- **Code hints / sinks:** ${intel.sinks.length}`,
    `- **Pages with __NEXT_DATA__:** ${pages.length}`,
    '',
  ];

  if (
    intel.endpoints.length === 0 &&
    intel.routes.length === 0 &&
    intel.comments.length === 0 &&
    intel.sinks.length === 0 &&
    pages.length === 0
  ) {
    lines.push('No endpoints, routes, developer notes or code hints were discovered.', '');
    return lines.join('\n');
  }

  if (intel.endpoints.length > 0) {
    lines.push(`## API & Internal Endpoints (${intel.endpoints.length})`, '');
    for (const category of ENDPOINT_CATEGORIES) {
      const group = intel.endpoints.filter((ep) => ep.category === category);
      if (group.length === 0) continue;
      lines.push(`### ${CATEGORY_LABELS[category]} (${group.length})`, '');
      lines.push('| Endpoint | Methods | Location |', '| --- | --- | --- |');
      for (const ep of group) {
        const methods = ep.methods.length > 0 ? ep.methods.join(', ') : '–';
        const loc = ep.locations[0];
        const where = loc ? code(`${loc.file}:${loc.line}`) : '–';
        lines.push(`| ${code(ep.value)} | ${cell(methods)} | ${where} |`);
      }
      lines.push('');
    }
  }

  if (intel.routes.length > 0) {
    lines.push(`## Frontend Routes (${intel.routes.length})`, '');
    lines.push('| Route | Source | Location |', '| --- | --- | --- |');
    for (const route of intel.routes) {
      const loc = route.locations[0];
      const where = loc ? code(`${loc.file}:${loc.line}`) : '–';
      lines.push(
        `| ${code(route.path)} | ${cell(ROUTE_KIND_LABELS[route.kind] ?? route.kind)} | ${where} |`,
      );
    }
    lines.push('');
  }

  if (intel.comments.length > 0) {
    lines.push(`## Developer Notes (${intel.comments.length})`, '');
    lines.push('| Marker | Level | Note | Location |', '| --- | --- | --- | --- |');
    for (const comment of intel.comments) {
      lines.push(
        `| ${cell(comment.marker)} | ${comment.level} | ${cell(comment.text)} | ${code(`${comment.location.file}:${comment.location.line}`)} |`,
      );
    }
    lines.push('');
  }

  if (intel.sinks.length > 0) {
    lines.push(`## Code Hints / Sinks (${intel.sinks.length})`, '');
    lines.push('| Level | Category | Hint | Location |', '| --- | --- | --- | --- |');
    for (const sink of intel.sinks) {
      lines.push(
        `| ${sink.level} | ${cell(sink.category)} | ${cell(sink.title)} | ${code(`${sink.location.file}:${sink.location.line}`)} |`,
      );
    }
    lines.push('');
  }

  if (pages.length > 0) {
    lines.push(`## Next.js __NEXT_DATA__ Summaries (${pages.length})`, '');
    for (const page of pages) {
      const nd = page.nextData;
      lines.push(`### ${code(page.pageUrl)}`, '');
      if (nd.page) lines.push(`- Page route: ${code(nd.page)}`);
      if (nd.buildId) lines.push(`- Build ID: ${code(nd.buildId)}`);
      if (nd.dataFetching.length > 0) {
        lines.push(`- Data fetching: ${nd.dataFetching.join(', ')}`);
      }
      if (nd.pageProps.length > 0) {
        lines.push(`- pageProps keys: ${nd.pageProps.map(code).join(', ')}`);
      }
      if (nd.sensitive.length > 0) {
        lines.push('', '| Path | Reason | Type | Preview (masked) |', '| --- | --- | --- | --- |');
        for (const item of nd.sensitive) {
          lines.push(
            `| ${code(item.path)} | ${cell(item.reason)} | ${cell(item.type)} | ${item.preview ? code(item.preview) : '–'} |`,
          );
        }
      }
      lines.push('');
    }
  }

  return lines.join('\n');
}

export function endpointsText(intel: ScriptIntel): string {
  const lines: string[] = [];
  for (const ep of intel.endpoints) {
    const prefix = ep.methods.length > 0 ? `${ep.methods.join(',')} ` : '';
    lines.push(`${prefix}${ep.value}`);
  }
  for (const route of intel.routes) {
    lines.push(`ROUTE ${route.path}`);
  }
  return `${lines.join('\n')}\n`;
}

export function endpointsJson(intel: ScriptIntel, origin: string): string {
  return `${JSON.stringify(
    {
      origin,
      summary: {
        endpoints: intel.endpoints.length,
        routes: intel.routes.length,
        comments: intel.comments.length,
      },
      endpoints: intel.endpoints,
      routes: intel.routes,
      comments: intel.comments,
    },
    null,
    2,
  )}\n`;
}
