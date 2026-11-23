import { decodeJwt } from '@/engine/validators/jwt';
import { AUDIT_BEARER, AUDIT_JWT, AUDIT_PROVIDER_PREFIX, AUDIT_SENSITIVE_KEY } from './patterns';
import type { AuditFinding } from './types';

const MAX_STORAGE_ENTRIES = 200;
const MAX_VALUE_SCAN_CHARS = 16_000;

export function maskAuditValue(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length <= 8) return '••••';
  return `${trimmed.slice(0, 4)}…${trimmed.slice(-4)}`;
}

export function auditStorageEntries(
  entries: readonly { key: string; value: string }[],
  storage: 'localStorage' | 'sessionStorage',
): AuditFinding[] {
  const findings: AuditFinding[] = [];
  const limit = Math.min(entries.length, MAX_STORAGE_ENTRIES);

  for (let i = 0; i < limit; i++) {
    const entry = entries[i];
    if (!entry || !entry.key) continue;
    const raw = entry.value.slice(0, MAX_VALUE_SCAN_CHARS);
    const subject = `${storage}:${entry.key}`;

    const jwtMatch = AUDIT_JWT.exec(raw);
    if (jwtMatch?.[1]) {
      const decoded = decodeJwt(jwtMatch[1]);
      if (decoded) {
        const claims: string[] = [];
        if (typeof decoded.header.alg === 'string') claims.push(`alg=${decoded.header.alg}`);
        if (typeof decoded.payload.role === 'string') claims.push(`role=${decoded.payload.role}`);
        if (typeof decoded.payload.exp === 'number') claims.push(`exp=${decoded.payload.exp}`);
        findings.push({
          id: `${storage}:jwt:${entry.key}`,
          category: 'storage',
          ruleId: 'storage-jwt',
          title: `JWT stored in ${storage}`,
          severity: 'high',
          subject,
          preview: maskAuditValue(jwtMatch[1]),
          detail: `Web Storage key "${entry.key}" holds a JWT accessible to any XSS payload${claims.length > 0 ? ` (${claims.join(', ')})` : ''}.`,
          recommendation:
            'Store session tokens in HttpOnly, Secure, SameSite cookies instead of Web Storage.',
        });
        continue;
      }
    }

    const bearerMatch = AUDIT_BEARER.exec(raw);
    if (bearerMatch?.[1] || AUDIT_PROVIDER_PREFIX.test(raw)) {
      const token = bearerMatch?.[1] ?? raw;
      findings.push({
        id: `${storage}:token:${entry.key}`,
        category: 'storage',
        ruleId: 'storage-bearer-token',
        title: `Bearer or API token stored in ${storage}`,
        severity: 'high',
        subject,
        preview: maskAuditValue(token),
        detail: `Web Storage key "${entry.key}" contains a Bearer or provider-prefixed token readable by client scripts.`,
        recommendation:
          'Avoid storing long-lived credentials or bearer tokens in Web Storage; move sessions to HttpOnly cookies.',
      });
      continue;
    }

    if (AUDIT_SENSITIVE_KEY.test(entry.key) && raw.trim().length >= 6) {
      findings.push({
        id: `${storage}:sensitive:${entry.key}`,
        category: 'storage',
        ruleId: 'storage-sensitive-key',
        title: `Sensitive-looking key in ${storage}`,
        severity: 'medium',
        subject,
        preview: maskAuditValue(raw),
        detail: `Key "${entry.key}" in ${storage} appears to store auth or session data readable via JavaScript.`,
        recommendation:
          'Verify whether this value is sensitive; move authentication state to HttpOnly cookies.',
      });
    }
  }

  return findings;
}
