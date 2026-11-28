import { defineExtensionMessaging } from '@webext-core/messaging';
import type { ClientAuditPayload, DiscoveryFilesRecord } from '@/engine/audit';
import type { NextDataSummary } from '@/engine/intel';
import type { CustomRuleRecord } from '@/engine/rules';
import type { RuntimeDomKind } from '@/engine/runtime';
import type { SafeCheckReport } from '@/engine/verify';
import type { TriageRecord } from '@/engine/workspace';
import type { MapAnalysisRequest, MapAnalysisResult } from './analyze';
import type { Scope, SiteSettings } from './db';
import type { ScriptScanRequest, ScriptScanResult } from './scan-job';
import type { AddOriginsResult, EnableResult } from './sites';

export interface ScanResult {
  jobId: string;
  bytes: number;
  sha256: string;
}

export interface PingResult {
  echo: string;
  /** Components the message passed through, in order. */
  via: string[];
}

/** Typed protocol. Messages carry keys, never content. */
export interface ProtocolMap {
  'scripts:discovered': (data: { pageUrl: string; urls: string[] }) => void;
  'page:next-data': (data: { pageUrl: string; summary: NextDataSummary }) => void;
  'page:audit': (data: ClientAuditPayload) => void;
  'snapshot:capture': (data: { origin: string }) => { ok: boolean; id?: string };
  /** User-triggered fetch of standard public discovery files (`/robots.txt` and `/sitemap.xml`). */
  'site:check-discovery': (data: { origin: string }) => {
    ok: boolean;
    discovery?: DiscoveryFilesRecord;
    error?: string;
  };
  /** User-triggered non-destructive checks (CORS reflection, GraphQL introspection, .well-known). */
  'site:run-safe-checks': (data: { origin: string }) => {
    ok: boolean;
    report?: SafeCheckReport;
    error?: string;
  };
  /** Passive runtime API observation reported by the collector from an enabled tab. */
  'runtime:api': (data: {
    pageUrl: string;
    url: string;
    method: string;
    status: number;
    headerNames: string[];
    requestBody: string | null;
    responseBody: string | null;
  }) => void;
  /** Opt-in Runtime Guard DOM/postMessage event reported by the collector. */
  'runtime:dom': (data: {
    pageUrl: string;
    kind: RuntimeDomKind;
    detail: string;
    senderOrigin?: string;
    hasListener?: boolean;
    rawStack?: string;
  }) => void;
  /** Collector queries whether opt-in Runtime Guard is enabled for the active page. */
  'runtime:guard-status': (data: { pageUrl: string }) => { enabled: boolean };
  /** Custom Rules Studio CRUD (ReDoS-validated before saving). */
  'rules:save': (data: { rule: CustomRuleRecord }) => { ok: boolean; error?: string };
  'rules:delete': (data: { id: string }) => { ok: boolean };
  'rules:toggle': (data: { id: string; enabled: boolean }) => { ok: boolean };
  /** Bug Bounty Triage persistence (status + researcher note). */
  'triage:save': (data: { record: TriageRecord }) => { ok: boolean };
  'triage:delete': (data: { id: string }) => { ok: boolean };
  /** Sent by the side panel after `permissions.request` succeeded. */
  'site:enable': (data: {
    origin: string;
    scope: Scope;
    settings?: Partial<SiteSettings>;
  }) => EnableResult;
  'site:settings': (data: { origin: string; patch: Partial<SiteSettings> }) => { ok: boolean };
  'site:disable': (data: { origin: string; purge: boolean }) => { ok: boolean; revoked: string[] };
  /** Sent by the side panel after `permissions.request` for the extra origins succeeded. */
  'site:add-origins': (data: { origin: string; origins: string[] }) => AddOriginsResult;
  'site:remove-origin': (data: { origin: string; extraOrigin: string }) => {
    ok: boolean;
    revoked: string[];
  };
  'scan:request': (data: { jobId: string; blobKey: string; kind: 'script' | 'map' }) => ScanResult;
  /** Background to offscreen: parse a fetched map and store its file index. */
  'map:analyze': (data: MapAnalysisRequest) => MapAnalysisResult;
  /** Background to offscreen: run the secret scan for a fetched script. */
  'script:scan': (data: ScriptScanRequest) => ScriptScanResult;
  'scan:rescan': (data: { origin: string }) => { queued: number };
  /** Background to offscreen to worker round trip used to verify the pipeline. */
  'spike:ping': (data: { text: string }) => PingResult;
}

export const { sendMessage, onMessage } = defineExtensionMessaging<ProtocolMap>();
