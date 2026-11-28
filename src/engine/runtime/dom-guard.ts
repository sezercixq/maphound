export type RuntimeDomKind = 'postMessage' | 'innerHTML' | 'eval' | 'Function' | 'cookie';

export interface RuntimeDomEvent {
  id: string;
  origin: string;
  kind: RuntimeDomKind;
  detail: string;
  senderOrigin?: string;
  hasListener?: boolean;
  stack: string[];
  count: number;
  lastSeen: number;
}

export function sanitizeStack(rawStack: string | undefined, maxFrames = 3): string[] {
  if (!rawStack) return [];
  const frames: string[] = [];
  for (const line of rawStack.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed === 'Error' || trimmed.includes('runtime-hook')) continue;
    if (trimmed.startsWith('at ') || trimmed.includes('@')) {
      frames.push(trimmed.slice(0, 140));
      if (frames.length >= maxFrames) break;
    }
  }
  return frames;
}

export function summarizePayloadShape(data: unknown): string {
  if (data === null) return 'null';
  if (data === undefined) return 'undefined';
  if (typeof data === 'string') return `string(${data.length} chars)`;
  if (typeof data === 'number' || typeof data === 'boolean') return typeof data;
  if (Array.isArray(data)) return `array(${data.length})`;
  if (typeof data === 'object') {
    const keys = Object.keys(data as Record<string, unknown>).slice(0, 8);
    return keys.length > 0 ? `object{${keys.join(', ')}}` : 'object{}';
  }
  return typeof data;
}

export function buildRuntimeDomEvent(input: {
  origin: string;
  kind: RuntimeDomKind;
  detail: string;
  senderOrigin?: string;
  hasListener?: boolean;
  rawStack?: string;
  now?: number;
}): RuntimeDomEvent {
  const stack = sanitizeStack(input.rawStack);
  const cleanDetail = input.detail.replace(/\s+/g, ' ').trim().slice(0, 180);
  const topFrame = stack[0] ?? 'inline';
  const id = `${input.origin}|${input.kind}|${input.senderOrigin ?? ''}|${topFrame.slice(0, 60)}`;
  return {
    id,
    origin: input.origin,
    kind: input.kind,
    detail: cleanDetail,
    ...(input.senderOrigin ? { senderOrigin: input.senderOrigin } : {}),
    ...(input.hasListener !== undefined ? { hasListener: input.hasListener } : {}),
    stack,
    count: 1,
    lastSeen: input.now ?? Date.now(),
  };
}

export function mergeRuntimeDomEvent(
  existing: RuntimeDomEvent | undefined,
  incoming: RuntimeDomEvent,
): RuntimeDomEvent {
  if (!existing) return incoming;
  return {
    ...existing,
    detail: incoming.detail || existing.detail,
    stack: incoming.stack.length > 0 ? incoming.stack : existing.stack,
    count: existing.count + incoming.count,
    lastSeen: Math.max(existing.lastSeen, incoming.lastSeen),
  };
}
