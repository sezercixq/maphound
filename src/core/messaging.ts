import { defineExtensionMessaging } from '@webext-core/messaging';
import type { Scope } from './db';

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
  'site:enable': (data: { origin: string; scope: Scope }) => { ok: boolean };
  'site:disable': (data: { origin: string; purge: boolean }) => { ok: boolean };
  'scan:request': (data: { jobId: string; blobKey: string; kind: 'script' | 'map' }) => ScanResult;
  'scan:rescan': (data: { origin: string }) => { queued: number };
  /** Background to offscreen to worker round trip used to verify the pipeline. */
  'spike:ping': (data: { text: string }) => PingResult;
}

export const { sendMessage, onMessage } = defineExtensionMessaging<ProtocolMap>();
