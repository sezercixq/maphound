/**
 * Aho-Corasick automaton over lowercase keywords: one pass over the text finds every keyword
 * occurrence, case-insensitively for ASCII. Files without any keyword never reach a regex.
 */
export class KeywordIndex {
  private readonly next: Map<number, number>[] = [new Map()];
  private readonly fail: number[] = [0];
  /** Keyword ids that end in each state (including those reached through fail links). */
  private readonly output: number[][] = [[]];
  readonly keywords: readonly string[];

  constructor(keywords: readonly string[]) {
    this.keywords = keywords;
    keywords.forEach((keyword, id) => {
      let state = 0;
      for (let i = 0; i < keyword.length; i++) {
        const code = fold(keyword.charCodeAt(i));
        let target = this.next[state]?.get(code);
        if (target === undefined) {
          target = this.next.length;
          this.next.push(new Map());
          this.fail.push(0);
          this.output.push([]);
          this.next[state]?.set(code, target);
        }
        state = target;
      }
      this.output[state]?.push(id);
    });

    // Breadth-first fail links.
    const queue: number[] = [];
    for (const child of this.next[0]?.values() ?? []) queue.push(child);
    for (let head = 0; head < queue.length; head++) {
      const state = queue[head] as number;
      for (const [code, child] of this.next[state] ?? []) {
        queue.push(child);
        let f = this.fail[state] as number;
        while (f !== 0 && !this.next[f]?.has(code)) f = this.fail[f] as number;
        const target = this.next[f]?.get(code);
        this.fail[child] = target !== undefined && target !== child ? target : 0;
        const inherited = this.output[this.fail[child] as number] ?? [];
        if (inherited.length > 0)
          this.output[child] = [...(this.output[child] ?? []), ...inherited];
      }
    }
  }

  /** Calls `onHit(keywordId, start)` for every occurrence, in text order. */
  scan(
    text: string,
    onHit: (keywordId: number, start: number) => void,
    from = 0,
    to = text.length,
  ): void {
    let state = 0;
    for (let i = from; i < to; i++) {
      const code = fold(text.charCodeAt(i));
      let target = this.next[state]?.get(code);
      while (target === undefined && state !== 0) {
        state = this.fail[state] as number;
        target = this.next[state]?.get(code);
      }
      state = target ?? 0;
      const out = this.output[state];
      if (out && out.length > 0) {
        for (const id of out) onHit(id, i - (this.keywords[id]?.length ?? 1) + 1);
      }
    }
  }
}

/** ASCII lowercase. */
function fold(code: number): number {
  return code >= 65 && code <= 90 ? code + 32 : code;
}
