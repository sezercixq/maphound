import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { openMaphoundDb } from '@/core/db';
import {
  buildSiteSnapshot,
  diffMarkdown,
  diffSnapshots,
  MAX_SNAPSHOTS_PER_ORIGIN,
  recordSiteSnapshot,
} from '@/engine/diff';

const ORIGIN = 'https://diff.example';
let seq = 0;

describe('snapshot & diff engine', () => {
  it('computes file, endpoint, route, finding and sink deltas between snapshots', async () => {
    const v1 = await buildSiteSnapshot({
      origin: ORIGIN,
      now: 1_000,
      maps: [
        {
          id: 'm1',
          hash: 'h1',
          scriptHash: 's1',
          origin: ORIGIN,
          url: `${ORIGIN}/app.js.map`,
          indexed: false,
          sourceCount: 2,
          fileCount: 2,
          withContent: 2,
          missingContent: 0,
          vendorCount: 0,
          totalBytes: 200,
          hasSourcesContent: true,
          partial: false,
          partialReasons: [],
          warnings: [],
          files: [
            { path: 'src/a.ts', size: 100, vendor: false },
            { path: 'src/old.ts', size: 50, vendor: false },
          ],
          createdAt: 0,
        },
      ],
      scripts: [],
      findings: [
        {
          id: `${ORIGIN}|stripe|h1`,
          ruleId: 'stripe-live-secret-key',
          ruleName: 'Stripe live secret key',
          severity: 'critical',
          confidence: 'high',
          origin: ORIGIN,
          scriptHash: 's1',
          file: 'src/old.ts',
          line: 4,
          column: 2,
          locationKind: 'source',
          preview: 'sk_l…1234',
          snippet: '',
          secretHash: 'h1',
          secret: 'raw_secret_never_stored_in_snapshot',
          occurrences: 1,
          locations: [],
          references: [],
          createdAt: 0,
          updatedAt: 0,
        },
      ],
      intel: [
        {
          id: `${ORIGIN}|s1`,
          origin: ORIGIN,
          scriptHash: 's1',
          scriptUrl: `${ORIGIN}/app.js`,
          endpoints: [
            {
              value: '/api/v1/legacy',
              category: 'api',
              methods: ['GET'],
              dynamic: false,
              locations: [],
            },
          ],
          routes: [{ path: '/legacy', kind: 'definition', locations: [] }],
          comments: [],
          sinks: [],
          truncated: false,
          updatedAt: 0,
        },
      ],
      pages: [],
    });

    const v2 = await buildSiteSnapshot({
      origin: ORIGIN,
      now: 60_000,
      maps: [
        {
          id: 'm2',
          hash: 'h2',
          scriptHash: 's2',
          origin: ORIGIN,
          url: `${ORIGIN}/app.js.map`,
          indexed: false,
          sourceCount: 2,
          fileCount: 2,
          withContent: 2,
          missingContent: 0,
          vendorCount: 0,
          totalBytes: 240,
          hasSourcesContent: true,
          partial: false,
          partialReasons: [],
          warnings: [],
          files: [
            { path: 'src/a.ts', size: 120, vendor: false },
            { path: 'src/admin.ts', size: 80, vendor: false },
          ],
          createdAt: 0,
        },
      ],
      scripts: [],
      findings: [],
      intel: [
        {
          id: `${ORIGIN}|s2`,
          origin: ORIGIN,
          scriptHash: 's2',
          scriptUrl: `${ORIGIN}/app.js`,
          endpoints: [
            {
              value: '/internal/admin',
              category: 'admin',
              methods: ['POST'],
              dynamic: false,
              locations: [],
            },
          ],
          routes: [{ path: '/admin', kind: 'definition', locations: [] }],
          comments: [],
          sinks: [
            {
              ruleId: 'code-eval',
              title: 'Dynamic eval() call',
              category: 'code-injection',
              level: 'high',
              snippet: 'eval(x)',
              location: {
                file: 'src/admin.ts',
                line: 9,
                column: 2,
                kind: 'source',
                scriptUrl: `${ORIGIN}/app.js`,
              },
            },
          ],
          truncated: false,
          updatedAt: 0,
        },
      ],
      pages: [],
    });

    expect(JSON.stringify(v1)).not.toContain('raw_secret_never_stored_in_snapshot');
    const diff = diffSnapshots(v1, v2);
    expect(diff.hasChanges).toBe(true);
    expect(diff.files.added.map((f) => f.path)).toEqual(['src/admin.ts']);
    expect(diff.files.removed.map((f) => f.path)).toEqual(['src/old.ts']);
    expect(diff.files.modified).toEqual([
      { path: 'src/a.ts', previousSize: 100, currentSize: 120 },
    ]);
    expect(diff.endpoints).toEqual({ added: ['/internal/admin'], removed: ['/api/v1/legacy'] });
    expect(diff.routes).toEqual({ added: ['/admin'], removed: ['/legacy'] });
    expect(diff.findings.resolved).toHaveLength(1);
    expect(diff.sinks.added).toHaveLength(1);

    const md = diffMarkdown(diff, {
      origin: ORIGIN,
      generator: 'MapHound test',
      exportedAt: '2026-11-23T13:00:00Z',
    });
    expect(md).toContain('# MapHound version diff');
    expect(md).toContain('`src/admin.ts`');
    expect(md).toContain('`/internal/admin`');
    expect(md).toContain('Stripe live secret key');
  });

  it('merges within window, respects freeze/forceNew, and caps snapshots per origin', async () => {
    const db = await openMaphoundDb(`diff-${seq++}`);
    await db.put('scripts', {
      hash: 's1',
      urls: [`${ORIGIN}/a.js`],
      origin: ORIGIN,
      size: 10,
      sourceMapRef: null,
      status: 'scanned',
      lastAccess: 0,
    });
    const first = await recordSiteSnapshot(db, ORIGIN, { now: 1_000 });
    expect(first).not.toBeNull();

    // Update within 30 s window updates in place instead of creating snapshot #2.
    await db.put('scripts', {
      hash: 's2',
      urls: [`${ORIGIN}/b.js`],
      origin: ORIGIN,
      size: 20,
      sourceMapRef: null,
      status: 'scanned',
      lastAccess: 0,
    });
    await recordSiteSnapshot(db, ORIGIN, { now: 5_000 });
    expect(await db.countFromIndex('snapshots', 'by-origin', ORIGIN)).toBe(1);

    // Freeze baseline and mutate again -> creates snapshot #2.
    await recordSiteSnapshot(db, ORIGIN, { freezeLatest: true });
    for (let i = 3; i <= MAX_SNAPSHOTS_PER_ORIGIN + 5; i++) {
      await db.put('scripts', {
        hash: `s${i}`,
        urls: [`${ORIGIN}/${i}.js`],
        origin: ORIGIN,
        size: i,
        sourceMapRef: null,
        status: 'scanned',
        lastAccess: 0,
      });
      await recordSiteSnapshot(db, ORIGIN, { now: 10_000 + i * 40_000, forceNew: true });
    }
    expect(await db.countFromIndex('snapshots', 'by-origin', ORIGIN)).toBe(
      MAX_SNAPSHOTS_PER_ORIGIN,
    );
  });
});
