import type { SiftConfig } from '../../config/index.js';
import { countTokensWithFallbackDetailed } from '../../repo-search/prompt-budget.js';
import type { TokenCount, TokenCounter } from '../domain/tokens.js';

/**
 * Backend tokenizer with the repo's existing estimate fallback (§10.5). `tokenizerId` records
 * which of the two produced the number.
 */
export class BackendTokenCounter implements TokenCounter {
  constructor(private readonly config: SiftConfig) {}

  async count(text: string): Promise<TokenCount> {
    const result = await countTokensWithFallbackDetailed(this.config, text);
    return { tokenCount: result.tokenCount, tokenizerId: result.source };
  }
}