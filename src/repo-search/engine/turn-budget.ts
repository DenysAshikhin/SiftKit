export const THINKING_BUFFER_RATIO = 0.15;
export const THINKING_BUFFER_MIN_TOKENS = 4000;
// Share of usable prompt tokens one turn's tool results may consume in total.
// A batch splits this share; it is not granted per call.
export const TURN_TOOL_RESULT_RATIO = 0.075;

export class TurnBudget {
  readonly totalContextTokens: number;
  readonly thinkingBufferTokens: number;
  readonly usablePromptTokens: number;

  constructor(options: { totalContextTokens: number }) {
    this.totalContextTokens = Math.max(1, options.totalContextTokens);
    this.thinkingBufferTokens = Math.max(
      Math.ceil(this.totalContextTokens * THINKING_BUFFER_RATIO),
      THINKING_BUFFER_MIN_TOKENS,
    );
    this.usablePromptTokens = Math.max(this.totalContextTokens - this.thinkingBufferTokens, 0);
  }

  perToolCapTokens(commandCount: number): number {
    const calls = Math.max(1, Math.floor(commandCount));
    const turnShareTokens = this.usablePromptTokens * TURN_TOOL_RESULT_RATIO;
    return Math.max(1, Math.floor(turnShareTokens / calls));
  }

  remainingToolAllowance(promptTokenCount: number, acceptedToolPromptTokensThisTurn: number): number {
    return Math.max(this.usablePromptTokens - promptTokenCount - acceptedToolPromptTokensThisTurn, 0);
  }
}
