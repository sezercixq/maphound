import { describe, expect, it } from 'vitest';
import {
  MAX_DEPTH,
  MAX_PATH_LENGTH,
  MAX_SEGMENT_LENGTH,
  PathAllocator,
  sanitizeSegment,
  sanitizeSourcePath,
} from '@/engine/sourcemap/sanitize-path';

const s = sanitizeSourcePath;

describe('bundler prefixes', () => {
  it.each([
    ['webpack:///./src/App.tsx', 'src/App.tsx'],
    ['webpack://my-app/./src/index.js', 'my-app/src/index.js'],
    ['webpack:///webpack/bootstrap', 'webpack/bootstrap'],
    ['webpack:///webpack:/nested.js', 'nested.js'],
    ['vite:///src/main.ts', 'src/main.ts'],
    ['/src/main.ts', 'src/main.ts'],
    ['file:///home/dev/project/src/a.ts', 'home/dev/project/src/a.ts'],
    ['rollup://plugin/virtual.js', 'plugin/virtual.js'],
    ['ng://Module/Comp.html', 'Module/Comp.html'],
    ['src/App.vue?vue&type=script&lang=ts', 'src/App.vue'],
    ['src/a.js#L10', 'src/a.js'],
  ])('%s -> %s', (input, expected) => {
    expect(s(input)).toBe(expected);
  });
});

describe('Zip Slip and traversal', () => {
  it.each([
    ['../../../../etc/passwd', 'etc/passwd'],
    ['src/../../../etc/passwd', 'etc/passwd'],
    ['./../x/./../../y.js', 'y.js'],
    ['/etc/passwd', 'etc/passwd'],
    ['//etc/passwd', 'etc/passwd'],
    ['http://evil.com/../../x.js', 'x.js'],
    ['webpack:///../../../root/.ssh/id_rsa', 'root/.ssh/id_rsa'],
    ['%2e%2e%2f%2e%2e%2fetc%2fpasswd', 'etc/passwd'],
    ['%2E%2E/%2E%2E/boot.ini', 'boot.ini'],
    ['..%5c..%5cwindows%5cwin.ini', 'windows/win.ini'],
    ['..\\..\\..\\Windows\\System32\\cmd.exe', 'Windows/System32/cmd.exe'],
    ['..\u0000/..\u0000/etc/shadow', 'etc/shadow'],
    ['.. /.. /x.js', 'x.js'],
    ['. ./x.js', 'x.js'],
    ['.../....//x.js', 'x.js'],
  ])('%j -> %s', (input, expected) => {
    expect(s(input)).toBe(expected);
  });

  it('decodes only once, leaving double-encoded input as a harmless literal', () => {
    expect(s('%252e%252e%252fetc')).toBe('%2e%2e%2fetc');
  });

  it('survives malformed percent-encoding', () => {
    expect(s('src/100%/a.js')).toBe('src/100%/a.js');
  });
});

describe('Windows drives, UNC and devices', () => {
  it.each([
    ['C:\\Windows\\System32\\drivers\\etc\\hosts', 'Windows/System32/drivers/etc/hosts'],
    ['c:/Users/dev/app.js', 'Users/dev/app.js'],
    ['\\\\server\\share\\secret.js', 'server/share/secret.js'],
    ['\\\\?\\C:\\x.js', 'x.js'],
    ['src/CON', 'src/_CON'],
    ['src/nul.txt', 'src/_nul.txt'],
    ['src/aux.ts', 'src/_aux.ts'],
    ['COM1.js', '_COM1.js'],
    ['LPT9', '_LPT9'],
    ['com\u00b9.txt', '_com\u00b9.txt'],
    ['CONIN$', '_CONIN$'],
    ['src/console.js', 'src/console.js'],
    ['src/auxiliary.ts', 'src/auxiliary.ts'],
    ['src/a<b>:"c|*.js', 'src/a_b___c__.js'],
    ['src/file.js. . .', 'src/file.js'],
    ['src/ spaced .js ', 'src/spaced .js'],
  ])('%j -> %s', (input, expected) => {
    expect(s(input)).toBe(expected);
  });
});

describe('control, invisible and look-alike characters', () => {
  it('strips NUL and other control characters', () => {
    expect(s('src/a\u0000.js')).toBe('src/a.js');
    expect(s('src/\u0007bell\u001f.js')).toBe('src/bell.js');
    expect(s('src/a\u0085b.js')).toBe('src/ab.js');
  });
  it('strips bidi overrides and zero-width characters', () => {
    expect(s('src/\u202egpj.exe')).toBe('src/gpj.exe');
    expect(s('src/a\u200bb\u2066c\ufeff.js')).toBe('src/abc.js');
  });
  it('treats look-alike slashes as plain characters, not separators', () => {
    expect(s('src\uff0f..\uff0fetc')).toBe('src_.._etc');
    expect(s('a\u2215..\u2215b')).toBe('a_.._b');
  });
  it('normalizes to NFC', () => {
    expect(s('cafe\u0301.js')).toBe('caf\u00e9.js');
  });
});

