import {
  getActiveInferenceBackend,
  type SiftConfig,
} from '../config/index.js';
import { estimateTokenCount } from '../lib/token-estimate.js';
import { InferenceBackendIdSchema } from '../config/types.js';
import { z } from '../lib/zod.js';
import {
  DEFAULT_INFERENCE_TOKENIZE_RETRY_MAX_WAIT_MS,
  DEFAULT_INFERENCE_TOKENIZE_TIMEOUT_MS,
  countInferenceTokensDetailed,
  type CountInferenceTokensOptions,
  type InferenceTokenCountResult,
} from '../providers/inference.js';
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
  inferenceTokenCount: InferenceTokenCountResult | null;
};

export async function countTokensWithFallbackDetailed(
  config: SiftConfig | undefined,
  text: string,
  options: CountInferenceTokensOptions = {},
): Promise<TokenCountWithFallbackResult> {
  if (config) {
    const inferenceTokenCount = await countInferenceTokensDetailed(config, text, options);
    if (Number.isFinite(inferenceTokenCount.tokenCount) && Number(inferenceTokenCount.tokenCount) > 0) {
      return {
        tokenCount: Number(inferenceTokenCount.tokenCount),
        source: getActiveInferenceBackend(config),
        inferenceTokenCount,
      };
    }
    return {
      tokenCount: estimateTokenCount(config, text),
      source: 'estimate',
      inferenceTokenCount,
    };
  }

  return {
    tokenCount: estimateTokenCount(config, text),
    source: 'estimate',
    inferenceTokenCount: null,
  };
}

export async function countTokensWithFallback(config: SiftConfig | undefined, text: string): Promise<number> {
  return (await countTokensWithFallbackDetailed(config, text)).tokenCount;
}

/**
 * A delta-derived transcript count within this many tokens of the prompt
 * budget triggers one exact full recount before the overflow decision.
 * Delta counting drifts ≤ ~2 tokens per seam; this margin bounds a whole
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
// Prompt token measurement
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

/** What a rendered prompt measures, before any budget policy is applied to it. */
export type PromptTokenMeasurement = Omit<
  PreflightResult,
  'ok' | 'maxPromptBudget' | 'overflowTokens'
>;

/**
 * Counts the tokens a rendered wire prompt occupies. Callers that fit generation into
 * the physical remainder of the window (compaction, terminal synthesis) need only this;
 * they decide nothing about prompt policy.
 */
export async function countPlannerPromptTokens(options: {
  config?: SiftConfig;
  prompt: WirePrompt;
  promptTokenCounter?: PromptTokenCounter;
  /** A delta-derived count at or above this triggers one exact recount; absent means never. */
  exactRecountThresholdTokens?: number;
}): Promise<PromptTokenMeasurement> {
  const promptText = options.prompt.text;

  // Image tokens cannot be derived from a data URI without decoding the image, and the
  // rendered wire prompt carries no text for them, so each attachment gets a flat allowance.
  const imageTokenCount = options.prompt.imageCount * SIFT_IMAGE_TOKEN_ESTIMATE;

  const promptCounter = options.promptTokenCounter ?? oneShotTokenCounter;
  let tokenCount = await promptCounter.count(options.config, promptText);

  // A delta-derived count is approximate; when it lands near the budget the
  // overflow/compaction decision needs an exact number.
  const provisionalPromptTokenCount = tokenCount.tokenCount + imageTokenCount;
  if (
    options.exactRecountThresholdTokens !== undefined
    && tokenCount.approximate
    && tokenCount.source !== 'estimate'
    && provisionalPromptTokenCount >= options.exactRecountThresholdTokens
  ) {
    tokenCount = await promptCounter.count(options.config, promptText, { forceExact: true });
  }

  const inferenceTokenCount = tokenCount.inferenceTokenCount;
  return {
    promptTokenCount: tokenCount.tokenCount + imageTokenCount,
    promptChars: promptText.length,
    tokenCountSource: tokenCount.source,
    tokenizationAttempted: inferenceTokenCount !== null,
    tokenizeElapsedMs: inferenceTokenCount?.elapsedMs ?? null,
    tokenizeRetryCount: inferenceTokenCount?.retryCount ?? null,
    tokenizeTimeoutMs: inferenceTokenCount?.timeoutMs ?? DEFAULT_INFERENCE_TOKENIZE_TIMEOUT_MS,
    tokenizeRetryMaxWaitMs: inferenceTokenCount?.retryMaxWaitMs ?? DEFAULT_INFERENCE_TOKENIZE_RETRY_MAX_WAIT_MS,
    tokenizeStatus: inferenceTokenCount?.status ?? null,
    tokenizeErrorMessage: inferenceTokenCount?.errorMessage ?? null,
  };
}

// ---------------------------------------------------------------------------
// Prompt budget preflight
// ---------------------------------------------------------------------------

/**
 * Measures the prompt and compares it against the one shared prompt limit. The limit
 * is resolved by the caller (TurnBudget); nothing here derives it from context or reserve.
 */
export async function preflightPlannerPromptBudget(options: {
  config?: SiftConfig;
  prompt: WirePrompt;
  maxPromptTokens: number;
  promptTokenCounter?: PromptTokenCounter;
}): Promise<PreflightResult> {
  const { maxPromptTokens } = options;
  const measurement = await countPlannerPromptTokens({
    config: options.config,
    prompt: options.prompt,
    promptTokenCounter: options.promptTokenCounter,
    exactRecountThresholdTokens: maxPromptTokens - EXACT_RECOUNT_MARGIN_TOKENS,
  });
  const overflowTokens = Math.max(measurement.promptTokenCount - maxPromptTokens, 0);
  return {
    ...measurement,
    ok: overflowTokens === 0,
    maxPromptBudget: maxPromptTokens,
    overflowTokens,
  };
}
