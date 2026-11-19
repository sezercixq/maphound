import { describe, expect, it } from 'vitest';
import {
  classifyThirdParty,
  effectiveScope,
  isInScope,
  originPatterns,
  parseOrigin,
  patternsToRevoke,
  siteForUrl,
} from '@/core/scope';

describe('parseOrigin', () => {
  it('normalizes URLs and bare hosts', () => {
    expect(parseOrigin('https://Example.com/path?q=1#x')).toBe('https://example.com');
    expect(parseOrigin('example.com')).toBe('https://example.com');
    expect(parseOrigin('http://localhost:3000/app')).toBe('http://localhost:3000');
  });
  it('rejects non-web schemes and junk', () => {
    expect(parseOrigin('chrome://extensions')).toBeNull();
    expect(parseOrigin('file:///etc/passwd')).toBeNull();
    expect(parseOrigin('')).toBeNull();
    expect(parseOrigin('http://')).toBeNull();
  });
});

describe('originPatterns', () => {
  it('covers one host for origin scope, without the port', () => {
    expect(originPatterns('https://app.example.com', 'origin')).toEqual([
      'https://app.example.com/*',
    ]);
    expect(originPatterns('http://localhost:3000', 'origin')).toEqual(['http://localhost/*']);
  });
  it('uses a wildcard host for subdomain scope and drops www', () => {
    expect(originPatterns('https://www.example.com', 'subdomains')).toEqual([
      'https://*.example.com/*',
    ]);
    expect(originPatterns('https://app.example.com', 'subdomains')).toEqual([
      'https://*.app.example.com/*',
    ]);
  });
  it('falls back to origin scope where subdomains make no sense', () => {
    expect(effectiveScope('http://127.0.0.1:8080', 'subdomains')).toBe('origin');
    expect(effectiveScope('http://localhost', 'subdomains')).toBe('origin');
    expect(originPatterns('http://127.0.0.1:8080', 'subdomains')).toEqual(['http://127.0.0.1/*']);
  });
});

describe('isInScope', () => {
  const origin = { origin: 'https://example.com', scope: 'origin' as const };
  const subs = { origin: 'https://www.example.com', scope: 'subdomains' as const };

  it('origin scope matches exactly one origin including port and scheme', () => {
    expect(isInScope('https://example.com/static/app.js', origin)).toBe(true);
    expect(isInScope('https://cdn.example.com/app.js', origin)).toBe(false);
    expect(isInScope('http://example.com/app.js', origin)).toBe(false);
    expect(isInScope('https://example.com:8443/app.js', origin)).toBe(false);
  });
  it('subdomain scope matches the root and its subdomains only', () => {
    expect(isInScope('https://example.com/a.js', subs)).toBe(true);
    expect(isInScope('https://static.cdn.example.com/a.js', subs)).toBe(true);
    expect(isInScope('https://evil-example.com/a.js', subs)).toBe(false);
    expect(isInScope('https://example.com.evil.net/a.js', subs)).toBe(false);
  });
  it('rejects malformed URLs', () => {
    expect(isInScope('not a url', origin)).toBe(false);
  });
});

describe('siteForUrl', () => {
  it('prefers an exact origin site over a subdomain site', () => {
    const sites = [
      { origin: 'https://example.com', scope: 'subdomains' as const },
      { origin: 'https://app.example.com', scope: 'origin' as const },
    ];
    expect(siteForUrl(sites, 'https://app.example.com/x')?.origin).toBe('https://app.example.com');
    expect(siteForUrl(sites, 'https://docs.example.com/')?.origin).toBe('https://example.com');
    expect(siteForUrl(sites, 'https://other.com/')).toBeUndefined();
  });
});

describe('patternsToRevoke', () => {
  it('keeps patterns another site still needs', () => {
    const a = { origin: 'http://localhost:3000', scope: 'origin' as const };
    const b = { origin: 'http://localhost:4000', scope: 'origin' as const };
    expect(patternsToRevoke(a, [b])).toEqual([]);
    expect(patternsToRevoke(a, [])).toEqual(['http://localhost/*']);
  });
});

describe('classifyThirdParty', () => {
  it('labels common analytics and CDN hosts', () => {
    expect(classifyThirdParty('https://www.googletagmanager.com/gtm.js')).toBe('analytics');
    expect(classifyThirdParty('https://cdn.jsdelivr.net/npm/x.js')).toBe('cdn');
    expect(classifyThirdParty('https://partner.io/widget.js')).toBe('other');
  });
});
