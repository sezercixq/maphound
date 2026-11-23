/** Client-side attack surface extracted from rebuilt sources and bundles. */

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD' | 'OPTIONS';

export const HTTP_METHODS: readonly HttpMethod[] = [
  'GET',
  'POST',
  'PUT',
  'PATCH',
  'DELETE',
  'HEAD',
  'OPTIONS',
];

/** Most interesting first; the order is used for sorting and reports. */
export type EndpointCategory =
  | 'admin'
  | 'graphql'
  | 'auth'
  | 'api'
  | 'next-data'
  | 'websocket'
  | 'external';

export const ENDPOINT_CATEGORIES: readonly EndpointCategory[] = [
  'admin',
  'graphql',
  'auth',
  'api',
  'next-data',
  'websocket',
  'external',
];

/**
 * `definition`: a router path (react-router, vue-router). `navigation`: a push, redirect, link
 * or href target. `file`: a file-system route (Next.js `pages/` and `app/`, Nuxt, SvelteKit).
 * `manifest`: listed in Next.js `__BUILD_MANIFEST`.
 */
export type RouteKind = 'definition' | 'navigation' | 'file' | 'manifest';

export type HintLevel = 'high' | 'medium' | 'low' | 'info';

export const HINT_LEVELS: readonly HintLevel[] = ['high', 'medium', 'low', 'info'];

export type SinkCategory = 'dom-xss' | 'code-injection' | 'messaging' | 'redirect' | 'framework';

export interface IntelLocation {
  /** Rebuilt source path (`src/...`) or the bundle's file name. */
  file: string;
  /** 1-based. */
  line: number;
  /** 0-based. */
  column: number;
  /** `source`: an original file from the map. `bundle`: the served script. */
  kind: 'source' | 'bundle';
  scriptUrl: string;
  mapUrl?: string;
}

export interface EndpointHit {
  /** Path or URL, template expressions as `{name}`. */
  value: string;
  category: EndpointCategory;
  /** Methods seen next to it (`axios.post`, `method: 'DELETE'`); empty when unknown. */
  methods: HttpMethod[];
  /** Whether part of it is computed at runtime (template expression). */
  dynamic: boolean;
  locations: IntelLocation[];
}

export interface RouteHit {
  path: string;
  kind: RouteKind;
  locations: IntelLocation[];
}

export interface CommentHit {
  /** `TODO`, `FIXME`, `HACK`, `XXX`, `INTERNAL`, `BYPASS` or `SECURITY`. */
  marker: string;
  text: string;
  level: HintLevel;
  location: IntelLocation;
}

export interface SinkHit {
  ruleId: string;
  title: string;
  category: SinkCategory;
  level: HintLevel;
  /** The line around the match. */
  snippet: string;
  location: IntelLocation;
}

export interface NextDataEntry {
  /** Dotted path into the JSON, e.g. `props.pageProps.user.email`. */
  path: string;
  /** `string`, `number`, `boolean`, `null`, `array[3]` or `object{5}`. */
  type: string;
  /** Short, partly masked preview of a scalar value. */
  preview?: string;
}

export interface NextDataSensitive extends NextDataEntry {
  reason: string;
}

/** Readable summary of a page's `__NEXT_DATA__` (server-side props sent to the browser). */
export interface NextDataSummary {
  bytes: number;
  page?: string;
  buildId?: string;
  assetPrefix?: string;
  query: Record<string, string>;
  /** `getServerSideProps` / `getStaticProps` / `getInitialProps` were used. */
  dataFetching: string[];
  hasRuntimeConfig: boolean;
  /** Keys of `props.pageProps`. */
  pageProps: string[];
  /** Total number of keys in the document. */
  keyCount: number;
  /** Paths whose names suggest secrets, personal data or privileges. */
  sensitive: NextDataSensitive[];
  /** First levels of the tree, for orientation. */
  outline: NextDataEntry[];
  /** URLs and API paths found among the values. */
  endpoints: string[];
}

/** Everything extracted from one script and its source maps (or from one page). */
export interface ScriptIntel {
  endpoints: EndpointHit[];
  routes: RouteHit[];
  comments: CommentHit[];
  sinks: SinkHit[];
  /** Set when a limit cut the result short. */
  truncated: boolean;
}
