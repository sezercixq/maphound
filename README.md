<div align="center">

<img src="docs/assets/logo.svg" width="84" alt="MapHound logo">

# MapHound

**Rebuild exposed source maps and find the secrets they leak, entirely inside your browser.**

[![CI](https://github.com/sezercixq/maphound/actions/workflows/ci.yml/badge.svg)](https://github.com/sezercixq/maphound/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-10b981.svg)](LICENSE)
![Chrome Manifest V3](https://img.shields.io/badge/Chrome-Manifest%20V3-4285F4?logo=googlechrome&logoColor=white)
![40 detectors](https://img.shields.io/badge/detectors-40%2C%20ReDoS--proven-10b981)
![100% local](https://img.shields.io/badge/data-100%25%20local-18181b)

<img src="docs/assets/maphound-preview.png" alt="MapHound rebuilds app.js.map into its original source tree and flags a hard-coded GitHub token with a verified checksum" width="100%">

</div>

Modern web apps ship minified bundles, and often the source maps that turn them back into the
original code: file names, comments, internal API routes and, too often, hard-coded credentials.
MapHound collects the scripts a page loads, recovers that source tree, scans it for secrets and lets
you export everything as a ZIP. No server, no account, no telemetry.

## Why MapHound?

|                                                                               | MapHound | Typical secret-finder extensions | Source map downloaders |
| ----------------------------------------------------------------------------- | :------: | :------------------------------: | :--------------------: |
| Rebuilds the original source tree from source maps                            |    ✅    |                ❌                |           ✅           |
| Finds lazy-loaded chunks and `SourceMap` headers, not just `<script>` tags    |    ✅    |              partly              |         partly         |
| Scans the original files **and** values inlined into the bundle at build time |    ✅    |           bundle only            |           ❌           |
| Reports the original file and line, mapped back through the source map        |    ✅    |                ❌                |           ❌           |
| Offline checksum and structure validation (GitHub CRC32, JWT, PEM)            |    ✅    |                ❌                |           ❌           |
| Every rule proven free of catastrophic backtracking (ReDoS) in CI             |    ✅    |                ❌                |          n/a           |
| Zip-Slip-safe export of attacker-controlled paths                             |    ✅    |               n/a                |         rarely         |
| No host access at install; one site at a time, revocable                      |    ✅    |       usually `<all_urls>`       |         varies         |
| Nothing leaves the browser                                                    |    ✅    |              varies              |           ✅           |

### Highlights

- **Source map reconstruction.** `SourceMap`/`X-SourceMap` headers, `sourceMappingURL` comments,
  inline `data:` maps, index maps with `sections`, XSSI prefixes. `node_modules` and `ignoreList`
  files are separated into `_vendor/`.
- **40 detectors** for AWS, Google Cloud, Azure, Stripe, GitHub, GitLab, npm, OpenAI, Anthropic,
  Slack, Supabase, Twilio, SendGrid, private keys and more, written as YAML and compiled into the
  extension at build time.
- **A five-stage scanner** that stays fast on large bundles (about 100 ms for 5 MB): Aho-Corasick
  keyword prefilter, regex only around keyword hits, entropy and placeholder filtering, offline
  validators, context and suppression.
- **Low noise.** Placeholders such as `your_api_key_here` are dropped, checksums must match, and keys
  meant to be public (Stripe `pk_live_`, Firebase web config, Supabase anon keys) are reported as
  `info`, not as alarms.
- **CDNs and sibling domains, one click away.** Big apps serve their bundles from a CDN or another
  domain of theirs. MapHound groups those origins and scans them with **Allow & scan**, one origin
  or all of them at once, without ever asking for blanket access.
- **Private by construction.** Optional per-site host permissions only, no `webRequest`, no remote
  code, no outbound requests except to the site you enabled. See [`docs/PRIVACY.md`](docs/PRIVACY.md).

## Quick start

### Install a build

1. Open the latest successful [CI run](https://github.com/sezercixq/maphound/actions/workflows/ci.yml)
   (sign in to GitHub), download the `maphound-<version>-chrome.zip` artifact and unzip it.
2. Go to `chrome://extensions`, turn on **Developer mode** and click **Load unpacked**.
3. Select the unzipped folder (the one that contains `manifest.json`).

### Build from source

Requires Node 22+ and pnpm (`corepack enable` picks the pinned version).

```bash
git clone https://github.com/sezercixq/maphound.git
cd maphound
pnpm install
pnpm build          # output: .output/chrome-mv3, load it as above
# or: pnpm dev      # Chrome with the extension and hot reload
```

### Use it

1. Open the site and click the MapHound toolbar icon to open the side panel.
2. Choose whether to include subdomains and whether to guess `<script>.map` URLs, then click
   **Enable this site**. Chrome asks for access to that site only.
3. MapHound lists scripts (including lazy chunks), the source maps it found and the **Findings**:
   severity, confidence, `file:line` in the original source, with reveal and copy.
   With subdomains on, the scope is the whole registrable domain (`*.airbnb.com.tr` for
   `www.airbnb.com.tr`).
4. Scripts from other origins are listed under **Third-party origins**. If one of them is really the
   site's own CDN or a sibling domain, click **Allow & scan** (or **Allow & scan all**; analytics and
   tag managers are left out unless you tick them). Chrome asks once, and those scripts are fetched
   and scanned like the site's own.
5. **Download sources (ZIP)** exports:

   ```
   FINDINGS.md                          readable report, secrets always masked
   findings.json                        machine-readable; raw values only if you opt in
   manifest.json                        scanned URLs, hashes, what was skipped and why
   source/<host>/<script>/src/...       first-party files
   source/<host>/<script>/_vendor/...   node_modules and ignoreList files
   ```

6. **Disable and delete data** removes the collector, the site's data and every host permission it
   was granted, extra origins included.

## How it works

```mermaid
flowchart LR
  A["Collector<br/>script URLs"] --> B["Service worker<br/>fetch, SHA-256, queue"]
  B --> C["Source map<br/>discovery"]
  C --> D["Scan worker<br/>rebuild tree"]
  D --> E["Secret scanner<br/>5 stages"]
  E --> F[("IndexedDB")]
  F --> G["Side panel<br/>and ZIP export"]
```

Scripts are fetched by the extension (no CORS issues, no cookies by default), stored once by hash,
and analysed in a worker. Maps are parsed and every path is sanitized before it can reach an
archive. Each script is scanned after its maps, so a secret found in the bundle can still be traced to
its original file. Details: [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

## Contribute a detector

A detector is one YAML file. This is all it takes:

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
  negative: ["acme_live_{{}}xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"]
```

Save it as `rules/saas/acme-api-key.yml` and run `pnpm rules:check`: it validates the schema, runs
your samples through the real scanner and proves the regex ReDoS-safe. The `{{}}` marker keeps fake
samples from tripping repository secret scanners. Validators for checksums and JWTs, public-key
handling and more are explained in [`CONTRIBUTING.md`](CONTRIBUTING.md).

Missing a provider? [Propose a detector](https://github.com/sezercixq/maphound/issues/new?template=new-detector.yml),
or open a pull request. Every rule ships with tests, so reviews are quick.

## Development

```bash
pnpm lint          # Biome lint and format check
pnpm typecheck     # TypeScript, strict
pnpm test          # 199 unit tests (Vitest)
pnpm rules:check   # rule schema, samples, ReDoS proof
VITE_MH_E2E=1 pnpm build && pnpm test:e2e   # real-Chromium end-to-end tests (Playwright)
```

CI runs all of the above on every push and pull request and publishes the packaged extension as a
build artifact.

## Responsible use

MapHound is for **authorized security testing and for auditing your own applications.** Only enable
it on sites you own or have explicit permission to test, for example within the scope of a bug bounty
program. Source maps and bundles are publicly served, but what you do with what you find is your
responsibility.

If MapHound finds a credential on someone else's site, **do not use it**. Report it to the owner
through their security contact or bug bounty program so it can be revoked. The authors accept no
liability for misuse.

## Security and privacy

- Found a vulnerability in MapHound? Please report it privately: [`SECURITY.md`](SECURITY.md).
- What MapHound does and does not do with data, and why each permission is needed:
  [`docs/PRIVACY.md`](docs/PRIVACY.md).

## License

[MIT](LICENSE) © MapHound contributors
