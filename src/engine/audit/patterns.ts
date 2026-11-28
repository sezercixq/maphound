/** Bounded regexes for storage & cookie auditing, verified ReDoS-safe by `pnpm rules:check`. */

export const AUDIT_JWT =
  /(?<![A-Za-z0-9_-])(eyJ[A-Za-z0-9_-]{8,500}\.eyJ[A-Za-z0-9_-]{8,2000}\.[A-Za-z0-9_-]{16,600})(?![A-Za-z0-9_-])/;

export const AUDIT_BEARER = /\bBearer[ \t]{1,4}([A-Za-z0-9._\-+/=]{12,500})/i;

export const AUDIT_PROVIDER_PREFIX =
  /\b(?:sk_live_|sk_test_|rk_live_|ghp_|gho_|ghu_|ghs_|sb_secret_|sbp_|hf_|AIza[A-Za-z0-9_-]{20}|AKIA[0-9A-Z]{16}|sk-proj-|sk-ant-|gsk_|r8_|pplx-)/;

export const AUDIT_SENSITIVE_KEY =
  /(?:token|secret|auth|jwt|session|password|passwd|apikey|api[_-]?key|credential|refresh|bearer|access[_-]?key|id[_-]?token|oauth|firebase:authUser)/i;

export const AUDIT_SENSITIVE_COOKIE =
  /(?:session|sess|sid|auth|token|jwt|bearer|access|refresh|csrf|xsrf|remember|oauth|sso|connect\.sid|phpsessid|jsessionid|asp\.net_sessionid|_session)/i;

export const AUDIT_ANALYTICS_COOKIE =
  /^(?:_ga|_gid|_gat|_gcl_|_fbp|_fbc|_hj|__utm|_clck|_clsk|amplitude_|mp_|ph_|ajs_)/i;

export const AUDIT_DEBUG_HEADER_NAME =
  /^(?:x-(?:debug|dev|internal|backend|upstream|env|environment|stage|build|commit|git|version|app-version|api-version|runtime|php|rails|drupal|spring|server-version))(?:$|-[a-z0-9_-]{1,40}$)/i;

export const HTML_COMMENT_MARKER = /\b(TODO|FIXME|HACK|XXX|INTERNAL|BYPASS|DEBUG|SECURITY)\b/i;

export const HTML_COMMENT_PATH =
  /(?<![A-Za-z0-9])(\/(?:admin|internal|api|debug|backup|staging|dev|graphql|config|swagger|private|secret|console|v[0-9]{1,2})\/[A-Za-z0-9._/-]{1,80})/i;

export const HTML_COMMENT_VERSION = /(?<![0-9.])v?([0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,4})(?![0-9.])/i;

export const HTML_COMMENT_SECRET_HINT =
  /(?:api[_-]?key|secret|password|passwd|bearer|auth[_-]?token|flag\{|debug[_-]?mode)/i;

export const SITEMAP_LOC_TAG = /<loc>\s{0,20}([^<\s]{4,500})\s{0,20}<\/loc>/gi;

export const AUDIT_PATTERNS: readonly { name: string; regex: RegExp }[] = Object.entries({
  AUDIT_JWT,
  AUDIT_BEARER,
  AUDIT_PROVIDER_PREFIX,
  AUDIT_SENSITIVE_KEY,
  AUDIT_SENSITIVE_COOKIE,
  AUDIT_ANALYTICS_COOKIE,
  AUDIT_DEBUG_HEADER_NAME,
  HTML_COMMENT_MARKER,
  HTML_COMMENT_PATH,
  HTML_COMMENT_VERSION,
  HTML_COMMENT_SECRET_HINT,
  SITEMAP_LOC_TAG,
}).map(([name, regex]) => ({ name, regex }));
