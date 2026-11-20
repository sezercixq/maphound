# Contributing to MapHound

Thanks for helping. The most valuable contribution is usually a new **detector**: one YAML file,
reviewed in minutes. Bug fixes, docs and features are welcome too.

## Ground rules

- **Never commit, paste or attach a real credential**, not even an expired one. Issues and pull
  requests are public. Use randomly generated values (see below).
- MapHound only reads what a site already serves publicly, only on sites the user enables, and never
  sends anything anywhere. Changes that add network requests, permissions or remote code need a very
  good reason and an update to [`docs/PRIVACY.md`](docs/PRIVACY.md).

## Run it locally

Requirements: Node 22+, pnpm 12 (`corepack enable` picks the pinned version), Chrome 116+.

```bash
git clone https://github.com/sezercixq/maphound.git
cd maphound
pnpm install          # also compiles the rules
pnpm dev              # opens Chrome with the extension loaded, with hot reload
```

| Command            | What it does                                                     |
| ------------------ | ---------------------------------------------------------------- |
| `pnpm build`       | Production build into `.output/chrome-mv3`                       |
| `pnpm zip`         | Build and package `.output/maphound-<version>-chrome.zip`        |
| `pnpm lint`        | Biome lint and format check (`pnpm format` fixes formatting)     |
| `pnpm typecheck`   | TypeScript in strict mode                                        |
| `pnpm test`        | Unit tests (Vitest)                                              |
| `pnpm rules:check` | Rule schema, samples, ReDoS proof and timing                     |
| `pnpm test:e2e`    | Real-Chromium tests; build first with `VITE_MH_E2E=1 pnpm build` |

For the end-to-end tests, install the browser once with `pnpm exec playwright install chromium`.
The `VITE_MH_E2E=1` build adds test hooks and pre-grants `http://127.0.0.1/*`; never ship it.

Where things live is described in [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

## Add a detector in one file

Create `rules/<category>/<id>.yml` (categories: `cloud`, `payment`, `vcs`, `saas`, `generic`):

```yaml
id: acme-api-key
name: "Acme API key"
severity: high
confidence: high
keywords: ["acme_live_"]
regex: "(?<![A-Za-z0-9_])(acme_live_[A-Za-z0-9]{32})(?![A-Za-z0-9])"
secretGroup: 1
entropy: 3.5
references: [https://docs.acme.example/api-keys]
tests:
  positive: ['const key = "acme_live_{{}}Hq3ZtV9mK2pR7xW4bN8cL1fD6gJ0sY5a";']
  negative: ["acme_live_{{}}xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx", "acme_live_{{}}short"]
```

Then run `pnpm rules:check`. It validates the file against [`rules/_schema.json`](rules/_schema.json),
runs your samples through the real scanner and proves the regex free of catastrophic backtracking.

How to write a good rule:

- **keywords** are lowercase literals that must appear near every secret. The regex only runs within
  `window` characters (default 300) of a keyword, so pick the provider prefix.
- **regex** is JavaScript syntax. Put the secret in a capture group (`secretGroup`). Anchor it with
  lookarounds like `(?<![A-Za-z0-9_])` and `(?![A-Za-z0-9])` instead of `\b`, which treats `_` as a
  word character. Bound every repetition (`{32}`, `{20,64}`), never use nested quantifiers.
- **entropy** drops low-randomness values. 3.0 to 3.5 suits prefixed tokens; generic rules need 3.8+.
- **validators** add offline checks: `github-checksum`, `github-fine-grained`, `jwt`,
  `supabase-service-role`, `private-key`. A passing checksum makes the finding `verified-format`.
- **public: true** marks keys meant to be embedded in pages (reported as `info`).
  **publicContext** does the same only when a regex matches nearby (Firebase web configs).
- **severity** describes what an attacker could do with the key, not how often it leaks.
- Optional fields: `description`, `flags: i`, `requireContext`, `window`, `generic`.

### Test samples and the `{{}}` marker

Positive samples must look real, which makes repository secret scanners (including GitHub push
protection) block the push. Put `{{}}` anywhere inside the secret: the test runner removes it before
scanning. Do the same in negative samples that start with a provider prefix.

Generate a random body instead of inventing one:

```bash
node -e "const c='ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';console.log(Array.from(crypto.getRandomValues(new Uint32Array(32)),n=>c[n%c.length]).join(''))"
```

Include at least one placeholder negative (`xxxx…`, `your_key_here`) and, where it makes sense, a
near miss (wrong length, wrong checksum). Samples can assert the outcome:

```yaml
positive:
  - text: 'token = "ghp_{{}}…"'
    confidence: verified-format
  - text: 'apiKey: "AIza{{}}…", authDomain: "demo.firebaseapp.com"'
    severity: info
```

## Pull requests

1. Fork, create a branch, make the change with tests.
2. Run `pnpm lint && pnpm typecheck && pnpm test` (and `pnpm rules:check` for rules).
3. Use [Conventional Commits](https://www.conventionalcommits.org/) for the title:
   `feat(rules): add Acme API key`, `fix: ...`, `docs: ...`.
4. Fill in the pull request checklist. CI runs everything, including Chromium end-to-end tests.

## Reporting

- Bugs and detector ideas: [issue forms](https://github.com/sezercixq/maphound/issues/new/choose).
- Vulnerabilities in MapHound: privately, see [`SECURITY.md`](SECURITY.md).

By contributing you agree that your work is released under the [MIT License](LICENSE).
