import { randomInt } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  buildSnippet,
  CHUNK_SIZE,
  type CompiledRule,
  computeLineStarts,
  isPlaceholder,
  KeywordIndex,
  lineOf,
  maskSecret,
  mergeWindows,
  runInWindows,
  Scanner,
  shannonEntropy,
} from '@/engine/scan';
import {
  base62,
  crc32,
  decodeJwt,
  hasValidGithubChecksum,
  inspectPrivateKey,
  makeGithubStyleToken,
  VALIDATORS,
} from '@/engine/validators';
import rules from '@/generated/rules.json';

const scanner = new Scanner(rules as { version: 1; rules: CompiledRule[] });
const ALNUM = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
const rand = (n: number, chars = ALNUM) =>
  Array.from({ length: n }, () => chars[randomInt(chars.length)]).join('');
// Built at runtime so the repository never contains a credential-shaped literal.
const stripeLive = () => ['sk', 'live', rand(32)].join('_');
const b64url = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
const jwt = (payload: unknown) =>
  `${b64url({ alg: 'HS256', typ: 'JWT' })}.${b64url(payload)}.${rand(43)}`;

describe('KeywordIndex (Aho-Corasick)', () => {
  it('finds overlapping keywords in one pass, case-insensitively', () => {
    const index = new KeywordIndex(['he', 'she', 'his', 'hers', 'sk_live_']);
    const hits: [string, number][] = [];
    index.scan('uSHErS and SK_LIVE_x', (id, start) =>
      hits.push([index.keywords[id] as string, start]),
    );
    expect(hits).toEqual([
      ['she', 1],
      ['he', 2],
      ['hers', 2],
      ['sk_live_', 11],
    ]);
  });
  it('respects a range', () => {
    const index = new KeywordIndex(['ab']);
    const hits: number[] = [];
    index.scan('ab ab ab', (_, start) => hits.push(start), 2, 6);
    expect(hits).toEqual([3]);
  });
});

describe('regex stage', () => {
  it('merges windows around keyword hits', () => {
    expect(
      mergeWindows(
        [
          { start: 100, length: 3 },
          { start: 150, length: 3 },
          { start: 1000, length: 3 },
        ],
        50,
        1020,
      ),
    ).toEqual([
      [50, 203],
      [950, 1020],
    ]);
  });
  it('reports group offsets in the original text', () => {
    const text = `${'x'.repeat(500)} key=abc123 ${'y'.repeat(500)}`;
    const matches = runInWindows(text, /key=([a-z0-9]+)/dg, [[480, 560]], 1);
    expect(matches).toEqual([{ start: 505, end: 511, secret: 'abc123' }]);
  });
});

describe('entropy and placeholders', () => {
  it('computes Shannon entropy', () => {
    expect(shannonEntropy('aaaa')).toBe(0);
    expect(shannonEntropy('abcd')).toBe(2);
    expect(shannonEntropy(rand(64))).toBeGreaterThan(4.5);
  });
  it.each([
    'your_api_key_here',
    'xxxxxxxxxxxxxxxx',
    ['sk', 'live', 'XXXXXXXXXXXXXXXX'].join('_'),
    'EXAMPLEKEY',
    '${STRIPE_KEY}',
    'password',
    'abc1234567',
    'aaaaaaaa1',
    'Your_Token',
    'XXXXXXXXXXXX',
    'FAKE_KEY_123',
  ])('treats %s as a placeholder', (value) => expect(isPlaceholder(value)).toBe(true));
  it('keeps random tokens', () => {
    for (let i = 0; i < 1000; i++) expect(isPlaceholder(rand(40))).toBe(false);
  });
});

describe('GitHub checksum (CRC32 + Base62)', () => {
  it('implements standard CRC-32 and base62', () => {
    expect(crc32('123456789')).toBe(0xcbf43926);
    expect(crc32('')).toBe(0);
    expect(base62(0, 6)).toBe('000000');
    expect(base62(61, 1)).toBe('z');
    expect(base62(62, 2)).toBe('10');
  });
  it('accepts correct checksums and rejects any change', () => {
    const token = makeGithubStyleToken('ghp', rand(30));
    expect(hasValidGithubChecksum(token)).toBe(true);
    const flipped = token.slice(0, -1) + (token.endsWith('A') ? 'B' : 'A');
    expect(hasValidGithubChecksum(flipped)).toBe(false);
    const body = token.slice(4, 34);
    const changedBody = `ghp_${body.slice(0, -1)}${body.endsWith('a') ? 'b' : 'a'}${token.slice(-6)}`;
    expect(hasValidGithubChecksum(changedBody)).toBe(false);
    expect(hasValidGithubChecksum(makeGithubStyleToken('npm', rand(30)))).toBe(true);
    expect(hasValidGithubChecksum('ghp_short')).toBe(false);
  });
});

