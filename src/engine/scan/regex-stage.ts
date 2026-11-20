export interface RegexMatch {
  /** Offsets of the secret group within the scanned text. */
  start: number;
  end: number;
  secret: string;
}

/**
 * Merge `[hit - radius, hit + keywordLength + radius]` ranges into sorted, non-overlapping
 * windows, so every character is examined at most once per rule.
 */
export function mergeWindows(
  hits: readonly { start: number; length: number }[],
  radius: number,
  textLength: number,
): [number, number][] {
  const ranges = hits
    .map(
      ({ start, length }) =>
        [Math.max(0, start - radius), Math.min(textLength, start + length + radius)] as [
          number,
          number,
        ],
    )
    .sort((a, b) => a[0] - b[0]);
  const merged: [number, number][] = [];
  for (const range of ranges) {
    const last = merged[merged.length - 1];
    if (last && range[0] <= last[1]) last[1] = Math.max(last[1], range[1]);
    else merged.push([range[0], range[1]]);
  }
  return merged;
}

/** Run a global regex (`g` + `d` flags) only inside the windows. */
export function runInWindows(
  text: string,
  regex: RegExp,
  windows: readonly [number, number][],
  group: number,
  maxMatches = 1_000,
): RegexMatch[] {
  const matches: RegexMatch[] = [];
  for (const [from, to] of windows) {
    const slice = text.slice(from, to);
    regex.lastIndex = 0;
    let match: RegExpExecArray | null = regex.exec(slice);
    while (match !== null) {
      const span = match.indices?.[group];
      const secret = match[group];
      if (span && secret) matches.push({ start: from + span[0], end: from + span[1], secret });
      if (matches.length >= maxMatches) return matches;
      if (match[0].length === 0) regex.lastIndex++;
      match = regex.exec(slice);
    }
  }
  return matches;
}
