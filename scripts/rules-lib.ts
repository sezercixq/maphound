import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import Ajv from 'ajv';
import { parse } from 'yaml';
import { Scanner } from '../src/engine/scan/scanner';
import type { CompiledRule, Confidence, RuleSet, Severity } from '../src/engine/scan/types';

export const RULES_DIR = 'rules';
export const OUTPUT = 'src/generated/rules.json';
/** Removed from samples before scanning; keeps fixtures from looking like real leaks. */
export const SPLIT_MARKER = '{{}}';
export const DEFAULT_WINDOW = 300;

type Sample = string | { text: string; severity?: Severity; confidence?: Confidence };

export interface SourceRule
  extends Omit<
    CompiledRule,
    | 'description'
    | 'confidence'
    | 'public'
    | 'generic'
    | 'flags'
    | 'validators'
    | 'window'
    | 'references'
  > {
  description?: string;
  confidence?: CompiledRule['confidence'];
  public?: boolean;
  generic?: boolean;
  flags?: string;
  validators?: CompiledRule['validators'];
  window?: number;
  references?: string[];
  tests: { positive: Sample[]; negative: Sample[] };
}

export interface LoadedRule {
  file: string;
  source: SourceRule;
  compiled: CompiledRule;
}

function listYaml(dir: string): string[] {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && /\.ya?ml$/.test(entry.name) && !entry.name.startsWith('_'))
    .map((entry) => join(entry.parentPath, entry.name))
    .sort();
}

const unsplit = (text: string) => text.split(SPLIT_MARKER).join('');
export const sampleText = (sample: Sample) =>
  unsplit(typeof sample === 'string' ? sample : sample.text);

function captureGroups(source: string, flags: string): number {
  return (new RegExp(`${source}|`, flags).exec('')?.length ?? 1) - 1;
}

/** Parse, schema-check and compile every rule. Returns rules and human-readable errors. */
export function loadRules(dir = RULES_DIR): { rules: LoadedRule[]; errors: string[] } {
  const ajv = new Ajv({ allErrors: true, strict: true });
  const validate = ajv.compile(JSON.parse(readFileSync(join(dir, '_schema.json'), 'utf8')));
  const errors: string[] = [];
  const rules: LoadedRule[] = [];
  const ids = new Map<string, string>();

  for (const path of listYaml(dir)) {
    const file = relative('.', path);
    let data: unknown;
    try {
      data = parse(readFileSync(path, 'utf8'));
    } catch (error) {
      errors.push(`${file}: invalid YAML: ${(error as Error).message}`);
      continue;
    }
    if (!validate(data)) {
      for (const e of validate.errors ?? [])
        errors.push(`${file}: ${e.instancePath || '/'} ${e.message}`);
      continue;
    }
    const source = data as SourceRule;
    const fail = (message: string) => errors.push(`${file} (${source.id}): ${message}`);
    if (ids.has(source.id)) fail(`duplicate id, also in ${ids.get(source.id)}`);
    ids.set(source.id, file);
    if (!file.endsWith(`${source.id}.yml`)) fail('file name must be <id>.yml');

    const flags = source.flags ?? '';
    try {
      new RegExp(source.regex, `gd${flags}`);
    } catch (error) {
      fail(`regex does not compile: ${(error as Error).message}`);
      continue;
    }
    if (captureGroups(source.regex, flags) < source.secretGroup)
      fail(`regex has no group ${source.secretGroup}`);
    if (new RegExp(source.regex, flags).test('')) fail('regex matches the empty string');
    for (const key of ['publicContext', 'requireContext'] as const) {
      const pattern = source[key];
      if (!pattern) continue;
      try {
        new RegExp(pattern, 'i');
      } catch (error) {
        fail(`${key} does not compile: ${(error as Error).message}`);
      }
    }
    for (const sample of source.tests.positive) {
      const text = sampleText(sample).toLowerCase();
      if (!source.keywords.some((keyword) => text.includes(keyword))) {
        fail(
          `positive sample contains none of the keywords, so the prefilter would skip it: ${sampleText(sample).slice(0, 60)}`,
        );
      }
    }

    rules.push({
      file,
      source,
      compiled: {
        id: source.id,
        name: source.name,
        description: source.description ?? '',
        severity: source.severity,
        confidence: source.confidence ?? 'medium',
        public: source.public ?? false,
        generic: source.generic ?? false,
        keywords: source.keywords,
        regex: source.regex,
        flags,
        secretGroup: source.secretGroup,
        ...(source.entropy !== undefined ? { entropy: source.entropy } : {}),
        validators: source.validators ?? [],
        ...(source.publicContext ? { publicContext: source.publicContext } : {}),
        ...(source.requireContext ? { requireContext: source.requireContext } : {}),
        window: source.window ?? DEFAULT_WINDOW,
        references: source.references ?? [],
      },
    });
  }
  return { rules, errors };
}

/** Run every rule's samples through the real scanner with all rules loaded. */
export function runRuleTests(rules: readonly LoadedRule[]): { errors: string[]; samples: number } {
  const scanner = new Scanner(rules.map((rule) => rule.compiled));
  const errors: string[] = [];
  let samples = 0;
  for (const { file, source } of rules) {
    for (const sample of source.tests.positive) {
      samples++;
      const text = sampleText(sample);
      const hit = scanner.scan(text).find((h) => h.ruleId === source.id);
      const label = `${file}: positive ${JSON.stringify(text.slice(0, 70))}`;
      if (!hit) {
        errors.push(`${label} was not detected`);
        continue;
      }
      if (typeof sample !== 'string') {
        if (sample.severity && hit.severity !== sample.severity)
          errors.push(`${label}: severity ${hit.severity}, expected ${sample.severity}`);
        if (sample.confidence && hit.confidence !== sample.confidence) {
          errors.push(`${label}: confidence ${hit.confidence}, expected ${sample.confidence}`);
        }
      }
    }
    for (const sample of source.tests.negative) {
      samples++;
      const text = sampleText(sample);
      const hit = scanner.scan(text).find((h) => h.ruleId === source.id);
      if (hit)
        errors.push(
          `${file}: negative ${JSON.stringify(text.slice(0, 70))} was detected as ${hit.preview}`,
        );
    }
  }
  return { errors, samples };
}

export function toRuleSet(rules: readonly LoadedRule[]): RuleSet {
  return {
    version: 1,
    rules: [...rules].map((rule) => rule.compiled).sort((a, b) => a.id.localeCompare(b.id)),
  };
}