describe('JWT validator', () => {
  it('decodes header and payload offline', () => {
    const token = jwt({ sub: '1', role: 'service_role' });
    expect(decodeJwt(token)?.payload).toEqual({ sub: '1', role: 'service_role' });
    expect(VALIDATORS['supabase-service-role'](token)).toEqual({ valid: true, strong: true });
    expect(VALIDATORS.jwt(jwt({ role: 'anon' }))).toEqual({
      valid: true,
      strong: true,
      severity: 'info',
    });
  });
  it('rejects malformed tokens', () => {
    expect(decodeJwt('eyJhbGciOiJIUzI1NiJ9.bm90IGpzb24.c2lnbmF0dXJlc2lnbmF0dXJl')).toBeNull();
    expect(decodeJwt(`${b64url({ typ: 'JWT' })}.${b64url({})}.${rand(43)}`)).toBeNull(); // no alg
    expect(decodeJwt(`${b64url({ alg: 'HS256' })}.${b64url([1])}.${rand(43)}`)).toBeNull(); // array payload
    expect(decodeJwt(`${b64url({ alg: 'HS256' })}.${b64url({})}.x`)).toBeNull(); // short signature
    expect(decodeJwt('a.b')).toBeNull();
    expect(VALIDATORS['supabase-service-role'](jwt({ role: 'anon' })).valid).toBe(false);
  });
});

describe('private key validator', () => {
  const body = Buffer.from(rand(300)).toString('base64');
  it('accepts PEM with real or escaped newlines and flags encryption', () => {
    expect(
      inspectPrivateKey(`-----BEGIN RSA PRIVATE KEY-----\n${body}\n-----END RSA PRIVATE KEY-----`),
    ).toMatchObject({
      type: 'RSA',
      encrypted: false,
    });
    expect(
      inspectPrivateKey(
        `-----BEGIN RSA PRIVATE KEY-----\\nProc-Type: 4,ENCRYPTED\\nDEK-Info: AES-128-CBC,AB\\n\\n${body}\\n-----END RSA PRIVATE KEY-----`,
      ),
    ).toMatchObject({ encrypted: true });
  });
  it('rejects bodies that are not base64 key material', () => {
    expect(
      inspectPrivateKey('-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----'),
    ).toBeNull();
    expect(
      inspectPrivateKey(`-----BEGIN RSA PRIVATE KEY-----\n${body}\n-----END EC PRIVATE KEY-----`),
    ).toBeNull();
  });
});

describe('masking', () => {
  it('never reveals more than a few characters', () => {
    const secret = stripeLive();
    expect(maskSecret(secret)).toBe(`sk_l…${secret.slice(-4)}`);
    expect(maskSecret('abcdefghij')).toBe('abc…ij');
    expect(maskSecret('-----BEGIN RSA PRIVATE KEY-----\nAAAA')).toBe(
      '-----BEGIN RSA PRIVATE KEY----- … (36 chars)',
    );
    expect(buildSnippet('const k = "SECRETVALUE"; run();', 11, 22, 'SEC…LUE')).toBe(
      'const k = "SEC…LUE"; run();',
    );
  });
});

