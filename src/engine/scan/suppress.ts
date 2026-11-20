import { CONFIDENCE_ORDER, type ScanHit, SEVERITY_ORDER } from './types';

/**
 * `maphound-ignore` on the same line as the match, or on the line above when that line is only
 * a comment. A trailing `// maphound-ignore` after code applies to its own line only.
 */
export function hasIgnoreComment(text: string, start: number): boolean {
  const lineStart = text.lastIndexOf('\n', start - 1) + 1;
  let lineEnd = text.indexOf('\n', start);
  if (lineEnd < 0) lineEnd = text.length;
  if (text.slice(lineStart, Math.min(lineEnd, lineStart + 4000)).includes('maphound-ignore'))
    return true;
  if (lineStart === 0) return false;
  const previousStart = text.lastIndexOf('\n', lineStart - 2) + 1;
  const previous = text.slice(Math.max(previousStart, lineStart - 4000), lineStart).trim();
  return /^(?:\/\/|\/\*|\*|#)/.test(previous) && previous.includes('maphound-ignore');
}

/** A reference to configuration rather than a value: `process.env.X`, `import.meta.env.X`, `${X}`. */
export function isEnvReference(secret: string, text: string, start: number): boolean {
  if (/^(?:process\.env\.|import\.meta\.env\.|\$\{|\{\{|%\{|env\()/.test(secret)) return true;
  const before = text.slice(Math.max(0, start - 20), start);
  return /(?:process\.env|import\.meta\.env)\.?$/.test(before);
}

export function contextMatches(
  text: string,
  start: number,
  end: number,
  pattern: RegExp,
  radius = 200,
): boolean {
  pattern.lastIndex = 0;
  return pattern.test(text.slice(Math.max(0, start - radius), Math.min(text.length, end + radius)));
}

function rank(hit: ScanHit): number {
  return (
    (hit.generic ? 0 : 1000) +
    SEVERITY_ORDER[hit.severity] * 100 +
    CONFIDENCE_ORDER[hit.confidence] * 10
  );
}

/**
 * Where two rules matched overlapping text (a Supabase service key is also a JWT; a Stripe key
 * inside `apiKey: "..."` is also a generic secret), keep a provider-specific rule over a
 * catch-all one, then the most severe, most confident and longest match.
 */
export function dropOverlaps(hits: ScanHit[]): ScanHit[] {
  const sorted = [...hits].sort(
    (a, b) => rank(b) - rank(a) || b.end - b.start - (a.end - a.start) || a.start - b.start,
  );
  const kept: ScanHit[] = [];
  for (const hit of sorted) {
    if (kept.some((k) => hit.start < k.end && k.start < hit.end)) continue;
    kept.push(hit);
  }
  return kept.sort((a, b) => a.start - b.start);
}

/** One hit per rule and secret; repeats only raise `occurrences`. */
export function collapseRepeats(hits: ScanHit[]): ScanHit[] {
  const first = new Map<string, ScanHit>();
  for (const hit of hits) {
    const key = `${hit.ruleId}\u0000${hit.secret}`;
    const existing = first.get(key);
    if (existing) existing.occurrences += hit.occurrences;
    else first.set(key, { ...hit });
  }
  return [...first.values()];
}
