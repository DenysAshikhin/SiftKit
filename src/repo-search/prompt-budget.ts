import {
  getActiveInferenceBackend,
  getActiveModelPreset,
  getConfiguredEngineBaseUrl,
  type SiftConfig,
} from '../config/index.ts';
import { estimateTokenCount } from '../lib/token-estimate.ts';
import { InferenceBackendIdSchema } from '../config/types.ts';
import { z } from '../lib/zod.ts';
import {
  DEFAULT_INFERENCE_TOKENIZE_RETRY_MAX_WAIT_MS,
  DEFAULT_INFERENCE_TOKENIZE_TIMEOUT_MS,
  countInferenceTokensDetailed,
  type CountInferenceTokensOptions,
  type InferenceTokenCountResult,
} from '../providers/inference.ts';
import { PromptTokenCounter } from '../providers/prompt-token-counter.ts';
import { tryRecordAccurateCharTokenObservation } from '../state/observed-budget.ts';
import type { WirePrompt } from './wire-prompt.ts';
import { SIFT_IMAGE_TOKEN_ESTIMATE } from '../config/constants.ts';

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

/** Most a wire block tokenized on its own can differ from its tokens inside the prompt: one seam. */
export const WIRE_SEGMENT_DRIFT_TOKENS = 2;

/** Counts a wire prompt, reusing the counter's earlier counts; an unreachable engine yields the estimate. */
async function countWirePromptTokens(
  config: SiftConfig | undefined,
  prompt: WirePrompt,
  counter: PromptTokenCounter,
  limitTokens: number,
): Promise<TokenCountWithFallbackResult> {
  if (!config) {
    return countTokensWithFallbackDetailed(undefined, prompt.text);
  }
  const counted = await counter.count({
    target: { baseUrl: getConfiguredEngineBaseUrl(config) },
    contextKey: `model:${getActiveModelPreset(config).Model ?? 'unset'}`,
    segments: prompt.segments.map((segment) => ({ identity: segment, text: segment })),
    exactBody: { text: prompt.text },
    limitTokens,
    segmentDriftTokens: WIRE_SEGMENT_DRIFT_TOKENS,
  });
  if (!counted.ok) {
    return { tokenCount: estimateTokenCount(config, prompt.text), source: 'estimate', inferenceTokenCount: counted.tokenization };
  }
  if (counted.driftTokens === 0 && counted.tokenization !== null) {
    tryRecordAccurateCharTokenObservation({
      chars: prompt.text.length,
      tokens: counted.tokenCount,
      updatedAtUtc: new Date().toISOString(),
    });
  }
  return { tokenCount: counted.tokenCount, source: getActiveInferenceBackend(config), inferenceTokenCount: counted.tokenization };
}

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
  /** Reuses counts across a growing conversation; absent counts this prompt on its own. */
  promptTokenCounter?: PromptTokenCounter;
  /** A reused count whose drift could reach this many prompt tokens is recounted exactly. */
  maxPromptTokens?: number;
}): Promise<PromptTokenMeasurement> {
  const promptText = options.prompt.text;

  // Image tokens cannot be derived from a data URI without decoding the image, and the
  // rendered wire prompt carries no text for them, so each attachment gets a flat allowance.
  const imageTokenCount = options.prompt.imageCount * SIFT_IMAGE_TOKEN_ESTIMATE;

  const tokenCount = await countWirePromptTokens(
    options.config,
    options.prompt,
    options.promptTokenCounter ?? new PromptTokenCounter(),
    (options.maxPromptTokens ?? Number.POSITIVE_INFINITY) - imageTokenCount,
  );

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
    maxPromptTokens,
  });
  const overflowTokens = Math.max(measurement.promptTokenCount - maxPromptTokens, 0);
  return {
    ...measurement,
    ok: overflowTokens === 0,
    maxPromptBudget: maxPromptTokens,
    overflowTokens,
  };
}
