/** Masked display form of a secret. Never enough to use it, enough to recognize it. */
export function maskSecret(secret: string): string {
  const flat = secret.trim();
  const pem = /^-----BEGIN ([A-Z ]+)-----/.exec(flat);
  if (pem) return `-----BEGIN ${pem[1]}----- … (${flat.length} chars)`;
  if (flat.length <= 8) return `${flat.slice(0, 1)}…`;
  if (flat.length <= 16) return `${flat.slice(0, 3)}…${flat.slice(-2)}`;
  return `${flat.slice(0, 4)}…${flat.slice(-4)}`;
}

/** The line around a match, secret masked, clipped to ~160 characters. */
export function buildSnippet(text: string, start: number, end: number, preview: string): string {
  const lineStart = text.lastIndexOf('\n', start - 1) + 1;
  let lineEnd = text.indexOf('\n', end);
  if (lineEnd < 0) lineEnd = text.length;
  const from = Math.max(lineStart, start - 60);
  const to = Math.min(lineEnd, end + 60);
  const before = text.slice(from, start).replace(/\s+/g, ' ').trimStart();
  const after = text.slice(end, to).replace(/\s+/g, ' ').trimEnd();
  const snippet = `${from > lineStart ? '…' : ''}${before}${preview}${after}${to < lineEnd ? '…' : ''}`;
  return snippet.length > 200 ? `${snippet.slice(0, 199)}…` : snippet;
}
