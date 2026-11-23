import { decodeJwt } from '@/engine/validators/jwt';
import { AUDIT_ANALYTICS_COOKIE, AUDIT_JWT, AUDIT_SENSITIVE_COOKIE } from './patterns';
import { maskAuditValue } from './storage';
import type { AuditFinding, ClientCookieInput } from './types';

export function parseSetCookieHeader(raw: string): ClientCookieInput | null {
  const parts = raw
    .split(';')
    .map((p) => p.trim())
    .filter(Boolean);
  const first = parts[0];
  if (!first) return null;
  const eq = first.indexOf('=');
  if (eq <= 0) return null;

  const name = first.slice(0, eq).trim();
  const value = first.slice(eq + 1).trim();
  if (!name) return null;

  const cookie: ClientCookieInput = {
    name,
    value,
    httpOnly: false,
    secure: false,
    fromDocumentCookie: false,
  };

  for (const attr of parts.slice(1)) {
    const idx = attr.indexOf('=');
    const key = (idx < 0 ? attr : attr.slice(0, idx)).trim().toLowerCase();
    const val = idx < 0 ? '' : attr.slice(idx + 1).trim();
    if (key === 'httponly') cookie.httpOnly = true;
    else if (key === 'secure') cookie.secure = true;
    else if (key === 'samesite') cookie.sameSite = val.toLowerCase();
    else if (key === 'domain') cookie.domain = val;
    else if (key === 'path') cookie.path = val;
  }
  return cookie;
}

export function auditCookies(
  cookies: readonly ClientCookieInput[],
  pageUrl: string,
): AuditFinding[] {
  const findings: AuditFinding[] = [];
  let isHttps = false;
  try {
    isHttps = new URL(pageUrl).protocol === 'https:';
  } catch {
    // default false
  }

  for (const cookie of cookies.slice(0, 150)) {
    const name = cookie.name.trim();
    if (!name) continue;
    if (AUDIT_ANALYTICS_COOKIE.test(name)) continue;

    const jwtMatch = cookie.value ? AUDIT_JWT.exec(cookie.value) : null;
    const hasJwt = Boolean(jwtMatch?.[1] && decodeJwt(jwtMatch[1]));
    const sensitive = AUDIT_SENSITIVE_COOKIE.test(name) || hasJwt;
    const preview = hasJwt && jwtMatch?.[1] ? maskAuditValue(jwtMatch[1]) : undefined;

    if (cookie.httpOnly === false || cookie.fromDocumentCookie) {
      findings.push({
        id: `cookie:no-httponly:${name}`,
        category: 'cookie',
        ruleId: 'cookie-missing-httponly',
        title: sensitive
          ? `Sensitive cookie "${name}" lacks HttpOnly`
          : `Cookie "${name}" readable by JavaScript (missing HttpOnly)`,
        severity: sensitive ? 'high' : 'low',
        subject: name,
        ...(preview ? { preview } : {}),
        detail: `Cookie "${name}" can be read via document.cookie${hasJwt ? ' and contains a JWT' : ''}.`,
        recommendation: 'Set the HttpOnly attribute on session and authentication cookies.',
      });
    }

    if (cookie.sameSite === 'none' && cookie.secure === false) {
      findings.push({
        id: `cookie:samesite-none-insecure:${name}`,
        category: 'cookie',
        ruleId: 'cookie-samesite-none-insecure',
        title: `Cookie "${name}" uses SameSite=None without Secure`,
        severity: 'high',
        subject: name,
        detail: 'SameSite=None requires the Secure attribute and HTTPS transport.',
        recommendation: 'Add the Secure attribute or switch SameSite to Lax or Strict.',
      });
    }

    if (cookie.secure === false && (isHttps || sensitive)) {
      findings.push({
        id: `cookie:no-secure:${name}`,
        category: 'cookie',
        ruleId: 'cookie-missing-secure',
        title: `Cookie "${name}" lacks Secure flag`,
        severity: sensitive ? 'medium' : 'low',
        subject: name,
        detail: `Cookie "${name}" may be transmitted over unencrypted HTTP.`,
        recommendation: 'Set the Secure attribute on cookies so they are only sent over HTTPS.',
      });
    }

    if (cookie.sameSite === undefined && !cookie.fromDocumentCookie) {
      findings.push({
        id: `cookie:no-samesite:${name}`,
        category: 'cookie',
        ruleId: 'cookie-missing-samesite',
        title: `Cookie "${name}" omits SameSite attribute`,
        severity: sensitive ? 'medium' : 'info',
        subject: name,
        detail: `No explicit SameSite attribute on cookie "${name}".`,
        recommendation: 'Set SameSite=Lax or SameSite=Strict to protect against CSRF.',
      });
    }
  }

  return findings;
}

export function auditSetCookieHeaders(headers: readonly string[], pageUrl: string): AuditFinding[] {
  const parsed: ClientCookieInput[] = [];
  for (const raw of headers) {
    const cookie = parseSetCookieHeader(raw);
    if (cookie) parsed.push(cookie);
  }
  return auditCookies(parsed, pageUrl);
}

export function mergeAuditFindings(...groups: (readonly AuditFinding[])[]): AuditFinding[] {
  const byId = new Map<string, AuditFinding>();
  for (const group of groups) {
    for (const item of group) {
      if (!byId.has(item.id)) byId.set(item.id, item);
    }
  }
  return [...byId.values()];
}
