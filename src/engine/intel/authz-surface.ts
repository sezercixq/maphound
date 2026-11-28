import { hasIgnoreComment } from '@/engine/scan/suppress';
import { type LexResult, type LineIndex, lineAround } from './lexer';
import { SINK_MESSAGE_LISTENER, SINK_ONMESSAGE, WINDOW_RECEIVER_BEFORE } from './patterns';
import type { EndpointHit, IntelLocation, SinkHit } from './types';

export const MAX_AUTHZ_HITS_PER_FILE = 60;

const ORIGIN_GUARD =
  /\.origin\s{0,4}(?:===?|!==?)|\.origin\s{0,2}\.\s{0,2}(?:endsWith|startsWith|includes)\s{0,2}\(|\b(?:allowedOrigins|trustedOrigins|validOrigins)\b/i;

const CLIENT_AUTHZ_GATE =
  /\b(?:isAdmin|isSuperAdmin|isStaff|canAccessAdmin|hasAdminRole)\b|\b(?:user|currentUser|session|profile|account)\s{0,2}\??\.\s{0,2}role\s{0,4}(?:===?|!==?)|\b(?:permissions|roles)\s{0,2}\??\.\s{0,2}includes\s{0,4}\(|\b(?:hasPermission|hasRole|checkPermission)\s{0,4}\(/g;

const IDOR_PATH_PATTERN =
  /\/(?::(?:id|userId|user_id|accountId|account_id|orderId|order_id|orgId|org_id|customerId|invoiceId|memberId|projectId)|\{(?:id|userId|user_id|accountId|account_id|orderId|order_id|orgId|org_id|customerId|invoiceId|memberId|projectId)\})(?:[/?#]|$)/i;

const IDOR_QUERY_PATTERN =
  /[?&](?:userId|user_id|accountId|account_id|orderId|order_id|orgId|org_id|customerId|invoiceId|memberId|id)=/i;

function extractHandlerSlice(code: string, startOffset: number, maxLen = 1400): string {
  const limit = Math.min(code.length, startOffset + maxLen);
  let braceDepth = 0;
  let seenOpenBrace = false;
  for (let i = startOffset; i < limit; i++) {
    const ch = code[i];
    if (ch === '{') {
      braceDepth++;
      seenOpenBrace = true;
    } else if (ch === '}') {
      if (braceDepth > 0) braceDepth--;
      if (seenOpenBrace && braceDepth === 0) return code.slice(startOffset, i + 1);
    } else if (!seenOpenBrace && ch === ';') {
      return code.slice(startOffset, i + 1);
    }
  }
  return code.slice(startOffset, limit);
}

/**
 * Extracts unvalidated `postMessage` handlers, client-side authorization gates
 * (`isAdmin`, `role ===`, `permissions.includes`), and IDOR candidate API endpoints.
 */
export function extractAuthzSurface(
  text: string,
  lexed: LexResult,
  lines: LineIndex,
  base: Omit<IntelLocation, 'line' | 'column'>,
  endpoints: readonly EndpointHit[],
): SinkHit[] {
  const hits: SinkHit[] = [];
  const seen = new Set<string>();
  const code = lexed.code;

  const push = (hit: SinkHit) => {
    const key = `${hit.ruleId}:${hit.location.line}:${hit.snippet.slice(0, 60)}`;
    if (seen.has(key) || hits.length >= MAX_AUTHZ_HITS_PER_FILE) return;
    seen.add(key);
    hits.push(hit);
  };

  if (code) {
    // 1. Unvalidated postMessage handlers (addEventListener('message', ...) & onmessage = ...)
    SINK_MESSAGE_LISTENER.lastIndex = 0;
    for (const match of code.matchAll(SINK_MESSAGE_LISTENER)) {
      const start = match.index;
      const before = code.slice(Math.max(0, start - 32), start);
      if (!WINDOW_RECEIVER_BEFORE.test(before)) continue;
      const quoteOffset = start + match[0].length - 1;
      const rawTail = text.slice(quoteOffset, quoteOffset + 12);
      if (!/^['"`]message['"`]/.test(rawTail)) continue;
      const handlerSlice = extractHandlerSlice(code, start + match[0].length);
      if (ORIGIN_GUARD.test(handlerSlice)) continue;
      if (hasIgnoreComment(text, start)) continue;
      const pos = lines.position(start);
      push({
        ruleId: 'authz-unvalidated-postmessage',
        title: 'Unvalidated postMessage Handler',
        category: 'authz-idor',
        level: 'high',
        snippet: lineAround(text, start),
        location: { ...base, line: pos.line, column: pos.column },
      });
    }

    SINK_ONMESSAGE.lastIndex = 0;
    for (const match of code.matchAll(SINK_ONMESSAGE)) {
      const start = match.index;
      const handlerSlice = extractHandlerSlice(code, start + match[0].length);
      if (ORIGIN_GUARD.test(handlerSlice)) continue;
      if (hasIgnoreComment(text, start)) continue;
      const pos = lines.position(start);
      push({
        ruleId: 'authz-unvalidated-postmessage',
        title: 'Unvalidated postMessage Handler',
        category: 'authz-idor',
        level: 'high',
        snippet: lineAround(text, start),
        location: { ...base, line: pos.line, column: pos.column },
      });
    }

    // 2. Client-side authorization gates (AuthZ candidates)
    CLIENT_AUTHZ_GATE.lastIndex = 0;
    for (const match of code.matchAll(CLIENT_AUTHZ_GATE)) {
      const start = match.index;
      if (hasIgnoreComment(text, start)) continue;
      const pos = lines.position(start);
      push({
        ruleId: 'authz-client-gate',
        title: 'AuthZ Candidate: client-side role/permission gate',
        category: 'authz-idor',
        level: 'medium',
        snippet: lineAround(text, start),
        location: { ...base, line: pos.line, column: pos.column },
      });
    }
  }

  // 3. IDOR candidate endpoints (parameterized / predictable object IDs)
  for (const ep of endpoints) {
    if (!IDOR_PATH_PATTERN.test(ep.value) && !IDOR_QUERY_PATTERN.test(ep.value)) continue;
    const loc = ep.locations[0] ?? { ...base, line: 1, column: 0 };
    push({
      ruleId: 'authz-idor-candidate',
      title: 'AuthZ / IDOR Candidate endpoint',
      category: 'authz-idor',
      level: 'medium',
      snippet: `${ep.methods.length > 0 ? `${ep.methods.join(',')} ` : ''}${ep.value}`,
      location: loc,
    });
  }

  return hits;
}
