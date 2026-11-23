import { describe, expect, it } from 'vitest';
import {
  analyzeSourceFile,
  buildOsintLinks,
  extractSourcePathLeaks,
  mergeScriptIntel,
  osintMarkdown,
} from '@/engine/intel';

describe('passive OSINT extractor', () => {
  it('extracts cloud storage, active-domain subdomains, internal IPs, attribution and telemetry offline', () => {
    const code = [
      'const s3Bucket = "https://acme-assets.s3.us-east-1.amazonaws.com/logo.png";',
      'const s3Uri = "s3://acme-backups/daily";',
      'const gcs = "https://storage.googleapis.com/acme-public-media/a.json";',
      'const firebase = "https://acme-prod.firebaseio.com/v1";',
      'const azure = "https://acmevault01.blob.core.windows.net/exports";',
      'const r2 = "https://acme-edge.r2.cloudflarestorage.com/static";',
      'const stagingApi = "https://staging-api.acme-corp.example/v2";',
      'const devAdmin = "https://admin.acme-corp.example/login";',
      'const sameRoot = "https://app.acme-corp.example/health";',
      'const realPrivate = "http://10.24.8.15:8080/internal";',
      'const fakePrivate = "http://192.168.1.1/router";',
      'const clusterHost = "http://billing-svc.prod.svc.cluster.local/rpc";',
      'const corpEmail = "security@acme-corp.example";',
      'const noiseEmail = "example@acme-corp.example";',
      'const sentry = "https://9a1b2c3d4e5f6789abcdef0123456789@o42.ingest.sentry.io/987654";',
      'const gitRepo = "https://github.com/acme-corp/checkout-web";',
      'const jira = "https://acme-eng.atlassian.net/browse/PAY-412";',
      'const ga4 = "G-MAPHOUND01";',
      'const gtm = "GTM-ABC1234";',
      'const posthog = "phc_1234567890abcdefghijklmnop";',
      'analytics.load("segWriteKey9876543210");',
      'const intercom = { app_id: "ab12cd34" };',
      'const auth0Domain = "acme-corp.us.auth0.com";',
      '// Built from C:\\Users\\developer\\checkout-web',
    ].join('\n');

    const intel = analyzeSourceFile(
      code,
      { file: 'src/config.ts', kind: 'source', scriptUrl: 'https://app.acme-corp.example/app.js' },
      { siteOrigin: 'https://app.acme-corp.example' },
    );

    const values = (intel.osint ?? []).map((h) => `${h.kind}:${h.value}`);
    expect(values).toContain('AWS S3 Bucket:s3://acme-assets');
    expect(values).toContain('AWS S3 Bucket:s3://acme-backups');
    expect(values).toContain('GCS Bucket:gs://acme-public-media');
    expect(values).toContain('Firebase Project:acme-prod.firebaseio.com');
    expect(values).toContain('Azure Blob Storage:acmevault01.blob.core.windows.net/exports');
    expect(values).toContain('Cloudflare R2:acme-edge/static');
    expect(values).toContain('Subdomain Reference:staging-api.acme-corp.example');
    expect(values).toContain('Subdomain Reference:admin.acme-corp.example');
    expect(values).not.toContain('Subdomain Reference:app.acme-corp.example');
    expect(values).toContain('Private IPv4:10.24.8.15:8080');
    expect(values).not.toContain('Private IPv4:192.168.1.1');
    expect(values).toContain('Internal Host:billing-svc.prod.svc.cluster.local');
    expect(values).toContain('Corporate Email:security@acme-corp.example');
    expect(values).not.toContain('Corporate Email:example@acme-corp.example');
    expect(values).toContain('Repository Reference:github.com/acme-corp/checkout-web');
    expect(values).toContain('Atlassian Workspace:acme-eng.atlassian.net');
    expect(values).toContain('Google Analytics 4:G-MAPHOUND01');
    expect(values).toContain('Google Tag Manager:GTM-ABC1234');
    expect(values).toContain('Intercom App ID:ab12cd34');
    expect(values).toContain('Auth0 Tenant:acme-corp.us.auth0.com');
    expect(values).toContain('Windows Home Path:C:\\Users\\d***r\\checkout-web');

    // Sensitive tokens (Sentry DSN key, PostHog, Segment write key) are masked.
    const serialized = JSON.stringify(intel.osint);
    expect(serialized).not.toContain('9a1b2c3d4e5f6789abcdef0123456789');
    expect(serialized).not.toContain('phc_1234567890abcdefghijklmnop');
    expect(serialized).not.toContain('segWriteKey9876543210');
    expect(serialized).not.toContain('Users\\developer');
  });

  it('masks personal usernames in source map build paths and deduplicates results', () => {
    const leaks = extractSourcePathLeaks(
      [
        'webpack:///Users/alice/repos/payments-ui/src/index.ts',
        'webpack:///Users/alice/repos/payments-ui/src/utils.ts',
        '/home/jenkins-bot/checkout/app.ts',
      ],
      'https://acme.example/app.js',
      'https://acme.example/app.js.map',
    );
    expect(leaks.map((h) => h.value)).toEqual(['/home/j***t/checkout', '/Users/a***e/repos']);
    expect(JSON.stringify(leaks)).not.toContain('alice');
    expect(JSON.stringify(leaks)).not.toContain('jenkins-bot');
  });

  it('renders OSINT.md and safely builds 1-click OSINT & Dork links', () => {
    const publicLinks = buildOsintLinks('https://app.example.co.uk:8443');
    expect(publicLinks.domain).toBe('example.co.uk');
    expect(publicLinks.links.find((l) => l.id === 'crtsh')?.url).toBe(
      'https://crt.sh/?q=%25.example.co.uk',
    );
    expect(publicLinks.links.find((l) => l.id === 'wayback')?.url).toBe(
      'https://web.archive.org/web/*/example.co.uk/*',
    );
    expect(publicLinks.links.find((l) => l.id === 'urlscan')?.url).toBe(
      'https://urlscan.io/search/#domain:example.co.uk',
    );
    expect(publicLinks.links.filter((l) => l.group === 'dorks')).toHaveLength(4);

    expect(buildOsintLinks('http://127.0.0.1:8080')).toEqual({ domain: null, links: [] });

    const merged = mergeScriptIntel([
      analyzeSourceFile(
        'const g = "G-TEST12345";',
        { file: 'src/a.ts', kind: 'source', scriptUrl: 'https://example.co.uk/a.js' },
        { siteOrigin: 'https://example.co.uk' },
      ),
    ]);
    const md = osintMarkdown(merged.osint ?? [], {
      origin: 'https://example.co.uk',
      generator: 'MapHound test',
      exportedAt: '2026-11-23T12:00:00Z',
    });
    expect(md).toContain('# MapHound passive OSINT: https://example.co.uk');
    expect(md).toContain('No external requests were made.');
    expect(md).toContain('`G-TEST12345`');
  });
});
