import { type IntelLocation, type LineIndex, lineAround, type SinkHit } from '@/engine/intel';
import type { AuditFinding, ExternalResourceTag } from './types';

export interface LibraryAdvisory {
  name: string;
  /** Minimum safe semver (inclusive). Versions strictly below are flagged. */
  minSafe: string;
  severity: 'high' | 'medium' | 'low';
  advisory: string;
}

export interface LibraryFingerprint {
  name: string;
  version: string;
  source: 'sourcemap-path' | 'package-json' | 'banner';
  vulnerable: boolean;
  advisory?: string;
  minSafe?: string;
}

const LIBRARY_ADVISORIES: readonly LibraryAdvisory[] = [
  {
    name: 'jquery',
    minSafe: '3.5.0',
    severity: 'medium',
    advisory: 'Known DOM XSS issues in jQuery < 3.5.0 (CVE-2020-11022 / CVE-2020-11023)',
  },
  {
    name: 'lodash',
    minSafe: '4.17.21',
    severity: 'high',
    advisory:
      'Prototype pollution & command injection in Lodash < 4.17.21 (CVE-2020-8203 / CVE-2021-23337)',
  },
  {
    name: 'angular',
    minSafe: '1.9.0',
    severity: 'high',
    advisory: 'End-of-life AngularJS 1.x with known template/XSS bypasses',
  },
  {
    name: 'react',
    minSafe: '16.14.0',
    severity: 'low',
    advisory: 'Outdated React < 16.14.0 missing modern security & hydration fixes',
  },
  {
    name: 'moment',
    minSafe: '2.29.4',
    severity: 'medium',
    advisory: 'Path traversal & ReDoS issues in Moment.js < 2.29.4 (CVE-2022-31129)',
  },
  {
    name: 'handlebars',
    minSafe: '4.7.7',
    severity: 'high',
    advisory: 'Prototype pollution & RCE in Handlebars < 4.7.7 (CVE-2021-23369)',
  },
  {
    name: 'dompurify',
    minSafe: '3.0.6',
    severity: 'high',
    advisory: 'mXSS sanitizer bypasses in older DOMPurify < 3.0.6',
  },
  {
    name: 'bootstrap',
    minSafe: '4.6.2',
    severity: 'medium',
    advisory: 'XSS in tooltip/popover attributes in Bootstrap < 4.6.2 (CVE-2019-8331)',
  },
  {
    name: 'axios',
    minSafe: '1.6.0',
    severity: 'medium',
    advisory: 'CSRF token leakage & SSRF issues in Axios < 1.6.0 (CVE-2023-45857)',
  },
];

const ADVISORY_BY_NAME = new Map<string, LibraryAdvisory>(
  LIBRARY_ADVISORIES.map((a) => [a.name, a]),
);

const VALID_SRI_RE = /^sha(?:256|384|512)-[A-Za-z0-9+/=]{32,128}$/;

