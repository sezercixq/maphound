# Changelog

All notable changes to MapHound. The format follows [Keep a Changelog](https://keepachangelog.com/)
and the project uses [Semantic Versioning](https://semver.org/).

## [0.6.0] - 2026-11-28

### Added

- **Scope-Aware Source-to-Sink Taint Flow Tracker (`src/engine/intel/taint.ts`).** Linear-time
  data-flow tracing across `const`/`let`/`var` assignments and destructuring from untrusted browser
  sources (`location.*`, `document.URL`, `document.referrer`, `window.name`, `URLSearchParams`,
  `postMessage` `event.data`, `localStorage`/`sessionStorage.getItem`) to dangerous sinks (DOM XSS,
  code execution, open redirect, prototype pollution), clearing taint on sanitizers and emitting
  **Confirmed Source-to-Sink Flow** traces (`L<source> → L<sink>`) in `CodeHints.tsx` and `results.sarif`.
- **`postMessage` & Client-Side AuthZ / IDOR Surface Analyzer (`src/engine/intel/authz-surface.ts`).**
  Detects `addEventListener('message', ...)` / `onmessage` handlers missing `.origin` validation,
  client-side authorization gates (`isAdmin`, `isSuperAdmin`, `role ===`, `permissions.includes`),
  and parameterized/predictable IDOR API endpoint candidates (`:userId`, `?accountId=`).
- **Cryptographic Weakness & Deep JWT Auditor (`src/engine/audit/crypto-audit.ts`).** Detects
  `Math.random()` in security contexts, weak hashes (`MD5` / `SHA-1`), AES ECB mode, hardcoded static
  IVs/salts, and performs offline deep JWT inspection (`alg: "none"`, `>30`-day token lifetimes, and
  privileged role/scope claims, always strictly masked) across source code, Web Storage, and cookies.
- **Burp / Postman Compatible OpenAPI 3.0.3 Generator (`src/engine/export/openapi.ts`).** Converts
  discovered endpoints, HTTP methods, path/query parameters, JSON request bodies, and `BearerAuth` /
  `ApiKeyAuth` schemes into standard `openapi.json`, downloadable/copyable directly from the
  **Endpoints** tab and bundled inside the exported ZIP archive.

## [0.5.0] - 2026-11-23

### Added

- **Raw HTTP Response Headers & Custom Debug Header Audit (`headers.ts`, `SecurityAudit.tsx`, `AUDIT.md`).**
  Captures all non-cookie HTTP response headers on the enabled document (including `X-Debug-*`,
  `X-Request-Id`, `X-Runtime`, `X-Backend-*`, `X-Version`, and other custom headers), automatically
  flags debug/internal/version-leaking custom headers as audit findings, and provides a collapsible
  **Raw Response Headers** table with 1-click copy.
- **HTML Source Comments & Meta Tag Extraction (`html-audit.ts`, `collector.content.ts`, `SecurityAudit.tsx`).**
  Walks the active page DOM (`NodeFilter.SHOW_COMMENT`) and `<meta>` tags (`generator`, `author`,
  `version`, `build`, `csrf-token` masked) purely locally, surfacing forgotten developer notes
  (`TODO`, `FIXME`, `BYPASS`, `INTERNAL`), hidden paths, version numbers, and masked token hints
  in the **HTML Source Comments & Meta** card and `AUDIT.md` (and feeding `<meta name="generator">`
  into stack hints).
- **On-Demand Standard Discovery Files (`robots.txt` & `sitemap.xml`, `discovery-files.ts`, `OsintView.tsx`).**
  Adds a user-triggered **Check robots.txt & sitemap.xml** button in the **OSINT** tab (zero
  background auto-fetching, zero brute-force) that parses `Disallow:`, `Allow:`, `Sitemap:` and
  `<loc>` URLs into clickable lists and includes them in both `OSINT.md` and `ENDPOINTS.md`.

## [0.4.1] - 2026-11-23

### Added

- **Passive Backend & Technology Stack Hints (`src/engine/audit/stack-hints.ts`).** Purely local,
  zero-extra-request technology fingerprinting that aggregates signals already collected by MapHound:
  - **Web server & reverse proxy banner detection** from `Server`, `X-Powered-By`, `Via`,
    `X-AspNet-Version`, `X-AspNetMvc-Version` and `X-Generator` headers (nginx, Apache, Cloudflare,
    CloudFront, Express, Next.js, PHP, ASP.NET, Tomcat, Jetty, etc.), with `low`/`info` findings
    when response headers disclose backend versions.
  - **Session cookie name fingerprinting** (names only, never values): `JSESSIONID` (Java/Spring/Tomcat),
    `PHPSESSID` (PHP), `ASP.NET_SessionId` / `.AspNetCore.*` (.NET), `connect.sid` (Node.js/Express),
    `csrftoken` + `sessionid` (Django), `_rails_session` (Ruby on Rails), and `XSRF-TOKEN` +
    `laravel_session` (Laravel).
  - **Cloud, BaaS/database, API layer & build-OS summary** uniting OSINT cloud buckets (S3, GCS,
    Azure Blob, R2), SDKs (`Supabase / PostgreSQL`, `Firebase / Firestore`), GraphQL/REST/WebSocket
    endpoints, and source-map build host OS (`Windows`, `macOS`, `Linux`).
- **Detected Stack & Server Hints UI & reports.** Added a top-level **Detected Stack & Server Hints**
  card in the **Audit** tab with provenance badges (`Header: ...`, `Cookie: ...`, `SDK: ...`,
  `OSINT: ...`) and included the summary table in both **`AUDIT.md`** and **`OSINT.md`**.

## [0.4.0] - 2026-11-23

### Added

- **Client-side architecture & dependency map (`Architecture` tab + `ARCHITECTURE.md`).** Linear-time
  extraction of `import`/`export` module dependencies, relative internal edges, file → API
  endpoint data flows, and third-party SDK detection (Stripe, Firebase, Sentry, Auth0, Supabase,
  Segment, PostHog, Mixpanel, Amplitude, Datadog, Clerk, LaunchDarkly, AWS SDK, OpenAI, Anthropic,
  GraphQL clients, Realtime WS). Includes a collapsible interactive module tree with click-to-view
  source preview and an auto-generated Mermaid `flowchart LR` diagram inside `ARCHITECTURE.md`.
- **HTTP security headers, cookie & Web Storage auditor (`Audit` tab + `AUDIT.md`).** Audits active
  document response headers (CSP weaknesses, HSTS, clickjacking `X-Frame-Options` /
  `frame-ancestors`, `X-Content-Type-Options`, `Referrer-Policy`, permissive CORS), `localStorage` /
  `sessionStorage` for JWTs, Bearer tokens and sensitive keys (strictly masked), and cookie
  `HttpOnly`, `Secure`, `SameSite` flags without adding any static permissions.
- **Version tracking: Snapshot & Diff engine (`Diff` tab + `DIFF.md`).** Upgraded IndexedDB to v4
  (`audits` and `snapshots` stores) with non-destructive migration. Tracks files, endpoints,
  routes, secret findings and code sinks across rescans and deployments, surfaces a **Changes /
  Diff** badge in the panel, and writes `DIFF.md` into the ZIP archive when differences exist.
- **SARIF v2.1.0 export (`results.sarif`) & 1-click disclosure drafts.** Exports masked secret
  findings and static code sinks in standard SARIF v2.1.0 format compatible with GitHub Code
  Scanning and VS Code SARIF Viewer, and adds a **Copy report draft** action on secret findings,
  endpoints, code sinks, and security audit items.
- **Offline Passive OSINT & 1-Click Launcher (`OSINT` tab + `OSINT.md`).** Linear-time offline
  extraction of cloud storage buckets (S3, GCS, Firebase, Azure Blob, Cloudflare R2), target
  subdomains, private RFC1918 IPs, masked local developer build paths, organizational/project
  attribution, and telemetry IDs from rebuilt source maps and bundles, paired with a zero-background-request
  1-click external OSINT & Google Dork launcher (`crt.sh`, Wayback Machine, `urlscan.io`, dorks).

### Changed

- **IndexedDB schema v4.** Added `audits` and `snapshots` object stores with non-destructive upgrade
  from v3.

## [0.3.0] - 2026-11-23

### Added

- **Attack surface & endpoint discovery (`Endpoints` tab + `ENDPOINTS.md`).** Linear-time lexer and
  extractors surface internal REST/GraphQL/auth/admin/WebSocket API endpoints with inferred HTTP
  methods, frontend router & file-system routes (React Router, Vue Router, Next.js `pages/` and
  `app/`, `__BUILD_MANIFEST`, SvelteKit), and developer comments (`TODO`, `FIXME`, `HACK`,
  `INTERNAL`, `BYPASS`, `SECURITY`). Exportable directly as TXT/JSON or bundled in the ZIP as
  `ENDPOINTS.md`.
- **Static code hints & sinks (`Code Hints` tab).** Separate from verified credential findings,
  flags first-party (`_vendor/` excluded) DOM XSS sinks (`dangerouslySetInnerHTML`, `innerHTML`,
  `outerHTML`, `insertAdjacentHTML`, `document.write`, `srcdoc`), code injection (`eval`,
  `new Function`, string timers), unverified `window.addEventListener('message')` handlers and
  wildcard `postMessage`, open-redirect candidates, and framework-specific sinks (`v-html`,
  `{@html}`, Angular bypass).
- **Next.js `__NEXT_DATA__` SSR props summary.** Locally parses `__NEXT_DATA__` on enabled sites
  into readable `pageProps` outlines, flags privilege/PII/credential-named paths with masked
  previews, and extracts embedded API paths.
- **In-panel source search & read-only code viewer (`Search` tab).** Dedicated Web Worker
  (`search.worker.ts`) searches rebuilt source trees in IndexedDB by plain text or regex with
  `_vendor/` toggle and opens any match, finding, endpoint, or sink in a read-only line-highlighted
  code viewer modal.
- **15 new ReDoS-proven secret detectors (40 → 55 rules).** Added detectors for Hugging Face org
  tokens, Replicate, Groq, OpenRouter, Perplexity, Cloudflare API tokens & Origin CA keys, Vercel,
  Heroku, Mailgun, Sentry DSN & auth tokens, Supabase PATs, publishable keys, and Postgres URLs.

### Changed

- **IndexedDB schema v3.** Added `intel` and `pages` object stores with automatic non-destructive
  upgrade from v2.

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
