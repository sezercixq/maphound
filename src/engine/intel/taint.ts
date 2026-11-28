import { hasIgnoreComment } from '@/engine/scan/suppress';
import { type LexResult, type LineIndex, lineAround } from './lexer';
import type { IntelLocation, SinkHit } from './types';

export const MAX_TAINT_FLOWS_PER_FILE = 60;
const MAX_LINES_TO_TRACE = 12_000;

interface TaintEntry {
  sourceExpr: string;
  sourceLine: number;
  depth: number;
}

// Bounded, linear-time source matchers (run per line on blanked `lexed.code`).
const SOURCE_MATCHERS: readonly { label: string; regex: RegExp }[] = [
  { label: 'location.search', regex: /\blocation\s{0,2}\.\s{0,2}search\b/ },
  { label: 'location.hash', regex: /\blocation\s{0,2}\.\s{0,2}hash\b/ },
  { label: 'location.href', regex: /\blocation\s{0,2}\.\s{0,2}href\b/ },
  { label: 'document.URL', regex: /\bdocument\s{0,2}\.\s{0,2}URL\b/ },
  { label: 'document.referrer', regex: /\bdocument\s{0,2}\.\s{0,2}referrer\b/ },
  { label: 'window.name', regex: /\bwindow\s{0,2}\.\s{0,2}name\b/ },
  { label: 'URLSearchParams', regex: /\bURLSearchParams\b/ },
  { label: 'localStorage.getItem', regex: /\blocalStorage\s{0,2}\.\s{0,2}getItem\s{0,2}\(/ },
  { label: 'sessionStorage.getItem', regex: /\bsessionStorage\s{0,2}\.\s{0,2}getItem\s{0,2}\(/ },
  {
    label: 'postMessage(event.data)',
    regex: /\b(?:event|ev|evt|e|msg|message)\s{0,2}\.\s{0,2}data\b/,
  },
];

const SANITIZER_EXPR =
  /\b(?:DOMPurify\s{0,2}\.\s{0,2}sanitize|sanitize(?:Html|Url)?|purify|escapeHtml|encodeURIComponent|encodeURI|parseInt|parseFloat|Number|Boolean|JSON\.stringify)\s{0,2}\(/i;

const DECL_SIMPLE =
  /^\s{0,16}(?:export\s{1,4})?(?:const|let|var)\s{1,4}([A-Za-z_$][\w$]{0,40})\s{0,4}=\s{0,4}(.+)$/;
const DECL_DESTRUCTURE =
  /^\s{0,16}(?:export\s{1,4})?(?:const|let|var)\s{1,4}\{([^}{]{1,160})\}\s{0,4}=\s{0,4}(.+)$/;
const ASSIGN_SIMPLE = /^\s{0,16}([A-Za-z_$][\w$]{0,40})\s{0,4}=\s{0,4}(?!=)(.+)$/;

interface SinkDetector {
  ruleId: string;
  label: string;
  regex: RegExp;
  extractArg: (line: string, match: RegExpExecArray) => string;
}

const SINK_DETECTORS: readonly SinkDetector[] = [
  {
    ruleId: 'taint-dom-xss',
    label: 'DOM XSS (innerHTML / outerHTML)',
    regex: /\.(?:innerHTML|outerHTML)\s{0,4}\+?=\s{0,4}(?!=)/,
    extractArg: (line, m) => line.slice(m.index + m[0].length),
  },
  {
    ruleId: 'taint-dom-xss',
    label: 'DOM XSS (insertAdjacentHTML)',
    regex: /\.insertAdjacentHTML\s{0,4}\(/,
    extractArg: (line, m) => line.slice(m.index + m[0].length),
  },
  {
    ruleId: 'taint-dom-xss',
    label: 'DOM XSS (document.write)',
    regex: /\bdocument\s{0,2}\.\s{0,2}write(?:ln)?\s{0,4}\(/,
    extractArg: (line, m) => line.slice(m.index + m[0].length),
  },
  {
    ruleId: 'taint-dom-xss',
    label: 'DOM XSS (dangerouslySetInnerHTML)',
    regex: /\bdangerouslySetInnerHTML\s{0,4}[:=]/,
    extractArg: (line, m) => line.slice(m.index + m[0].length),
  },
  {
    ruleId: 'taint-dom-xss',
    label: 'DOM XSS (bypassSecurityTrustHtml)',
    regex: /\bbypassSecurityTrustHtml\s{0,4}\(/,
    extractArg: (line, m) => line.slice(m.index + m[0].length),
  },
  {
    ruleId: 'taint-code-exec',
    label: 'Code Execution (eval)',
    regex: /(?<![\w$.])eval\s{0,4}\(/,
    extractArg: (line, m) => line.slice(m.index + m[0].length),
  },
  {
    ruleId: 'taint-code-exec',
    label: 'Code Execution (new Function)',
    regex: /\bnew\s{1,4}Function\s{0,4}\(/,
    extractArg: (line, m) => line.slice(m.index + m[0].length),
  },
  {
    ruleId: 'taint-code-exec',
    label: 'Code Execution (setTimeout/setInterval)',
    regex: /\bset(?:Timeout|Interval)\s{0,4}\(/,
    extractArg: (line, m) => line.slice(m.index + m[0].length),
  },
  {
    ruleId: 'taint-open-redirect',
    label: 'Open Redirect (location / window.open)',
    regex:
      /\blocation(?:\s{0,2}\.\s{0,2}href)?\s{0,4}=\s{0,4}(?!=)|\blocation\s{0,2}\.\s{0,2}(?:assign|replace)\s{0,4}\(|\bwindow\s{0,2}\.\s{0,2}open\s{0,4}\(/,
    extractArg: (line, m) => line.slice(m.index + m[0].length),
  },
  {
    ruleId: 'taint-proto-pollution',
    label: 'Prototype Pollution (Object.assign / __proto__)',
    regex:
      /\bObject\s{0,2}\.\s{0,2}assign\s{0,4}\(|(?:__proto__|constructor\s{0,2}\.\s{0,2}prototype)\s{0,4}(?:=|\[)|\b(?:deepMerge|mergeDeep|extend)\s{0,4}\(/,
    extractArg: (line, m) => line.slice(m.index + m[0].length),
  },
];

function detectDirectSource(expr: string): string | null {
  for (const src of SOURCE_MATCHERS) {
    if (src.regex.test(expr)) return src.label;
  }
  return null;
}

function extractIdentifiers(expr: string): string[] {
  const out: string[] = [];
  const matches = expr.matchAll(/\b([A-Za-z_$][\w$]{0,40})\b/g);
  for (const m of matches) {
    if (m[1]) out.push(m[1]);
  }
  return out;
}

function findTaintedReference(
  expr: string,
  tainted: Map<string, TaintEntry>,
): { variable: string; entry: TaintEntry } | null {
  if (tainted.size === 0) return null;
  for (const ident of extractIdentifiers(expr)) {
    const entry = tainted.get(ident);
    if (entry) return { variable: ident, entry };
  }
  return null;
}

function parseDestructuredNames(raw: string): string[] {
  const names: string[] = [];
  for (const part of raw.split(',')) {
    const cleaned = part.trim().replace(/^\.\.\./, '');
    if (!cleaned) continue;
    const eq = cleaned.indexOf('=');
    const beforeDefault = (eq >= 0 ? cleaned.slice(0, eq) : cleaned).trim();
    const colon = beforeDefault.indexOf(':');
    const name = (colon >= 0 ? beforeDefault.slice(colon + 1) : beforeDefault).trim();
    if (/^[A-Za-z_$][\w$]{0,40}$/.test(name)) names.push(name);
  }
  return names;
}

/**
 * Scope-aware linear-time Source -> Sink taint flow analyzer operating on `lexed.code`.
 * Tracks variable assignments, destructuring and sanitizer clearing within file/block scopes.
 */
export function extractTaintFlows(
  text: string,
  lexed: LexResult,
  lines: LineIndex,
  base: Omit<IntelLocation, 'line' | 'column'>,
): SinkHit[] {
  if (!lexed.code) return [];
  const codeLines = lexed.code.split('\n');
  const limit = Math.min(codeLines.length, MAX_LINES_TO_TRACE);
  const tainted = new Map<string, TaintEntry>();
  const hits: SinkHit[] = [];
  const seenKeys = new Set<string>();
  let depth = 0;

  for (let i = 0; i < limit; i++) {
    const lineNo = i + 1;
    const line = codeLines[i] ?? '';
    const trimmed = line.trim();

    if (trimmed) {
      const sanitized = SANITIZER_EXPR.test(line);

      // 1. Check sink consumption BEFORE updating assignments on the same line
      if (!sanitized) {
        for (const sink of SINK_DETECTORS) {
          const match = sink.regex.exec(line);
          if (!match) continue;
          const argSlice = sink.extractArg(line, match);
          if (!argSlice.trim()) continue;
          if (SANITIZER_EXPR.test(argSlice)) continue;

          // Ignore setTimeout(() => ..., 100) arrow/function callbacks
          if (
            sink.ruleId === 'taint-code-exec' &&
            sink.label.includes('setTimeout') &&
            /^\s*(?:async\s+)?(?:\([^)]*\)\s*=>|function\b)/.test(argSlice)
          ) {
            continue;
          }

          const ref = findTaintedReference(argSlice, tainted);
          const direct = !ref ? detectDirectSource(argSlice) : null;
          if (!ref && !direct) continue;

          const offset = lines.lineStart(lineNo) + match.index;
          if (hasIgnoreComment(text, offset)) continue;

          const sourceExpr = ref ? ref.entry.sourceExpr : (direct as string);
          const sourceLine = ref ? ref.entry.sourceLine : lineNo;
          const key = `${sink.ruleId}:${lineNo}:${sourceLine}`;
          if (seenKeys.has(key)) continue;
          seenKeys.add(key);

          hits.push({
            ruleId: sink.ruleId,
            title: `Confirmed Source-to-Sink Flow: ${sink.label}`,
            category: 'taint-flow',
            level: 'high',
            snippet: lineAround(text, offset),
            trace: {
              sourceExpr,
              sourceLine,
              sinkLine: lineNo,
              ...(ref ? { variable: ref.variable } : {}),
            },
            location: { ...base, line: lineNo, column: match.index },
          });
          if (hits.length >= MAX_TAINT_FLOWS_PER_FILE) return hits;
        }
      }

      // 2. Track variable declarations, destructuring & reassignments
      const declSimple = DECL_SIMPLE.exec(line);
      if (declSimple?.[1] && declSimple[2]) {
        const varName = declSimple[1];
        const rhs = declSimple[2];
        if (SANITIZER_EXPR.test(rhs)) {
          tainted.delete(varName);
        } else {
          const direct = detectDirectSource(rhs);
          const ref = !direct ? findTaintedReference(rhs, tainted) : null;
          if (direct) {
            tainted.set(varName, { sourceExpr: direct, sourceLine: lineNo, depth });
          } else if (ref) {
            tainted.set(varName, {
              sourceExpr: ref.entry.sourceExpr,
              sourceLine: ref.entry.sourceLine,
              depth,
            });
          }
        }
      } else {
        const declDest = DECL_DESTRUCTURE.exec(line);
        if (declDest?.[1] && declDest[2]) {
          const rhs = declDest[2];
          if (!SANITIZER_EXPR.test(rhs)) {
            const direct = detectDirectSource(rhs);
            const ref = !direct ? findTaintedReference(rhs, tainted) : null;
            if (direct || ref) {
              const sourceExpr = direct ?? ref!.entry.sourceExpr;
              const sourceLine = direct ? lineNo : ref!.entry.sourceLine;
              for (const name of parseDestructuredNames(declDest[1])) {
                tainted.set(name, { sourceExpr, sourceLine, depth });
              }
            }
          }
        } else {
          const assign = ASSIGN_SIMPLE.exec(line);
          if (assign?.[1] && assign[2]) {
            const varName = assign[1];
            const rhs = assign[2];
            if (SANITIZER_EXPR.test(rhs)) {
              tainted.delete(varName);
            } else {
              const direct = detectDirectSource(rhs);
              const ref = !direct ? findTaintedReference(rhs, tainted) : null;
              if (direct) {
                tainted.set(varName, { sourceExpr: direct, sourceLine: lineNo, depth });
              } else if (ref) {
                tainted.set(varName, {
                  sourceExpr: ref.entry.sourceExpr,
                  sourceLine: ref.entry.sourceLine,
                  depth,
                });
              } else if (tainted.has(varName)) {
                tainted.delete(varName);
              }
            }
          }
        }
      }
    }

    // 3. Maintain block scope depth and drop out-of-scope variables on `}`
    for (let c = 0; c < line.length; c++) {
      const ch = line[c];
      if (ch === '{') {
        depth++;
      } else if (ch === '}') {
        for (const [varName, entry] of tainted.entries()) {
          if (entry.depth >= depth && depth > 0) tainted.delete(varName);
        }
        if (depth > 0) depth--;
      }
    }
  }

  return hits;
}
