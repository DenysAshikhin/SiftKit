import type { SiftConfig } from '../../config/index.js';
import { estimateTokenCount } from '../../lib/token-estimate.js';
import { countTokensWithFallbackDetailed } from '../prompt-budget.js';
import {
  foldTurnTokenRecords,
  type TurnTokenRecord,
} from './turn-token-record.js';

export type ModelUsageResponse = {
  text?: string;
  thinkingText?: string;
  promptCacheTokens?: number | null;
  promptEvalTokens?: number | null;
  promptEvalDurationMs?: number | null;
  generationDurationMs?: number | null;
  speculativeAcceptedTokens?: number | null;
  speculativeGeneratedTokens?: number | null;
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
  speculativeAcceptedTokens: number;
  speculativeGeneratedTokens: number;
};

export class TokenUsageTracker {
  private readonly records: TurnTokenRecord[] = [];
  private promptCacheTokens = 0;
  private promptEvalTokens = 0;
  private promptEvalDurationMs = 0;
  private generationDurationMs = 0;
  private speculativeAcceptedTokens = 0;
  private speculativeGeneratedTokens = 0;
  private readonly config: SiftConfig | undefined;

  constructor(config: SiftConfig | undefined, useEstimatedTokensOnly = false) {
    this.config = config;
    this.useEstimatedTokensOnly = useEstimatedTokensOnly;
  }

  private readonly useEstimatedTokensOnly: boolean;

  private recordFor(turn: number): TurnTokenRecord {
    const existing = this.records.find((record) => record.turn === turn);
    if (existing) {
      return existing;
    }
    const created: TurnTokenRecord = {
      turn,
      promptTokens: 0,
      thinkingTokens: 0,
      outputTokens: 0,
      toolTokens: 0,
      generatedChars: 0,
      thinkingTokensEstimated: false,
      outputTokensEstimated: false,
    };
    this.records.push(created);
    this.records.sort((left, right) => left.turn - right.turn);
    return created;
  }

  turnRecords(): readonly TurnTokenRecord[] {
    return this.records;
  }

  async recordModelResponse(
    response: ModelUsageResponse,
    promptTokenCount: number,
    turn: number,
  ): Promise<ResolvedResponseTokens> {
    const record = this.recordFor(turn);
    if (Number.isFinite(promptTokenCount) && promptTokenCount >= 0) {
      record.promptTokens += promptTokenCount;
    }
    const completion = await this.resolveTextTokens(response.text);
    const thinking = await this.resolveTextTokens(response.thinkingText);
    record.thinkingTokens += thinking.tokenCount;
    record.generatedChars += String(response.text || '').trim().length
      + String(response.thinkingText || '').trim().length;
    if (thinking.estimated && thinking.tokenCount > 0) {
      record.thinkingTokensEstimated = true;
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
    if (Number.isFinite(response.speculativeAcceptedTokens) && Number(response.speculativeAcceptedTokens) >= 0) {
      this.speculativeAcceptedTokens += Number(response.speculativeAcceptedTokens);
    }
    if (Number.isFinite(response.speculativeGeneratedTokens) && Number(response.speculativeGeneratedTokens) >= 0) {
      this.speculativeGeneratedTokens += Number(response.speculativeGeneratedTokens);
    }
    return {
      completionTokens: completion.tokenCount,
      thinkingTokens: thinking.tokenCount,
      completionTokensEstimated: completion.estimated,
      thinkingTokensEstimated: thinking.estimated,
    };
  }

  addOutputTokens(tokens: number, turn: number, estimated = false): void {
    const record = this.recordFor(turn);
    record.outputTokens += tokens;
    if (estimated && tokens > 0) {
      record.outputTokensEstimated = true;
    }
  }

  addToolTokens(tokens: number, turn: number): void {
    this.recordFor(turn).toolTokens += Math.max(0, Math.ceil(tokens));
  }

  snapshot(): TokenUsageSnapshot {
    const totals = foldTurnTokenRecords(this.records);
    return {
      promptTokens: totals.promptTokens,
      outputTokens: totals.outputTokens,
      toolTokens: totals.toolTokens,
      thinkingTokens: totals.thinkingTokens,
      outputTokensEstimatedCount: totals.outputTokensEstimatedCount,
      thinkingTokensEstimatedCount: totals.thinkingTokensEstimatedCount,
      promptCacheTokens: this.promptCacheTokens,
      promptEvalTokens: this.promptEvalTokens,
      promptEvalDurationMs: this.promptEvalDurationMs,
      generationDurationMs: this.generationDurationMs,
      speculativeAcceptedTokens: this.speculativeAcceptedTokens,
      speculativeGeneratedTokens: this.speculativeGeneratedTokens,
    };
  }

  private async resolveTextTokens(text: string | undefined): Promise<{
    tokenCount: number;
    estimated: boolean;
  }> {
    const content = String(text || '').trim();
    if (!content) {
      return { tokenCount: 0, estimated: false };
    }
    if (!this.config || this.useEstimatedTokensOnly) {
      return { tokenCount: estimateTokenCount(this.config, content), estimated: true };
    }
    const result = await countTokensWithFallbackDetailed(this.config, content);
    return { tokenCount: result.tokenCount, estimated: result.source === 'estimate' };
  }
}
