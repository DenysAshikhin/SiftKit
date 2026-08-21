import {
  getActiveInferenceBackend,
  type SiftConfig,
} from '../config/index.js';
import { estimateTokenCount } from '../lib/token-estimate.js';
import type { InferenceBackendId } from '../config/types.js';
import {
  DEFAULT_LLAMA_CPP_TOKENIZE_RETRY_MAX_WAIT_MS,
  DEFAULT_LLAMA_CPP_TOKENIZE_TIMEOUT_MS,
  countLlamaCppTokensDetailed,
  type CountLlamaCppTokensOptions,
  type LlamaCppTokenCountResult,
} from '../providers/llama-cpp.js';
import type { ChatMessage } from './planner-protocol.js';
import { renderTaskTranscript } from './planner-protocol.js';
import { SIFT_IMAGE_TOKEN_ESTIMATE } from '../config/constants.js';
import { countContentImages } from '../llm-protocol/image-attachments.js';

/**
 * Where a token count came from: the engine that tokenized it, or the local
 * characters-per-token estimate when no server count was available.
 */
export type TokenCountSource = InferenceBackendId | 'estimate';

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
  promptTokenCount: number;
  transcriptPromptTokenCount: number;
  providerPromptReserveTokenCount: number;
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
  providerPromptReserveText?: string;
  totalContextTokens: number;
  responseReserveTokens: number;
  transcriptTokenCounter?: PromptTokenCounter;
  reserveTokenCounter?: PromptTokenCounter;
} & (
  // A caller-supplied prompt string is already the final counted text; the
  // messages path renders it here and must state whether preserved
  // reasoning_content is part of what will be sent.
  | { prompt: string; messages?: undefined; includeReasoningContent?: undefined }
  | { prompt?: undefined; messages: ChatMessage[]; includeReasoningContent: boolean }
)): Promise<PreflightResult> {
  const totalContextTokens = Math.max(1, Number(options.totalContextTokens || 0));
  const responseReserveTokens = Math.max(0, Number(options.responseReserveTokens || 0));

  const messages = Array.isArray(options.messages) ? options.messages : [];
  const promptText = typeof options.prompt === 'string'
    ? options.prompt
    : renderTaskTranscript(messages, { includeReasoningContent: options.includeReasoningContent === true });

  // Image tokens cannot be derived from a data URI without decoding the image, and the
  // rendered transcript carries no text for them, so each attachment gets a flat
  // allowance. Only the transcript path can hold attachments; a caller-supplied prompt
  // string is already the final text.
  const imageTokenCount = typeof options.prompt === 'string'
    ? 0
    : messages.reduce((total, message) => total + countContentImages(message.content), 0)
      * SIFT_IMAGE_TOKEN_ESTIMATE;

  const transcriptCounter = options.transcriptTokenCounter ?? oneShotTokenCounter;
  const reserveCounter = options.reserveTokenCounter ?? oneShotTokenCounter;
  const maxPromptBudget = Math.max(totalContextTokens - responseReserveTokens, 0);

  let tokenCount = await transcriptCounter.count(options.config, promptText);
  const providerPromptReserveText = String(options.providerPromptReserveText || '').trim();
  const reserveTokenCount = providerPromptReserveText
    ? await reserveCounter.count(options.config, providerPromptReserveText)
    : null;
  const providerPromptReserveTokenCount = reserveTokenCount?.tokenCount ?? 0;

  // A delta-derived count is approximate; when it lands near the budget the
  // overflow/compaction decision needs an exact number.
  const provisionalPromptTokenCount = tokenCount.tokenCount + imageTokenCount + providerPromptReserveTokenCount;
  if (
    tokenCount.approximate
    && tokenCount.source !== 'estimate'
    && provisionalPromptTokenCount >= maxPromptBudget - EXACT_RECOUNT_MARGIN_TOKENS
  ) {
    tokenCount = await transcriptCounter.count(options.config, promptText, { forceExact: true });
  }

  const transcriptPromptTokenCount = tokenCount.tokenCount + imageTokenCount;
  const promptTokenCount = transcriptPromptTokenCount + providerPromptReserveTokenCount;
  const overflowTokens = Math.max(promptTokenCount - maxPromptBudget, 0);
  const llamaTokenCount = tokenCount.llamaTokenCount;
  const reserveLlamaTokenCount = reserveTokenCount?.llamaTokenCount ?? null;

  return {
    ok: overflowTokens === 0,
    promptTokenCount,
    transcriptPromptTokenCount,
    providerPromptReserveTokenCount,
    maxPromptBudget,
    overflowTokens,
    tokenCountSource: tokenCount.source !== 'estimate'
      && (!reserveTokenCount || reserveTokenCount.source !== 'estimate')
      ? tokenCount.source
      : 'estimate',
    tokenizationAttempted: llamaTokenCount !== null || reserveLlamaTokenCount !== null,
    tokenizeElapsedMs: (llamaTokenCount?.elapsedMs ?? 0) + (reserveLlamaTokenCount?.elapsedMs ?? 0) || null,
    tokenizeRetryCount: (llamaTokenCount?.retryCount ?? 0) + (reserveLlamaTokenCount?.retryCount ?? 0) || null,
    tokenizeTimeoutMs: Math.max(
      llamaTokenCount?.timeoutMs ?? DEFAULT_LLAMA_CPP_TOKENIZE_TIMEOUT_MS,
      reserveLlamaTokenCount?.timeoutMs ?? DEFAULT_LLAMA_CPP_TOKENIZE_TIMEOUT_MS,
    ),
    tokenizeRetryMaxWaitMs: Math.max(
      llamaTokenCount?.retryMaxWaitMs ?? DEFAULT_LLAMA_CPP_TOKENIZE_RETRY_MAX_WAIT_MS,
      reserveLlamaTokenCount?.retryMaxWaitMs ?? DEFAULT_LLAMA_CPP_TOKENIZE_RETRY_MAX_WAIT_MS,
    ),
    tokenizeStatus: reserveLlamaTokenCount?.status ?? llamaTokenCount?.status ?? null,
    tokenizeErrorMessage: reserveLlamaTokenCount?.errorMessage ?? llamaTokenCount?.errorMessage ?? null,
  };
}
