import {
  analyzeSourceFile,
  extractFileArtifacts,
  mergeScriptIntel,
  type ScriptIntel,
} from '@/engine/intel';
import type { Scanner } from '@/engine/scan/scanner';
import { CONFIDENCE_ORDER, type ScanHit, SEVERITY_ORDER } from '@/engine/scan/types';
import {
  createPositionMapper,
  type PositionMapper,
  parseSourceMap,
  rebuildSourceTree,
} from '@/engine/sourcemap';
import type { FindingLocation, FindingRecord, MaphoundHandle } from './db';
import { sha256Hex } from './hash';

export interface ScriptScanRequest {
  jobId: string;
  scriptHash: string;
  origin: string;
  url: string;
}

export type ScriptScanResult =
  | { ok: true; findings: number; hits: number }
  | { ok: false; permanent: boolean; error: string };

/** Locations kept per finding. */
export const MAX_LOCATIONS = 25;

const KIND_ORDER: Record<FindingLocation['kind'], number> = {
  source: 2,
  'bundle-mapped': 1,
  bundle: 0,
};

interface Located {
  hit: ScanHit;
  location: FindingLocation;
}

function bundleFileName(url: string): string {
  try {
    return new URL(url).pathname.split('/').filter(Boolean).pop() ?? url;
  } catch {
    return url;
  }
}

function sameLocation(a: FindingLocation, b: FindingLocation): boolean {
  return (
    a.file === b.file && a.line === b.line && a.column === b.column && a.scriptUrl === b.scriptUrl
  );
}

/**
 * Scan one script: every original file of its analysed source maps (exact file and line), then
 * the bundle itself, which also holds values a bundler inlined at build time. Bundle positions
 * are mapped back through the source map where possible. Results are merged into one finding
 * per site, rule and secret.
 */
