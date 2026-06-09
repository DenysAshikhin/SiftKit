import type { SiftConfig } from '../../config/index.js';
import { estimateTokenCount } from '../prompt-budget.js';

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
};

export type TokenUsageSnapshot = {
  promptTokens: number;
  outputTokens: number;
  toolTokens: number;
  thinkingTokens: number;
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
  private promptCacheTokens = 0;
  private promptEvalTokens = 0;
  private promptEvalDurationMs = 0;
  private generationDurationMs = 0;
  private readonly config: SiftConfig | undefined;

  constructor(config: SiftConfig | undefined) {
    this.config = config;
  }

  recordModelResponse(response: ModelUsageResponse): ResolvedResponseTokens {
    if (Number.isFinite(response.promptTokens) && Number(response.promptTokens) >= 0) {
      this.promptTokens += Number(response.promptTokens);
    }
    const completionTokens = Number.isFinite(response.completionTokens) && Number(response.completionTokens) >= 0
      ? Number(response.completionTokens)
      : (String(response.text || '').trim() ? estimateTokenCount(this.config, String(response.text || '')) : 0);
    const thinkingTokens = Number.isFinite(response.usageThinkingTokens) && Number(response.usageThinkingTokens) >= 0
      ? Number(response.usageThinkingTokens)
      : (String(response.thinkingText || '').trim() ? estimateTokenCount(this.config, String(response.thinkingText || '')) : 0);
    this.thinkingTokens += thinkingTokens;
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
    return { completionTokens, thinkingTokens };
  }

  addOutputTokens(tokens: number): void {
    this.outputTokens += tokens;
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
      promptCacheTokens: this.promptCacheTokens,
      promptEvalTokens: this.promptEvalTokens,
      promptEvalDurationMs: this.promptEvalDurationMs,
      generationDurationMs: this.generationDurationMs,
    };
  }
}
