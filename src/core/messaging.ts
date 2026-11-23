import { defineExtensionMessaging } from '@webext-core/messaging';
import type { ClientAuditPayload } from '@/engine/audit';
import type { NextDataSummary } from '@/engine/intel';
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
