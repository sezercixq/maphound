import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { loadRules, OUTPUT, runRuleTests, toRuleSet } from './rules-lib';

/** Validate rules, run their tests and write src/generated/rules.json. Fails the build on error. */
const { rules, errors } = loadRules();
if (errors.length === 0) errors.push(...runRuleTests(rules).errors);
if (errors.length > 0) {
  console.error(`rules: ${errors.length} error(s)\n${errors.map((e) => `  - ${e}`).join('\n')}`);
  process.exit(1);
}
const json = `${JSON.stringify(toRuleSet(rules), null, 2)}\n`;
let current = '';
try {
  current = readFileSync(OUTPUT, 'utf8');
} catch {
  // first build
}
if (current !== json) {
  mkdirSync(dirname(OUTPUT), { recursive: true });
  writeFileSync(OUTPUT, json);
}
console.log(`rules: compiled ${rules.length} rules -> ${OUTPUT}`);
