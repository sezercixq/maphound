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

Paths from source maps are untrusted: every entry is sanitized (no `..`, absolute paths, drive letters, control characters or Windows device names), so an archive cannot write outside its folder. Limits per map: 20,000 files, 200 MB of content, 10 MB per file; maps over a limit are exported partially and marked as such.

## Privacy and permissions

MapHound declares no static `host_permissions` and no static `content_scripts`. Access is requested per site at runtime (`optional_host_permissions`). Third-party script origins are not scanned by default. Aggressive `<script>.map` probing is off by default.

## Development

```bash
pnpm install
pnpm dev        # opens Chrome with the extension
pnpm build
pnpm test
pnpm lint
```

Requires Node 20+ and pnpm.

## License

MIT
