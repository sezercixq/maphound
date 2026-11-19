# MapHound

Passive source map and bundle secret scanner for Chrome (Manifest V3). Everything stays local: no telemetry, no remote code, no live token validation.

> Status: early development (v0.1.0). Not yet published to the Chrome Web Store.

## What it does

- Discovers the JavaScript bundles a page loads, on sites you explicitly enable.
- Finds exposed source maps and rebuilds the original source tree in the browser.
- Scans for secrets with a pipeline: keyword prefilter, regex, entropy, offline format and checksum validation.
- Exports the rebuilt source and a findings report as a ZIP.

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
