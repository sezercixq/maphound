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

export const AUDIT_PATTERNS: readonly { name: string; regex: RegExp }[] = Object.entries({
  AUDIT_JWT,
  AUDIT_BEARER,
  AUDIT_PROVIDER_PREFIX,
  AUDIT_SENSITIVE_KEY,
  AUDIT_SENSITIVE_COOKIE,
  AUDIT_ANALYTICS_COOKIE,
}).map(([name, regex]) => ({ name, regex }));
