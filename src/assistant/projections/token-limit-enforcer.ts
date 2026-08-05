import type { TokenCounter } from '../domain/tokens.js';

export class TokenLimitEnforcer {
  constructor(private readonly tokens: TokenCounter) {}

  async enforce(
    lines: readonly string[],
    tokenLimit: number,
  ): Promise<{ body: string; droppedLines: number }> {
    const working = [...lines];
    let body = working.join('\n');
    let droppedLines = 0;

    while ((await this.tokens.count(body)).tokenCount > tokenLimit) {
      const lastCitedIndex = working.map((line) => line.startsWith('- ')).lastIndexOf(true);
      if (lastCitedIndex < 0) break;
      working.splice(lastCitedIndex, 1);
      droppedLines += 1;
      body = working.join('\n');
    }

    return { body, droppedLines };
  }
}