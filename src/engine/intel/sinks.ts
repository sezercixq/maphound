import { hasIgnoreComment } from '@/engine/scan/suppress';
import { type LexResult, type LineIndex, lineAround, type StringToken } from './lexer';
import {
  DECLARATION_BEFORE,
  DOTTED_BEFORE,
  LOCATION_RECEIVER_BEFORE,
  ORIGIN_CHECK,
  REDIRECT_TAINT,
  SANITIZED,
  SINK_ANGULAR_BYPASS,
  SINK_ANGULAR_INNER_HTML,
  SINK_DANGEROUSLY_SET_INNER_HTML,
  SINK_DOCUMENT_WRITE,
  SINK_EVAL,
  SINK_INNER_HTML,
  SINK_INSERT_ADJACENT_HTML,
  SINK_LOCATION_ASSIGN,
  SINK_MESSAGE_LISTENER,
  SINK_NEW_FUNCTION,
  SINK_ONMESSAGE,
  SINK_POST_MESSAGE,
  SINK_SRCDOC,
  SINK_SSR_STATE,
  SINK_STRING_TIMER,
  SINK_SVELTE_HTML,
  SINK_VUE_V_HTML,
  WILDCARD_TARGET,
  WINDOW_RECEIVER_BEFORE,
} from './patterns';
import { type HintLevel, type IntelLocation, type SinkCategory, type SinkHit } from './types';

export const MAX_SINKS_PER_FILE = 150;

/** Binary search for the string token that begins at `offset` (e.g. an opening quote). */
function stringStartingAt(strings: readonly StringToken[], offset: number): StringToken | null {
  let lo = 0;
  let hi = strings.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const tok = strings[mid] as StringToken;
    if (tok.start === offset) return tok;
    if (tok.start < offset) lo = mid + 1;
    else hi = mid - 1;
  }
  return null;
}

function isStaticEmptyHtmlAssign(text: string, afterOffset: number): boolean {
  const rest = text.slice(afterOffset, Math.min(text.length, afterOffset + 16)).trimStart();
  return /^(?:''|""|``)\s*(?:[;,\n\r)]|$)/.test(rest);
}

function isStaticStringAssign(text: string, afterOffset: number): boolean {
  const rest = text.slice(afterOffset, Math.min(text.length, afterOffset + 240)).trimStart();
  const quote = rest[0];
  if (quote !== "'" && quote !== '"') return false;
  let i = 1;
  while (i < rest.length) {
    const ch = rest[i];
    if (ch === '\\') {
      i += 2;
      continue;
    }
    if (ch === '\n' || ch === '\r') return false;
    if (ch === quote) {
      const tail = rest.slice(i + 1).trimStart();
      return tail.length === 0 || /^[;,)\n\r]/.test(tail);
    }
    i++;
  }
  return false;
}

/**
 * Extract up to `maxLen` characters of a message listener callback from blanked `code`
 * so we can check whether `.origin` is inspected inside it.
 */