export async function scanScript(
  db: MaphoundHandle,
  scanner: Scanner,
  request: ScriptScanRequest,
  now: number = Date.now(),
): Promise<ScriptScanResult> {
  const blob = await db.get('blobs', request.scriptHash);
  if (!blob) return { ok: false, permanent: false, error: `blob not found: ${request.scriptHash}` };

  const located: Located[] = [];
  const intelParts: ScriptIntel[] = [];
  let mapper: PositionMapper | null = null;
  let mapperUrl: string | undefined;

  const maps = (await db.getAllFromIndex('maps', 'by-scriptHash', request.scriptHash)).filter(
    (map) => map.origin === request.origin,
  );
  for (const map of maps) {
    const mapBlob = await db.get('blobs', map.hash);
    if (!mapBlob) continue;
    let parsed: ReturnType<typeof parseSourceMap>;
    try {
      parsed = parseSourceMap(await mapBlob.blob.text());
    } catch {
      continue;
    }
    const rebuilt = rebuildSourceTree(parsed, { includeContent: true });
    for (const file of rebuilt.files) {
      if (file.content === undefined) {
        if (!file.vendor) {
          const artifacts = extractFileArtifacts(file.path, request.url, map.url);
          if (artifacts.endpoint || artifacts.route) {
            intelParts.push({
              endpoints: artifacts.endpoint ? [artifacts.endpoint] : [],
              routes: artifacts.route ? [artifacts.route] : [],
              comments: [],
              sinks: [],
              truncated: false,
            });
          }
        }
        continue;
      }
      if (!file.vendor) {
        intelParts.push(
          analyzeSourceFile(
            file.content,
            {
              file: file.path,
              kind: 'source',
              scriptUrl: request.url,
              mapUrl: map.url,
            },
            { vendor: false, isBundle: false },
          ),
        );
      }
      for (const hit of scanner.scan(file.content)) {
        located.push({
          hit,
          location: {
            file: file.path,
            line: hit.line,
            column: hit.column,
            kind: 'source',
            scriptUrl: request.url,
            mapUrl: map.url,
          },
        });
      }
    }
    if (!mapper && parsed.sections.some((section) => section.map.mappings)) {
      mapper = createPositionMapper(parsed, rebuilt);
      mapperUrl = map.url;
    }
  }

  const bundle = await blob.blob.text();
  intelParts.push(
    analyzeSourceFile(
      bundle,
      { file: bundleFileName(request.url), kind: 'bundle', scriptUrl: request.url },
      { vendor: false, isBundle: true },
    ),
  );
  for (const hit of scanner.scan(bundle)) {
    const original = mapper?.originalPositionFor(hit.line, hit.column) ?? null;
    located.push({
      hit,
      location: original
        ? {
            file: original.path,
            line: original.line,
            column: original.column,
            kind: 'bundle-mapped',
            scriptUrl: request.url,
            mapUrl: mapperUrl,
            bundleLine: hit.line,
            bundleColumn: hit.column,
          }
        : {
            file: bundleFileName(request.url),
            line: hit.line,
            column: hit.column,
            kind: 'bundle',
            scriptUrl: request.url,
          },
    });
  }

  // One group per rule and secret.
  const groups = new Map<string, Located[]>();
  for (const entry of located) {
    const key = `${entry.hit.ruleId}\u0000${entry.hit.secret}`;
    const list = groups.get(key) ?? [];
    list.push(entry);
    groups.set(key, list);
  }

  let stored = 0;
  for (const entries of groups.values()) {
    entries.sort((a, b) => KIND_ORDER[b.location.kind] - KIND_ORDER[a.location.kind]);
    const primary = entries[0] as Located;
    const { hit } = primary;
    const severity = entries.reduce(
      (best, e) => (SEVERITY_ORDER[e.hit.severity] > SEVERITY_ORDER[best] ? e.hit.severity : best),
      hit.severity,
    );
    const confidence = entries.reduce(
      (best, e) =>
        CONFIDENCE_ORDER[e.hit.confidence] > CONFIDENCE_ORDER[best] ? e.hit.confidence : best,
      hit.confidence,
    );
    const occurrences = entries.reduce((n, e) => n + e.hit.occurrences, 0);
    const secretHash = await sha256Hex(new TextEncoder().encode(hit.secret));
    const id = `${request.origin}|${hit.ruleId}|${secretHash}`;
    const locations: FindingLocation[] = [];
    for (const { location } of entries) {
      if (!locations.some((l) => sameLocation(l, location))) locations.push(location);
    }

    const tx = db.transaction('findings', 'readwrite');
    const existing = await tx.store.get(id);
    let record: FindingRecord;
    if (existing) {
      const merged = [...existing.locations];
      for (const location of locations)
        if (!merged.some((l) => sameLocation(l, location))) merged.push(location);
      merged.sort((a, b) => KIND_ORDER[b.kind] - KIND_ORDER[a.kind]);
      const best = merged[0] as FindingLocation;
      record = {
        ...existing,
        severity:
          SEVERITY_ORDER[severity] > SEVERITY_ORDER[existing.severity]
            ? severity
            : existing.severity,
        confidence:
          CONFIDENCE_ORDER[confidence] > CONFIDENCE_ORDER[existing.confidence]
            ? confidence
            : existing.confidence,
        file: best.file,
        line: best.line,
        column: best.column,
        locationKind: best.kind,
        occurrences: existing.occurrences + occurrences,
        locations: merged.slice(0, MAX_LOCATIONS),
        updatedAt: now,
      };
    } else {
      record = {
        id,
        ruleId: hit.ruleId,
        ruleName: hit.ruleName,
        severity,
        confidence,
        origin: request.origin,
        scriptHash: request.scriptHash,
        file: primary.location.file,
        line: primary.location.line,
        column: primary.location.column,
        locationKind: primary.location.kind,
        preview: hit.preview,
        snippet: hit.snippet,
        secretHash,
        secret: hit.secret,
        occurrences,
        locations: locations.slice(0, MAX_LOCATIONS),
        references: scanner.rule(hit.ruleId)?.references ?? [],
        createdAt: now,
        updatedAt: now,
      };
    }
    await tx.store.put(record);
    await tx.done;
    stored++;
  }

  const mergedIntel = mergeScriptIntel(intelParts);
  await db.put('intel', {
    id: `${request.origin}|${request.scriptHash}`,
    origin: request.origin,
    scriptHash: request.scriptHash,
    scriptUrl: request.url,
    ...mergedIntel,
    updatedAt: now,
  });

  const script = await db.get('scripts', request.scriptHash);
  if (script) await db.put('scripts', { ...script, status: 'scanned', lastAccess: now });
  return { ok: true, findings: stored, hits: located.length };
}
