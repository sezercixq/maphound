import type { AuditFinding, HeaderMatrixEntry } from './types';

export const SECURITY_HEADER_NAMES = [
  'content-security-policy',
  'content-security-policy-report-only',
  'strict-transport-security',
  'x-frame-options',
  'x-content-type-options',
  'referrer-policy',
  'access-control-allow-origin',
  'access-control-allow-credentials',
  'permissions-policy',
] as const;

function normalizeHeaders(input: Headers | Record<string, string>): Map<string, string> {
  const map = new Map<string, string>();
  if (typeof (input as Headers).forEach === 'function') {
    (input as Headers).forEach((value, key) => {
      map.set(key.toLowerCase(), value);
    });
  } else {
    for (const [key, value] of Object.entries(input)) {
      if (typeof value === 'string') map.set(key.toLowerCase(), value);
    }
  }
  return map;
}

function parseCspDirectives(csp: string): Map<string, string[]> {
  const directives = new Map<string, string[]>();
  for (const part of csp.split(';')) {
    const tokens = part.trim().split(/\s+/).filter(Boolean);
    const name = tokens[0]?.toLowerCase();
    if (!name) continue;
    directives.set(
      name,
      tokens.slice(1).map((t) => t.toLowerCase()),
    );
  }
  return directives;
}

function isLoopbackHost(hostname: string): boolean {
  const lower = hostname.toLowerCase();
  return lower === 'localhost' || lower === '127.0.0.1' || lower === '[::1]';
}