function extractHandlerSlice(code: string, startOffset: number, maxLen = 1200): string {
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

interface SimpleSinkSpec {
  ruleId: string;
  title: string;
  category: SinkCategory;
  pattern: RegExp;
  level: HintLevel | ((line: string) => HintLevel);
  accept?: (text: string, code: string, match: RegExpExecArray) => boolean;
}

const SIMPLE_SINKS: readonly SimpleSinkSpec[] = [
  {
    ruleId: 'dom-xss-dangerously-set-inner-html',
    title: 'React dangerouslySetInnerHTML',
    category: 'dom-xss',
    pattern: SINK_DANGEROUSLY_SET_INNER_HTML,
    level: (line) => (SANITIZED.test(line) ? 'low' : 'high'),
  },
  {
    ruleId: 'dom-xss-inner-html',
    title: 'DOM innerHTML / outerHTML assignment',
    category: 'dom-xss',
    pattern: SINK_INNER_HTML,
    level: (line) => (SANITIZED.test(line) ? 'low' : 'high'),
    accept: (text, _code, match) => !isStaticEmptyHtmlAssign(text, match.index + match[0].length),
  },
  {
    ruleId: 'dom-xss-insert-adjacent-html',
    title: 'DOM insertAdjacentHTML()',
    category: 'dom-xss',
    pattern: SINK_INSERT_ADJACENT_HTML,
    level: (line) => (SANITIZED.test(line) ? 'low' : 'high'),
  },
  {
    ruleId: 'dom-xss-document-write',
    title: 'document.write() call',
    category: 'dom-xss',
    pattern: SINK_DOCUMENT_WRITE,
    level: 'high',
  },
  {
    ruleId: 'dom-xss-srcdoc',
    title: 'iframe.srcdoc assignment',
    category: 'dom-xss',
    pattern: SINK_SRCDOC,
    level: 'medium',
  },
  {
    ruleId: 'code-eval',
    title: 'Dynamic eval() call',
    category: 'code-injection',
    pattern: SINK_EVAL,
    level: 'high',
  },
  {
    ruleId: 'code-new-function',
    title: 'Dynamic new Function() constructor',
    category: 'code-injection',
    pattern: SINK_NEW_FUNCTION,
    level: 'high',
  },
  {
    ruleId: 'code-string-timer',
    title: 'String-based setTimeout / setInterval',
    category: 'code-injection',
    pattern: SINK_STRING_TIMER,
    level: 'medium',
    accept: (_text, _code, match) => {
      // Quoted string start is right at the trailing quote character.
      const quoteIndex = match.index + match[0].length - 1;
      return quoteIndex >= 0;
    },
  },
  {
    ruleId: 'messaging-postmessage-wildcard',
    title: 'postMessage() with wildcard "*" targetOrigin',
    category: 'messaging',
    pattern: SINK_POST_MESSAGE,
    level: 'medium',
    accept: (text, _code, match) =>
      WILDCARD_TARGET.test(
        text.slice(match.index + match[0].length, match.index + match[0].length + 140),
      ),
  },
  {
    ruleId: 'open-redirect',
    title: 'Dynamic location redirect candidate',
    category: 'redirect',
    pattern: SINK_LOCATION_ASSIGN,
    level: (line) => (REDIRECT_TAINT.test(line) ? 'high' : 'medium'),
    accept: (text, code, match) => {
      const before = code.slice(Math.max(0, match.index - 40), match.index);
      if (DECLARATION_BEFORE.test(before)) return false;
      if (match[0].startsWith('location') && DOTTED_BEFORE.test(before)) {
        if (!LOCATION_RECEIVER_BEFORE.test(before)) return false;
      }
      return !isStaticStringAssign(text, match.index + match[0].length);
    },
  },
  {
    ruleId: 'framework-vue-v-html',
    title: 'Vue v-html directive',
    category: 'framework',
    pattern: SINK_VUE_V_HTML,
    level: (line) => (SANITIZED.test(line) ? 'low' : 'high'),
  },
  {
    ruleId: 'framework-svelte-html',
    title: 'Svelte {@html} tag',
    category: 'framework',
    pattern: SINK_SVELTE_HTML,
    level: (line) => (SANITIZED.test(line) ? 'low' : 'high'),
  },
  {
    ruleId: 'framework-angular-bypass',
    title: 'Angular DomSanitizer bypass',
    category: 'framework',
    pattern: SINK_ANGULAR_BYPASS,
    level: 'high',
  },
  {
    ruleId: 'framework-angular-inner-html',
    title: 'Angular [innerHTML] binding',
    category: 'framework',
    pattern: SINK_ANGULAR_INNER_HTML,
    level: 'medium',
  },
  {
    ruleId: 'framework-ssr-state',
    title: 'Client read of SSR hydration state (__NEXT_DATA__ / __INITIAL_STATE__)',
    category: 'framework',
    pattern: SINK_SSR_STATE,
    level: 'info',
  },
];

export function extractSinks(
  text: string,
  lexed: LexResult,
  lines: LineIndex,
  base: Omit<IntelLocation, 'line' | 'column'>,
): SinkHit[] {
  const code = lexed.code;
  if (!code) return [];

  const hits: SinkHit[] = [];
  const seen = new Set<string>();

  const record = (
    ruleId: string,
    title: string,
    category: SinkCategory,
    level: HintLevel,
    offset: number,
  ) => {
    if (hits.length >= MAX_SINKS_PER_FILE) return;
    if (hasIgnoreComment(text, offset)) return;
    const pos = lines.position(offset);
    const key = `${ruleId}:${pos.line}`;
    if (seen.has(key)) return;
    seen.add(key);
    hits.push({
      ruleId,
      title,
      category,
      level,
      snippet: lineAround(text, offset),
      location: { ...base, line: pos.line, column: pos.column },
    });
  };

  for (const spec of SIMPLE_SINKS) {
    if (hits.length >= MAX_SINKS_PER_FILE) break;
    spec.pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = spec.pattern.exec(code)) !== null) {
      if (spec.accept && !spec.accept(text, code, match)) continue;
      const lineText = lineAround(text, match.index, 240);
      const level = typeof spec.level === 'function' ? spec.level(lineText) : spec.level;
      record(spec.ruleId, spec.title, spec.category, level, match.index);
      if (hits.length >= MAX_SINKS_PER_FILE) break;
    }
  }

  // `window.addEventListener('message', ...)` without an `.origin` check inside the callback.
  if (hits.length < MAX_SINKS_PER_FILE) {
    SINK_MESSAGE_LISTENER.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = SINK_MESSAGE_LISTENER.exec(code)) !== null) {
      const before = code.slice(Math.max(0, match.index - 40), match.index);
      if (!WINDOW_RECEIVER_BEFORE.test(before)) continue;
      const quoteOffset = match.index + match[0].length - 1;
      const eventTok = stringStartingAt(lexed.strings, quoteOffset);
      if (!eventTok || eventTok.value !== 'message') continue;
      const handlerSlice = extractHandlerSlice(code, eventTok.end);
      if (ORIGIN_CHECK.test(handlerSlice)) continue;
      const isInline = handlerSlice.includes('=>') || /\bfunction\b/.test(handlerSlice);
      record(
        'messaging-unverified-origin',
        isInline
          ? 'postMessage listener without origin check'
          : 'postMessage listener (verify handler origin check)',
        'messaging',
        isInline ? 'high' : 'medium',
        match.index,
      );
      if (hits.length >= MAX_SINKS_PER_FILE) break;
    }
  }

  // `window.onmessage = ...` without `.origin` check.
  if (hits.length < MAX_SINKS_PER_FILE) {
    SINK_ONMESSAGE.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = SINK_ONMESSAGE.exec(code)) !== null) {
      const handlerSlice = extractHandlerSlice(code, match.index + match[0].length);
      if (ORIGIN_CHECK.test(handlerSlice)) continue;
      record(
        'messaging-unverified-origin',
        'window.onmessage handler without origin check',
        'messaging',
        'high',
        match.index,
      );
      if (hits.length >= MAX_SINKS_PER_FILE) break;
    }
  }

  return hits;
}
