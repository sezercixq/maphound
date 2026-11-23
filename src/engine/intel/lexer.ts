/**
 * A small, linear-time JavaScript/TypeScript lexer. It only separates code from string
 * literals, template literals, regular expression literals and comments, which is all the
 * endpoint, route and sink extractors need. No backtracking, no recursion: every character is
 * visited once, so hostile input cannot slow it down. Also good enough for JSX, Vue and
 * Svelte files: an apostrophe in markup ends at the end of its line.
 */

export interface StringToken {
  /** Offset of the opening quote. */
  start: number;
  /** Offset just past the closing quote (or the end of the line when unterminated). */
  end: number;
  /** Decoded value. Template expressions become `{name}` placeholders. */
  value: string;
  quote: '"' | "'" | '`';
  /** Template literal with at least one `${...}` expression. */
  dynamic: boolean;
}

export interface CommentToken {
  start: number;
  end: number;
  /** Text without the `//`, `/*` and `*\/` delimiters. */
  text: string;
}

export interface LexOptions {
  /** Whether to build the blanked `code` string (needed for sink detection, not bundles). */
  needCode?: boolean;
}

export interface LexResult {
  strings: StringToken[];
  comments: CommentToken[];
  /**
   * The input with comment text, string contents and regex bodies replaced by spaces. Quotes
   * and newlines stay, so offsets and line numbers are unchanged and patterns that run on it
   * never match inside a string or a comment.
   */
  code: string;
}

/** Longest string value kept; longer literals are still skipped correctly but truncated. */
const MAX_VALUE = 2_000;

const REGEX_AFTER_WORD = new Set([
  'return',
  'typeof',
  'instanceof',
  'in',
  'of',
  'new',
  'delete',
  'void',
  'throw',
  'case',
  'do',
  'else',
  'yield',
  'await',
]);

const isIdent = (code: number) =>
  (code >= 48 && code <= 57) ||
  (code >= 65 && code <= 90) ||
  (code >= 97 && code <= 122) ||
  code === 36 ||
  code === 95 ||
  code > 127;

const SIMPLE_ESCAPES: Record<string, string> = {
  n: '\n',
  r: '\r',
  t: '\t',
  b: '\b',
  f: '\f',
  v: '\v',
  '0': '\0',
};

/** Short, readable placeholder for a template expression: `${user.id}` -> `{id}`. */
function placeholder(expression: string): string {
  // Only the tail matters; slicing keeps the regex's work bounded on huge expressions.
  const trimmed = expression.trim().slice(-48);
  const match = /([A-Za-z_$][\w$]{0,40})\)?$/.exec(trimmed);
  return `{${match?.[1] ?? 'param'}}`;
}

interface TemplateFrame {
  start: number;
  value: string;
  dynamic: boolean;
  /** Offset where the current `${` expression began. */
  exprStart: number;
  /** Brace depth inside the current expression. */
  depth: number;
}

