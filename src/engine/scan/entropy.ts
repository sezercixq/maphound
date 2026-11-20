/** Shannon entropy in bits per character. */
export function shannonEntropy(value: string): number {
  if (value.length === 0) return 0;
  const counts = new Map<number, number>();
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    counts.set(code, (counts.get(code) ?? 0) + 1);
  }
  let entropy = 0;
  for (const count of counts.values()) {
    const p = count / value.length;
    entropy -= p * Math.log2(p);
  }
  return entropy;
}

/**
 * Matched as all-lowercase, all-uppercase or Capitalized only, and at least five characters
 * (or containing punctuation): mixed-case random tokens then practically never match by chance.
 */
const PLACEHOLDER_PARTS = [
  'example',
  'sample',
  'placeholder',
  'your_',
  'your-',
  'yourkey',
  'yourtoken',
  '<your',
  'changeme',
  'change_me',
  'dummy',
  'redacted',
  'insert',
  'replace',
  'xxxxx',
  '****',
  '####',
  '....',
  'fake_',
  'fake-',
  'testkey',
  'test_key',
];

const PLACEHOLDER_EXACT = new Set([
  'password',
  'passw0rd',
  'secret',
  'postgres',
  'root',
  'admin',
  'test',
  'testing',
  'undefined',
  'null',
  'none',
]);

const SEQUENCES = ['0123456', '1234567', '2345678', '3456789', 'abcdefg', 'bcdefgh', 'qwerty'];

/**
 * Documentation and template values (`your_api_key_here`, `xxxxxxxx`, `sk_live_XXXX`,
 * `${TOKEN}`). Random tokens practically never contain these.
 */
export function isPlaceholder(secret: string): boolean {
  const lower = secret.toLowerCase();
  if (PLACEHOLDER_EXACT.has(lower)) return true;
  if (/^(?:\$\{|\{\{|<%|%\(|\$[A-Z_]+$)/.test(secret)) return true;
  if (/(.)\1{5,}/.test(lower)) return true;
  if (PLACEHOLDER_PARTS.some((part) => lower.includes(part) && containsAsWord(secret, part)))
    return true;
  return SEQUENCES.some((sequence) => lower.includes(sequence) && containsAsWord(secret, sequence));
}

function containsAsWord(value: string, lowerPart: string): boolean {
  const capitalized = lowerPart.charAt(0).toUpperCase() + lowerPart.slice(1);
  return (
    value.includes(lowerPart) ||
    value.includes(lowerPart.toUpperCase()) ||
    value.includes(capitalized)
  );
}
