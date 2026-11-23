import type { SiteSnapshotRecord, SnapshotDiff, SnapshotFileChange } from './types';

function diffStrings(
  prev: readonly string[],
  curr: readonly string[],
): { added: string[]; removed: string[] } {
  const prevSet = new Set(prev);
  const currSet = new Set(curr);
  return {
    added: curr.filter((x) => !prevSet.has(x)).sort(),
    removed: prev.filter((x) => !currSet.has(x)).sort(),
  };
}

function diffKeyed<T extends { key: string }>(
  prev: readonly T[],
  curr: readonly T[],
): { added: T[]; resolved: T[] } {
  const prevKeys = new Set(prev.map((x) => x.key));
  const currKeys = new Set(curr.map((x) => x.key));
  return {
    added: curr.filter((x) => !prevKeys.has(x.key)).sort((a, b) => a.key.localeCompare(b.key)),
    resolved: prev.filter((x) => !currKeys.has(x.key)).sort((a, b) => a.key.localeCompare(b.key)),
  };
}

export function diffSnapshots(
  previous: SiteSnapshotRecord,
  current: SiteSnapshotRecord,
): SnapshotDiff {
  const prevFiles = new Map(previous.files.map((f) => [f.path, f]));
  const currFiles = new Map(current.files.map((f) => [f.path, f]));

  const addedFiles = current.files
    .filter((f) => !prevFiles.has(f.path))
    .sort((a, b) => a.path.localeCompare(b.path));
  const removedFiles = previous.files
    .filter((f) => !currFiles.has(f.path))
    .sort((a, b) => a.path.localeCompare(b.path));
  const modifiedFiles: SnapshotFileChange[] = [];
  for (const [path, curr] of currFiles.entries()) {
    const prev = prevFiles.get(path);
    if (prev && (prev.hash !== curr.hash || prev.size !== curr.size)) {
      modifiedFiles.push({ path, previousSize: prev.size, currentSize: curr.size });
    }
  }
  modifiedFiles.sort((a, b) => a.path.localeCompare(b.path));

  const endpoints = diffStrings(previous.endpoints, current.endpoints);
  const routes = diffStrings(previous.routes, current.routes);
  const findings = diffKeyed(previous.findings, current.findings);
  const sinks = diffKeyed(previous.sinks, current.sinks);

  const totalChanges =
    addedFiles.length +
    removedFiles.length +
    modifiedFiles.length +
    endpoints.added.length +
    endpoints.removed.length +
    routes.added.length +
    routes.removed.length +
    findings.added.length +
    findings.resolved.length +
    sinks.added.length +
    sinks.resolved.length;

  return {
    previous,
    current,
    files: { added: addedFiles, removed: removedFiles, modified: modifiedFiles },
    endpoints,
    routes,
    findings,
    sinks,
    totalChanges,
    hasChanges: totalChanges > 0,
  };
}
