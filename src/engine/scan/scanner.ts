import { VALIDATORS } from '../validators';
import { isPlaceholder, shannonEntropy } from './entropy';
import { KeywordIndex } from './keyword-index';
import { buildSnippet, maskSecret } from './mask';
import { mergeWindows, runInWindows } from './regex-stage';
import {
  collapseRepeats,
  contextMatches,
  dropOverlaps,
  hasIgnoreComment,
  isEnvReference,
} from './suppress';
import {
  type CompiledRule,
  type Confidence,
  downgrade,
  type RuleSet,
  type ScanHit,
  type Severity,
} from './types';

/** Files above this size are scanned in overlapping chunks. */
export const CHUNK_SIZE = 1024 * 1024;
/** Minimum chunk overlap; raised to the largest rule window so no match is cut in half. */
export const MIN_OVERLAP = 512;
/** Keyword hits kept per rule and chunk; a minified bundle can mention "token" thousands of times. */
export const MAX_HITS_PER_RULE = 20_000;
/** Entropy within this margin above the threshold lowers confidence by one step. */
const ENTROPY_MARGIN = 0.3;

interface PreparedRule {
  rule: CompiledRule;
  regex: RegExp;
  publicContext?: RegExp;
  requireContext?: RegExp;
}

export interface ScanOptions {
  /** Keep only hits from these rules (the rule checker uses this). */
  onlyRules?: ReadonlySet<string>;
}

/**
 * The five-stage pipeline: keyword prefilter (Aho-Corasick) -> regex in windows around hits ->
 * placeholder and entropy filter -> offline validators -> context and suppression. Pure and
 * synchronous; runs in the scan worker.
 */
export class Scanner {
  private readonly prepared: PreparedRule[];
  private readonly index: KeywordIndex;
  /** keyword id -> rules using it */
  private readonly keywordRules: number[][];
  private readonly overlap: number;

  constructor(rules: RuleSet | readonly CompiledRule[]) {
    const list = Array.isArray(rules) ? rules : (rules as RuleSet).rules;
    this.prepared = list.map((rule) => ({
      rule,
      regex: new RegExp(rule.regex, `gd${rule.flags}`),
      publicContext: rule.publicContext ? new RegExp(rule.publicContext, 'i') : undefined,
      requireContext: rule.requireContext ? new RegExp(rule.requireContext, 'i') : undefined,
    }));
    const keywordIds = new Map<string, number>();
    this.keywordRules = [];
    this.prepared.forEach(({ rule }, ruleIndex) => {
      for (const keyword of rule.keywords) {
        let id = keywordIds.get(keyword);
        if (id === undefined) {
          id = keywordIds.size;
          keywordIds.set(keyword, id);
          this.keywordRules.push([]);
        }
        this.keywordRules[id]?.push(ruleIndex);
      }
    });
    this.index = new KeywordIndex([...keywordIds.keys()]);
    this.overlap = Math.max(MIN_OVERLAP, ...list.map((rule) => rule.window));
  }

  get ruleCount(): number {
    return this.prepared.length;
  }

  rule(id: string): CompiledRule | undefined {
    return this.prepared.find((p) => p.rule.id === id)?.rule;
  }

  scan(text: string, options: ScanOptions = {}): ScanHit[] {
    if (text.length === 0) return [];
    const raw: ScanHit[] = [];
    const seen = new Set<string>();
    // Small files in one pass; large ones in overlapping chunks so each regex call stays bounded.
    for (let chunkStart = 0; chunkStart < text.length; chunkStart += CHUNK_SIZE) {
      const chunkEnd = Math.min(text.length, chunkStart + CHUNK_SIZE + this.overlap);
      for (const hit of this.scanRange(text, chunkStart, chunkEnd, options)) {
        const key = `${hit.ruleId}:${hit.start}`;
        if (seen.has(key)) continue;
        seen.add(key);
        raw.push(hit);
      }
      if (chunkEnd === text.length) break;
    }
    const kept = collapseRepeats(dropOverlaps(raw));
    if (kept.length === 0) return kept;

    const lineStarts = computeLineStarts(text);
    for (const hit of kept) {
      const line = lineOf(lineStarts, hit.start);
      hit.line = line + 1;
      hit.column = hit.start - (lineStarts[line] as number);
      hit.snippet = buildSnippet(text, hit.start, hit.end, hit.preview);
    }
    return kept;
  }

