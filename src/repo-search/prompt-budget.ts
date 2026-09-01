import {
  getActiveInferenceBackend,
  type SiftConfig,
} from '../config/index.js';
import { estimateTokenCount } from '../lib/token-estimate.js';
import { InferenceBackendIdSchema } from '../config/types.js';
import { z } from '../lib/zod.js';
import {
  DEFAULT_LLAMA_CPP_TOKENIZE_RETRY_MAX_WAIT_MS,
  DEFAULT_LLAMA_CPP_TOKENIZE_TIMEOUT_MS,
  countLlamaCppTokensDetailed,
  type CountLlamaCppTokensOptions,
  type LlamaCppTokenCountResult,
} from '../providers/llama-cpp.js';
import type { WirePrompt } from './wire-prompt.js';
import { SIFT_IMAGE_TOKEN_ESTIMATE } from '../config/constants.js';

/**
 * Where a token count came from: the engine that tokenized it, or the local
 * characters-per-token estimate when no server count was available.
 */
export const TokenCountSourceSchema = z.union([InferenceBackendIdSchema, z.literal('estimate')]);
export type TokenCountSource = z.infer<typeof TokenCountSourceSchema>;

export type TokenCountWithFallbackResult = {
  tokenCount: number;
  source: TokenCountSource;
  llamaTokenCount: LlamaCppTokenCountResult | null;
};

export async function countTokensWithFallbackDetailed(
  config: SiftConfig | undefined,
  text: string,
  options: CountLlamaCppTokensOptions = {},
): Promise<TokenCountWithFallbackResult> {
  if (config) {
    const llamaTokenCount = await countLlamaCppTokensDetailed(config, text, options);
    if (Number.isFinite(llamaTokenCount.tokenCount) && Number(llamaTokenCount.tokenCount) > 0) {
      return {
        tokenCount: Number(llamaTokenCount.tokenCount),
        source: getActiveInferenceBackend(config),
        llamaTokenCount,
      };
    }
    return {
      tokenCount: estimateTokenCount(config, text),
      source: 'estimate',
      llamaTokenCount,
    };
  }

  return {
    tokenCount: estimateTokenCount(config, text),
    source: 'estimate',
    llamaTokenCount: null,
  };
}

export async function countTokensWithFallback(config: SiftConfig | undefined, text: string): Promise<number> {
  return (await countTokensWithFallbackDetailed(config, text)).tokenCount;
}

/**
 * A delta-derived transcript count within this many tokens of the prompt
 * budget triggers one exact full recount before the overflow decision.
 * Delta counting drifts â‰¤ ~2 tokens per seam; this margin bounds a whole
 * run's drift with room to spare.
 */
export const EXACT_RECOUNT_MARGIN_TOKENS = 2048;

export type PromptTokenCounter = {
  count(
    config: SiftConfig | undefined,
    text: string,
    options?: { forceExact?: boolean },
  ): Promise<TokenCountWithFallbackResult & { approximate: boolean }>;
};

const oneShotTokenCounter: PromptTokenCounter = {
  async count(config, text) {
    return { ...(await countTokensWithFallbackDetailed(config, text)), approximate: false };
  },
};

// ---------------------------------------------------------------------------
// Prompt budget preflight
// ---------------------------------------------------------------------------

export type PreflightResult = {
  ok: boolean;
  /** Tokens the rendered wire prompt occupies, including tool schemas and the image allowance. */
  promptTokenCount: number;
  /** Character length of the rendered wire prompt, for progress reporting. */
  promptChars: number;
  maxPromptBudget: number;
  overflowTokens: number;
  tokenCountSource: TokenCountSource;
  tokenizationAttempted: boolean;
  tokenizeElapsedMs: number | null;
  tokenizeRetryCount: number | null;
  tokenizeTimeoutMs: number;
  tokenizeRetryMaxWaitMs: number;
  tokenizeStatus: string | null;
  tokenizeErrorMessage: string | null;
};

export async function preflightPlannerPromptBudget(options: {
  config?: SiftConfig;
  prompt: WirePrompt;
  totalContextTokens: number;
  responseReserveTokens: number;
  promptTokenCounter?: PromptTokenCounter;
}): Promise<PreflightResult> {
  const totalContextTokens = Math.max(1, Number(options.totalContextTokens || 0));
  const responseReserveTokens = Math.max(0, Number(options.responseReserveTokens || 0));

  const promptText = options.prompt.text;

  // Image tokens cannot be derived from a data URI without decoding the image, and the
  // rendered wire prompt carries no text for them, so each attachment gets a flat allowance.
  const imageTokenCount = options.prompt.imageCount * SIFT_IMAGE_TOKEN_ESTIMATE;

  const promptCounter = options.promptTokenCounter ?? oneShotTokenCounter;
  const maxPromptBudget = Math.max(totalContextTokens - responseReserveTokens, 0);

  let tokenCount = await promptCounter.count(options.config, promptText);

  // A delta-derived count is approximate; when it lands near the budget the
  // overflow/compaction decision needs an exact number.
  const provisionalPromptTokenCount = tokenCount.tokenCount + imageTokenCount;
  if (
    tokenCount.approximate
    && tokenCount.source !== 'estimate'
    && provisionalPromptTokenCount >= maxPromptBudget - EXACT_RECOUNT_MARGIN_TOKENS
  ) {
    tokenCount = await promptCounter.count(options.config, promptText, { forceExact: true });
  }

  const promptTokenCount = tokenCount.tokenCount + imageTokenCount;
  const overflowTokens = Math.max(promptTokenCount - maxPromptBudget, 0);
  const llamaTokenCount = tokenCount.llamaTokenCount;

  return {
    ok: overflowTokens === 0,
    promptTokenCount,
    promptChars: promptText.length,
    maxPromptBudget,
    overflowTokens,
    tokenCountSource: tokenCount.source,
    tokenizationAttempted: llamaTokenCount !== null,
    tokenizeElapsedMs: llamaTokenCount?.elapsedMs ?? null,
    tokenizeRetryCount: llamaTokenCount?.retryCount ?? null,
    tokenizeTimeoutMs: llamaTokenCount?.timeoutMs ?? DEFAULT_LLAMA_CPP_TOKENIZE_TIMEOUT_MS,
    tokenizeRetryMaxWaitMs: llamaTokenCount?.retryMaxWaitMs ?? DEFAULT_LLAMA_CPP_TOKENIZE_RETRY_MAX_WAIT_MS,
    tokenizeStatus: llamaTokenCount?.status ?? null,
    tokenizeErrorMessage: llamaTokenCount?.errorMessage ?? null,
  };
}
