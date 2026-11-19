import { type DBSchema, type IDBPDatabase, openDB } from 'idb';

export const DB_NAME = 'maphound';
export const DB_VERSION = 1;

export type Scope = 'origin' | 'subdomains';
export type JobState =
  | 'queued'
  | 'fetching'
  | 'fetched'
  | 'scanning'
  | 'done'
  | 'failed'
  /** Deliberately not fetched or not usable; see `skipReason`. Terminal. */
  | 'skipped';
export type JobKind = 'script' | 'map';
export type Severity = 'critical' | 'high' | 'medium' | 'low' | 'info';
export type Confidence = 'verified-format' | 'high' | 'medium' | 'low';
export type ThirdPartyKind = 'cdn' | 'analytics' | 'other';
export type SkipReason =
  /** Outside the site's scope: shown in the UI as "third party (not scanned)". */
  | 'third-party'
  | 'too-large'
  /** A `<script>.map` probe that returned 404/410. */
  | 'not-found'
  /** The response did not look like a source map. */
  | 'not-a-map'
  | 'unsupported-url'
  | 'site-disabled';

export interface SiteSettings {
  /** Probe `<script>.map` even when no sourceMappingURL is declared. Off by default. */
  aggressiveMapProbing: boolean;
  /** Send cookies when fetching same-origin assets. Off by default. */
  useCredentials: boolean;
}

export interface SiteRecord {
  origin: string;
  scope: Scope;
  enabledAt: number;
  settings: SiteSettings;
}

export interface ScriptRecord {
  hash: string;
  urls: string[];
  origin: string;
  size: number;
  sourceMapRef: string | null;
  status: 'fetched' | 'scanned' | 'skipped' | 'error';
  lastAccess: number;
}

export interface BlobRecord {
  hash: string;
  kind: 'script' | 'map';
  blob: Blob;
  size: number;
  lastAccess: number;
}

export interface MapRecord {
  hash: string;
  scriptHash: string;
  fileCount: number;
  hasSourcesContent: boolean;
  partial: boolean;
}

export interface FindingRecord {
  id: string;
  ruleId: string;
  severity: Severity;
  confidence: Confidence;
  origin: string;
  scriptHash: string;
  file: string;
  line: number;
  column: number;
  /** Masked preview, e.g. `AKIA…XY12`. */
  preview: string;
  secretHash: string;
  /** Raw value. Stays local; never exported unless the user opts in. */
  secret?: string;
  createdAt: number;
}

export interface JobRecord {
  id: string;
  kind: JobKind;
  url: string;
  origin: string;
  hash?: string;
  state: JobState;
  attempts: number;
  /**
   * While `fetching`/`scanning`: epoch ms until which a worker owns this job; expired leases
   * return to `queued`. While `queued`: earliest time it may run again (retry backoff).
   */
  leasedUntil: number;
  error?: string;
  skipReason?: SkipReason;
  /** Set for `skipReason: 'third-party'`. */
  thirdParty?: ThirdPartyKind;
  /** For map jobs: hash of the script that referenced this map. */
  parentHash?: string;
  /** How a map job was discovered. */
  via?: 'header' | 'comment' | 'data-uri' | 'probe';
  /** Page on which a script job was discovered. */
  pageUrl?: string;
  createdAt: number;
  updatedAt: number;
}

export interface MaphoundDB extends DBSchema {
  sites: { key: string; value: SiteRecord };
  scripts: {
    key: string;
    value: ScriptRecord;
    indexes: { 'by-origin': string; 'by-lastAccess': number };
  };
  blobs: {
    key: string;
    value: BlobRecord;
    indexes: { 'by-lastAccess': number };
  };
  maps: {
    key: string;
    value: MapRecord;
    indexes: { 'by-scriptHash': string };
  };
  findings: {
    key: string;
    value: FindingRecord;
    indexes: { 'by-origin': string; 'by-scriptHash': string; 'by-secretHash': string };
  };
  jobs: {
    key: string;
    value: JobRecord;
    indexes: { 'by-state': JobState; 'by-origin': string };
  };
}

export type StoreName = keyof MaphoundDB;
export type MaphoundHandle = IDBPDatabase<MaphoundDB>;

export function openMaphoundDb(name: string = DB_NAME): Promise<MaphoundHandle> {
  return openDB<MaphoundDB>(name, DB_VERSION, {
    upgrade(db) {
      db.createObjectStore('sites', { keyPath: 'origin' });

      const scripts = db.createObjectStore('scripts', { keyPath: 'hash' });
      scripts.createIndex('by-origin', 'origin');
      scripts.createIndex('by-lastAccess', 'lastAccess');

      const blobs = db.createObjectStore('blobs', { keyPath: 'hash' });
      blobs.createIndex('by-lastAccess', 'lastAccess');

      const maps = db.createObjectStore('maps', { keyPath: 'hash' });
      maps.createIndex('by-scriptHash', 'scriptHash');

      const findings = db.createObjectStore('findings', { keyPath: 'id' });
      findings.createIndex('by-origin', 'origin');
      findings.createIndex('by-scriptHash', 'scriptHash');
      findings.createIndex('by-secretHash', 'secretHash');

      const jobs = db.createObjectStore('jobs', { keyPath: 'id' });
      jobs.createIndex('by-state', 'state');
      jobs.createIndex('by-origin', 'origin');
    },
  });
}

let shared: Promise<MaphoundHandle> | undefined;

/** Shared connection for the default database. Each extension context has its own. */
export function getDb(): Promise<MaphoundHandle> {
  shared ??= openMaphoundDb();
  return shared;
}
