import { createEmptyToolTypeStats } from '../../line-read-guidance.js';
import type { ToolTypeStats } from '../../status-server/metrics.js';

export type ToolCallStatsInput = {
  toolType: string;
  resultTextLength: number;
  resultTokenCount: number;
  resultTokenCountEstimated: boolean;
  rawResultTokenCount: number;
  lineReadStats: {
    lineReadCalls?: number;
    lineReadLinesTotal?: number;
    lineReadTokensTotal?: number;
  } | null;
};

export class ToolStatsRecorder {
  private readonly statsByType: Record<string, ToolTypeStats> = {};

  private current(toolType: string): ToolTypeStats {
    return this.statsByType[toolType] || createEmptyToolTypeStats();
  }

  recordFinishRejection(): void {
    const stats = this.current('loop');
    this.statsByType.loop = { ...stats, finishRejections: stats.finishRejections + 1 };
  }

  recordSemanticRepeatReject(toolType: string): void {
    const stats = this.current(toolType);
    this.statsByType[toolType] = { ...stats, semanticRepeatRejects: stats.semanticRepeatRejects + 1 };
  }

  recordForcedFinishFromStagnation(toolType: string): void {
    const stats = this.current(toolType);
    this.statsByType[toolType] = {
      ...stats,
      forcedFinishFromStagnation: Number(stats.forcedFinishFromStagnation || 0) + 1,
    };
  }

  recordToolCall(input: ToolCallStatsInput): void {
    const stats = this.current(input.toolType);
    this.statsByType[input.toolType] = {
      ...stats,
      calls: stats.calls + 1,
      outputCharsTotal: stats.outputCharsTotal + input.resultTextLength,
      outputTokensTotal: stats.outputTokensTotal + Math.max(0, Math.ceil(input.resultTokenCount)),
      outputTokensEstimatedCount: stats.outputTokensEstimatedCount + (input.resultTokenCountEstimated ? 1 : 0),
      lineReadCalls: stats.lineReadCalls + Number(input.lineReadStats?.lineReadCalls || 0),
      lineReadLinesTotal: stats.lineReadLinesTotal + Number(input.lineReadStats?.lineReadLinesTotal || 0),
      lineReadTokensTotal: stats.lineReadTokensTotal + Number(input.lineReadStats?.lineReadTokensTotal || 0),
      promptInsertedTokens: stats.promptInsertedTokens + Math.max(0, Math.ceil(input.resultTokenCount)),
      rawToolResultTokens: stats.rawToolResultTokens + Math.max(0, Math.ceil(input.rawResultTokenCount)),
    };
  }

  recordNovelty(toolType: string, hasNewEvidence: boolean): void {
    const stats = this.current(toolType);
    this.statsByType[toolType] = {
      ...stats,
      newEvidenceCalls: stats.newEvidenceCalls + (hasNewEvidence ? 1 : 0),
      noNewEvidenceCalls: stats.noNewEvidenceCalls + (hasNewEvidence ? 0 : 1),
    };
  }

  get(toolType: string): ToolTypeStats | null {
    return this.statsByType[toolType] || null;
  }

  snapshot(): Record<string, ToolTypeStats> {
    return { ...this.statsByType };
  }
}
