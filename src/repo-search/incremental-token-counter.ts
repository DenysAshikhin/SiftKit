import type { SiftConfig } from '../config/index.js';
import {
  countTokensWithFallbackDetailed,
  estimateTokenCount,
  type TokenCountSource,
  type TokenCountWithFallbackResult,
} from './prompt-budget.js';

export type IncrementalTokenCountResult = TokenCountWithFallbackResult & {
  /** True when the count includes accumulated delta sums rather than one full tokenize. */
  approximate: boolean;
};

/**
 * Token counter for prompts that grow by appending. When the new text starts
 * with the previously counted text, only the appended tail is tokenized and
 * added to the cached count. Any other change (compaction, mid-transcript
 * rewrites) falls back to a full tokenize. Only server-sourced counts update
 * the cache, so an estimate fallback never poisons later delta sums.
 */
export class IncrementalTokenCounter {
  private lastText: string | null = null;
  private lastCount = 0;
  private lastSource: TokenCountSource = 'estimate';
  private lastApproximate = false;

  async count(
    config: SiftConfig | undefined,
    text: string,
    options: { forceExact?: boolean } = {},
  ): Promise<IncrementalTokenCountResult> {
    if (!config) {
      return { ...(await countTokensWithFallbackDetailed(undefined, text)), approximate: false };
    }
    if (!options.forceExact && this.lastText !== null && text === this.lastText) {
      return {
        tokenCount: this.lastCount,
        source: this.lastSource,
        llamaTokenCount: null,
        approximate: this.lastApproximate,
      };
    }
    if (!options.forceExact && this.lastText !== null && text.startsWith(this.lastText)) {
      const delta = await countTokensWithFallbackDetailed(config, text.slice(this.lastText.length));
      if (delta.source !== 'estimate') {
        this.lastText = text;
        this.lastCount += delta.tokenCount;
        this.lastSource = delta.source;
        this.lastApproximate = true;
        return {
          tokenCount: this.lastCount,
          source: delta.source,
          llamaTokenCount: delta.llamaTokenCount,
          approximate: true,
        };
      }
      // Server unavailable: report the estimate for the full text and keep the
      // cache as-is so the next reachable call can delta from the last good prefix.
      return {
        tokenCount: estimateTokenCount(config, text),
        source: 'estimate',
        llamaTokenCount: delta.llamaTokenCount,
        approximate: true,
      };
    }
    const full = await countTokensWithFallbackDetailed(config, text);
    if (full.source !== 'estimate') {
      this.lastText = text;
      this.lastCount = full.tokenCount;
      this.lastSource = full.source;
      this.lastApproximate = false;
    }
    return { ...full, approximate: false };
  }
}
