# MapHound

Passive source map and bundle secret scanner for Chrome (Manifest V3). Everything stays local: no telemetry, no remote code, no live token validation.

> Status: early development (v0.1.0). Not yet published to the Chrome Web Store.

## What it does

- Discovers the JavaScript bundles a page loads, on sites you explicitly enable.
- Finds exposed source maps and rebuilds the original source tree in the browser.
- Scans for secrets with a pipeline: keyword prefilter, regex, entropy, offline format and checksum validation.
- Exports the rebuilt source and a findings report as a ZIP.

## Usage

1. Open the site and click the MapHound toolbar icon. The side panel opens.
2. Choose whether to include subdomains and whether to guess `<script>.map` URLs, then click **Enable this site**. Chrome asks for access to that site only.
3. MapHound lists the scripts the page loads, including lazy-loaded chunks, and the source maps it finds through the `SourceMap` header, the `sourceMappingURL` comment or inline `data:` URIs.
4. Click **Download sources (ZIP)**. The archive contains:

   ```
   manifest.json                        scanned URLs, hashes, what was skipped and why
   source/<host>/<script>/src/...       first-party files
   source/<host>/<script>/_vendor/...   node_modules and ignoreList files
   ```

5. **Disable and delete data** removes the collector, the site's data and the host permission.

The archive also contains `FINDINGS.md` and `findings.json`. Secret values are masked (`AKIA…XY12`) unless you tick **Include raw secret values in findings.json**; `FINDINGS.md` is always masked.

Paths from source maps are untrusted: every entry is sanitized (no `..`, absolute paths, drive letters, control characters or Windows device names), so an archive cannot write outside its folder. Limits per map: 20,000 files, 200 MB of content, 10 MB per file; maps over a limit are exported partially and marked as such.

## Secret scanning

Each script is scanned after its source maps are analysed: every original file from `sourcesContent` (exact file and line), then the bundle itself, which also holds values a bundler inlined at build time. Bundle positions are mapped back to the original file with the source map when possible.

The pipeline runs in a worker, offline:

1. **Keyword prefilter**: one Aho-Corasick pass; files without a keyword never reach a regex.
2. **Windowed regex**: only ±300 characters around keyword hits; files over 1 MB in overlapping chunks.
3. **Entropy and placeholders**: `your_api_key_here`, `xxxxx`, `EXAMPLE` and low-entropy values are dropped.
4. **Offline validation**: GitHub and npm token CRC32 checksums, JWT header/payload decoding, PEM key structure. A passing check means `verified-format` confidence; a failing one drops the match. Nothing is ever sent to a provider.
5. **Context**: `maphound-ignore` comments and `process.env` references are suppressed, repeats are merged, and publishable keys (Stripe `pk_live_`, Firebase web config, Supabase anon keys) are reported as `info`.

The 40 rules live in [`rules/`](./rules) as YAML (cloud, payment, VCS, SaaS/AI and generic). `pnpm rules:check` validates them against the schema, runs each rule's positive and negative samples, and proves every regex free of catastrophic backtracking with [recheck](https://makenowjust-labs.github.io/recheck/). See [`rules/README.md`](./rules/README.md) to add one.

## Privacy and permissions

MapHound declares no static `host_permissions` and no static `content_scripts`. Access is requested per site at runtime (`optional_host_permissions`). Third-party script origins are not scanned by default. Aggressive `<script>.map` probing is off by default.

## Development

```bash
pnpm install
pnpm dev        # opens Chrome with the extension
pnpm build
pnpm test
pnpm lint
pnpm rules:check   # schema, rule tests and ReDoS proof for every rule
```

Requires Node 20+ and pnpm.

## License

MIT
