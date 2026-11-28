import { getDb } from '@/core/db';
import { mergeWorkspaceState, registrableDomainFor, sitesInWorkspace } from '@/engine/workspace';
import { exportSourceZip } from '@/engine/zip/export';

export type ExportRequest = {
  type: 'export';
  origin: string;
  generator: string;
  includeSecrets: boolean;
  workspaceMode?: boolean;
};
export type ExportMessage =
  | { type: 'data'; chunk: Uint8Array; final: boolean }
  | { type: 'progress'; done: number; total: number; url?: string }
  | {
      type: 'done';
      maps: number;
      files: number;
      bytes: number;
      skippedMaps: number;
      findings: number;
    }
  | { type: 'error'; error: string };

const post = (message: ExportMessage, transfer: Transferable[] = []) =>
  self.postMessage(message, { transfer });

/** Builds the ZIP off the side panel's main thread and streams it back in chunks. */
self.onmessage = async (event: MessageEvent<ExportRequest>) => {
  const { origin, generator, includeSecrets, workspaceMode } = event.data;
  try {
    const db = await getDb();
    const site = await db.get('sites', origin);
    if (!site) throw new Error(`site not enabled: ${origin}`);
    const domain = registrableDomainFor(origin);
    const targetOrigins = workspaceMode
      ? sitesInWorkspace(await db.getAll('sites'), origin).map((s) => s.origin)
      : [origin];
    const originsToRead = targetOrigins.length > 0 ? targetOrigins : [origin];

    const perOrigin = await Promise.all(
      originsToRead.map(async (o) => {
        const [
          maps,
          scripts,
          jobs,
          findings,
          intel,
          pages,
          audits,
          snapshots,
          runtimeApi,
          runtimeDom,
        ] = await Promise.all([
          db.getAllFromIndex('maps', 'by-origin', o),
          db.getAllFromIndex('scripts', 'by-origin', o),
          db.getAllFromIndex('jobs', 'by-origin', o),
          db.getAllFromIndex('findings', 'by-origin', o),
          db.getAllFromIndex('intel', 'by-origin', o),
          db.getAllFromIndex('pages', 'by-origin', o),
          db.getAllFromIndex('audits', 'by-origin', o),
          db.getAllFromIndex('snapshots', 'by-origin', o),
          db.getAllFromIndex('runtimeApi', 'by-origin', o),
          db.getAllFromIndex('runtimeDom', 'by-origin', o),
        ]);
        return {
          maps,
          scripts,
          jobs,
          findings,
          intel,
          pages,
          audits,
          snapshots,
          runtimeApi,
          runtimeDom,
        };
      }),
    );

    const triage = workspaceMode
      ? await db.getAllFromIndex('triage', 'by-domain', domain)
      : await db.getAllFromIndex('triage', 'by-origin', origin);

    const merged = mergeWorkspaceState({
      domain,
      origins: originsToRead,
      maps: perOrigin.flatMap((x) => x.maps),
      scripts: perOrigin.flatMap((x) => x.scripts),
      jobs: perOrigin.flatMap((x) => x.jobs),
      findings: perOrigin.flatMap((x) => x.findings),
      intel: perOrigin.flatMap((x) => x.intel),
      pages: perOrigin.flatMap((x) => x.pages),
      audits: perOrigin.flatMap((x) => x.audits),
      runtimeApi: perOrigin.flatMap((x) => x.runtimeApi),
      runtimeDom: perOrigin.flatMap((x) => x.runtimeDom),
    });

    const stats = await exportSourceZip(
      {
        site,
        maps: merged.maps,
        scripts: merged.scripts,
        jobs: merged.jobs,
        findings: merged.findings,
        intel: perOrigin.flatMap((x) => x.intel),
        pages: merged.pages,
        audits: merged.audits,
        snapshots: perOrigin.flatMap((x) => x.snapshots),
        runtimeApi: merged.runtimeApi,
        runtimeDom: merged.runtimeDom,
        triage,
        ...(workspaceMode
          ? {
              workspace: {
                domain: merged.domain,
                origins: merged.origins,
                visitedPages: merged.visitedPages,
              },
            }
          : {}),
        readBlob: async (hash) => (await db.get('blobs', hash))?.blob,
      },
      {
        generator,
        includeSecrets,
        onData: (chunk, final) => {
          // fflate may reuse buffers: copy before transferring ownership.
          const copy = chunk.slice();
          post({ type: 'data', chunk: copy, final }, [copy.buffer]);
        },
        onProgress: (progress) => post({ type: 'progress', ...progress }),
      },
    );
    post({ type: 'done', ...stats });
  } catch (error) {
    post({ type: 'error', error: error instanceof Error ? error.message : String(error) });
  }
};
