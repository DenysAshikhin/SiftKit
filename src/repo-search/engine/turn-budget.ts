export const THINKING_BUFFER_RATIO = 0.15;
export const THINKING_BUFFER_MIN_TOKENS = 4000;
export const PER_TOOL_RESULT_RATIO = 0.10;

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

  perToolCapTokens(commandCount: number): number {
    const dynamicRatio = Math.max(PER_TOOL_RESULT_RATIO, commandCount / this.maxTurns);
    return Math.max(1, Math.floor(this.usablePromptTokens * dynamicRatio));
  }

  remainingToolAllowance(promptTokenCount: number, acceptedToolPromptTokensThisTurn: number): number {
    return Math.max(this.usablePromptTokens - promptTokenCount - acceptedToolPromptTokensThisTurn, 0);
  }
}
