import type { TokenCounter } from '../domain/tokens.js';

export class TokenLimitEnforcer {
  constructor(private readonly tokens: TokenCounter) {}

  async enforce(
    lines: readonly string[],
    tokenLimit: number,
  ): Promise<{ body: string; droppedLines: number }> {
    const citedIndices: number[] = [];
    for (const [index, line] of lines.entries()) {
      if (line.startsWith('- ')) citedIndices.push(index);
    }
    const bodyFor = (dropped: number): string => {
      if (dropped === 0) return lines.join('\n');
      const removed = new Set(citedIndices.slice(citedIndices.length - dropped));
      return lines.filter((_, index) => !removed.has(index)).join('\n');
    };
    const fits = async (dropped: number): Promise<boolean> => (
      (await this.tokens.count(bodyFor(dropped))).tokenCount <= tokenLimit
    );

    if (await fits(0)) return { body: bodyFor(0), droppedLines: 0 };
    if (citedIndices.length === 0) return { body: bodyFor(0), droppedLines: 0 };

    // Token count is monotone in the drop count, so the minimal sufficient drop is found by
    // binary search: O(log n) tokenizer calls instead of one per dropped line. When even
    // dropping every cited line does not fit, all of them are dropped — the same terminal
    // state the old one-at-a-time loop reached.
    let low = 1;
    let high = citedIndices.length;
    let dropped = citedIndices.length;
    while (low <= high) {
      const mid = Math.floor((low + high) / 2);
      if (await fits(mid)) {
        dropped = mid;
        high = mid - 1;
      } else {
        low = mid + 1;
      }
    }
    return { body: bodyFor(dropped), droppedLines: dropped };
  }
}
