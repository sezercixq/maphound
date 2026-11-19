/**
 * Source map `sources` are attacker controlled. Every path that ends up in a ZIP entry or on
 * disk goes through here: the result is always a relative POSIX path made of safe segments,
 * so no entry can escape its folder (Zip Slip) or collide with reserved names on Windows.
 */

/** Longest segment kept, in UTF-16 code units (filesystems allow 255 bytes). */
export const MAX_SEGMENT_LENGTH = 120;
/** Longest path kept; deeper middle segments are collapsed into `_`. */
export const MAX_PATH_LENGTH = 400;
export const MAX_DEPTH = 32;

const SCHEME = /^[a-z][a-z0-9+.-]*:/i;
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/g;
/** Zero-width and bidi controls: used to spoof file names (`gpj.exe` shown as `exe.jpg`). */
const INVISIBLE = /[­؜᠎​-‏‪-‮⁠-⁤⁦-⁯﻿]/g;
/** Characters Windows forbids in names. `/` and `\` are separators and never reach this. */
const WINDOWS_ILLEGAL = /[<>:"|?*]/g;
/** Look-alike slashes are not separators anywhere, but are confusing in a file name. */
const LOOKALIKE_SLASH = /[⁄∕⧸⧹／＼]/g;
/** CON, PRN, AUX, NUL, COM0-9, LPT0-9 (with superscripts), with or without an extension. */
const WINDOWS_RESERVED =
  /^(?:con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³]|conin\$|conout\$|clock\$)(?:\..*)?$/i;

function safeDecode(value: string): string {
  if (!value.includes('%')) return value;
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function truncateSegment(segment: string): string {
  if (segment.length <= MAX_SEGMENT_LENGTH) return segment;
  const dot = segment.lastIndexOf('.');
  const ext = dot > 0 && segment.length - dot <= 16 ? segment.slice(dot) : '';
  return segment.slice(0, MAX_SEGMENT_LENGTH - ext.length) + ext;
}

/**
 * Clean one path segment. Returns '' for segments that must be dropped
 * (empty, `.`, `..`, or only dots/spaces once cleaned).
 */
export function sanitizeSegment(raw: string): string {
  let segment = raw
    .normalize('NFC')
    .replace(INVISIBLE, '')
    .replace(CONTROL, '')
    .replace(LOOKALIKE_SLASH, '_')
    .replace(/[/\\]/g, '_')
    .replace(WINDOWS_ILLEGAL, '_')
    .trim()
    // Windows strips trailing dots and spaces, which turns `..  ` into `..`.
    .replace(/[. ]+$/, '');
  if (!segment || /^\.+$/.test(segment)) return '';
  if (WINDOWS_RESERVED.test(segment)) segment = `_${segment}`;
  return truncateSegment(segment);
}

/** Remove `scheme:` prefixes (`webpack://`, `vite:`, `file:///`, `C:`) and leading slashes. */
function stripPrefixes(path: string): string {
  let current = path;
  for (let i = 0; i < 4; i++) {
    const before = current;
    current = current.replace(SCHEME, '').replace(/^\/+/, '');
    if (current === before) break;
  }
  return current;
}

/**
 * Turn a source map `sources` entry into a safe relative path.
 *
 * - Percent-decoding happens first, so `%2e%2e%2f` is treated as `../`.
 * - Backslashes are separators; query strings and fragments (webpack loader suffixes) are dropped.
 * - URL schemes, drive letters, UNC prefixes and leading slashes are stripped.
 * - `..` is resolved and clamped at the root, so `../../etc/passwd` becomes `etc/passwd`.
 * - Each segment is cleaned by `sanitizeSegment`.
 */
export function sanitizeSourcePath(raw: unknown, fallback = 'unnamed'): string {
  let path = typeof raw === 'string' ? raw : '';
  path = safeDecode(path.normalize('NFC')).replace(CONTROL, '');
  path = path.replace(/\\/g, '/');
  // Win32 device/long-path prefixes (`\\?\C:\`, `\\.\`) before `?` is read as a query.
  path = path.replace(/^\/\/[?.]\//, '');
  path = path.replace(/[?#].*$/s, '');
  path = stripPrefixes(path);

  const segments: string[] = [];
  for (const raw of path.split('/')) {
    if (raw === '..') {
      segments.pop();
      continue;
    }
    const segment = sanitizeSegment(raw);
    if (segment) segments.push(segment);
  }

  let kept = segments.length > MAX_DEPTH ? segments.slice(-MAX_DEPTH) : segments;
  if (kept.join('/').length > MAX_PATH_LENGTH && kept.length > 2) {
    // Keep the first segment and as much of the tail (the file name) as fits.
    const head = kept[0] as string;
    const tail: string[] = [];
    let length = head.length + 2;
    for (let i = kept.length - 1; i > 0; i--) {
      const segment = kept[i] as string;
      if (tail.length > 0 && length + segment.length + 1 > MAX_PATH_LENGTH) break;
      tail.unshift(segment);
      length += segment.length + 1;
    }
    kept = [head, '_', ...tail];
  }
  const result = kept.join('/');
  return result || sanitizeSegment(fallback) || 'unnamed';
}

/** Insert `-n` before the extension: `index.ts` -> `index-2.ts`, `.env` -> `.env-2`. */
function numbered(name: string, n: number): string {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? `${name.slice(0, dot)}-${n}${name.slice(dot)}` : `${name}-${n}`;
}

/**
 * Hands out unique paths inside one folder. Comparison is case-insensitive (Windows, macOS),
 * and a file never shares a name with a directory: whichever comes second is numbered.
 */
export class PathAllocator {
  private readonly files = new Set<string>();
  private readonly dirs = new Set<string>();
  /** Directory renames, so every file of a renamed directory lands in the same new place. */
  private readonly dirRenames = new Map<string, string>();

  allocate(path: string): string {
    const segments = path.split('/').filter(Boolean);
    const name = segments.pop() ?? 'unnamed';
    let parent = '';
    for (const segment of segments) {
      const wanted = parent ? `${parent}/${segment}` : segment;
      let actual = this.dirRenames.get(wanted.toLowerCase()) ?? wanted;
      if (this.files.has(actual.toLowerCase())) {
        let n = 2;
        const base = parent ? `${parent}/` : '';
        while (this.files.has(`${base}${segment}-${n}`.toLowerCase())) n++;
        actual = `${base}${segment}-${n}`;
        this.dirRenames.set(wanted.toLowerCase(), actual);
      }
      this.dirs.add(actual.toLowerCase());
      parent = actual;
    }
    const base = parent ? `${parent}/` : '';
    let candidate = `${base}${name}`;
    for (
      let n = 2;
      this.files.has(candidate.toLowerCase()) || this.dirs.has(candidate.toLowerCase());
      n++
    ) {
      candidate = `${base}${numbered(name, n)}`;
    }
    this.files.add(candidate.toLowerCase());
    return candidate;
  }
}