describe('length and depth', () => {
  it('truncates long segments and keeps the extension', () => {
    const out = s(`src/${'a'.repeat(300)}.tsx`);
    const name = out.split('/')[1] ?? '';
    expect(name.length).toBe(MAX_SEGMENT_LENGTH);
    expect(name.endsWith('.tsx')).toBe(true);
  });
  it('caps depth, keeping the deepest segments', () => {
    const out = s(`${'d/'.repeat(100)}file.js`);
    expect(out.split('/')).toHaveLength(MAX_DEPTH);
    expect(out.endsWith('/file.js')).toBe(true);
  });
  it('caps total length, keeping the first segment and the file name', () => {
    const out = s(`${Array.from({ length: 10 }, (_, i) => `${i}`.repeat(100)).join('/')}/name.js`);
    expect(out.length).toBeLessThanOrEqual(MAX_PATH_LENGTH);
    expect(out.startsWith(`${'0'.repeat(100)}/_/`)).toBe(true);
    expect(out.endsWith('/name.js')).toBe(true);
  });
});

describe('empty and junk input', () => {
  it.each([[''], ['/'], ['///'], ['../..'], ['.'], [null], [undefined], [42], [{}]])(
    '%j -> fallback',
    (input) => {
      expect(s(input)).toBe('unnamed');
    },
  );
  it('uses a sanitized fallback', () => {
    expect(s('', 'unnamed-3')).toBe('unnamed-3');
    expect(s('', '../CON')).toBe('.._CON');
  });
});

describe('sanitizeSegment', () => {
  it('never returns a separator, dot segment or reserved name', () => {
    expect(sanitizeSegment('a/b\\c')).toBe('a_b_c');
    expect(sanitizeSegment('..')).toBe('');
    expect(sanitizeSegment('PRN.log')).toBe('_PRN.log');
    expect(sanitizeSegment('127.0.0.1:8080')).toBe('127.0.0.1_8080');
  });
});

/** Invariants that must hold for any input, checked against generated hostile strings. */
describe('fuzz', () => {
  const pieces = [
    '.',
    '..',
    '...',
    '/',
    '//',
    '\\',
    '%2e',
    '%2f',
    '%5c',
    '%25',
    '%00',
    'C:',
    'c:\\',
    'webpack://',
    'file:///',
    '\u0000',
    '\u001f',
    ' ',
    'a',
    'src',
    'CON',
    'nul.js',
    ':',
    '?',
    '#',
    '*',
    '<',
    '|',
    '"',
    '\u202e',
    '\u200b',
    '\uff0f',
    'node_modules',
    '~',
    '$',
    'COM1',
    '%E2%80%AE',
    '\u0301',
    'é',
  ];
  let seed = 1234567;
  const random = () => {
    seed = (seed * 1103515245 + 12345) % 2 ** 31;
    return seed / 2 ** 31;
  };

  it('always yields a safe relative path', () => {
    for (let i = 0; i < 5000; i++) {
      const length = 1 + Math.floor(random() * 12);
      let input = '';
      for (let j = 0; j < length; j++) input += pieces[Math.floor(random() * pieces.length)];
      const out = s(input);
      const context = `input ${JSON.stringify(input)} -> ${JSON.stringify(out)}`;
      expect(out.length, context).toBeGreaterThan(0);
      expect(out.startsWith('/'), context).toBe(false);
      expect(out, context).not.toMatch(
        /[\\\u0000-\u001f\u007f-\u009f<>:"|?*\u202a-\u202e\u200b-\u200f]/,
      );
      for (const segment of out.split('/')) {
        expect(segment, context).not.toBe('');
        expect(segment, context).not.toMatch(/^\.+$/);
        expect(segment, context).not.toMatch(/[. ]$/);
        expect(segment, context).not.toMatch(/^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i);
      }
    }
  });
});

describe('PathAllocator', () => {
  it('numbers duplicates before the extension, case-insensitively', () => {
    const a = new PathAllocator();
    expect(a.allocate('src/a.ts')).toBe('src/a.ts');
    expect(a.allocate('src/a.ts')).toBe('src/a-2.ts');
    expect(a.allocate('src/A.ts')).toBe('src/A-3.ts');
    expect(a.allocate('.env')).toBe('.env');
    expect(a.allocate('.env')).toBe('.env-2');
    expect(a.allocate('index.d.ts')).toBe('index.d.ts');
    expect(a.allocate('index.d.ts')).toBe('index.d-2.ts');
  });

  it('never lets a file and a directory share a path', () => {
    const a = new PathAllocator();
    expect(a.allocate('src/util')).toBe('src/util');
    expect(a.allocate('src/util/x.ts')).toBe('src/util-2/x.ts');
    expect(a.allocate('src/util/y.ts')).toBe('src/util-2/y.ts');
    expect(a.allocate('src/lib/a.ts')).toBe('src/lib/a.ts');
    expect(a.allocate('src/LIB')).toBe('src/LIB-2');
  });
});
