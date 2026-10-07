import type { SiftConfig } from '../../config/index.ts';
import { countTokensWithFallbackDetailed } from '../../repo-search/prompt-budget.ts';
import type { TokenCount, TokenCounter } from '../domain/tokens.ts';

/**
 * Backend tokenizer with the repo's existing estimate fallback (§10.5). `tokenizerId` records
 * which of the two produced the number.
 */
export class BackendTokenCounter implements TokenCounter {
  private readonly config: SiftConfig;

  constructor(config: SiftConfig) {
    this.config = config;
  }

  async count(text: string): Promise<TokenCount> {
    const result = await countTokensWithFallbackDetailed(this.config, text);
    return { tokenCount: result.tokenCount, tokenizerId: result.source };
  }
}