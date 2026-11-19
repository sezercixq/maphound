/** Source map reference discovery (ECMA-426): HTTP header, trailing comment, data: URI, probe. */

export type MapRef =
  | { type: 'url'; url: string; via: 'header' | 'comment' | 'probe' }
  | { type: 'inline'; bytes: Uint8Array; via: 'data-uri' };

interface HeaderSource {
  get(name: string): string | null;
}

/** How many trailing non-empty lines are inspected; others (e.g. `//# debugId=`) may follow. */
const TRAILING_LINES = 8;
const COMMENT_RE = /^(?:\/\/|\/\*)\s*[#@]\s*sourceMappingURL\s*=\s*(\S+?)\s*(?:\*\/)?$/;

/**
 * Value of the last `sourceMappingURL` comment. Only trailing comment lines are considered,
 * so the string "sourceMappingURL=" inside code or a string literal is not picked up.
 */
export function findSourceMappingComment(text: string): string | null {
  let end = text.length;
  let inspected = 0;
  while (end > 0 && inspected < TRAILING_LINES) {
    const start = text.lastIndexOf('\n', end - 1) + 1;
    const line = text.slice(start, end).trim();
    end = start - 1;
    if (!line) continue;
    inspected++;
    const match = COMMENT_RE.exec(line);
    if (match?.[1]) return match[1];
    const isComment = line.startsWith('//') || (line.startsWith('/*') && line.endsWith('*/'));
    if (!isComment) return null;
  }
  return null;
}

/** Decode a `data:` URI to bytes, or null if malformed or larger than `maxBytes`. */
export function decodeDataUri(uri: string, maxBytes: number): Uint8Array | null {
  if (!/^data:/i.test(uri)) return null;
  const comma = uri.indexOf(',');
  if (comma < 0) return null;
  const meta = uri.slice(5, comma);
  const payload = uri.slice(comma + 1);
  try {
    if (/;base64$/i.test(meta)) {
      // Upper bound before decoding: 4 base64 chars -> 3 bytes.
      if (Math.floor((payload.length * 3) / 4) > maxBytes + 2) return null;
      const binary = atob(payload.replace(/\s+/g, ''));
      if (binary.length > maxBytes) return null;
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      return bytes;
    }
    const bytes = new TextEncoder().encode(decodeURIComponent(payload));
    return bytes.length > maxBytes ? null : bytes;
  } catch {
    return null;
  }
}

/** `<script>.map` next to the script, without query or fragment (`app.js?v=3` -> `app.js.map`). */
export function probeUrlFor(scriptUrl: string): string {
  const url = new URL(scriptUrl);
  url.search = '';
  url.hash = '';
  url.pathname = `${url.pathname}.map`;
  return url.href;
}

function resolveValue(
  value: string,
  base: string,
  via: 'header' | 'comment',
  maxBytes: number,
): MapRef | null {
  if (/^data:/i.test(value)) {
    const bytes = decodeDataUri(value, maxBytes);
    return bytes ? { type: 'inline', bytes, via: 'data-uri' } : null;
  }
  try {
    const url = new URL(value, base);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    url.hash = '';
    return { type: 'url', url: url.href, via };
  } catch {
    return null;
  }
}

/**
 * Where to find the source map for a fetched script. The `SourceMap` header wins over the
 * deprecated `X-SourceMap`, which wins over the comment. Probing is opt-in per site.
 */
export function discoverSourceMap(
  scriptUrl: string,
  headers: HeaderSource,
  text: string,
  { probe, maxBytes }: { probe: boolean; maxBytes: number },
): MapRef | null {
  const header = headers.get('SourceMap') ?? headers.get('X-SourceMap');
  if (header?.trim()) {
    const ref = resolveValue(header.trim(), scriptUrl, 'header', maxBytes);
    if (ref) return ref;
  }
  const comment = findSourceMappingComment(text);
  if (comment) {
    const ref = resolveValue(comment, scriptUrl, 'comment', maxBytes);
    if (ref) return ref;
  }
  return probe ? { type: 'url', url: probeUrlFor(scriptUrl), via: 'probe' } : null;
}

/** Cheap check before storing: JSON object (after an optional XSSI prefix) with `mappings`. */
export function looksLikeSourceMap(text: string): boolean {
  const body = text.replace(/^\)\]\}'[^\n]*\n/, '').trimStart();
  return body.startsWith('{') && (body.includes('"mappings"') || body.includes('"sections"'));
}
