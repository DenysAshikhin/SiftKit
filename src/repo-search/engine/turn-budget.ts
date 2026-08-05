export const THINKING_BUFFER_RATIO = 0.15;
export const THINKING_BUFFER_MIN_TOKENS = 4000;
// Floor on the share of usable prompt tokens one turn's tool results may consume
// in total. The share grows as a run progresses (later calls are better targeted
// and worth more context), and a batch splits whatever share the turn gets — it is
// never granted per call.
export const MIN_TURN_TOOL_RESULT_RATIO = 0.075;

export class TurnBudget {
  readonly totalContextTokens: number;
  readonly thinkingBufferTokens: number;
  readonly usablePromptTokens: number;
  private readonly maxTurns: number;

  constructor(options: { totalContextTokens: number; maxTurns: number }) {
    this.totalContextTokens = Math.max(1, options.totalContextTokens);
    this.maxTurns = Math.max(1, options.maxTurns);
    this.thinkingBufferTokens = Math.max(
      Math.ceil(this.totalContextTokens * THINKING_BUFFER_RATIO),
      THINKING_BUFFER_MIN_TOKENS,
    );
    this.usablePromptTokens = Math.max(this.totalContextTokens - this.thinkingBufferTokens, 0);
  }

  perToolCapTokens(completedCommandCount: number, batchCommandCount: number): number {
    const turnShareRatio = Math.max(MIN_TURN_TOOL_RESULT_RATIO, completedCommandCount / this.maxTurns);
    const calls = Math.max(1, Math.floor(batchCommandCount));
    return Math.max(1, Math.floor((this.usablePromptTokens * turnShareRatio) / calls));
  }

  remainingToolAllowance(promptTokenCount: number, acceptedToolPromptTokensThisTurn: number): number {
    return Math.max(this.usablePromptTokens - promptTokenCount - acceptedToolPromptTokensThisTurn, 0);
  }
}
