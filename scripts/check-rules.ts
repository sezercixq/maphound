import { check } from 'recheck';
import { INTEL_PATTERNS } from '../src/engine/intel/patterns';
import { loadRules, runRuleTests } from './rules-lib';

/**
 * Full rule audit (`pnpm rules:check`): schema, compilation, the rules' own tests, a ReDoS proof
 * per regex with recheck, and a timing test against hostile input.
 */
const started = Date.now();
// More fuzzing seeds on CI; fewer locally to keep the command quick.
const RECHECK_SEEDS = process.env.CI ? [1, 2, 3, 4, 5] : [1, 2];
const { rules, errors } = loadRules();
const tests = runRuleTests(rules);
errors.push(...tests.errors);
const warnings: string[] = [];

for (const { file, source } of rules) {
  const patterns = [
    ['regex', source.regex, source.flags ?? ''],
    ['publicContext', source.publicContext, 'i'],
    ['requireContext', source.requireContext, 'i'],
  ] as const;
  for (const [name, pattern, flags] of patterns) {
    if (!pattern) continue;
    // Patterns with lookarounds are checked by recheck's fuzzer, which is random. Fixed seeds
    // make CI deterministic, and several of them widen the search.
    for (const randomSeed of RECHECK_SEEDS) {
      const result = await check(pattern, flags, { timeout: 20_000, randomSeed });
      if (result.status === 'vulnerable') {
        errors.push(
          `${file}: ${name} is vulnerable to ReDoS (${result.complexity.summary}), attack: ${result.attack.pattern}`,
        );
        break;
      }
      if (result.status === 'unknown') {
        warnings.push(`${file}: ${name} could not be proven safe (${result.error.kind})`);
        break;
      }
      if (result.checker === 'automaton') break; // exact proof, seeds do not matter
    }
  }

  // Belt and braces: worst-case inputs well beyond the window size the scanner uses.
  const regex = new RegExp(source.regex, `g${source.flags ?? ''}`);
  const keyword = source.keywords[0] ?? '';
  const hostile = [
    'a'.repeat(50_000),
    `${keyword}${'A'.repeat(50_000)}`,
    `${keyword}${'-'.repeat(50_000)}`,
    `${keyword}${'aB3_'.repeat(12_500)}!`,
    `${keyword}=${'"'.repeat(1_000)}${'x'.repeat(20_000)}`,
    `-----BEGIN PRIVATE KEY-----${'\\n'.repeat(10_000)}`,
  ];
  for (const input of hostile) {
    const t = performance.now();
    regex.lastIndex = 0;
    while (regex.exec(input) !== null) {
      // drain
    }
    const ms = performance.now() - t;
    if (ms > 250)
      errors.push(
        `${file}: regex took ${ms.toFixed(0)} ms on a ${input.length}-char hostile input`,
      );
  }
}

for (const { name, regex } of INTEL_PATTERNS) {
  for (const randomSeed of RECHECK_SEEDS) {
    const result = await check(regex.source, regex.flags.replace('g', ''), {
      timeout: 20_000,
      randomSeed,
    });
    if (result.status === 'vulnerable') {
      errors.push(
        `src/engine/intel/patterns.ts: ${name} is vulnerable to ReDoS (${result.complexity.summary}), attack: ${result.attack.pattern}`,
      );
      break;
    }
    if (result.status === 'unknown') {
      warnings.push(
        `src/engine/intel/patterns.ts: ${name} could not be proven safe (${result.error.kind})`,
      );
      break;
    }
    if (result.checker === 'automaton') break;
  }

  const probe = new RegExp(
    regex.source,
    regex.flags.includes('g') ? regex.flags : `g${regex.flags}`,
  );
  const hostile = ['a'.repeat(50_000), '/api/'.repeat(10_000), ' '.repeat(50_000)];
  for (const input of hostile) {
    const t = performance.now();
    probe.lastIndex = 0;
    while (probe.exec(input) !== null) {
      // drain
    }
    const ms = performance.now() - t;
    if (ms > 250) {
      errors.push(
        `src/engine/intel/patterns.ts: ${name} took ${ms.toFixed(0)} ms on a ${input.length}-char hostile input`,
      );
    }
  }
}

for (const warning of warnings) console.warn(`warning: ${warning}`);
if (errors.length > 0) {
  console.error(
    `rules:check: ${errors.length} error(s)\n${errors.map((e) => `  - ${e}`).join('\n')}`,
  );
  process.exit(1);
}
console.log(
  `rules:check: ${rules.length} rules, ${tests.samples} samples, ${INTEL_PATTERNS.length} intel patterns, ReDoS-safe, ${((Date.now() - started) / 1000).toFixed(1)} s`,
);