export function lex(text: string, options: LexOptions = {}): LexResult {
  const strings: StringToken[] = [];
  const comments: CommentToken[] = [];
  const needCode = options.needCode ?? true;
  const parts: string[] = [];
  let copyFrom = 0;
  const blank = (from: number, to: number) => {
    if (!needCode || to <= from || to <= copyFrom) return;
    const safeFrom = Math.max(from, copyFrom);
    if (safeFrom > copyFrom) parts.push(text.slice(copyFrom, safeFrom));
    const slice = text.slice(safeFrom, to);
    if (!slice.includes('\n') && !slice.includes('\r')) {
      parts.push(' '.repeat(to - safeFrom));
    } else {
      parts.push(slice.replace(/[^\r\n]/g, ' '));
    }
    copyFrom = to;
  };
  const templates: TemplateFrame[] = [];
  const n = text.length;
  /** Last significant code character, for the regex-or-division decision. */
  let prev = '';
  let prevWord = '';
  let i = 0;

  const readTemplate = (frame: TemplateFrame) => {
    // Scan template characters until the closing backtick or a `${`.
    while (i < n) {
      const c = text[i] as string;
      if (c === '\\') {
        const next = text[i + 1] ?? '';
        if (frame.value.length < MAX_VALUE) frame.value += SIMPLE_ESCAPES[next] ?? next;
        blank(i, i + 2);
        i += 2;
        continue;
      }
      if (c === '`') {
        templates.pop();
        strings.push({
          start: frame.start,
          end: i + 1,
          value: frame.value,
          quote: '`',
          dynamic: frame.dynamic,
        });
        i++;
        prev = '`';
        prevWord = '';
        return;
      }
      if (c === '$' && text[i + 1] === '{') {
        blank(i, i + 2);
        i += 2;
        frame.exprStart = i;
        frame.depth = 0;
        frame.dynamic = true;
        prev = '{';
        prevWord = '';
        return;
      }
      if (frame.value.length < MAX_VALUE) frame.value += c;
      blank(i, i + 1);
      i++;
    }
    // Unterminated: keep what we have.
    templates.pop();
    strings.push({
      start: frame.start,
      end: n,
      value: frame.value,
      quote: '`',
      dynamic: frame.dynamic,
    });
  };

  while (i < n) {
    const c = text[i] as string;
    const code = text.charCodeAt(i);

    // Inside a template expression: track braces to find its end.
    const frame = templates[templates.length - 1];
    if (frame && frame.exprStart >= 0) {
      if (c === '{') frame.depth++;
      else if (c === '}') {
        if (frame.depth === 0) {
          if (frame.value.length < MAX_VALUE)
            frame.value += placeholder(text.slice(frame.exprStart, i));
          frame.exprStart = -1;
          blank(i, i + 1);
          i++;
          readTemplate(frame);
          continue;
        }
        frame.depth--;
      }
    }

    if (c === '/' && text[i + 1] === '/') {
      const end = text.indexOf('\n', i);
      const stop = end < 0 ? n : end;
      comments.push({ start: i, end: stop, text: text.slice(i + 2, stop) });
      blank(i, stop);
      i = stop;
      continue;
    }
    if (c === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      const stop = end < 0 ? n : end + 2;
      comments.push({ start: i, end: stop, text: text.slice(i + 2, end < 0 ? n : end) });
      blank(i, stop);
      i = stop;
      continue;
    }
    if (c === '"' || c === "'") {
      const start = i;
      let value = '';
      i++;
      while (i < n) {
        const d = text[i] as string;
        if (d === '\\') {
          const next = text[i + 1] ?? '';
          if (value.length < MAX_VALUE) value += SIMPLE_ESCAPES[next] ?? next;
          i += 2;
          continue;
        }
        if (d === c || d === '\n') break;
        if (value.length < MAX_VALUE) value += d;
        i++;
      }
      const closed = text[i] === c;
      const end = closed ? i + 1 : i;
      blank(start + 1, closed ? i : end);
      strings.push({ start, end, value, quote: c, dynamic: false });
      i = end;
      prev = c;
      prevWord = '';
      continue;
    }
    if (c === '`') {
      const created: TemplateFrame = {
        start: i,
        value: '',
        dynamic: false,
        exprStart: -1,
        depth: 0,
      };
      templates.push(created);
      i++;
      readTemplate(created);
      continue;
    }
    if (c === '/') {
      const regexAllowed =
        prev === '' || '(,=:[!&|?{};+-*%<>~^'.includes(prev) || REGEX_AFTER_WORD.has(prevWord);
      if (regexAllowed) {
        const start = i;
        let inClass = false;
        i++;
        while (i < n) {
          const d = text[i] as string;
          if (d === '\\') {
            i += 2;
            continue;
          }
          if (d === '\n') break;
          if (d === '[') inClass = true;
          else if (d === ']') inClass = false;
          else if (d === '/' && !inClass) break;
          i++;
        }
        if (text[i] === '/') {
          blank(start + 1, i);
          i++;
          while (i < n && isIdent(text.charCodeAt(i))) i++;
          prev = '/';
          prevWord = '';
          continue;
        }
        // Not a regex after all (unterminated on this line): treat as division.
        i = start;
      }
      prev = '/';
      prevWord = '';
      i++;
      continue;
    }
    if (isIdent(code)) {
      const start = i;
      while (i < n && isIdent(text.charCodeAt(i))) i++;
      prevWord = text.slice(start, i);
      prev = 'a';
      continue;
    }
    if (c !== ' ' && c !== '\t' && c !== '\n' && c !== '\r') {
      prev = c;
      prevWord = '';
    }
    i++;
  }

  if (needCode && copyFrom < n) parts.push(text.slice(copyFrom));
  return { strings, comments, code: needCode ? parts.join('') : '' };
}

/** Offsets of line starts, for turning offsets into 1-based lines and 0-based columns. */
export class LineIndex {
  private readonly starts: number[] = [0];

  constructor(text: string) {
    for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) this.starts.push(i + 1);
  }

  position(offset: number): { line: number; column: number } {
    let lo = 0;
    let hi = this.starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if ((this.starts[mid] as number) <= offset) lo = mid;
      else hi = mid - 1;
    }
    return { line: lo + 1, column: offset - (this.starts[lo] as number) };
  }

  lineStart(line: number): number {
    return this.starts[line - 1] ?? 0;
  }
}

/** The text of the line containing `offset`, trimmed to at most `max` characters around it. */
export function lineAround(text: string, offset: number, max = 160): string {
  const start = text.lastIndexOf('\n', offset - 1) + 1;
  let end = text.indexOf('\n', offset);
  if (end < 0) end = text.length;
  let from = start;
  let to = end;
  if (to - from > max) {
    from = Math.max(start, offset - Math.floor(max / 3));
    to = Math.min(end, from + max);
  }
  const prefix = from > start ? '…' : '';
  const suffix = to < end ? '…' : '';
  return `${prefix}${text.slice(from, to).trim()}${suffix}`;
}
