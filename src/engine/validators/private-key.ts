export interface PrivateKeyInfo {
  type: string;
  encrypted: boolean;
  bytes: number;
}

const PEM =
  /^-----BEGIN ([A-Z ]*?)PRIVATE KEY( BLOCK)?-----([\s\S]*?)-----END \1PRIVATE KEY\2-----$/;

/**
 * Check that a PEM block has a plausible body: header lines (`Proc-Type:`), JS string escapes
 * (`\n`) and whitespace are removed, and the rest must be base64 of at least 48 bytes.
 */
export function inspectPrivateKey(pem: string): PrivateKeyInfo | null {
  const match = PEM.exec(pem.trim());
  if (!match) return null;
  const type = (match[1] ?? '').trim() || 'PKCS8';
  const lines = (match[3] ?? '').split(/\\r\\n|\\n|\\r|\r?\n/);
  let encrypted = type === 'ENCRYPTED';
  const body: string[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.includes(':')) {
      if (/ENCRYPTED/i.test(trimmed)) encrypted = true;
      continue;
    }
    body.push(trimmed);
  }
  const base64 = body.join('').replace(/\s+/g, '');
  if (base64.length < 64 || !/^[A-Za-z0-9+/]+={0,2}$/.test(base64)) return null;
  try {
    const bytes = atob(base64).length;
    return bytes >= 48 ? { type, encrypted, bytes } : null;
  } catch {
    return null;
  }
}
