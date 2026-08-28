import type { SiftConfig } from '../../config/index.js';
import { computeResponseReserveTokens } from '../../lib/response-reserve.js';

// Floor on the share of usable prompt tokens one turn's tool results may consume
// in total. The share grows as a run progresses (later calls are better targeted
// and worth more context), and a batch splits whatever share the turn gets — it is
// never granted per call.
export const MIN_TURN_TOOL_RESULT_RATIO = 0.075;

// Lives here rather than in task-loop-support because it is the denominator of the
// turn share above, and this module has to stay a leaf that any budget consumer can
// import without pulling in the loop.
export const DEFAULT_MAX_TURNS = 45;

// Below this there is not enough room to write a summary worth resuming from, so the
// run fails loudly instead of emitting a stub that silently loses the conversation.
export const COMPACTION_SUMMARY_MIN_OUTPUT_TOKENS = 512;

// Room for the summarization instruction and the (tool-free) provider overhead of the
// summarization request, on top of the summary's own output.
export const COMPACTION_PROMPT_HEADROOM_TOKENS = 6_000;

export function splitCompactionGenerationTokens(totalTokens: number): {
  totalTokens: number;
  reasoningTokens: number;
  outputTokens: number;
} {
  const normalizedTotal = Math.max(0, Math.floor(Number(totalTokens) || 0));
  const outputTokens = Math.floor(normalizedTotal / 3);
  return {
    totalTokens: normalizedTotal,
    reasoningTokens: normalizedTotal - outputTokens,
    outputTokens,
  };
}

export class TurnBudget {
  readonly totalContextTokens: number;
  readonly responseReserveTokens: number;
  readonly compactionReserveTokens: number;
  readonly usablePromptTokens: number;
  private readonly maxTurns: number;

  constructor(options: { totalContextTokens: number; maxTurns: number; config: SiftConfig | null | undefined }) {
    this.totalContextTokens = Math.max(1, Math.floor(Number(options.totalContextTokens) || 0));
    this.maxTurns = Math.max(1, options.maxTurns);
    this.responseReserveTokens = computeResponseReserveTokens({
      totalContextTokens: this.totalContextTokens,
      config: options.config,
    });
    const promptTokensBeforeCompactionReserve = Math.max(this.totalContextTokens - this.responseReserveTokens, 0);
    const summaryOutputTokens = splitCompactionGenerationTokens(this.responseReserveTokens).outputTokens;
    // Never more than half the prompt budget: on a tiny context window the summary
    // reserve would otherwise leave no room for any tool result at all.
    this.compactionReserveTokens = Math.min(
      summaryOutputTokens + COMPACTION_PROMPT_HEADROOM_TOKENS,
      Math.floor(promptTokensBeforeCompactionReserve / 2),
    );
    this.usablePromptTokens = Math.max(promptTokensBeforeCompactionReserve - this.compactionReserveTokens, 0);
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
