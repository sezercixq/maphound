export type AuditCategory = 'headers' | 'cookie' | 'storage' | 'supply-chain' | 'oauth';
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

export interface RawHeaderEntry {
  name: string;
  value: string;
}

export interface HtmlCommentHit {
  text: string;
  tags: string[];
  level: 'high' | 'medium' | 'low' | 'info';
}

export interface HtmlMetaTag {
  name: string;
  content: string;
}

export interface HtmlAuditSummary {
  comments: HtmlCommentHit[];
  metas: HtmlMetaTag[];
}

export interface RobotsSummary {
  found: boolean;
  status: number;
  disallow: string[];
  allow: string[];
  sitemaps: string[];
}

export interface SitemapSummary {
  found: boolean;
  status: number;
  urls: string[];
}

export interface DiscoveryFilesRecord {
  origin: string;
  checkedAt: number;
  robots: RobotsSummary;
  sitemap: SitemapSummary;
}

export interface ExternalResourceTag {
  tag: 'script' | 'stylesheet';
  url: string;
  integrity?: string;
  crossOrigin?: string | null;
}

export interface ClientAuditPayload {
  pageUrl: string;
  storageFindings: AuditFinding[];
  cookieFindings: AuditFinding[];
  /** Client-side SRI / Supply Chain and OAuth URL/fragment audit findings. */
  supplyChainFindings?: AuditFinding[];
  oauthFindings?: AuditFinding[];
  /** External <script> and <link rel="stylesheet"> tags captured for SRI auditing. */
  externalResources?: ExternalResourceTag[];
  /** Cookie names only (never values), for passive backend stack fingerprinting. */
  cookieNames?: string[];
  htmlAudit?: HtmlAuditSummary;
  storageKeysChecked: number;
  cookiesChecked: number;
}
