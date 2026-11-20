import { shannonEntropy } from '../scan/entropy';
import type { Severity, ValidatorName } from '../scan/types';
import { hasValidGithubChecksum } from './github-crc32';
import { decodeJwt } from './jwt';
import { inspectPrivateKey } from './private-key';

export interface ValidationResult {
  valid: boolean;
  /** A checksum or full structural decode passed: confidence becomes `verified-format`. */
  strong: boolean;
  /** Overrides the rule's severity (public anon keys, encrypted private keys). */
  severity?: Severity;
}

const INVALID: ValidationResult = { valid: false, strong: false };

export const VALIDATORS: Record<ValidatorName, (secret: string) => ValidationResult> = {
  'github-checksum': (secret) =>
    hasValidGithubChecksum(secret) ? { valid: true, strong: true } : INVALID,

  /** No public checksum: check the layout and that both random parts look random. */
  'github-fine-grained': (secret) => {
    const match = /^github_pat_([A-Za-z0-9]{22})_([A-Za-z0-9]{59})$/.exec(secret);
    if (!match) return INVALID;
    return shannonEntropy(match[1] as string) >= 3.5 && shannonEntropy(match[2] as string) >= 4.5
      ? { valid: true, strong: false }
      : INVALID;
  },

  jwt: (secret) => {
    const jwt = decodeJwt(secret);
    if (!jwt) return INVALID;
    // Supabase anon keys (and similar) are designed to be embedded in clients.
    if (jwt.payload.role === 'anon') return { valid: true, strong: true, severity: 'info' };
    return { valid: true, strong: true };
  },

  'supabase-service-role': (secret) => {
    const jwt = decodeJwt(secret);
    return jwt && jwt.payload.role === 'service_role' ? { valid: true, strong: true } : INVALID;
  },

  'private-key': (secret) => {
    const key = inspectPrivateKey(secret);
    if (!key) return INVALID;
    return key.encrypted
      ? { valid: true, strong: true, severity: 'high' }
      : { valid: true, strong: true };
  },
};

export { base62, crc32, hasValidGithubChecksum, makeGithubStyleToken } from './github-crc32';
export { decodeJwt } from './jwt';
export { inspectPrivateKey } from './private-key';
