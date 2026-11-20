export interface DecodedJwt {
  header: Record<string, unknown>;
  payload: Record<string, unknown>;
  signature: string;
}

function base64UrlToText(segment: string): string | null {
  if (!/^[A-Za-z0-9_-]+$/.test(segment)) return null;
  const base64 = segment.replace(/-/g, '+').replace(/_/g, '/');
  const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
  try {
    const binary = atob(padded);
    const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

function parseObject(text: string | null): Record<string, unknown> | null {
  if (text === null) return null;
  try {
    const value: unknown = JSON.parse(text);
    return typeof value === 'object' && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/**
 * Structural JWS check, offline: base64url header and payload that decode to JSON objects,
 * a string `alg`, and a signature unless `alg` is `none`. The signature is not verified.
 */
export function decodeJwt(token: string): DecodedJwt | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [rawHeader, rawPayload, signature] = parts as [string, string, string];
  const header = parseObject(base64UrlToText(rawHeader));
  if (!header || typeof header.alg !== 'string') return null;
  const payload = parseObject(base64UrlToText(rawPayload));
  if (!payload) return null;
  if (header.alg.toLowerCase() !== 'none' && !/^[A-Za-z0-9_-]{16,}$/.test(signature)) return null;
  return { header, payload, signature };
}
