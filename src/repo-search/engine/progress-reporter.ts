import type { ActivitySummaryProgressEvent } from '../types.js';
import type { RepoSearchProgressEvent } from '../types.js';
import type { ProgressWriter } from '../../lib/progress-writer.js';
import type { TokenCountSource } from '../prompt-budget.js';
import type { ToolActivityKind, ToolActivitySubject } from '@siftkit/contracts';
import { foldTurnTokenRecords, resolveCharsPerToken } from './turn-token-record.js';
import type { TurnTokenRecord } from './turn-token-record.js';

export type TokenizeDoneInfo = {
  promptTokenCount: number;
  tokenCountSource?: TokenCountSource;
  tokenizeElapsedMs?: number | null;
  tokenizeRetryCount?: number | null;
  tokenizeTimeoutMs?: number;
  tokenizeRetryMaxWaitMs?: number;
  tokenizeStatus?: string | null;
  tokenizeErrorMessage?: string | null;
};

export class ProgressReporter {
  private readonly progressWriter: ProgressWriter<RepoSearchProgressEvent>;
  private readonly taskId: string;
  private readonly maxTurns: number;
  private readonly taskStartedAt: number;

  constructor(options: {
    progressWriter: ProgressWriter<RepoSearchProgressEvent>;
    taskId: string;
    maxTurns: number;
    taskStartedAt: number;
  }) {
    this.progressWriter = options.progressWriter;
    this.taskId = options.taskId;
    this.maxTurns = options.maxTurns;
    this.taskStartedAt = options.taskStartedAt;
  }

  get enabled(): boolean {
    return this.progressWriter.enabled;
  }

  get liveTextEnabled(): boolean {
    return this.progressWriter.enabled && this.progressWriter.wantsLiveText;
  }

  private elapsedMs(): number {
    return Date.now() - this.taskStartedAt;
  }

  private emit(event: RepoSearchProgressEvent): void {
    this.progressWriter.write(event);
  }

  preflightStart(turn: number, promptChars: number): void {
    this.emit({ kind: 'preflight_start', taskId: this.taskId, turn, maxTurns: this.maxTurns, promptChars, elapsedMs: this.elapsedMs() });
  }

  tokenizeStart(turn: number, promptChars: number): void {
    this.emit({
      kind: 'preflight_tokenize_start', taskId: this.taskId, turn, maxTurns: this.maxTurns, promptChars,
      tokenizeTimeoutMs: 10_000, tokenizeRetryMaxWaitMs: 30_000, elapsedMs: this.elapsedMs(),
    });
  }

  tokenizeDone(turn: number, promptChars: number, info: TokenizeDoneInfo): void {
    this.emit({
      kind: 'preflight_tokenize_done', taskId: this.taskId, turn, maxTurns: this.maxTurns, promptChars,
      promptTokenCount: info.promptTokenCount,
      tokenCountSource: info.tokenCountSource,
      tokenizeElapsedMs: info.tokenizeElapsedMs ?? undefined,
      tokenizeRetryCount: info.tokenizeRetryCount ?? undefined,
      tokenizeTimeoutMs: info.tokenizeTimeoutMs,
      tokenizeRetryMaxWaitMs: info.tokenizeRetryMaxWaitMs,
      tokenizeStatus: info.tokenizeStatus ?? undefined,
      errorMessage: info.tokenizeErrorMessage ?? undefined,
      elapsedMs: this.elapsedMs(),
    });
  }

  preflightDone(turn: number, promptChars: number, promptTokenCount: number): void {
    this.emit({ kind: 'preflight_done', taskId: this.taskId, turn, maxTurns: this.maxTurns, promptChars, promptTokenCount, elapsedMs: this.elapsedMs() });
  }

  llmStart(turn: number, promptTokenCount: number, thinkingTokenCount: number): void {
    this.emit({ kind: 'llm_start', turn, maxTurns: this.maxTurns, promptTokenCount, thinkingTokenCount, elapsedMs: this.elapsedMs() });
  }

  llmEnd(turn: number, promptTokenCount: number, thinkingTokenCount: number): void {
    this.emit({ kind: 'llm_end', turn, maxTurns: this.maxTurns, promptTokenCount, thinkingTokenCount, elapsedMs: this.elapsedMs() });
  }

  /** Publishes the closing record for `turn`. The lookup and the fold live here so no caller
   *  can emit a frame that disagrees with another caller's. */
  usageForTurn(turn: number, records: readonly TurnTokenRecord[]): void {
    const record = records.find((entry) => entry.turn === turn);
    if (!record) {
      throw new Error(`Token usage record missing for turn ${turn}.`);
    }
    this.emit({
      kind: 'usage', turn, maxTurns: this.maxTurns, record,
      totals: foldTurnTokenRecords(records),
      charsPerToken: resolveCharsPerToken(records),
      elapsedMs: this.elapsedMs(),
    });
  }

  thinking(turn: number, thinkingText: string): void {
    this.emit({ kind: 'thinking', turn, maxTurns: this.maxTurns, thinkingText });
  }

  narration(turn: number, narrationText: string): void {
    this.emit({ kind: 'narration', turn, maxTurns: this.maxTurns, narrationText });
  }

  answer(turn: number, answerText: string): void {
    this.emit({ kind: 'answer', turn, maxTurns: this.maxTurns, answerText });
  }

  progressUpdate(turn: number, progressText: string): void {
    this.emit({ kind: 'progress_update', taskId: this.taskId, turn, maxTurns: this.maxTurns, progressText, elapsedMs: this.elapsedMs() });
  }

  toolStart(
    toolCallId: string,
    turn: number,
    activityKind: ToolActivityKind,
    activitySubject: ToolActivitySubject,
    command: string,
    promptTokenCount: number,
    thinkingTokenCount: number,
  ): void {
    this.emit({
      kind: 'tool_start', toolCallId, turn, maxTurns: this.maxTurns,
      activityKind, activitySubject, command,
      promptTokenCount, thinkingTokenCount, elapsedMs: this.elapsedMs(),
    });
  }

  toolResult(options: {
    toolCallId: string;
    turn: number;
    activityKind: ToolActivityKind;
    activitySubject: ToolActivitySubject;
    command: string;
    exitCode: number;
    outputSnippet: string;
    outputTokens: number;
    outputTokensEstimated: boolean;
    promptTokenCount: number;
    thinkingTokenCount: number;
  }): void {
    this.emit({
      kind: 'tool_result',
      ...options,
      maxTurns: this.maxTurns,
      elapsedMs: this.elapsedMs(),
    });
  }

  getMaxTurns(): number {
    return this.maxTurns;
  }

  activitySummary(event: ActivitySummaryProgressEvent): void {
    this.emit(event);
  }
}