  private scanRange(text: string, from: number, to: number, options: ScanOptions): ScanHit[] {
    const hitsByRule = new Map<number, { start: number; length: number }[]>();
    this.index.scan(
      text,
      (keywordId, start) => {
        for (const ruleIndex of this.keywordRules[keywordId] ?? []) {
          let list = hitsByRule.get(ruleIndex);
          if (!list) {
            list = [];
            hitsByRule.set(ruleIndex, list);
          }
          if (list.length < MAX_HITS_PER_RULE) {
            list.push({ start, length: this.index.keywords[keywordId]?.length ?? 1 });
          }
        }
      },
      from,
      to,
    );

    const hits: ScanHit[] = [];
    for (const [ruleIndex, keywordHits] of hitsByRule) {
      const prepared = this.prepared[ruleIndex] as PreparedRule;
      if (options.onlyRules && !options.onlyRules.has(prepared.rule.id)) continue;
      const windows = mergeWindows(keywordHits, prepared.rule.window, text.length);
      for (const match of runInWindows(text, prepared.regex, windows, prepared.rule.secretGroup)) {
        const hit = this.evaluate(prepared, text, match.start, match.end, match.secret);
        if (hit) hits.push(hit);
      }
    }
    return hits;
  }

  /** Stages 3 to 5 for one regex match. Returns null when the match is not reported. */
  private evaluate(
    prepared: PreparedRule,
    text: string,
    start: number,
    end: number,
    secret: string,
  ): ScanHit | null {
    const { rule } = prepared;
    if (isPlaceholder(secret)) return null;
    if (isEnvReference(secret, text, start)) return null;
    if (hasIgnoreComment(text, start)) return null;
    if (prepared.requireContext && !contextMatches(text, start, end, prepared.requireContext))
      return null;

    let confidence: Confidence = rule.confidence;
    let severity: Severity = rule.severity;

    if (rule.entropy !== undefined) {
      const entropy = shannonEntropy(secret);
      if (entropy < rule.entropy) return null;
      if (entropy < rule.entropy + ENTROPY_MARGIN) confidence = downgrade(confidence);
    }

    for (const name of rule.validators) {
      const result = VALIDATORS[name](secret);
      if (!result.valid) return null;
      if (result.strong) confidence = 'verified-format';
      if (result.severity) severity = result.severity;
    }

    if (
      rule.public ||
      (prepared.publicContext && contextMatches(text, start, end, prepared.publicContext))
    ) {
      severity = 'info';
    }

    const preview = maskSecret(secret);
    return {
      ruleId: rule.id,
      ruleName: rule.name,
      severity,
      confidence,
      secret,
      start,
      end,
      line: 0,
      column: 0,
      preview,
      snippet: '',
      occurrences: 1,
      generic: rule.generic,
    };
  }
}

export function computeLineStarts(text: string): number[] {
  const starts = [0];
  let index = text.indexOf('\n');
  while (index >= 0) {
    starts.push(index + 1);
    index = text.indexOf('\n', index + 1);
  }
  return starts;
}

/** 0-based line containing `offset`. */
export function lineOf(lineStarts: readonly number[], offset: number): number {
  let low = 0;
  let high = lineStarts.length - 1;
  while (low < high) {
    const mid = (low + high + 1) >> 1;
    if ((lineStarts[mid] as number) <= offset) low = mid;
    else high = mid - 1;
  }
  return low;
}
