export type AuditCategory = 'headers' | 'cookie' | 'storage';
export type AuditSeverity = 'critical' | 'high' | 'medium' | 'low' | 'info';

export const AUDIT_SEVERITY_ORDER: Record<AuditSeverity, number> = {
  critical: 5,
  high: 4,
  medium: 3,
  low: 2,
  info: 1,
};

export interface AuditFinding {
  id: string;
  category: AuditCategory;
  ruleId: string;
  title: string;
  severity: AuditSeverity;
  detail: string;
  recommendation: string;
  /** Header name, cookie name, or `localStorage:<key>`. */
  subject: string;
  /** Always masked when derived from a secret or token value. */
  preview?: string;
}

export type HeaderStatus = 'ok' | 'weak' | 'missing' | 'info';

export interface HeaderMatrixEntry {
  header: string;
  status: HeaderStatus;
  value: string | null;
}

export interface ClientCookieInput {
  name: string;
  value?: string;
  secure?: boolean;
  httpOnly?: boolean;
  sameSite?: string;
  domain?: string;
  path?: string;
  fromDocumentCookie?: boolean;
}

export interface ClientAuditPayload {
  pageUrl: string;
  storageFindings: AuditFinding[];
  cookieFindings: AuditFinding[];
  /** Cookie names only (never values), for passive backend stack fingerprinting. */
  cookieNames?: string[];
  storageKeysChecked: number;
  cookiesChecked: number;
}
