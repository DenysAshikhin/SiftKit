import type { SiftConfig } from '../../config/index.js';
import { countTokensWithFallbackDetailed, estimateTokenCount } from '../prompt-budget.js';

export type ModelUsageResponse = {
  text?: string;
  thinkingText?: string;
  promptTokens?: number | null;
  completionTokens?: number | null;
  usageThinkingTokens?: number | null;
  promptCacheTokens?: number | null;
  promptEvalTokens?: number | null;
  promptEvalDurationMs?: number | null;
  generationDurationMs?: number | null;
};

export type ResolvedResponseTokens = {
  completionTokens: number;
  thinkingTokens: number;
  completionTokensEstimated: boolean;
  thinkingTokensEstimated: boolean;
};

export type TokenUsageSnapshot = {
  promptTokens: number;
  outputTokens: number;
  toolTokens: number;
  thinkingTokens: number;
  outputTokensEstimatedCount: number;
  thinkingTokensEstimatedCount: number;
  promptCacheTokens: number;
  promptEvalTokens: number;
  promptEvalDurationMs: number;
  generationDurationMs: number;
};

export class TokenUsageTracker {
  private promptTokens = 0;
  private outputTokens = 0;
  private toolTokens = 0;
  private thinkingTokens = 0;
  private outputTokensEstimatedCount = 0;
  private thinkingTokensEstimatedCount = 0;
  private promptCacheTokens = 0;
  private promptEvalTokens = 0;
  private promptEvalDurationMs = 0;
  private generationDurationMs = 0;
  private readonly config: SiftConfig | undefined;

  constructor(config: SiftConfig | undefined, useEstimatedTokensOnly = false) {
    this.config = config;
    this.useEstimatedTokensOnly = useEstimatedTokensOnly;
  }

  private readonly useEstimatedTokensOnly: boolean;

  async recordModelResponse(response: ModelUsageResponse): Promise<ResolvedResponseTokens> {
    if (Number.isFinite(response.promptTokens) && Number(response.promptTokens) >= 0) {
      this.promptTokens += Number(response.promptTokens);
    }
    const completion = await this.resolveTextTokens(response.completionTokens, response.text);
    const thinking = await this.resolveTextTokens(response.usageThinkingTokens, response.thinkingText);
    const completionTokens = completion.tokenCount;
    const thinkingTokens = thinking.tokenCount;
    this.thinkingTokens += thinkingTokens;
    if (thinking.estimated && thinkingTokens > 0) {
      this.thinkingTokensEstimatedCount += 1;
    }
    if (Number.isFinite(response.promptCacheTokens) && Number(response.promptCacheTokens) >= 0) {
      this.promptCacheTokens += Number(response.promptCacheTokens);
    }
    if (Number.isFinite(response.promptEvalTokens) && Number(response.promptEvalTokens) >= 0) {
      this.promptEvalTokens += Number(response.promptEvalTokens);
    }
    if (Number.isFinite(response.promptEvalDurationMs) && Number(response.promptEvalDurationMs) >= 0) {
      this.promptEvalDurationMs += Number(response.promptEvalDurationMs);
    }
    if (Number.isFinite(response.generationDurationMs) && Number(response.generationDurationMs) >= 0) {
      this.generationDurationMs += Number(response.generationDurationMs);
    }
    return {
      completionTokens,
      thinkingTokens,
      completionTokensEstimated: completion.estimated,
      thinkingTokensEstimated: thinking.estimated,
    };
  }

  addOutputTokens(tokens: number, estimated = false): void {
    this.outputTokens += tokens;
    if (estimated && tokens > 0) {
      this.outputTokensEstimatedCount += 1;
    }
  }

  addToolTokens(tokens: number): void {
    this.toolTokens += Math.max(0, Math.ceil(tokens));
  }

  snapshot(): TokenUsageSnapshot {
    return {
      promptTokens: this.promptTokens,
      outputTokens: this.outputTokens,
      toolTokens: this.toolTokens,
      thinkingTokens: this.thinkingTokens,
      outputTokensEstimatedCount: this.outputTokensEstimatedCount,
      thinkingTokensEstimatedCount: this.thinkingTokensEstimatedCount,
      promptCacheTokens: this.promptCacheTokens,
      promptEvalTokens: this.promptEvalTokens,
      promptEvalDurationMs: this.promptEvalDurationMs,
      generationDurationMs: this.generationDurationMs,
    };
  }

  private async resolveTextTokens(explicitTokens: number | null | undefined, text: string | undefined): Promise<{
    tokenCount: number;
    estimated: boolean;
  }> {
    if (Number.isFinite(explicitTokens) && Number(explicitTokens) >= 0) {
      return { tokenCount: Number(explicitTokens), estimated: false };
    }
    const content = String(text || '').trim();
    if (!content) {
      return { tokenCount: 0, estimated: false };
    }
    if (!this.config || this.useEstimatedTokensOnly) {
      return { tokenCount: estimateTokenCount(this.config, content), estimated: true };
    }
    const result = await countTokensWithFallbackDetailed(this.config, content);
    return { tokenCount: result.tokenCount, estimated: result.source !== 'llama.cpp' };
  }
}
