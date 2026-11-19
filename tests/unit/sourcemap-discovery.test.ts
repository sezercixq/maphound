import { describe, expect, it } from 'vitest';
import {
  decodeDataUri,
  discoverSourceMap,
  findSourceMappingComment,
  looksLikeSourceMap,
  probeUrlFor,
} from '@/core/sourcemap-discovery';

const noHeaders = { get: () => null };
const headers = (h: Record<string, string>) => ({ get: (n: string) => h[n] ?? null });
const opts = { probe: false, maxBytes: 1024 * 1024 };
const script = 'https://example.com/static/js/main.abc.js?v=1';

describe('findSourceMappingComment', () => {
  it('finds line and block comments, including the legacy @ form', () => {
    expect(findSourceMappingComment('x()\n//# sourceMappingURL=main.js.map\n')).toBe('main.js.map');
    expect(findSourceMappingComment('x()\n//@ sourceMappingURL=old.map')).toBe('old.map');
    expect(findSourceMappingComment('x()\n/*# sourceMappingURL=a.map */')).toBe('a.map');
    expect(findSourceMappingComment('x()\n/*# sourceMappingURL=a.map*/')).toBe('a.map');
  });
  it('skips other trailing comments such as debugId', () => {
    expect(findSourceMappingComment('x()\n//# sourceMappingURL=a.map\n//# debugId=123\n\n')).toBe(
      'a.map',
    );
  });
  it('ignores the marker when code follows it or it sits inside a string', () => {
    expect(findSourceMappingComment('//# sourceMappingURL=a.map\nrun();')).toBeNull();
    expect(findSourceMappingComment('const s = "//# sourceMappingURL=a.map";')).toBeNull();
    expect(findSourceMappingComment('')).toBeNull();
  });
});

describe('discoverSourceMap', () => {
  it('resolves the comment relative to the script', () => {
    expect(
      discoverSourceMap(script, noHeaders, 'a\n//# sourceMappingURL=main.abc.js.map', opts),
    ).toEqual({
      type: 'url',
      url: 'https://example.com/static/js/main.abc.js.map',
      via: 'comment',
    });
  });
  it('prefers SourceMap over X-SourceMap over the comment', () => {
    const text = '//# sourceMappingURL=c.map';
    expect(
      discoverSourceMap(
        script,
        headers({ SourceMap: '/h.map', 'X-SourceMap': 'x.map' }),
        text,
        opts,
      ),
    ).toMatchObject({
      url: 'https://example.com/h.map',
      via: 'header',
    });
    expect(
      discoverSourceMap(script, headers({ 'X-SourceMap': 'x.map' }), text, opts),
    ).toMatchObject({
      url: 'https://example.com/static/js/x.map',
      via: 'header',
    });
  });
  it('decodes data: URI maps', () => {
    const json = '{"version":3,"mappings":"AAAA"}';
    const b64 = Buffer.from(json).toString('base64');
    const ref = discoverSourceMap(
      script,
      noHeaders,
      `a\n//# sourceMappingURL=data:application/json;charset=utf-8;base64,${b64}`,
      opts,
    );
    expect(ref?.type).toBe('inline');
    if (ref?.type === 'inline') expect(new TextDecoder().decode(ref.bytes)).toBe(json);
  });
  it('probes only when enabled', () => {
    expect(discoverSourceMap(script, noHeaders, 'a()', opts)).toBeNull();
    expect(discoverSourceMap(script, noHeaders, 'a()', { ...opts, probe: true })).toEqual({
      type: 'url',
      url: 'https://example.com/static/js/main.abc.js.map',
      via: 'probe',
    });
  });
  it('rejects non-web map URLs', () => {
    expect(
      discoverSourceMap(script, noHeaders, '//# sourceMappingURL=file:///x.map', opts),
    ).toBeNull();
  });
});

describe('decodeDataUri', () => {
  it('handles percent-encoding and enforces the size cap', () => {
    expect(
      new TextDecoder().decode(
        decodeDataUri('data:application/json,%7B%7D', 10) ?? new Uint8Array(),
      ),
    ).toBe('{}');
    const big = Buffer.from('x'.repeat(100)).toString('base64');
    expect(decodeDataUri(`data:application/json;base64,${big}`, 50)).toBeNull();
    expect(decodeDataUri('data:application/json;base64,@@@', 50)).toBeNull();
  });
});

describe('helpers', () => {
  it('builds probe URLs without query', () => {
    expect(probeUrlFor('https://e.com/a.js?v=3#x')).toBe('https://e.com/a.js.map');
  });
  it('sniffs source maps', () => {
    expect(looksLikeSourceMap('{"version":3,"mappings":""}')).toBe(true);
    expect(looksLikeSourceMap(')]}\'\n{"mappings":""}')).toBe(true);
    expect(looksLikeSourceMap('<!doctype html><html>')).toBe(false);
  });
});
