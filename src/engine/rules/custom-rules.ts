import { buildSnippet, maskSecret } from '@/engine/scan/mask';
import type { ScanHit, Severity } from '@/engine/scan/types';

export type CustomRuleScope = 'code' | 'html' | 'both';

export interface CustomRuleRecord {
  id: string;
  name: string;
  pattern: string;
  flags: string;
  severity: Severity;
  scope: CustomRuleScope;
  enabled: boolean;
  createdAt: number;
}

export interface RegexSafetyResult {
  safe: boolean;
  reason?: string;
  probeMs: number;
}

export interface CustomRuleTestMatch {
  line: number;
  column: number;
  preview: string;
  snippet: string;
}

export interface CustomRuleTestResult {
  safety: RegexSafetyResult;
  matches: CustomRuleTestMatch[];
  elapsedMs: number;
}

const MAX_PATTERN_LENGTH = 300;
const MAX_CUSTOM_MATCHES = 50;
const ALLOWED_FLAGS = /^[imsu]*$/;

// Static heuristic patterns that catch classic catastrophic backtracking (ReDoS) shapes in-browser.
const BACKREF_RE = /\\[1-9]/;
const NESTED_QUANTIFIER_RE = /\([^()]{0,120}[+*?][^()]{0,120}\)[+*{]/;
const ADJACENT_QUANTIFIERS_RE = /[+*]\s*[+*]/;
const REPEATED_WILDCARD_RE = /\(\.\*\)[+*{]|\(\.\+\)[+*{]/;

/**
 * In-browser ReDoS safety verifier: validates syntax, rejects backreferences and nested
 * quantifiers, and runs a bounded adversarial timing probe (< 20 ms budget).
 */
export function validateCustomRegex(pattern: string, flags = ''): RegexSafetyResult {
  const trimmed = pattern.trim();
  if (!trimmed) return { safe: false, reason: 'Pattern cannot be empty.', probeMs: 0 };
  if (trimmed.length > MAX_PATTERN_LENGTH) {
    return {
      safe: false,
      reason: `Pattern exceeds maximum length (${MAX_PATTERN_LENGTH} chars).`,
      probeMs: 0,
    };
  }
  if (!ALLOWED_FLAGS.test(flags)) {
    return { safe: false, reason: 'Only i, m, s, u flags are allowed.', probeMs: 0 };
  }
  if (BACKREF_RE.test(trimmed)) {
    return {
      safe: false,
      reason: 'Backreferences (\\1..\\9) are disallowed for ReDoS safety.',
      probeMs: 0,
    };
  }
  if (
    NESTED_QUANTIFIER_RE.test(trimmed) ||
    ADJACENT_QUANTIFIERS_RE.test(trimmed) ||
    REPEATED_WILDCARD_RE.test(trimmed)
  ) {
    return {
      safe: false,
      reason:
        'Nested or overlapping quantifiers detected (potential catastrophic backtracking / ReDoS).',
      probeMs: 0,
    };
  }

  let compiled: RegExp;
  try {
    compiled = new RegExp(trimmed, `${flags}g`);
  } catch (err) {
    return {
      safe: false,
      reason: err instanceof Error ? err.message : 'Invalid regular expression.',
      probeMs: 0,
    };
  }

  // Adversarial timing probe on short non-matching inputs
  const probes = [
    `${'a'.repeat(28)}!`,
    `${'0'.repeat(28)}!`,
    `${'a_'.repeat(14)}!`,
    `${' '.repeat(28)}!`,
  ];
  const t0 = performance.now();
  for (const probe of probes) {
    compiled.lastIndex = 0;
    compiled.exec(probe);
  }
  const probeMs = Math.round((performance.now() - t0) * 100) / 100;
  if (probeMs > 20) {
    return {
      safe: false,
      reason: `Regex took ${probeMs}ms on adversarial probe (exceeds 20ms safety limit).`,
      probeMs,
    };
  }

  return { safe: true, probeMs };
}

function lineColAt(text: string, offset: number): { line: number; column: number } {
  let line = 1;
  let lastNl = -1;
  for (let i = 0; i < offset; i++) {
    if (text.charCodeAt(i) === 10) {
      line++;
      lastNl = i;
    }
  }
  return { line, column: offset - lastNl - 1 };
}

/** Live Regex Playground runner: checks ReDoS safety first, then returns masked matches. */
export function testCustomRule(
  pattern: string,
  flags: string,
  sampleText: string,
): CustomRuleTestResult {
  const safety = validateCustomRegex(pattern, flags);
  if (!safety.safe) {
    return { safety, matches: [], elapsedMs: safety.probeMs };
  }
  const slice = sampleText.slice(0, 100_000);
  const regex = new RegExp(pattern.trim(), `${flags}g`);
  const matches: CustomRuleTestMatch[] = [];
  const t0 = performance.now();
  let m: RegExpExecArray | null = regex.exec(slice);
  while (m && matches.length < MAX_CUSTOM_MATCHES) {
    const raw = m[1] ?? m[0];
    if (raw.length > 0) {
      const preview = maskSecret(raw);
      const { line, column } = lineColAt(slice, m.index);
      matches.push({
        line,
        column,
        preview,
        snippet: buildSnippet(slice, m.index, m.index + m[0].length, preview),
      });
    }
    if (m[0].length === 0) regex.lastIndex++;
    m = regex.exec(slice);
  }
  const elapsedMs = Math.round((performance.now() - t0) * 100) / 100;
  return { safety, matches, elapsedMs };
}

/** Execute enabled ReDoS-validated custom rules against source/bundle text, returning `ScanHit[]`. */
export function scanWithCustomRules(
  text: string,
  rules: readonly CustomRuleRecord[],
  targetScope: 'code' | 'html',
): ScanHit[] {
  const hits: ScanHit[] = [];
  const slice = text.slice(0, 1_500_000);

  for (const rule of rules) {
    if (!rule.enabled) continue;
    if (rule.scope !== 'both' && rule.scope !== targetScope) continue;
    const safety = validateCustomRegex(rule.pattern, rule.flags);
    if (!safety.safe) continue;

    const regex = new RegExp(rule.pattern.trim(), `${rule.flags}g`);
    let count = 0;
    let m: RegExpExecArray | null = regex.exec(slice);
    while (m && count < 20) {
      const secret = m[1] ?? m[0];
      if (secret.length > 0) {
        const preview = maskSecret(secret);
        const { line, column } = lineColAt(slice, m.index);
        hits.push({
          ruleId: `custom/${rule.id}`,
          ruleName: `Custom: ${rule.name}`,
          severity: rule.severity,
          confidence: 'medium',
          secret,
          preview,
          snippet: buildSnippet(slice, m.index, m.index + m[0].length, preview),
          line,
          column,
          start: m.index,
          end: m.index + m[0].length,
          generic: false,
          occurrences: 1,
        });
        count++;
      }
      if (m[0].length === 0) regex.lastIndex++;
      m = regex.exec(slice);
    }
  }

  return hits;
}