export function auditHeaders(
  headers: Headers | Record<string, string>,
  pageUrl: string,
): {
  summary: Record<string, string | null>;
  matrix: HeaderMatrixEntry[];
  findings: AuditFinding[];
} {
  const map = normalizeHeaders(headers);
  const summary: Record<string, string | null> = {};
  for (const name of SECURITY_HEADER_NAMES) {
    summary[name] = map.get(name) ?? null;
  }

  let parsedUrl: URL | null = null;
  try {
    parsedUrl = new URL(pageUrl);
  } catch {
    // ignore malformed URL
  }

  const findings: AuditFinding[] = [];
  const matrix: HeaderMatrixEntry[] = [];

  // 1. Content-Security-Policy
  const csp = map.get('content-security-policy') ?? null;
  const cspReportOnly = map.get('content-security-policy-report-only') ?? null;
  let hasFrameAncestors = false;
  if (!csp) {
    matrix.push({
      header: 'Content-Security-Policy',
      status: cspReportOnly ? 'weak' : 'missing',
      value: cspReportOnly,
    });
    findings.push({
      id: cspReportOnly ? 'headers:csp-report-only' : 'headers:csp-missing',
      category: 'headers',
      ruleId: cspReportOnly ? 'csp-report-only' : 'csp-missing',
      title: cspReportOnly
        ? 'Content-Security-Policy is Report-Only'
        : 'Missing Content-Security-Policy header',
      severity: cspReportOnly ? 'medium' : 'high',
      subject: cspReportOnly ? 'Content-Security-Policy-Report-Only' : 'Content-Security-Policy',
      detail: cspReportOnly
        ? 'Only Content-Security-Policy-Report-Only is set; violations are logged but not blocked.'
        : 'No Content-Security-Policy header was returned on the document response.',
      recommendation:
        'Enforce a strict Content-Security-Policy with nonce- or hash-based script-src and frame-ancestors.',
    });
  } else {
    const directives = parseCspDirectives(csp);
    hasFrameAncestors = directives.has('frame-ancestors');
    const scriptSrc = directives.get('script-src') ?? directives.get('default-src') ?? [];
    let cspWeak = false;

    if (scriptSrc.includes("'unsafe-inline'")) {
      cspWeak = true;
      findings.push({
        id: 'headers:csp-unsafe-inline',
        category: 'headers',
        ruleId: 'csp-unsafe-inline',
        title: "CSP allows 'unsafe-inline' scripts",
        severity: 'high',
        subject: 'Content-Security-Policy',
        detail:
          "script-src/default-src includes 'unsafe-inline', neutralizing XSS script-injection protection.",
        recommendation: "Remove 'unsafe-inline' and adopt cryptographic nonces or hashes.",
      });
    }
    if (scriptSrc.includes("'unsafe-eval'")) {
      cspWeak = true;
      findings.push({
        id: 'headers:csp-unsafe-eval',
        category: 'headers',
        ruleId: 'csp-unsafe-eval',
        title: "CSP allows 'unsafe-eval'",
        severity: 'high',
        subject: 'Content-Security-Policy',
        detail:
          "script-src/default-src includes 'unsafe-eval', permitting eval() and dynamic code execution.",
        recommendation: "Remove 'unsafe-eval' from Content-Security-Policy.",
      });
    }
    if (scriptSrc.some((tok) => tok === '*' || tok === 'http:' || tok === 'data:')) {
      cspWeak = true;
      findings.push({
        id: 'headers:csp-wildcard',
        category: 'headers',
        ruleId: 'csp-wildcard',
        title: 'CSP script source uses wildcard or broad scheme',
        severity: 'medium',
        subject: 'Content-Security-Policy',
        detail:
          'script-src/default-src permits *, http:, or data: sources, allowing scripts from untrusted origins.',
        recommendation: 'Restrict script-src to explicit trusted origins or hashes/nonces.',
      });
    }
    if (!directives.has('object-src') || !directives.has('base-uri')) {
      findings.push({
        id: 'headers:csp-hardening',
        category: 'headers',
        ruleId: 'csp-hardening',
        title: "CSP missing object-src 'none' or base-uri",
        severity: 'low',
        subject: 'Content-Security-Policy',
        detail:
          'Missing object-src or base-uri directive leaves plugin or base-tag hijacking surfaces open.',
        recommendation: "Add object-src 'none'; base-uri 'self' to Content-Security-Policy.",
      });
    }
    matrix.push({
      header: 'Content-Security-Policy',
      status: cspWeak ? 'weak' : 'ok',
      value: csp,
    });
  }

  // 2. HSTS / HTTPS
  const hsts = map.get('strict-transport-security') ?? null;
  if (parsedUrl?.protocol === 'http:') {
    const loopback = isLoopbackHost(parsedUrl.hostname);
    matrix.push({ header: 'Strict-Transport-Security', status: 'info', value: hsts });
    findings.push({
      id: loopback ? 'headers:https-loopback' : 'headers:https-missing',
      category: 'headers',
      ruleId: loopback ? 'https-loopback' : 'https-missing',
      title: loopback
        ? 'Document served over plain HTTP (loopback)'
        : 'Document served over unencrypted HTTP',
      severity: loopback ? 'info' : 'medium',
      subject: parsedUrl.origin,
      detail: 'Traffic on http:// cannot enforce HSTS or Secure cookie protections.',
      recommendation:
        'Serve production traffic strictly over HTTPS with Strict-Transport-Security.',
    });
  } else if (!hsts) {
    matrix.push({ header: 'Strict-Transport-Security', status: 'missing', value: null });
    findings.push({
      id: 'headers:hsts-missing',
      category: 'headers',
      ruleId: 'hsts-missing',
      title: 'Missing Strict-Transport-Security (HSTS)',
      severity: 'medium',
      subject: 'Strict-Transport-Security',
      detail: 'No HSTS header was returned on this HTTPS document.',
      recommendation: 'Set Strict-Transport-Security: max-age=31536000; includeSubDomains.',
    });
  } else {
    const maxAgeMatch = /max-age=(\d{1,12})/i.exec(hsts);
    const maxAge = maxAgeMatch ? Number(maxAgeMatch[1]) : 0;
    if (maxAge < 15_552_000) {
      matrix.push({ header: 'Strict-Transport-Security', status: 'weak', value: hsts });
      findings.push({
        id: 'headers:hsts-short',
        category: 'headers',
        ruleId: 'hsts-short',
        title: 'HSTS max-age is below 6 months',
        severity: 'low',
        subject: 'Strict-Transport-Security',
        detail: `HSTS max-age is ${maxAge} seconds (recommended minimum: 15552000).`,
        recommendation: 'Increase HSTS max-age to at least 31536000 (1 year).',
      });
    } else {
      matrix.push({ header: 'Strict-Transport-Security', status: 'ok', value: hsts });
      if (!/includesubdomains/i.test(hsts)) {
        findings.push({
          id: 'headers:hsts-no-subdomains',
          category: 'headers',
          ruleId: 'hsts-no-subdomains',
          title: 'HSTS omits includeSubDomains',
          severity: 'info',
          subject: 'Strict-Transport-Security',
          detail: 'Subdomains may still be accessed over HTTP without includeSubDomains.',
          recommendation:
            'Add includeSubDomains to Strict-Transport-Security if all subdomains support HTTPS.',
        });
      }
    }
  }

  // 3. X-Frame-Options / frame-ancestors
  const xfo = map.get('x-frame-options') ?? null;
  if (!xfo && !hasFrameAncestors) {
    matrix.push({ header: 'X-Frame-Options', status: 'missing', value: null });
    findings.push({
      id: 'headers:xfo-missing',
      category: 'headers',
      ruleId: 'xfo-missing',
      title: 'Missing clickjacking protection (X-Frame-Options / frame-ancestors)',
      severity: 'medium',
      subject: 'X-Frame-Options',
      detail: 'Neither X-Frame-Options nor CSP frame-ancestors is set, allowing arbitrary framing.',
      recommendation:
        "Set X-Frame-Options: DENY (or SAMEORIGIN) and CSP frame-ancestors 'none' / 'self'.",
    });
  } else if (xfo && /^allow-from/i.test(xfo.trim())) {
    matrix.push({ header: 'X-Frame-Options', status: 'weak', value: xfo });
    findings.push({
      id: 'headers:xfo-deprecated',
      category: 'headers',
      ruleId: 'xfo-deprecated',
      title: 'Deprecated X-Frame-Options ALLOW-FROM directive',
      severity: 'low',
      subject: 'X-Frame-Options',
      detail: 'Modern browsers ignore X-Frame-Options: ALLOW-FROM.',
      recommendation: 'Replace ALLOW-FROM with CSP frame-ancestors.',
    });
  } else {
    matrix.push({
      header: 'X-Frame-Options',
      status: 'ok',
      value: xfo ?? 'CSP frame-ancestors',
    });
  }

  // 4. X-Content-Type-Options
  const xcto = map.get('x-content-type-options') ?? null;
  if (!xcto || xcto.trim().toLowerCase() !== 'nosniff') {
    matrix.push({
      header: 'X-Content-Type-Options',
      status: xcto ? 'weak' : 'missing',
      value: xcto,
    });
    findings.push({
      id: 'headers:xcto-missing',
      category: 'headers',
      ruleId: 'xcto-missing',
      title: 'Missing or invalid X-Content-Type-Options: nosniff',
      severity: 'low',
      subject: 'X-Content-Type-Options',
      detail: 'Browsers may MIME-sniff responses without X-Content-Type-Options: nosniff.',
      recommendation: 'Set X-Content-Type-Options: nosniff.',
    });
  } else {
    matrix.push({ header: 'X-Content-Type-Options', status: 'ok', value: xcto });
  }

  // 5. Referrer-Policy
  const referrer = map.get('referrer-policy') ?? null;
  if (!referrer) {
    matrix.push({ header: 'Referrer-Policy', status: 'missing', value: null });
    findings.push({
      id: 'headers:referrer-missing',
      category: 'headers',
      ruleId: 'referrer-missing',
      title: 'Missing Referrer-Policy header',
      severity: 'low',
      subject: 'Referrer-Policy',
      detail:
        'No Referrer-Policy specified; default browser behavior may leak path/query tokens in Referer.',
      recommendation: 'Set Referrer-Policy: strict-origin-when-cross-origin or no-referrer.',
    });
  } else if (/unsafe-url|no-referrer-when-downgrade/i.test(referrer)) {
    matrix.push({ header: 'Referrer-Policy', status: 'weak', value: referrer });
    findings.push({
      id: 'headers:referrer-weak',
      category: 'headers',
      ruleId: 'referrer-weak',
      title: `Permissive Referrer-Policy (${referrer.trim()})`,
      severity: 'medium',
      subject: 'Referrer-Policy',
      detail: 'Full URL paths and query parameters may be sent in cross-origin Referer headers.',
      recommendation: 'Use strict-origin-when-cross-origin or same-origin.',
    });
  } else {
    matrix.push({ header: 'Referrer-Policy', status: 'ok', value: referrer });
  }

  // 6. CORS
  const acao = map.get('access-control-allow-origin') ?? null;
  const acac = map.get('access-control-allow-credentials') ?? null;
  if (acao) {
    const trimmed = acao.trim();
    const withCreds = acac?.trim().toLowerCase() === 'true';
    if (trimmed === '*') {
      matrix.push({ header: 'Access-Control-Allow-Origin', status: 'weak', value: acao });
      findings.push({
        id: withCreds ? 'headers:cors-wildcard-creds' : 'headers:cors-wildcard',
        category: 'headers',
        ruleId: withCreds ? 'cors-wildcard-creds' : 'cors-wildcard',
        title: withCreds
          ? 'CORS wildcard (*) combined with Allow-Credentials: true'
          : 'Permissive CORS Access-Control-Allow-Origin: *',
        severity: withCreds ? 'high' : 'medium',
        subject: 'Access-Control-Allow-Origin',
        detail: 'Any origin can read responses from this resource via cross-origin requests.',
        recommendation: 'Restrict Access-Control-Allow-Origin to explicitly allowlisted origins.',
      });
    } else if (trimmed.toLowerCase() === 'null') {
      matrix.push({ header: 'Access-Control-Allow-Origin', status: 'weak', value: acao });
      findings.push({
        id: 'headers:cors-null',
        category: 'headers',
        ruleId: 'cors-null',
        title: 'CORS allows "null" origin',
        severity: 'high',
        subject: 'Access-Control-Allow-Origin',
        detail:
          'Sandboxed iframes and local files carry Origin: null and can bypass origin checks.',
        recommendation: 'Never allow Origin: null in Access-Control-Allow-Origin.',
      });
    } else {
      matrix.push({ header: 'Access-Control-Allow-Origin', status: 'ok', value: acao });
    }
  } else {
    matrix.push({ header: 'Access-Control-Allow-Origin', status: 'ok', value: 'same-origin' });
  }

  return { summary, matrix, findings };
}
