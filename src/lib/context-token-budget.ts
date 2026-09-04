/**
 * The single context budget every context-aware operation derives from. The only
 * reservation is the headroom compaction needs to summarize a full transcript;
 * generation itself is bounded by whatever the prompt leaves unused.
 */
export const PROMPT_COMPACTION_RESERVE_TOKENS = 15_000;

/** The reserve may never take more than this share of the context window. */
export const PROMPT_COMPACTION_RESERVE_MAX_CONTEXT_RATIO = 0.5;

export type ContextTokenBudget = {
  totalContextTokens: number;
  compactionReserveTokens: number;
  maxPromptTokens: number;
};

function requirePositiveInteger(name: string, value: number): number {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer, got ${value}.`);
  }
  return value;
}

function requireNonNegativeInteger(name: string, value: number): number {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative integer, got ${value}.`);
  }
  return value;
}

export function resolveContextTokenBudget(options: { totalContextTokens: number }): ContextTokenBudget {
  const totalContextTokens = requirePositiveInteger('totalContextTokens', options.totalContextTokens);
  const compactionReserveTokens = Math.max(1, Math.min(
    PROMPT_COMPACTION_RESERVE_TOKENS,
    Math.floor(totalContextTokens * PROMPT_COMPACTION_RESERVE_MAX_CONTEXT_RATIO),
  ));
  return {
    totalContextTokens,
    compactionReserveTokens,
    maxPromptTokens: Math.max(0, totalContextTokens - compactionReserveTokens),
  };
}

/**
 * What the physical window still holds once this prompt is in it, lowered further
 * by an explicit per-operation cap. The compaction reserve bounds how large a
 * *prompt* may grow, not how much a request may generate, so generation is
 * measured against the whole window.
 */
function resolveRemainingWindowTokens(options: {
  totalContextTokens: number;
  promptTokenCount: number;
  operationMaxTokens?: number;
}): number {
  const totalContextTokens = requirePositiveInteger('totalContextTokens', options.totalContextTokens);
  const promptTokenCount = requireNonNegativeInteger('promptTokenCount', options.promptTokenCount);
  const remainingWindowTokens = totalContextTokens - promptTokenCount;
  if (options.operationMaxTokens === undefined) {
    return remainingWindowTokens;
  }
  return Math.min(
    remainingWindowTokens,
    requirePositiveInteger('operationMaxTokens', options.operationMaxTokens),
  );
}

/**
 * The generation limit for one request. A prompt that leaves no room has no
 * generation limit at all and throws: the caller must compact or stop rather than
 * send a request that could only emit a truncated answer.
 */
export function resolveGenerationTokenLimit(options: {
  totalContextTokens: number;
  promptTokenCount: number;
  operationMaxTokens?: number;
}): number {
  const generationTokenLimit = resolveRemainingWindowTokens(options);
  if (generationTokenLimit < 1) {
    throw new Error(
      `A prompt of ${options.promptTokenCount} tokens fills the ${options.totalContextTokens}-token `
        + 'context window; there is no room left to generate.',
    );
  }
  return generationTokenLimit;
}

/**
 * The generation limit for a terminal answer, which is always attempted: repo-search
 * promises a best-effort answer from the evidence it already has, so an over-full
 * transcript still issues the request and the server, not SiftKit, decides it does
 * not fit. Every other path uses resolveGenerationTokenLimit and fails loudly.
 */
export function resolveFinalGenerationTokenLimit(options: {
  totalContextTokens: number;
  promptTokenCount: number;
}): number {
  return Math.max(1, resolveRemainingWindowTokens(options));
}