/** Compare two dot-separated semver strings (`a < b` => negative). */
export function compareSemver(a: string, b: string): number {
  const pa = a.split('.').map((n) => Number.parseInt(n, 10) || 0);
  const pb = b.split('.').map((n) => Number.parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/**
 * Audit cross-origin `<script src>` and `<link rel="stylesheet" href>` elements for
 * missing Subresource Integrity (`integrity`) or `crossorigin` attributes.
 */
export function auditSubresourceIntegrity(
  pageUrl: string,
  resources: readonly ExternalResourceTag[],
): AuditFinding[] {
  let pageOrigin = '';
  try {
    pageOrigin = new URL(pageUrl).origin;
  } catch {
    return [];
  }

  const findings: AuditFinding[] = [];
  const seen = new Set<string>();

  for (const res of resources) {
    if (!res.url || seen.has(res.url)) continue;
    let resOrigin = '';
    try {
      const parsed = new URL(res.url, pageUrl);
      if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') continue;
      resOrigin = parsed.origin;
    } catch {
      continue;
    }
    if (resOrigin === pageOrigin) continue;
    seen.add(res.url);

    const integrity = (res.integrity ?? '').trim();
    const tokens = integrity ? integrity.split(/\s+/) : [];
    const hasValidSri = tokens.some((tok) => VALID_SRI_RE.test(tok));
    const hasCrossOrigin = typeof res.crossOrigin === 'string' && res.crossOrigin.length > 0;

    const shortUrl = res.url.length > 100 ? `${res.url.slice(0, 97)}...` : res.url;

    if (!hasValidSri) {
      findings.push({
        id: `supply-chain|missing-sri|${res.url}`,
        category: 'supply-chain',
        ruleId: 'supply-chain.missing-sri',
        title: `Missing Subresource Integrity (SRI) on third-party ${res.tag}`,
        severity: res.tag === 'script' ? 'medium' : 'low',
        detail: `External ${res.tag} loaded from ${resOrigin} without a valid sha256/sha384/sha512 integrity hash.`,
        recommendation:
          'Add integrity="sha384-..." and crossorigin="anonymous" to pin third-party scripts and stylesheets.',
        subject: shortUrl,
      });
    } else if (!hasCrossOrigin) {
      findings.push({
        id: `supply-chain|missing-crossorigin|${res.url}`,
        category: 'supply-chain',
        ruleId: 'supply-chain.missing-crossorigin',
        title: `SRI present without crossorigin attribute on ${res.tag}`,
        severity: 'low',
        detail: `External ${res.tag} from ${resOrigin} defines integrity but omits crossorigin="anonymous", preventing CORS-verified integrity enforcement.`,
        recommendation: 'Add crossorigin="anonymous" alongside the integrity attribute.',
        subject: shortUrl,
      });
    }
  }

  return findings;
}

const BANNER_PATTERNS: readonly { name: string; re: RegExp }[] = [
  { name: 'jquery', re: /jQuery(?:\s+JavaScript\s+Library)?\s+v?(\d+\.\d+\.\d+)/i },
  { name: 'lodash', re: /lodash(?:\.js)?\s+v?(\d+\.\d+\.\d+)/i },
  { name: 'angular', re: /AngularJS\s+v?(\d+\.\d+\.\d+)/i },
  { name: 'react', re: /React\s+v?(\d+\.\d+\.\d+)/i },
  { name: 'moment', re: /moment\.js\s*[\r\n/*\s]*version\s*[:=]?\s*v?(\d+\.\d+\.\d+)/i },
  { name: 'handlebars', re: /handlebars\s+v?(\d+\.\d+\.\d+)/i },
  { name: 'dompurify', re: /DOMPurify\s+v?(\d+\.\d+\.\d+)/i },
  { name: 'bootstrap', re: /Bootstrap\s+v?(\d+\.\d+\.\d+)/i },
  { name: 'axios', re: /axios\s+v?(\d+\.\d+\.\d+)/i },
];

const PACKAGE_JSON_RE =
  /"name"\s*:\s*"(jquery|lodash|angular|react|moment|handlebars|dompurify|bootstrap|axios)"[\s\S]{0,200}?"version"\s*:\s*"(\d+\.\d+\.\d+)"/i;

const NODE_MODULES_VER_RE =
  /node_modules\/(jquery|lodash|angular|react|moment|handlebars|dompurify|bootstrap|axios)[@/-](\d+\.\d+\.\d+)/i;

function evaluateLibrary(
  name: string,
  version: string,
  source: LibraryFingerprint['source'],
): LibraryFingerprint {
  const lower = name.toLowerCase();
  const adv = ADVISORY_BY_NAME.get(lower);
  if (!adv) return { name: lower, version, source, vulnerable: false };
  // Angular 2+ is a separate framework; only flag AngularJS 1.x
  if (lower === 'angular' && !version.startsWith('1.')) {
    return { name: lower, version, source, vulnerable: false };
  }
  const vulnerable = compareSemver(version, adv.minSafe) < 0;
  return {
    name: lower,
    version,
    source,
    vulnerable,
    ...(vulnerable ? { advisory: adv.advisory, minSafe: adv.minSafe } : {}),
  };
}

/**
 * Offline library version fingerprinter from source map paths, `package.json` remnants,
 * and standard library banners/version constants.
 */
export function fingerprintLibraries(
  sourceText: string,
  sourcePaths: readonly string[] = [],
): LibraryFingerprint[] {
  const found = new Map<string, LibraryFingerprint>();
  const add = (fp: LibraryFingerprint) => {
    const key = `${fp.name}@${fp.version}`;
    if (!found.has(key)) found.set(key, fp);
  };

  for (const p of sourcePaths) {
    const m = NODE_MODULES_VER_RE.exec(p);
    if (m?.[1] && m[2]) {
      add(evaluateLibrary(m[1], m[2], 'sourcemap-path'));
    }
  }

  const head = sourceText.slice(0, 60_000);
  const pkgMatch = PACKAGE_JSON_RE.exec(head);
  if (pkgMatch?.[1] && pkgMatch[2]) {
    add(evaluateLibrary(pkgMatch[1], pkgMatch[2], 'package-json'));
  }

  for (const { name, re } of BANNER_PATTERNS) {
    const m = re.exec(head);
    if (m?.[1]) {
      add(evaluateLibrary(name, m[1], 'banner'));
    }
  }

  return [...found.values()];
}

const SENSITIVE_READ_RE =
  /input\[type=['"]?password['"]?\]|\b(?:cardNumber|cc_number|ccNumber|creditCard|cardCvv|cvv2?|cardExp|pan)\b|document\.cookie/i;

const EXFIL_SINK_RE =
  /navigator\.sendBeacon\s*\(|new\s+Image\s*\(\s*\)\s*\.src\s*=|\bimg\.src\s*=|createElement\s*\(\s*['"]script['"]\s*\)/i;

const EXTERNAL_URL_RE = /https?:\/\/([a-z0-9.-]+\.[a-z]{2,})(?:\/|['"`])/i;

/**
 * Detect suspicious web skimmer / client-side exfiltration patterns where sensitive form
 * fields (passwords, credit cards/CVV, `document.cookie`) are read in the same file as
 * third-party `sendBeacon`, `Image().src`, or dynamic `<script>` injection.
 */
export function detectSkimmerPatterns(
  source: string,
  lines: LineIndex,
  location: Omit<IntelLocation, 'line' | 'column'>,
  siteOrigin?: string,
): SinkHit[] {
  const hits: SinkHit[] = [];

  // 1. Outdated / vulnerable library fingerprint hits
  const libs = fingerprintLibraries(source, [location.file]);
  for (const lib of libs) {
    if (!lib.vulnerable) continue;
    const adv = ADVISORY_BY_NAME.get(lib.name);
    hits.push({
      ruleId: `supply-chain.outdated-${lib.name}`,
      title: `Outdated ${lib.name} ${lib.version} (< ${lib.minSafe})`,
      category: 'supply-chain',
      level: adv?.severity ?? 'medium',
      snippet: lib.advisory ?? `${lib.name}@${lib.version} below ${lib.minSafe}`,
      location: { ...location, line: 1, column: 0 },
    });
  }

  // 2. Web Skimmer / Exfiltration heuristic
  const readMatch = SENSITIVE_READ_RE.exec(source);
  if (!readMatch) return hits;
  const exfilMatch = EXFIL_SINK_RE.exec(source);
  if (!exfilMatch) return hits;

  const urlMatch = EXTERNAL_URL_RE.exec(source);
  if (!urlMatch?.[1]) return hits;

  const targetHost = urlMatch[1].toLowerCase();
  if (siteOrigin) {
    try {
      const ownHost = new URL(siteOrigin).hostname.toLowerCase();
      if (targetHost === ownHost || targetHost.endsWith(`.${ownHost}`)) {
        return hits;
      }
    } catch {
      // ignore invalid siteOrigin
    }
  }

  const pos = lines.position(exfilMatch.index);
  const lineText = lineAround(source, exfilMatch.index, 180);
  hits.push({
    ruleId: 'supply-chain.skimmer-exfil',
    title: `Potential web skimmer / exfiltration to ${targetHost}`,
    category: 'supply-chain',
    level: 'high',
    snippet: lineText || `${readMatch[0]} -> ${exfilMatch[0]} (${targetHost})`,
    trace: {
      sourceExpr: readMatch[0].slice(0, 60),
      sourceLine: lines.position(readMatch.index).line,
      sinkLine: pos.line,
    },
    location: { ...location, line: pos.line, column: pos.column },
  });

  return hits;
}
