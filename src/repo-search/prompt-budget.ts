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
import { countContentImages, extractContentText } from '../llm-protocol/image-attachments.js';

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
  prompt?: string;
  messages?: ChatMessage[];
  providerPromptReserveText?: string;
  totalContextTokens: number;
  responseReserveTokens: number;
  transcriptTokenCounter?: PromptTokenCounter;
  reserveTokenCounter?: PromptTokenCounter;
}): Promise<PreflightResult> {
  const totalContextTokens = Math.max(1, Number(options.totalContextTokens || 0));
  const responseReserveTokens = Math.max(0, Number(options.responseReserveTokens || 0));

  const messages = Array.isArray(options.messages) ? options.messages : [];
  const promptText = typeof options.prompt === 'string'
    ? options.prompt
    : renderTaskTranscript(messages);

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

// ---------------------------------------------------------------------------
// Message compaction
// ---------------------------------------------------------------------------

const COMPRESSED_HISTORY_MARKER = '[COMPRESSED HISTORICAL EVIDENCE]';

function summarizeMessageForCompaction(message: ChatMessage): string {
  if (!message) return '';
  const role = String(message.role || 'unknown');
  const content = extractContentText(message.content).replace(/\s+/gu, ' ').trim();
  const trimmedContent = content.length > 220 ? `${content.slice(0, 220)}...` : content;
  const toolCallCount = Array.isArray(message.tool_calls) ? message.tool_calls.length : 0;
  const toolCallSuffix = toolCallCount > 0 ? ` | tool_calls=${toolCallCount}` : '';
  const toolCallIdSuffix = typeof message.tool_call_id === 'string' && message.tool_call_id
    ? ` | tool_call_id=${message.tool_call_id}` : '';
  // Without this an image-only turn summarizes as "(no content)", which reads as an
  // empty message rather than a dropped attachment.
  const imageCount = countContentImages(message.content);
  const imageSuffix = imageCount > 0 ? ` | images=${imageCount}` : '';
  return `[${role}] ${trimmedContent || '(no content)'}${imageSuffix}${toolCallSuffix}${toolCallIdSuffix}`.trim();
}

function buildCompressedHistorySummary(droppedMessages: ChatMessage[]): string {
  const sampled = droppedMessages.slice(-8)
    .map((m) => summarizeMessageForCompaction(m))
    .filter(Boolean);
  const body = sampled.length > 0 ? sampled.join('\n') : '(no retained details)';
  return [
    COMPRESSED_HISTORY_MARKER,
    `Dropped older planner messages: ${droppedMessages.length}.`,
    'Use this as compressed prior context only:',
    body,
  ].join('\n');
}

function buildCompactedMessages(
  messages: ChatMessage[],
  keptIndices: Set<number>,
): { messages: ChatMessage[]; droppedMessageCount: number; summaryInserted: boolean } {
  const keptOrdered = messages
    .map((message, index) => ({ message, index }))
    .filter((entry) => keptIndices.has(entry.index))
    .map((entry) => ({ ...entry.message }));
  const droppedMessages = messages.filter((_, index) => !keptIndices.has(index));

  if (droppedMessages.length === 0) {
    return { messages: keptOrdered, droppedMessageCount: 0, summaryInserted: false };
  }

  const summaryMessage: ChatMessage = {
    role: 'assistant',
    content: buildCompressedHistorySummary(droppedMessages),
  };
  const insertAt = keptOrdered[0] && String(keptOrdered[0].role || '') === 'system' ? 1 : 0;
  const compacted = [
    ...keptOrdered.slice(0, insertAt),
    summaryMessage,
    ...keptOrdered.slice(insertAt),
  ];

  return { messages: compacted, droppedMessageCount: droppedMessages.length, summaryInserted: true };
}

export async function compactPlannerMessagesOnce(options: {
  messages: ChatMessage[];
  config?: SiftConfig;
  maxPromptBudget: number;
  providerPromptReserveText?: string;
}): Promise<{
  messages: ChatMessage[];
  droppedMessageCount: number;
  summaryInserted: boolean;
  promptTokenCount: number;
}> {
  const sourceMessages = Array.isArray(options.messages) ? options.messages : [];
  const maxPromptBudget = Math.max(0, Number(options.maxPromptBudget || 0));
  const providerPromptReserveText = String(options.providerPromptReserveText || '').trim();
  const providerPromptReserveTokenCount = providerPromptReserveText
    ? await countTokensWithFallback(options.config, providerPromptReserveText)
    : 0;

  if (sourceMessages.length === 0) {
    return {
      messages: [],
      droppedMessageCount: 0,
      summaryInserted: false,
      promptTokenCount: providerPromptReserveTokenCount,
    };
  }

  const requiredIndices = new Set<number>();
  if (String(sourceMessages[0]?.role || '') === 'system') {
    requiredIndices.add(0);
  }
  for (let index = sourceMessages.length - 1; index >= 0; index -= 1) {
    if (String(sourceMessages[index]?.role || '') === 'user') {
      requiredIndices.add(index);
      break;
    }
  }

  let selectedIndices = new Set(requiredIndices);
  const candidateIndices: number[] = [];
  for (let index = sourceMessages.length - 1; index >= 0; index -= 1) {
    if (!requiredIndices.has(index)) {
      candidateIndices.push(index);
    }
  }

  for (const index of candidateIndices) {
    const tentativeIndices = new Set(selectedIndices);
    tentativeIndices.add(index);
    const tentative = buildCompactedMessages(sourceMessages, tentativeIndices).messages;
    const tentativePromptTokens =
      await countTokensWithFallback(options.config, renderTaskTranscript(tentative))
      + providerPromptReserveTokenCount;
    if (tentativePromptTokens <= maxPromptBudget) {
      selectedIndices = tentativeIndices;
    }
  }

  const compacted = buildCompactedMessages(sourceMessages, selectedIndices);
  const promptTokenCount =
    await countTokensWithFallback(options.config, renderTaskTranscript(compacted.messages))
    + providerPromptReserveTokenCount;

  return {
    messages: compacted.messages,
    droppedMessageCount: compacted.droppedMessageCount,
    summaryInserted: compacted.summaryInserted,
    promptTokenCount,
  };
}
