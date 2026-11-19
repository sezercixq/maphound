import { defineExtensionMessaging } from '@webext-core/messaging';
import type { MapAnalysisRequest, MapAnalysisResult } from './analyze';
import type { Scope, SiteSettings } from './db';
import type { EnableResult } from './sites';

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
  /** Sent by the side panel after `permissions.request` succeeded. */
  'site:enable': (data: {
    origin: string;
    scope: Scope;
    settings?: Partial<SiteSettings>;
  }) => EnableResult;
  'site:settings': (data: { origin: string; patch: Partial<SiteSettings> }) => { ok: boolean };
  'site:disable': (data: { origin: string; purge: boolean }) => { ok: boolean; revoked: string[] };
  'scan:request': (data: { jobId: string; blobKey: string; kind: 'script' | 'map' }) => ScanResult;
  /** Background to offscreen: parse a fetched map and store its file index. */
  'map:analyze': (data: MapAnalysisRequest) => MapAnalysisResult;
  'scan:rescan': (data: { origin: string }) => { queued: number };
  /** Background to offscreen to worker round trip used to verify the pipeline. */
  'spike:ping': (data: { text: string }) => PingResult;
}

export const { sendMessage, onMessage } = defineExtensionMessaging<ProtocolMap>();
