import { describe, expect, it } from 'vitest';
import {
  classifyThirdParty,
  effectiveScope,
  extraOriginPatternsToRevoke,
  isInScope,
  isRelatedDomain,
  originPatterns,
  parseOrigin,
  patternsToRevoke,
  registrableDomain,
  siteForUrl,
  sitePatterns,
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
      'https://*.example.com/*',
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

describe('registrable domains (Public Suffix List)', () => {
  it.each([
    ['www.airbnb.com.tr', 'airbnb.com.tr'],
    ['d0a7e.airbnb.com', 'airbnb.com'],
    ['shop.example.co.uk', 'example.co.uk'],
    ['me.github.io', 'me.github.io'],
    ['a.b.vercel.app', 'b.vercel.app'],
    ['github.io', null],
    ['localhost', null],
    ['127.0.0.1', null],
  ])('%s -> %s', (host, domain) => {
    expect(registrableDomain(host)).toBe(domain);
  });

  it('roots subdomain scope at the registrable domain, never at a public suffix', () => {
    expect(originPatterns('https://www.airbnb.com.tr', 'subdomains')).toEqual([
      'https://*.airbnb.com.tr/*',
    ]);
    expect(originPatterns('https://shop.example.co.uk', 'subdomains')).toEqual([
      'https://*.example.co.uk/*',
    ]);
    expect(originPatterns('https://me.github.io', 'subdomains')).toEqual([
      'https://*.me.github.io/*',
    ]);
    expect(effectiveScope('https://github.io', 'subdomains')).toBe('origin');
    const site = { origin: 'https://app.example.com', scope: 'subdomains' as const };
    expect(isInScope('https://cdn.example.com/a.js', site)).toBe(true);
    expect(
      isInScope('https://other.github.io/a.js', {
        origin: 'https://me.github.io',
        scope: 'subdomains',
      }),
    ).toBe(false);
  });

  it('keeps sibling TLDs out of scope but flags them as related', () => {
    const site = { origin: 'https://www.airbnb.com.tr', scope: 'subdomains' as const };
    expect(isInScope('https://d0a7e.airbnb.com/app.js', site)).toBe(false);
    expect(isInScope('https://a0.muscache.com/app.js', site)).toBe(false);
    expect(isRelatedDomain('www.airbnb.com.tr', 'd0a7e.airbnb.com')).toBe(true);
    expect(isRelatedDomain('www.airbnb.com.tr', 'a0.muscache.com')).toBe(false);
    expect(isRelatedDomain('www.airbnb.com.tr', 'static.airbnb.com.tr')).toBe(false); // same domain
  });
});

describe('extra origins', () => {
  const site = {
    origin: 'https://www.airbnb.com.tr',
    scope: 'subdomains' as const,
    extraOrigins: ['https://a0.muscache.com', 'http://localhost:4000'],
  };

  it('are in scope exactly, port and scheme included', () => {
    expect(isInScope('https://a0.muscache.com/airbnb/static/app.js', site)).toBe(true);
    expect(isInScope('https://a1.muscache.com/app.js', site)).toBe(false);
    expect(isInScope('http://a0.muscache.com/app.js', site)).toBe(false);
    expect(isInScope('http://localhost:4000/x.js', site)).toBe(true);
    expect(isInScope('http://localhost:5000/x.js', site)).toBe(false);
  });

  it('do not make their pages part of the site', () => {
    expect(siteForUrl([site], 'https://a0.muscache.com/page')).toBeUndefined();
    expect(siteForUrl([site], 'https://www.airbnb.com.tr/rooms')?.origin).toBe(site.origin);
  });

  it('add their patterns to the site and are revoked with it', () => {
    expect(sitePatterns(site)).toEqual([
      'https://*.airbnb.com.tr/*',
      'https://a0.muscache.com/*',
      'http://localhost/*',
    ]);
    const other = {
      origin: 'https://shop.example',
      scope: 'origin' as const,
      extraOrigins: ['https://a0.muscache.com'],
    };
    expect(patternsToRevoke(site, [other])).toEqual([
      'https://*.airbnb.com.tr/*',
      'http://localhost/*',
    ]);
    expect(patternsToRevoke(site, [])).toEqual(sitePatterns(site));
  });

  it('revoke one extra origin only when nothing else needs its pattern', () => {
    expect(extraOriginPatternsToRevoke('https://a0.muscache.com', site, [])).toEqual([
      'https://a0.muscache.com/*',
    ]);
    const other = {
      origin: 'https://shop.example',
      scope: 'origin' as const,
      extraOrigins: ['https://a0.muscache.com'],
    };
    expect(extraOriginPatternsToRevoke('https://a0.muscache.com', site, [other])).toEqual([]);
    const local = {
      origin: 'http://localhost:3000',
      scope: 'origin' as const,
      extraOrigins: ['http://localhost:4000'],
    };
    expect(extraOriginPatternsToRevoke('http://localhost:4000', local, [])).toEqual([]); // same host as the site
  });
});