describe('Scanner pipeline', () => {
  it('skips files without any keyword', () => {
    expect(scanner.scan(`const a = "${rand(64)}";\n`.repeat(100))).toEqual([]);
  });

  it('reports provider keys with line, column and masked snippet', () => {
    const secret = stripeLive();
    const text = `// config\nconst stripe = Stripe("${secret}");\n`;
    const [hit, ...rest] = scanner.scan(text);
    expect(rest).toEqual([]);
    expect(hit).toMatchObject({
      ruleId: 'stripe-live-secret-key',
      severity: 'critical',
      confidence: 'high',
      secret,
      line: 2,
      column: 23,
      occurrences: 1,
    });
    expect(hit?.snippet).toBe(`const stripe = Stripe("${hit?.preview}");`);
    expect(hit?.snippet).not.toContain(secret);
  });

  it('verifies GitHub tokens and drops forged checksums', () => {
    const token = makeGithubStyleToken('ghp', rand(30));
    expect(scanner.scan(`t="${token}"`)[0]).toMatchObject({
      ruleId: 'github-classic-pat',
      confidence: 'verified-format',
    });
    const forged = token.slice(0, -1) + (token.endsWith('Z') ? 'Y' : 'Z');
    expect(scanner.scan(`t="${forged}"`)).toEqual([]);
  });

  it('prefers the specific rule on overlapping matches', () => {
    const service = jwt({ iss: 'supabase', role: 'service_role' });
    expect(
      scanner.scan(`createClient(u, "${service}")`).map((h) => [h.ruleId, h.severity]),
    ).toEqual([['supabase-service-role-key', 'critical']]);
    const stripe = stripeLive();
    expect(scanner.scan(`apiKey: "${stripe}"`).map((h) => h.ruleId)).toEqual([
      'stripe-live-secret-key',
    ]);
  });

  it('lowers public keys to info', () => {
    expect(
      scanner.scan(`createClient(u, "${jwt({ iss: 'supabase', role: 'anon' })}")`)[0],
    ).toMatchObject({
      ruleId: 'json-web-token',
      severity: 'info',
    });
    const key = `AIza${rand(35, `${ALNUM}_-`)}`;
    expect(
      scanner.scan(`{ apiKey: "${key}", authDomain: "app.firebaseapp.com" }`)[0],
    ).toMatchObject({
      ruleId: 'gcp-api-key',
      severity: 'info',
    });
    expect(scanner.scan(`fetch("/v1?key=${key}")`)[0]).toMatchObject({ severity: 'medium' });
  });

  it('suppresses ignore comments, env references and placeholders', () => {
    const secret = stripeLive();
    expect(scanner.scan(`const k = "${secret}"; // maphound-ignore`)).toEqual([]);
    expect(scanner.scan(`// maphound-ignore\nconst k = "${secret}";`)).toEqual([]);
    expect(scanner.scan(`const k = "${secret}";`)).toHaveLength(1);
    // A trailing ignore after code covers its own line only.
    expect(scanner.scan(`const a = 1; // maphound-ignore\nconst k = "${secret}";`)).toHaveLength(1);
    expect(scanner.scan(`/* maphound-ignore */\nconst k = "${secret}";`)).toEqual([]);
    expect(scanner.scan(`password: "\${process.env.DB_PASSWORD}"`)).toEqual([]);
    expect(scanner.scan('apiKey: "your_api_key_here_0000"')).toEqual([]);
  });

  it('collapses repeats of the same secret', () => {
    const secret = stripeLive();
    const hits = scanner.scan(`a("${secret}");\nb("${secret}");\nc("${secret}");`);
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ line: 1, occurrences: 3 });
  });

  it('finds secrets across chunk borders of large files', () => {
    const secret = stripeLive();
    const padding = 'x'.repeat(CHUNK_SIZE - 10);
    const text = `${padding}"${secret}"\n${'y'.repeat(2 * CHUNK_SIZE)}"${stripeLive()}"`;
    const hits = scanner.scan(text);
    expect(hits.map((h) => h.line)).toEqual([1, 2]);
    expect(hits[0]?.secret).toBe(secret);
  });

  it('scans a 5 MB bundle quickly', () => {
    const chunk = 'function a(b){return b.token?b.secret:fetch("/api/key",{headers:{auth:b}})}\n';
    const text = chunk.repeat(Math.ceil((5 * 1024 * 1024) / chunk.length));
    const started = performance.now();
    expect(scanner.scan(text)).toEqual([]);
    expect(performance.now() - started).toBeLessThan(10_000);
  });

  it('maps offsets to lines', () => {
    const starts = computeLineStarts('a\nbb\n\nccc');
    expect(starts).toEqual([0, 2, 5, 6]);
    expect([0, 1, 2, 4, 5, 6, 8].map((o) => lineOf(starts, o))).toEqual([0, 0, 1, 1, 2, 3, 3]);
  });
});
