import type { SiftConfig } from '../../config/index.js';
import { resolveContextTokenBudget } from '../../lib/response-reserve.js';

// Floor on the share of maxPromptTokens one turn's tool results may consume in
// total. The share grows as a run progresses (later calls are better targeted
// and worth more context), and a batch splits whatever share the turn gets — it is
// never granted per call.
export const MIN_TURN_TOOL_RESULT_RATIO = 0.075;

// Lives here rather than in task-loop-support because it is the denominator of the
// turn share above, and this module has to stay a leaf that any budget consumer can
// import without pulling in the loop.
export const DEFAULT_MAX_TURNS = 45;

// A failing command's tail is still evidence — test runners and compilers print
// their verdicts and failure summaries last — but failure dumps are low-density,
// so the kept tail gets a small fixed budget instead of the growing per-tool cap.
// ~75-125 lines: enough for a runner summary plus failing-test names, never
// enough for repeated failures to starve the remaining allowance.
export const FAILED_COMMAND_TAIL_CAP_TOKENS = 1_024;

// Below this there is not enough room to write a summary worth resuming from, so the
// run fails loudly instead of emitting a stub that silently loses the conversation.
export const COMPACTION_SUMMARY_MIN_OUTPUT_TOKENS = 512;

/**
 * Splits a compaction generation ceiling into a thinking cap and an output share.
 * The output share is a floor internal to the response reserve, not a cap: it
 * guarantees the continuation a minimum, while unspent thinking flows back to the
 * summary. It reserves nothing on the prompt side.
 */
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

/**
 * What a tool result may occupy, resolved before the tool runs. `exhausted` means the
 * result could not be represented in the transcript at all, so the tool must not execute.
 */
export type ToolResultCapacity =
  | AvailableToolResultCapacity
  | { kind: 'exhausted' };

export type AvailableToolResultCapacity = {
  kind: 'available';
  perToolCapTokens: number;
  remainingTokenAllowance: number;
};

export class TurnBudget {
  readonly totalContextTokens: number;
  readonly responseReserveTokens: number;
  readonly maxPromptTokens: number;
  private readonly maxTurns: number;

  constructor(options: { totalContextTokens: number; maxTurns: number; config: SiftConfig | null | undefined }) {
    const context = resolveContextTokenBudget({
      totalContextTokens: options.totalContextTokens,
      config: options.config,
    });
    this.totalContextTokens = context.totalContextTokens;
    this.responseReserveTokens = context.responseReserveTokens;
    this.maxPromptTokens = context.maxPromptTokens;
    this.maxTurns = Math.max(1, options.maxTurns);
  }

  perToolCapTokens(completedCommandCount: number, batchCommandCount: number): number {
    const turnShareRatio = Math.max(MIN_TURN_TOOL_RESULT_RATIO, completedCommandCount / this.maxTurns);
    const calls = Math.max(1, Math.floor(batchCommandCount));
    return Math.max(1, Math.floor((this.maxPromptTokens * turnShareRatio) / calls));
  }

  remainingToolAllowance(promptTokenCount: number, acceptedToolPromptTokensThisTurn: number): number {
    return Math.max(this.maxPromptTokens - promptTokenCount - acceptedToolPromptTokensThisTurn, 0);
  }

  resolveToolResultCapacity(options: {
    promptTokenCount: number;
    acceptedToolPromptTokensThisTurn: number;
    completedCommandCount: number;
    batchCommandCount: number;
  }): ToolResultCapacity {
    const perToolCapTokens = this.perToolCapTokens(options.completedCommandCount, options.batchCommandCount);
    const remainingTokenAllowance = this.remainingToolAllowance(
      options.promptTokenCount,
      options.acceptedToolPromptTokensThisTurn,
    );
    if (remainingTokenAllowance === 0) {
      return { kind: 'exhausted' };
    }
    return { kind: 'available', perToolCapTokens, remainingTokenAllowance };
  }
}
