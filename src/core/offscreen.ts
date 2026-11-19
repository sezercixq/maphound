import { browser } from 'wxt/browser';

const OFFSCREEN_PATH = 'offscreen.html';
let creating: Promise<void> | undefined;

/** Create the offscreen document if it does not exist. Safe to call concurrently. */
export async function ensureOffscreen(): Promise<void> {
  const url = browser.runtime.getURL(`/${OFFSCREEN_PATH}`);
  const existing = await browser.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT'],
    documentUrls: [url],
  });
  if (existing.length > 0) return;

  creating ??= browser.offscreen
    .createDocument({
      url: OFFSCREEN_PATH,
      reasons: ['WORKERS'],
      justification: 'Run source map parsing and secret scanning in a worker pool.',
    })
    .finally(() => {
      creating = undefined;
    });
  await creating;
}
