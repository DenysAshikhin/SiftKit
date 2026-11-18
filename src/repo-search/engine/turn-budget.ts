import { resolveContextTokenBudget } from '../../lib/context-token-budget.ts';

// Floor on the share of maxPromptTokens one turn's tool results may consume in
// total. The share grows as a run progresses (later calls are better targeted
// and worth more context), and a batch splits whatever share the turn gets — it is
// never granted per call.
export const MIN_TURN_TOOL_RESULT_RATIO = 0.075;

// Lives here rather than in task-loop-support because it is the denominator of the
// turn share above, and this module has to stay a leaf that any budget consumer can
// import without pulling in the loop.
export const DEFAULT_MAX_TURNS = 45;

// A failed command's output, or the output behind a digest, keeps this small fixed tail (~75-125 lines) instead of
// the per-tool cap: the digest holds every verdict and failure, and runners print their summaries last.
export const OUTPUT_TAIL_CAP_TOKENS = 1_024;

// Below this there is not enough room to write a summary worth resuming from, so the
// run fails loudly instead of emitting a stub that silently loses the conversation.
export const COMPACTION_SUMMARY_MIN_OUTPUT_TOKENS = 512;

// An orchestrator's compaction keeps only its run state, so past this share of its window with no plan
// saved it may only call save_plan: 150k of 200k leaves room to write the plan before compaction.
const ORCHESTRATOR_PLAN_DEADLINE_SHARE = 0.75;

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
  readonly compactionReserveTokens: number;
  readonly maxPromptTokens: number;
  private readonly maxTurns: number;

  constructor(options: { totalContextTokens: number; compactionReserveTokens: number; maxTurns: number }) {
    const context = resolveContextTokenBudget({
      totalContextTokens: options.totalContextTokens,
      compactionReserveTokens: options.compactionReserveTokens,
    });
    this.totalContextTokens = context.totalContextTokens;
    this.compactionReserveTokens = context.compactionReserveTokens;
    this.maxPromptTokens = context.maxPromptTokens;
    this.maxTurns = Math.max(1, options.maxTurns);
  }

  get planDeadlineTokens(): number {
    return Math.floor(this.totalContextTokens * ORCHESTRATOR_PLAN_DEADLINE_SHARE);
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
