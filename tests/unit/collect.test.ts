import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createUrlBatcher, isScriptResource, normalizeScriptUrl } from '@/core/collect';

describe('normalizeScriptUrl', () => {
  const base = 'https://example.com/app/page';
  it('resolves relative URLs and strips fragments', () => {
    expect(normalizeScriptUrl('../static/a.js#x', base)).toBe('https://example.com/static/a.js');
    expect(normalizeScriptUrl('/b.js?v=2', base)).toBe('https://example.com/b.js?v=2');
  });
  it('ignores inline and non-web scripts', () => {
    expect(normalizeScriptUrl('', base)).toBeNull();
    expect(normalizeScriptUrl(null, base)).toBeNull();
    expect(normalizeScriptUrl('blob:https://example.com/123', base)).toBeNull();
    expect(normalizeScriptUrl('data:text/javascript,1', base)).toBeNull();
    expect(normalizeScriptUrl('chrome-extension://abc/x.js', base)).toBeNull();
  });
});

describe('isScriptResource', () => {
  it('accepts script initiators and .js/.mjs paths', () => {
    expect(isScriptResource({ name: 'https://e.com/chunk', initiatorType: 'script' })).toBe(true);
    expect(isScriptResource({ name: 'https://e.com/x.mjs?v=1', initiatorType: 'other' })).toBe(
      true,
    );
    expect(isScriptResource({ name: 'https://e.com/a.css', initiatorType: 'link' })).toBe(false);
    expect(isScriptResource({ name: 'https://e.com/api/js', initiatorType: 'fetch' })).toBe(false);
  });
});

describe('createUrlBatcher', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('debounces by 500 ms and deduplicates', () => {
    const send = vi.fn();
    const batcher = createUrlBatcher(send);
    batcher.add(['a', 'b']);
    vi.advanceTimersByTime(300);
    batcher.add(['b', 'c']);
    vi.advanceTimersByTime(499);
    expect(send).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith(['a', 'b', 'c']);
    batcher.add(['a', 'c']);
    vi.advanceTimersByTime(1_000);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('splits into messages of at most 200 URLs', () => {
    const send = vi.fn();
    const batcher = createUrlBatcher(send);
    batcher.add(Array.from({ length: 450 }, (_, i) => `u${i}`));
    vi.advanceTimersByTime(500);
    expect(send.mock.calls.map(([urls]) => urls.length)).toEqual([200, 200, 50]);
  });

  it('flushes within maxWait under a constant stream', () => {
    const send = vi.fn();
    const batcher = createUrlBatcher(send, { debounceMs: 500, maxWaitMs: 2_000 });
    for (let i = 0; i < 10; i++) {
      batcher.add([`u${i}`]);
      vi.advanceTimersByTime(400);
    }
    expect(send).toHaveBeenCalled();
    expect(send.mock.calls[0]?.[0]).toHaveLength(5);
  });

  it('caps URLs per page', () => {
    const send = vi.fn();
    const batcher = createUrlBatcher(send, { maxTotal: 3 });
    batcher.add(['a', 'b', 'c', 'd']);
    batcher.flush();
    expect(send).toHaveBeenCalledWith(['a', 'b', 'c']);
    expect(batcher.seen).toBe(3);
  });
});
