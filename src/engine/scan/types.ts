import type { Confidence, Severity } from '../../core/db';

export type { Confidence, Severity };

export type ValidatorName =
  | 'github-checksum'
  | 'github-fine-grained'
  | 'jwt'
  | 'supabase-service-role'
  | 'private-key';

/** A rule as compiled from `rules/**\/*.yml` into `src/generated/rules.json`. */
export interface CompiledRule {
  id: string;
  name: string;
  description: string;
  severity: Severity;
  /** Base confidence before validation. `verified-format` is only granted by a validator. */
  confidence: Exclude<Confidence, 'verified-format'>;
  /** Meant to be public (publishable keys): always reported as `info`. */
  public: boolean;
  /** Catch-all rule; a provider-specific rule matching the same text always wins. */
  generic: boolean;
  /** Lowercase literals; the regex only runs near one of them. */
  keywords: string[];
  regex: string;
  /** Extra RegExp flags (only `i`). `g` and `d` are always added. */
  flags: string;
  /** Capture group holding the secret (0 = whole match). */
  secretGroup: number;
  /** Minimum Shannon entropy (bits per character) of the secret. */
  entropy?: number;
  validators: ValidatorName[];
  /** Seen within ±200 chars: the key is a public config value, reported as `info`. */
  publicContext?: string;
  /** Must be seen within ±200 chars, or the match is dropped. */
  requireContext?: string;
  /** Characters around a keyword hit that the regex may look at. */
  window: number;
  references: string[];
}

export interface RuleSet {
  version: 1;
  rules: CompiledRule[];
}

export interface ScanHit {
  ruleId: string;
  ruleName: string;
  severity: Severity;
  confidence: Confidence;
  secret: string;
  /** UTF-16 offsets of the secret in the scanned text. */
  start: number;
  end: number;
  /** 1-based line and 0-based column of `start`. */
  line: number;
  column: number;
  /** Masked secret, e.g. `AKIA…XY12`. */
  preview: string;
  /** The surrounding line with the secret masked. */
  snippet: string;
  /** How many times this rule matched this exact secret in the text. */
  occurrences: number;
  /** From a catch-all rule. */
  generic: boolean;
}

export const SEVERITY_ORDER: Record<Severity, number> = {
  critical: 4,
  high: 3,
  medium: 2,
  low: 1,
  info: 0,
};
export const CONFIDENCE_ORDER: Record<Confidence, number> = {
  'verified-format': 3,
  high: 2,
  medium: 1,
  low: 0,
};

export function downgrade(confidence: Confidence): Confidence {
  return confidence === 'verified-format' ? 'high' : confidence === 'high' ? 'medium' : 'low';
}
