import { browser } from 'wxt/browser';
import type en from '../../public/_locales/en/messages.json';

export type MessageKey = keyof typeof en;

/** chrome.i18n lookup; `$1`..`$9` in a message are filled from `subs`. */
export function t(key: MessageKey, ...subs: (string | number)[]): string {
  return browser.i18n.getMessage(key, subs.map(String)) || key;
}
