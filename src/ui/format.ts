import type { Confidence, JobRecord, Severity, SkipReason, ThirdPartyKind } from '@/core/db';
import type { AuditCategory } from '@/engine/audit';
import type {
  EndpointCategory,
  HintLevel,
  RouteKind,
  SdkCategory,
  SinkCategory,
} from '@/engine/intel';
import type { MessageKey } from './i18n';

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '–';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

/** Last path segment of a URL (query kept short), for compact rows. */
export function fileName(url: string): string {
  try {
    const parsed = new URL(url.replace(/#inline-map$/, ''));
    const name = parsed.pathname.split('/').filter(Boolean).pop() ?? parsed.host;
    const query =
      parsed.search.length > 1
        ? parsed.search.length > 12
          ? `${parsed.search.slice(0, 10)}…`
          : parsed.search
        : '';
    return decodeURIComponentSafe(name) + query;
  } catch {
    return url;
  }
}

export function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return '';
  }
}

function decodeURIComponentSafe(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export type Tone = 'neutral' | 'busy' | 'ok' | 'warn' | 'error' | 'muted';

export interface StatusLabel {
  key: MessageKey;
  tone: Tone;
}

const SKIP_KEYS: Record<SkipReason, MessageKey> = {
  'third-party': 'skipThirdParty',
  'too-large': 'skipTooLarge',
  'not-found': 'skipNotFound',
  'not-a-map': 'skipNotAMap',
  'unsupported-url': 'skipUnsupported',
  'site-disabled': 'skipSiteDisabled',
};

/** Badge text and colour for a job. Scripts stop at `fetched` until secret scanning lands. */
export function statusOf(job: Pick<JobRecord, 'state' | 'skipReason' | 'kind'>): StatusLabel {
  switch (job.state) {
    case 'queued':
      return { key: 'stateQueued', tone: 'neutral' };
    case 'fetching':
      return { key: 'stateFetching', tone: 'busy' };
    case 'fetched':
    // Downloaded; waiting for map analysis or the secret scan.
    case 'scanning':
      return { key: 'stateScanning', tone: 'busy' };
    case 'done':
      return { key: 'stateDone', tone: 'ok' };
    case 'failed':
      return { key: 'stateFailed', tone: 'error' };
    case 'skipped':
      return {
        key: job.skipReason ? SKIP_KEYS[job.skipReason] : 'skipUnsupported',
        tone: job.skipReason === 'third-party' ? 'warn' : 'muted',
      };
  }
}

export const THIRD_PARTY_KEYS: Record<ThirdPartyKind, MessageKey> = {
  cdn: 'thirdPartyCdn',
  analytics: 'thirdPartyAnalytics',
  other: 'thirdPartyOther',
};

export const VIA_KEYS: Record<NonNullable<JobRecord['via']>, MessageKey> = {
  comment: 'viaComment',
  header: 'viaHeader',
  'data-uri': 'viaDataUri',
  probe: 'viaProbe',
};

export const SEVERITY_KEYS: Record<Severity, MessageKey> = {
  critical: 'severityCritical',
  high: 'severityHigh',
  medium: 'severityMedium',
  low: 'severityLow',
  info: 'severityInfo',
};

export const CONFIDENCE_KEYS: Record<Confidence, MessageKey> = {
  'verified-format': 'confidenceVerified',
  high: 'confidenceHigh',
  medium: 'confidenceMedium',
  low: 'confidenceLow',
};

export function isUrgent(severity: Severity): boolean {
  return severity === 'critical' || severity === 'high';
}

export const ENDPOINT_CATEGORY_KEYS: Record<EndpointCategory, MessageKey> = {
  admin: 'endpointCatAdmin',
  graphql: 'endpointCatGraphql',
  auth: 'endpointCatAuth',
  api: 'endpointCatApi',
  'next-data': 'endpointCatNextData',
  websocket: 'endpointCatWebsocket',
  external: 'endpointCatExternal',
};

export const ROUTE_KIND_KEYS: Record<RouteKind, MessageKey> = {
  definition: 'routeKindDefinition',
  file: 'routeKindFile',
  manifest: 'routeKindManifest',
  navigation: 'routeKindNavigation',
};

export const SINK_CATEGORY_KEYS: Record<SinkCategory, MessageKey> = {
  'dom-xss': 'sinkCatDomXss',
  'code-injection': 'sinkCatCodeInjection',
  messaging: 'sinkCatMessaging',
  redirect: 'sinkCatRedirect',
  framework: 'sinkCatFramework',
};

export const HINT_LEVEL_KEYS: Record<HintLevel, MessageKey> = {
  high: 'hintLevelHigh',
  medium: 'hintLevelMedium',
  low: 'hintLevelLow',
  info: 'hintLevelInfo',
};

export const NEXT_DATA_REASON_KEYS: Record<'credential' | 'privilege' | 'pii', MessageKey> = {
  credential: 'nextDataReasonCredential',
  privilege: 'nextDataReasonPrivilege',
  pii: 'nextDataReasonPii',
};

export const SDK_CATEGORY_KEYS: Record<SdkCategory, MessageKey> = {
  payment: 'sdkCatPayment',
  auth: 'sdkCatAuth',
  backend: 'sdkCatBackend',
  monitoring: 'sdkCatMonitoring',
  analytics: 'sdkCatAnalytics',
  ai: 'sdkCatAi',
  realtime: 'sdkCatRealtime',
  cloud: 'sdkCatCloud',
};

export const AUDIT_CATEGORY_KEYS: Record<AuditCategory, MessageKey> = {
  headers: 'auditCatHeaders',
  cookie: 'auditCatCookie',
  storage: 'auditCatStorage',
};
