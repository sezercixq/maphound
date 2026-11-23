import { utf8Length } from '@/engine/sourcemap/rebuild';
import {
  ABSOLUTE_URL,
  API_HOST,
  ASSET_PATH,
  CATEGORY_ADMIN,
  CATEGORY_API,
  CATEGORY_AUTH,
  CATEGORY_GRAPHQL,
  CATEGORY_NEXT_DATA,
  NEXT_DATA_CREDENTIAL_KEY,
  NEXT_DATA_PII_KEY,
  NEXT_DATA_PRIVILEGE_KEY,
} from './patterns';
import type { NextDataEntry, NextDataSensitive, NextDataSummary } from './types';

export const MAX_NEXT_DATA_BYTES = 512 * 1024;
const MAX_DEPTH = 6;
const MAX_NODES = 2_000;
const MAX_OUTLINE = 40;
const MAX_SENSITIVE = 40;
const MAX_ENDPOINTS = 40;
const MAX_PAGE_PROPS = 50;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function describeType(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return `array[${value.length}]`;
  if (typeof value === 'object') return `object{${Object.keys(value).length}}`;
  return typeof value;
}

function maskScalar(value: unknown, reason?: string): string | undefined {
  if (value === null) return 'null';
  if (typeof value === 'boolean' || typeof value === 'number') return String(value);
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!trimmed) return '""';
  if (reason === 'pii' && trimmed.includes('@')) {
    const [local = '', domain = ''] = trimmed.split('@');
    const maskedLocal =
      local.length <= 2 ? `${local[0] ?? '*'}…` : `${local[0]}…${local[local.length - 1]}`;
    return `${maskedLocal}@${domain}`;
  }
  if (reason === 'credential' || (reason && trimmed.length >= 16)) {
    if (trimmed.length <= 8) return '••••';
    return `${trimmed.slice(0, 4)}…${trimmed.slice(-4)}`;
  }
  return trimmed.length > 48 ? `${trimmed.slice(0, 45)}…` : trimmed;
}

function classifyKey(key: string): string | null {
  const normalized = key.replace(/([a-z0-9])([A-Z])/g, '$1_$2');
  if (NEXT_DATA_CREDENTIAL_KEY.test(normalized)) return 'credential';
  if (NEXT_DATA_PRIVILEGE_KEY.test(normalized)) return 'privilege';
  if (NEXT_DATA_PII_KEY.test(normalized)) return 'pii';
  return null;
}

function maybeEndpoint(value: string): boolean {
  if (value.length < 2 || value.length > 300 || /\s/.test(value)) return false;
  if (ASSET_PATH.test(value)) return false;
  if (value.startsWith('/') && !value.startsWith('//')) {
    return (
      CATEGORY_API.test(value.toLowerCase()) ||
      CATEGORY_ADMIN.test(value.toLowerCase()) ||
      CATEGORY_GRAPHQL.test(value.toLowerCase()) ||
      CATEGORY_NEXT_DATA.test(value.toLowerCase()) ||
      CATEGORY_AUTH.test(value.toLowerCase())
    );
  }
  if (ABSOLUTE_URL.test(value)) {
    try {
      const parsed = new URL(value);
      return (
        API_HOST.test(parsed.hostname.toLowerCase()) ||
        CATEGORY_API.test(parsed.pathname.toLowerCase()) ||
        CATEGORY_GRAPHQL.test(parsed.pathname.toLowerCase())
      );
    } catch {
      return false;
    }
  }
  return false;
}

/**
 * Parse Next.js `<script id="__NEXT_DATA__">` JSON locally into a bounded, readable summary
 * with masked previews for sensitive-looking keys.
 */
export function parseNextData(rawJson: string): NextDataSummary | null {
  const trimmed = rawJson.trim();
  if (!trimmed.startsWith('{')) return null;
  const bytes = utf8Length(trimmed);
  if (bytes > MAX_NEXT_DATA_BYTES) return null;

  let doc: unknown;
  try {
    doc = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (!isPlainObject(doc)) return null;
  if (!('props' in doc) && !('page' in doc) && !('buildId' in doc)) return null;

  const query: Record<string, string> = {};
  if (isPlainObject(doc.query)) {
    for (const [k, v] of Object.entries(doc.query).slice(0, 20)) {
      if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
        query[k] = String(v);
      } else if (Array.isArray(v)) {
        query[k] = v.map(String).join(',');
      }
    }
  }

  const dataFetching: string[] = [];
  if (doc.gssp === true) dataFetching.push('getServerSideProps');
  if (doc.gsp === true) dataFetching.push('getStaticProps');
  if (doc.gip === true) dataFetching.push('getInitialProps');
  if (doc.isFallback === true) dataFetching.push('isFallback');

  const props = isPlainObject(doc.props) ? doc.props : undefined;
  const pagePropsObj = props && isPlainObject(props.pageProps) ? props.pageProps : undefined;
  const pageProps = pagePropsObj ? Object.keys(pagePropsObj).slice(0, MAX_PAGE_PROPS) : [];
  const hasRuntimeConfig =
    isPlainObject(doc.runtimeConfig) && Object.keys(doc.runtimeConfig).length > 0;

  let keyCount = 0;
  let visited = 0;
  const outline: NextDataEntry[] = [];
  const sensitive: NextDataSensitive[] = [];
  const endpoints = new Set<string>();

  const walk = (value: unknown, path: string, keyName: string, depth: number) => {
    if (visited >= MAX_NODES || depth > MAX_DEPTH) return;
    visited++;

    if (keyName) {
      const reason = classifyKey(keyName);
      if (reason && sensitive.length < MAX_SENSITIVE) {
        const preview = maskScalar(value, reason);
        sensitive.push({
          path,
          reason,
          type: describeType(value),
          ...(preview !== undefined ? { preview } : {}),
        });
      }
    }

    if (typeof value === 'string' && endpoints.size < MAX_ENDPOINTS && maybeEndpoint(value)) {
      endpoints.add(value);
    }

    if (Array.isArray(value)) {
      for (let i = 0; i < Math.min(value.length, 20); i++) {
        walk(value[i], `${path}[${i}]`, '', depth + 1);
      }
      return;
    }

    if (isPlainObject(value)) {
      for (const [k, child] of Object.entries(value)) {
        keyCount++;
        const childPath = path ? `${path}.${k}` : k;
        if (
          outline.length < MAX_OUTLINE &&
          depth <= 2 &&
          (childPath.startsWith('props.pageProps.') || childPath.startsWith('runtimeConfig.'))
        ) {
          const preview = maskScalar(child);
          outline.push({
            path: childPath,
            type: describeType(child),
            ...(preview !== undefined ? { preview } : {}),
          });
        }
        walk(child, childPath, k, depth + 1);
        if (visited >= MAX_NODES) break;
      }
    }
  };

  if (props !== undefined) walk(props, 'props', '', 0);
  if (isPlainObject(doc.runtimeConfig)) walk(doc.runtimeConfig, 'runtimeConfig', '', 0);

  return {
    bytes,
    ...(typeof doc.page === 'string' ? { page: doc.page } : {}),
    ...(typeof doc.buildId === 'string' ? { buildId: doc.buildId } : {}),
    ...(typeof doc.assetPrefix === 'string' ? { assetPrefix: doc.assetPrefix } : {}),
    query,
    dataFetching,
    hasRuntimeConfig,
    pageProps,
    keyCount,
    sensitive,
    outline,
    endpoints: [...endpoints],
  };
}
