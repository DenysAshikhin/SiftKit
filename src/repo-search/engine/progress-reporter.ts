import type { RepoSearchProgressEvent } from '../types.js';

export type TokenizeDoneInfo = {
  promptTokenCount: number;
  tokenCountSource?: string;
  tokenizeElapsedMs?: number | null;
  tokenizeRetryCount?: number | null;
  tokenizeTimeoutMs?: number;
  tokenizeRetryMaxWaitMs?: number;
  tokenizeStatus?: string | null;
  tokenizeErrorMessage?: string | null;
};

export class ProgressReporter {
  private readonly onProgress: ((event: RepoSearchProgressEvent) => void) | null;
  private readonly taskId: string;
  private readonly maxTurns: number;
  private readonly taskStartedAt: number;

  constructor(options: {
    onProgress: ((event: RepoSearchProgressEvent) => void) | null;
    taskId: string;
    maxTurns: number;
    taskStartedAt: number;
  }) {
    this.onProgress = options.onProgress;
    this.taskId = options.taskId;
    this.maxTurns = options.maxTurns;
    this.taskStartedAt = options.taskStartedAt;
  }

  get enabled(): boolean {
    return this.onProgress !== null;
  }

  private elapsedMs(): number {
    return Date.now() - this.taskStartedAt;
  }

  private emit(event: RepoSearchProgressEvent): void {
    this.onProgress?.(event);
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

  llmStart(turn: number, promptTokenCount: number): void {
    this.emit({ kind: 'llm_start', turn, maxTurns: this.maxTurns, promptTokenCount, elapsedMs: this.elapsedMs() });
  }

  llmEnd(turn: number, promptTokenCount: number): void {
    this.emit({ kind: 'llm_end', turn, maxTurns: this.maxTurns, promptTokenCount, elapsedMs: this.elapsedMs() });
  }

  thinking(turn: number, thinkingText: string): void {
    this.emit({ kind: 'thinking', turn, maxTurns: this.maxTurns, thinkingText });
  }

  answer(turn: number, answerText: string): void {
    this.emit({ kind: 'answer', turn, maxTurns: this.maxTurns, answerText });
  }

  toolStart(toolCallId: string, turn: number, command: string, promptTokenCount: number): void {
    this.emit({ kind: 'tool_start', toolCallId, turn, maxTurns: this.maxTurns, command, promptTokenCount, elapsedMs: this.elapsedMs() });
  }

  toolResult(options: {
    toolCallId: string;
    turn: number;
    command: string;
    exitCode: number;
    outputSnippet: string;
    outputTokens: number;
    promptTokenCount: number;
  }): void {
    this.emit({ kind: 'tool_result', ...options, maxTurns: this.maxTurns, elapsedMs: this.elapsedMs() });
  }
}
