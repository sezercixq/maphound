# Detection rules

One YAML file per rule, grouped by provider category. `pnpm rules:compile` validates them against
[`_schema.json`](./_schema.json), runs every rule's own tests and writes `src/generated/rules.json`,
which is bundled into the extension. `pnpm build`, `pnpm dev` and `pnpm test` run it first.
`pnpm rules:check` additionally proves every regex free of catastrophic backtracking (ReDoS) with
[recheck](https://makenowjust-labs.github.io/recheck/) and times each one against hostile input.

## How a rule is applied

1. **Keywords**: an Aho-Corasick pass finds every keyword. A rule never runs on text without one.
2. **Regex**: runs only within `window` characters (default 300) around keyword hits.
3. **Entropy and placeholders**: `your_api_key_here`, `xxxx…` and values below `entropy` are dropped.
4. **Validators**: offline checks. A checksum or structural decode raises confidence to `verified-format`;
   a failed one drops the match.
5. **Context**: `maphound-ignore` on the line or the line above, `process.env.*` references and
   repeats are suppressed; `public: true` or `publicContext` lowers severity to `info`.

## Tests and the `{{}}` marker

Every rule needs positive and negative samples. Positive samples look like real credentials, so they
are written with a `{{}}` marker inside the secret, e.g. `sk_live_{{}}4eC39H…`. The test runner removes
the marker before scanning. This keeps repository secret scanners (GitHub push protection) from
mistaking fixtures for leaks. All samples are random and were never valid credentials.

A sample can also assert the outcome:

```yaml
positive:
  - text: 'const token = "ghp_{{}}…";'
    confidence: verified-format
  - text: 'apiKey: "AIza{{}}…", authDomain: "x.firebaseapp.com"'
    severity: info
```
