import { type LexResult, type LineIndex, lineAround } from '@/engine/intel/lexer';
import type { IntelLocation, SinkHit } from '@/engine/intel/types';
import { hasIgnoreComment } from '@/engine/scan/suppress';
import { decodeJwt } from '@/engine/validators/jwt';
import { AUDIT_JWT } from './patterns';
import { maskAuditValue } from './storage';
import type { AuditFinding } from './types';

export const MAX_CRYPTO_HITS_PER_FILE = 40;
const THIRTY_DAYS_SECONDS = 30 * 86_400;

const SECURITY_CONTEXT =
  /(?:token|secret|nonce|csrf|xsrf|session|encrypt|decrypt|cipher|hash|password|passwd|salt|otp|apikey)|\b(?:iv|key|reset)\b/i;

const MATH_RANDOM = /\bMath\s{0,2}\.\s{0,2}random\s{0,2}\(/g;
const WEAK_HASH =
  /\bCryptoJS\s{0,2}\.\s{0,2}(?:MD5|SHA1)\s{0,2}\(|\bcreateHash\s{0,2}\(\s{0,2}['"`](?:md5|sha1|sha-1)['"`]|\bsubtle\s{0,2}\.\s{0,2}digest\s{0,2}\(\s{0,2}['"`]SHA-1['"`]/gi;
const ECB_MODE =
  /\bCryptoJS\s{0,2}\.\s{0,2}mode\s{0,2}\.\s{0,2}ECB\b|\baes-(?:128|192|256)-ecb\b/gi;
const STATIC_IV_SALT =
  /\b(?:iv|salt)\s{0,2}[:=]\s{0,2}(?:CryptoJS\s{0,2}\.\s{0,2}enc\s{0,2}\.\s{0,2}(?:Utf8|Hex|Base64)\s{0,2}\.\s{0,2}parse\s{0,2}\(\s{0,2})?['"`][^'"`\n]{4,80}['"`]/gi;

const PRIVILEGED_ROLE_VALUE = /\b(?:admin|superadmin|super_admin|root|owner|staff|internal)\b/i;

export interface JwtSecurityIssue {
  ruleId: string;
  title: string;
  severity: 'critical' | 'high' | 'medium';
  detail: string;
  recommendation: string;
}

/** Pure offline JWT inspection for alg:none, >30-day lifetime and privileged claims. */
export function inspectJwtToken(token: string): JwtSecurityIssue[] {
  const decoded = decodeJwt(token);
  if (!decoded) return [];
  const issues: JwtSecurityIssue[] = [];
  const alg = typeof decoded.header.alg === 'string' ? decoded.header.alg.trim() : '';

  if (alg.toLowerCase() === 'none') {
    issues.push({
      ruleId: 'jwt-alg-none',
      title: 'JWT uses insecure alg: "none"',
      severity: 'critical',
      detail: 'JWT header specifies alg="none", disabling cryptographic signature verification.',
      recommendation:
        'Reject alg="none" server-side and enforce strong asymmetric signing (RS256/ES256/EdDSA).',
    });
  }

  const iat = typeof decoded.payload.iat === 'number' ? decoded.payload.iat : null;
  const exp = typeof decoded.payload.exp === 'number' ? decoded.payload.exp : null;
  if (iat !== null && exp !== null && exp - iat > THIRTY_DAYS_SECONDS) {
    const days = Math.round((exp - iat) / 86_400);
    issues.push({
      ruleId: 'jwt-long-lived',
      title: `Long-lived JWT (${days} days lifetime)`,
      severity: 'medium',
      detail: `Token lifetime (exp - iat) is ${days} days, exceeding the 30-day ceiling.`,
      recommendation:
        'Use short-lived access tokens (<= 15-60 min) paired with rotating refresh tokens.',
    });
  }

  const privClaims: string[] = [];
  if (decoded.payload.admin === true) privClaims.push('admin=true');
  if (decoded.payload.isAdmin === true || decoded.payload.is_admin === true) {
    privClaims.push('isAdmin=true');
  }
  if (
    typeof decoded.payload.role === 'string' &&
    PRIVILEGED_ROLE_VALUE.test(decoded.payload.role)
  ) {
    privClaims.push(`role=${decoded.payload.role}`);
  }
  if (Array.isArray(decoded.payload.roles)) {
    const matched = decoded.payload.roles.filter(
      (r): r is string => typeof r === 'string' && PRIVILEGED_ROLE_VALUE.test(r),
    );
    if (matched.length > 0) privClaims.push(`roles=[${matched.join(',')}]`);
  }
  if (
    typeof decoded.payload.scope === 'string' &&
    PRIVILEGED_ROLE_VALUE.test(decoded.payload.scope)
  ) {
    privClaims.push(`scope=${decoded.payload.scope.slice(0, 60)}`);
  }

  if (privClaims.length > 0) {
    issues.push({
      ruleId: 'jwt-privileged-claims',
      title: 'JWT contains privileged role/scope claims',
      severity: 'high',
      detail: `Decoded JWT payload carries elevated privilege claims: ${privClaims.join(', ')}.`,
      recommendation:
        'Minimize privileges in client-exposed JWTs and enforce authorization server-side.',
    });
  }

  return issues;
}

/** Produce `AuditFinding` records for deep JWT weaknesses found in Web Storage or cookies. */
export function auditJwtDeep(
  token: string,
  subject: string,
  category: 'storage' | 'cookie',
): AuditFinding[] {
  const preview = maskAuditValue(token);
  return inspectJwtToken(token).map((issue) => ({
    id: `${category}:${issue.ruleId}:${subject}`,
    category,
    ruleId: issue.ruleId,
    title: issue.title,
    severity: issue.severity,
    subject,
    preview,
    detail: issue.detail,
    recommendation: issue.recommendation,
  }));
}

/** Static cryptographic weakness & embedded JWT auditor for first-party source files. */
export function auditSourceCrypto(
  text: string,
  lexed: LexResult,
  lines: LineIndex,
  base: Omit<IntelLocation, 'line' | 'column'>,
): SinkHit[] {
  const hits: SinkHit[] = [];
  const seen = new Set<string>();

  const push = (hit: SinkHit) => {
    const key = `${hit.ruleId}:${hit.location.line}`;
    if (seen.has(key) || hits.length >= MAX_CRYPTO_HITS_PER_FILE) return;
    seen.add(key);
    hits.push(hit);
  };

  if (lexed.code) {
    // 1. Math.random() in security context (current line + preceding declaration line)
    MATH_RANDOM.lastIndex = 0;
    for (const match of lexed.code.matchAll(MATH_RANDOM)) {
      const start = match.index;
      const pos = lines.position(start);
      const ctxStart = lines.lineStart(Math.max(1, pos.line - 1));
      const nextLineEnd = text.indexOf('\n', start);
      const ctxEnd = nextLineEnd < 0 ? text.length : nextLineEnd;
      const windowSlice = text.slice(ctxStart, ctxEnd);
      if (!SECURITY_CONTEXT.test(windowSlice)) continue;
      if (hasIgnoreComment(text, start)) continue;
      push({
        ruleId: 'crypto-math-random',
        title: 'Weak PRNG: Math.random() used in security context',
        category: 'crypto',
        level: 'high',
        snippet: lineAround(text, start),
        location: { ...base, line: pos.line, column: pos.column },
      });
    }

    // 2. Weak hashes (MD5 / SHA-1) — run on original text since algorithm name is inside string literal
    WEAK_HASH.lastIndex = 0;
    for (const match of text.matchAll(WEAK_HASH)) {
      const start = match.index;
      if (hasIgnoreComment(text, start)) continue;
      const pos = lines.position(start);
      push({
        ruleId: 'crypto-weak-hash',
        title: 'Weak cryptographic hash (MD5 / SHA-1)',
        category: 'crypto',
        level: 'medium',
        snippet: lineAround(text, start),
        location: { ...base, line: pos.line, column: pos.column },
      });
    }

    // 3. AES ECB mode
    ECB_MODE.lastIndex = 0;
    for (const match of text.matchAll(ECB_MODE)) {
      const start = match.index;
      if (hasIgnoreComment(text, start)) continue;
      const pos = lines.position(start);
      push({
        ruleId: 'crypto-ecb-mode',
        title: 'Insecure AES ECB cipher mode',
        category: 'crypto',
        level: 'high',
        snippet: lineAround(text, start),
        location: { ...base, line: pos.line, column: pos.column },
      });
    }

    // 4. Hardcoded static IV or salt
    STATIC_IV_SALT.lastIndex = 0;
    for (const match of text.matchAll(STATIC_IV_SALT)) {
      const start = match.index;
      const windowSlice = text.slice(Math.max(0, start - 200), Math.min(text.length, start + 200));
      if (
        !/\b(?:CryptoJS|cipher|encrypt|aes|pbkdf2|scrypt|hmac|subtle|crypto)\b/i.test(windowSlice)
      ) {
        continue;
      }
      if (hasIgnoreComment(text, start)) continue;
      const pos = lines.position(start);
      push({
        ruleId: 'crypto-static-iv-salt',
        title: 'Hardcoded static IV or salt',
        category: 'crypto',
        level: 'medium',
        snippet: lineAround(text, start),
        location: { ...base, line: pos.line, column: pos.column },
      });
    }
  }

  // 5. Embedded JWTs in source strings -> deep JWT inspection (strictly masked)
  for (const tok of lexed.strings) {
    if (tok.value.length < 30 || !tok.value.includes('eyJ')) continue;
    const jwtMatch = AUDIT_JWT.exec(tok.value);
    if (!jwtMatch?.[1]) continue;
    const issues = inspectJwtToken(jwtMatch[1]);
    if (issues.length === 0) continue;
    const pos = lines.position(tok.start);
    const masked = maskAuditValue(jwtMatch[1]);
    for (const issue of issues) {
      push({
        ruleId: issue.ruleId,
        title: `${issue.title} (in source)`,
        category: 'crypto',
        level: issue.severity === 'critical' || issue.severity === 'high' ? 'high' : 'medium',
        snippet: `${masked} — ${issue.detail}`,
        location: { ...base, line: pos.line, column: pos.column },
      });
    }
  }

  return hits;
}
