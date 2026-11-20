/**
 * GitHub token checksum (also used by npm): `prefix_` + 30 base62 characters of entropy +
 * 6 base62 characters of CRC32(entropy), left-padded with `0`. Alphabet `0-9A-Za-z`.
 * https://github.blog/engineering/platform-security/behind-githubs-new-authentication-token-formats/
 */

const BASE62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

const TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

/** Standard CRC-32 (IEEE 802.3) of an ASCII/UTF-8 string. */
export function crc32(value: string): number {
  const bytes = new TextEncoder().encode(value);
  let crc = 0xffffffff;
  for (const byte of bytes) crc = (TABLE[(crc ^ byte) & 0xff] as number) ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

export function base62(value: number, width: number): string {
  let n = value;
  let out = '';
  do {
    out = BASE62[n % 62] + out;
    n = Math.floor(n / 62);
  } while (n > 0);
  return out.padStart(width, '0');
}

const TOKEN = /^(ghp|gho|ghu|ghs|ghr|npm)_([A-Za-z0-9]{30})([A-Za-z0-9]{6})$/;

/** True when the token's last 6 characters are the checksum of the 30 before them. */
export function hasValidGithubChecksum(token: string): boolean {
  const match = TOKEN.exec(token);
  if (!match) return false;
  return base62(crc32(match[2] as string), 6) === match[3];
}

/** Build a token with a correct checksum. For tests and fixtures only. */
export function makeGithubStyleToken(prefix: string, entropy: string): string {
  if (!/^[A-Za-z0-9]{30}$/.test(entropy)) throw new Error('entropy must be 30 base62 characters');
  return `${prefix}_${entropy}${base62(crc32(entropy), 6)}`;
}
