import type { Severity } from '@/core/db';
import type { HintLevel, SinkCategory } from '@/engine/intel';

export interface SnapshotFileEntry {
  path: string;
  hash: string;
  size: number;
}

export interface SnapshotFindingEntry {
  /** `${ruleId}|${secretHash}` (never stores raw secret values). */
  key: string;
  ruleId: string;
  ruleName: string;
  severity: Severity;
  file: string;
  line: number;
}

export interface SnapshotSinkEntry {
  /** `${ruleId}|${file}:${line}` */
  key: string;
  ruleId: string;
  title: string;
  category: SinkCategory;
  level: HintLevel;
  file: string;
  line: number;
}

export interface SiteSnapshotRecord {
  /** `${origin}|${createdAt}|${seq}` */
  id: string;
  origin: string;
  createdAt: number;
  /** Content hash of the normalized snapshot state. */
  signature: string;
  /** Locked as a baseline (e.g. before rescan or explicit user snapshot). */
  frozen?: boolean;
  scriptHashes: string[];
  files: SnapshotFileEntry[];
  endpoints: string[];
  routes: string[];
  findings: SnapshotFindingEntry[];
  sinks: SnapshotSinkEntry[];
}

export interface SnapshotFileChange {
  path: string;
  previousSize: number;
  currentSize: number;
}

export interface SnapshotDiff {
  previous: SiteSnapshotRecord;
  current: SiteSnapshotRecord;
  files: {
    added: SnapshotFileEntry[];
    removed: SnapshotFileEntry[];
    modified: SnapshotFileChange[];
  };
  endpoints: { added: string[]; removed: string[] };
  routes: { added: string[]; removed: string[] };
  findings: { added: SnapshotFindingEntry[]; resolved: SnapshotFindingEntry[] };
  sinks: { added: SnapshotSinkEntry[]; resolved: SnapshotSinkEntry[] };
  totalChanges: number;
  hasChanges: boolean;
}
