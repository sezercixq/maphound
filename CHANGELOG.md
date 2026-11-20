# Changelog

All notable changes to MapHound. The format follows [Keep a Changelog](https://keepachangelog.com/)
and the project uses [Semantic Versioning](https://semver.org/).

## [0.2.0] - 2026-11-20

### Added

- **Third-party and CDN origins.** Scripts from other origins (a site's CDN such as
  `a0.muscache.com`, sibling domains such as `airbnb.com` for `airbnb.com.tr`, vendors) are grouped
  by origin in the side panel with their script and map counts. **Allow & scan** asks Chrome for
  that one origin; **Allow & scan all** asks for every listed origin in a single prompt, with
  analytics and tag managers left out unless you include them. Allowed origins are stored on the
  site (`extraOrigins`), their skipped scripts and maps are queued at once, and new scripts from
  them are scanned automatically.
- Allowed origins are listed under the site and can be removed one by one; their host permission is
  revoked unless another site still needs it.
- Sibling domains of the same brand are marked as **related domain** and listed first.

### Changed

- **Subdomain scope uses the registrable domain** from the Public Suffix List (via `tldts`), private
  suffixes included. Enabling `https://app.example.com` with subdomains now covers `*.example.com`
  (so `cdn.example.com` is scanned), `www.airbnb.com.tr` covers `*.airbnb.com.tr`, and a site on a
  shared host such as `me.github.io` never widens to all of `github.io`. A site enabled with
  subdomains under 0.1 on a deeper host is disabled on update (its data is kept) and can be
  enabled again.
- Disabling a site also revokes the host permissions of all of its extra origins.
- If an extra origin's permission is revoked in Chrome, only that origin is dropped; the site stays.

## [0.1.0] - 2026-11-20

First release: per-site permissions and runtime collector, fetch and source map discovery, source
tree rebuild with Zip-Slip-safe ZIP export, 40 ReDoS-proven secret detectors with offline
validation, side panel, CI.
