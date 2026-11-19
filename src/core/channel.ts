import type { StoreName } from './db';

const CHANNEL_NAME = 'maphound';

export interface DbChanged {
  store: StoreName;
  origin?: string;
}

/** Notification only. The channel never carries data; readers re-query IndexedDB. */
export function notifyDbChanged(message: DbChanged): void {
  const channel = new BroadcastChannel(CHANNEL_NAME);
  channel.postMessage(message);
  channel.close();
}

export function onDbChanged(callback: (message: DbChanged) => void): () => void {
  const channel = new BroadcastChannel(CHANNEL_NAME);
  channel.onmessage = (event: MessageEvent<DbChanged>) => callback(event.data);
  return () => channel.close();
}
