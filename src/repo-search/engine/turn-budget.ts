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

// Hard cap on one compaction summary's output, and the output half of the compaction
// reserve below.
export const COMPACTION_SUMMARY_MAX_OUTPUT_TOKENS = 4_000;

// Withheld from the tool-result budget so a summarization request always fits in one
// shot: the summary's own output plus headroom for the summarization instruction and
// the (tool-free) provider overhead of that request.
export const COMPACTION_RESERVE_TOKENS = 10_000;

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
    // Never more than half the prompt budget: on a tiny context window a flat 10k
    // reserve would leave no room for any tool result at all.
    this.compactionReserveTokens = Math.min(
      COMPACTION_RESERVE_TOKENS,
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
