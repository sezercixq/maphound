import { type IntelLocation, type LineIndex, lineAround, type SinkHit } from '@/engine/intel';
import type { RuntimeDomEvent } from '@/engine/runtime';
import { maskAuditValue } from './storage';
import type { AuditFinding } from './types';

function parseParams(raw: string): URLSearchParams {
  return new URLSearchParams(raw.replace(/^[?#]/, ''));
}

/**
 * Audit the active page URL (query string & hash fragment) for OAuth 2.0, OIDC, and SAML
 * client-side flow weaknesses (Implicit Flow, fragment token leaks, missing `state`/`nonce`/PKCE,
 * open `redirect_uri` candidates, or SAML query tokens).
 */
export function auditOAuthPage(pageUrl: string): AuditFinding[] {
  let parsed: URL;
  try {
    parsed = new URL(pageUrl);
  } catch {
    return [];
  }

  const findings: AuditFinding[] = [];
  const query = parseParams(parsed.search);
  const hash = parseParams(parsed.hash);

  // 1. Fragment token leakage (#access_token=... or #id_token=...)
  for (const key of ['access_token', 'id_token'] as const) {
    const val = hash.get(key) ?? query.get(key);
    if (val && val.length >= 8) {
      findings.push({
        id: `oauth|fragment-token|${key}|${parsed.origin}${parsed.pathname}`,
        category: 'oauth',
        ruleId: 'oauth.fragment-token-leak',
        title: `OAuth ${key} exposed in URL ${hash.has(key) ? 'fragment' : 'query'}`,
        severity: 'high',
        detail: `An OAuth/OIDC \`${key}\` was observed in the browser URL on ${parsed.pathname}, exposing it to browser history, Referer headers, and client-side scripts.`,
        recommendation:
          'Migrate from Implicit Flow to Authorization Code Flow with PKCE (S256) and exchange tokens via a confidential backend.',
        subject: `${parsed.pathname}#${key}`,
        preview: maskAuditValue(val),
      });
    }
  }

  // 2. OAuth Authorization Request checks (response_type, state, nonce, code_challenge, redirect_uri)
  const responseType = (
    query.get('response_type') ??
    hash.get('response_type') ??
    ''
  ).toLowerCase();
  const isAuthEndpoint =
    /\/(?:oauth2?|oidc|auth)\b|\/authorize\b/i.test(parsed.pathname) ||
    Boolean(responseType) ||
    (query.has('client_id') && query.has('redirect_uri'));

  if (isAuthEndpoint) {
    const tokens = responseType.split(/\s+/).filter(Boolean);
    if (tokens.includes('token') || tokens.includes('id_token')) {
      findings.push({
        id: `oauth|implicit-flow|${parsed.origin}${parsed.pathname}`,
        category: 'oauth',
        ruleId: 'oauth.implicit-flow',
        title: `Deprecated OAuth Implicit Flow (response_type=${responseType})`,
        severity: 'high',
        detail:
          'Implicit Flow returns tokens directly in the URL fragment, increasing risk of token leakage via history, logs, and XSS.',
        recommendation:
          'Replace Implicit Flow with Authorization Code Flow + PKCE (`response_type=code`).',
        subject: `${parsed.pathname}?response_type=${responseType}`,
      });
    }

    if (!query.get('state') && !hash.get('state')) {
      findings.push({
        id: `oauth|missing-state|${parsed.origin}${parsed.pathname}`,
        category: 'oauth',
        ruleId: 'oauth.missing-state',
        title: 'OAuth authorization request missing state parameter (CSRF risk)',
        severity: 'high',
        detail:
          'Authorization request omits the `state` parameter, leaving the callback vulnerable to login CSRF / account fixation.',
        recommendation:
          'Generate a high-entropy per-session `state` parameter and verify it strictly on the OAuth callback.',
        subject: parsed.pathname,
      });
    }

    if (tokens.includes('id_token') && !query.get('nonce') && !hash.get('nonce')) {
      findings.push({
        id: `oauth|missing-nonce|${parsed.origin}${parsed.pathname}`,
        category: 'oauth',
        ruleId: 'oauth.missing-nonce',
        title: 'OIDC request missing nonce parameter (replay risk)',
        severity: 'medium',
        detail: 'OIDC `id_token` request omits `nonce`, weakening replay protection on ID tokens.',
        recommendation:
          'Include a cryptographically random `nonce` and verify it in the ID token claims.',
        subject: parsed.pathname,
      });
    }

    if (tokens.includes('code') && !query.get('code_challenge')) {
      findings.push({
        id: `oauth|missing-pkce|${parsed.origin}${parsed.pathname}`,
        category: 'oauth',
        ruleId: 'oauth.missing-pkce',
        title: 'OAuth code flow missing PKCE (code_challenge)',
        severity: 'medium',
        detail:
          'Public client authorization code request omits `code_challenge`, increasing risk of authorization code interception.',
        recommendation:
          'Use PKCE with `code_challenge_method=S256` on all browser-based OAuth flows.',
        subject: parsed.pathname,
      });
    }

    const redirectUri = query.get('redirect_uri') ?? hash.get('redirect_uri');
    if (redirectUri) {
      try {
        const target = new URL(redirectUri);
        if (
          target.origin !== parsed.origin ||
          redirectUri.includes('*') ||
          target.protocol === 'http:'
        ) {
          findings.push({
            id: `oauth|redirect-uri|${parsed.origin}${parsed.pathname}`,
            category: 'oauth',
            ruleId: 'oauth.open-redirect-uri',
            title: 'Suspicious or cross-origin OAuth redirect_uri candidate',
            severity: 'high',
            detail: `OAuth redirect_uri (${target.origin}${target.pathname}) differs from current origin or uses insecure/wildcard format.`,
            recommendation:
              'Enforce exact-match server-side allowlists for `redirect_uri` over HTTPS with no wildcard paths.',
            subject: redirectUri.slice(0, 120),
          });
        }
      } catch {
        // Non-absolute redirect_uri
      }
    }
  }

  // 3. SAML query parameters
  if (query.has('SAMLResponse') || query.has('SAMLRequest')) {
    findings.push({
      id: `oauth|saml-query|${parsed.origin}${parsed.pathname}`,
      category: 'oauth',
      ruleId: 'oauth.saml-query-binding',
      title: 'SAML assertion/request passed in URL query string',
      severity: 'medium',
      detail:
        'SAML payload observed in URL query parameters; ensure RelayState is validated and prefer HTTP-POST binding for SAMLResponse.',
      recommendation:
        'Use HTTP-POST binding for SAMLResponse and validate RelayState against an allowlist of local paths.',
      subject: parsed.pathname,
    });
  }

  return findings;
}

const IMPLICIT_CODE_RE =
  /response_type['"]?\s*[:=]\s*['"]?(?:token|id_token(?:\s+token)?|token\s+id_token)\b/gi;

const AUTHORIZE_CALL_RE =
  /['"`][^'"`\n]{0,120}\/(?:oauth2?\/)?authorize(?:\?[^'"`\n]{0,200})?['"`]/gi;

const DYNAMIC_REDIRECT_URI_RE =
  /redirect_uri['"]?\s*[:=]\s*(?:window\.)?(?:location\.(?:href|origin)|(?:params|searchParams|query)\.get\()/gi;

/**
 * Audit JavaScript/TypeScript source files for OAuth 2.0 / OIDC / SAML client weaknesses:
 * Implicit Flow, missing `state`/PKCE near `/authorize`, and dynamic `redirect_uri`.
 */
export function auditOAuthSource(
  source: string,
  lines: LineIndex,
  location: Omit<IntelLocation, 'line' | 'column'>,
): SinkHit[] {
  const hits: SinkHit[] = [];
  const seen = new Set<string>();

  const addHit = (ruleId: string, title: string, level: SinkHit['level'], index: number) => {
    const pos = lines.position(index);
    const key = `${ruleId}|${pos.line}`;
    if (seen.has(key) || hits.length >= 20) return;
    seen.add(key);
    hits.push({
      ruleId,
      title,
      category: 'oauth',
      level,
      snippet: lineAround(source, index, 180),
      location: { ...location, line: pos.line, column: pos.column },
    });
  };

  for (const m of source.matchAll(IMPLICIT_CODE_RE)) {
    if (m.index !== undefined) {
      addHit(
        'oauth.implicit-flow',
        'OAuth Implicit Flow (response_type=token/id_token) in client code',
        'high',
        m.index,
      );
    }
  }

  for (const m of source.matchAll(DYNAMIC_REDIRECT_URI_RE)) {
    if (m.index !== undefined) {
      addHit(
        'oauth.dynamic-redirect-uri',
        'Dynamic OAuth redirect_uri derived from location/query',
        'high',
        m.index,
      );
    }
  }

  for (const m of source.matchAll(AUTHORIZE_CALL_RE)) {
    if (m.index === undefined) continue;
    const windowSlice = source.slice(Math.max(0, m.index - 200), m.index + 500);
    if (!/\bstate\b/i.test(windowSlice)) {
      addHit(
        'oauth.missing-state',
        'OAuth /authorize call without visible state parameter',
        'medium',
        m.index,
      );
    }
    if (
      /response_type['"]?\s*[:=]\s*['"]?code\b/i.test(windowSlice) &&
      !/code_challenge/i.test(windowSlice)
    ) {
      addHit(
        'oauth.missing-pkce',
        'OAuth /authorize code flow without PKCE code_challenge',
        'medium',
        m.index,
      );
    }
  }

  return hits;
}

/** Detect OAuth/OIDC/SAML token references sent over cross-origin postMessage events. */
export function auditOAuthRuntimeDom(events: readonly RuntimeDomEvent[]): AuditFinding[] {
  const findings: AuditFinding[] = [];
  for (const ev of events) {
    if (ev.kind !== 'postMessage') continue;
    if (!/access_token|id_token|oauth|saml/i.test(ev.detail)) continue;
    findings.push({
      id: `oauth|postmessage-token|${ev.id}`,
      category: 'oauth',
      ruleId: 'oauth.postmessage-token',
      title: 'OAuth/SAML token message observed via postMessage',
      severity: 'high',
      detail: `postMessage event from ${ev.senderOrigin ?? 'unknown origin'} referenced OAuth/SAML token data.`,
      recommendation:
        'Verify event.origin strictly against an exact allowlist and avoid passing bearer tokens via postMessage.',
      subject: ev.senderOrigin ?? ev.origin,
      preview: ev.detail.slice(0, 100),
    });
  }
  return findings;
}
