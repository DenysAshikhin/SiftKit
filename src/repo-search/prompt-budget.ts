import {
  getEffectiveInputCharactersPerContextToken,
  type SiftConfig,
} from '../config/index.js';
import {
  DEFAULT_LLAMA_CPP_TOKENIZE_RETRY_MAX_WAIT_MS,
  DEFAULT_LLAMA_CPP_TOKENIZE_TIMEOUT_MS,
  countLlamaCppTokensDetailed,
  type LlamaCppTokenCountResult,
} from '../providers/llama-cpp.js';
import type { ChatMessage } from './planner-protocol.js';
import { renderTaskTranscript } from './planner-protocol.js';

// ---------------------------------------------------------------------------
// Token estimation
// ---------------------------------------------------------------------------

export function estimateTokenCount(config: SiftConfig | undefined, text: string): number {
  const charsPerToken = config
    ? Math.max(Number(getEffectiveInputCharactersPerContextToken(config) || 4), 0.1)
    : 4;
  return Math.max(1, Math.ceil(String(text || '').length / charsPerToken));
}

export type TokenCountWithFallbackResult = {
  tokenCount: number;
  source: 'llama.cpp' | 'estimate';
  llamaTokenCount: LlamaCppTokenCountResult | null;
};

export async function countTokensWithFallbackDetailed(
  config: SiftConfig | undefined,
  text: string,
): Promise<TokenCountWithFallbackResult> {
  if (config) {
    const llamaTokenCount = await countLlamaCppTokensDetailed(config, text);
    if (Number.isFinite(llamaTokenCount.tokenCount) && Number(llamaTokenCount.tokenCount) > 0) {
      return {
        tokenCount: Number(llamaTokenCount.tokenCount),
        source: 'llama.cpp',
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

// ---------------------------------------------------------------------------
// Prompt budget preflight
// ---------------------------------------------------------------------------

export type PreflightResult = {
  ok: boolean;
  promptTokenCount: number;
  maxPromptBudget: number;
  overflowTokens: number;
  tokenCountSource: 'llama.cpp' | 'estimate';
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
  totalContextTokens: number;
  thinkingBufferTokens: number;
}): Promise<PreflightResult> {
  const totalContextTokens = Math.max(1, Number(options.totalContextTokens || 0));
  const thinkingBufferTokens = Math.max(0, Number(options.thinkingBufferTokens || 0));

  const promptText = typeof options.prompt === 'string'
    ? options.prompt
    : renderTaskTranscript(Array.isArray(options.messages) ? options.messages : []);

  const tokenCount = await countTokensWithFallbackDetailed(options.config, promptText);
  const promptTokenCount = tokenCount.tokenCount;
  const maxPromptBudget = Math.max(totalContextTokens - thinkingBufferTokens, 0);
  const overflowTokens = Math.max(promptTokenCount - maxPromptBudget, 0);
  const llamaTokenCount = tokenCount.llamaTokenCount;

  return {
    ok: overflowTokens === 0,
    promptTokenCount,
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

// ---------------------------------------------------------------------------
// Message compaction
// ---------------------------------------------------------------------------

const COMPRESSED_HISTORY_MARKER = '[COMPRESSED HISTORICAL EVIDENCE]';

function summarizeMessageForCompaction(message: ChatMessage): string {
  if (!message) return '';
  const role = String(message.role || 'unknown');
  const content = typeof message.content === 'string'
    ? message.content.replace(/\s+/gu, ' ').trim()
    : '';
  const trimmedContent = content.length > 220 ? `${content.slice(0, 220)}...` : content;
  const toolCallCount = Array.isArray(message.tool_calls) ? message.tool_calls.length : 0;
  const toolCallSuffix = toolCallCount > 0 ? ` | tool_calls=${toolCallCount}` : '';
  const toolCallIdSuffix = typeof message.tool_call_id === 'string' && message.tool_call_id
    ? ` | tool_call_id=${message.tool_call_id}` : '';
  return `[${role}] ${trimmedContent || '(no content)'}${toolCallSuffix}${toolCallIdSuffix}`.trim();
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
}): Promise<{
  messages: ChatMessage[];
  droppedMessageCount: number;
  summaryInserted: boolean;
  promptTokenCount: number;
}> {
  const sourceMessages = Array.isArray(options.messages) ? options.messages : [];
  const maxPromptBudget = Math.max(0, Number(options.maxPromptBudget || 0));

  if (sourceMessages.length === 0) {
    return { messages: [], droppedMessageCount: 0, summaryInserted: false, promptTokenCount: 0 };
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
    const tentativePromptTokens = await countTokensWithFallback(options.config, renderTaskTranscript(tentative));
    if (tentativePromptTokens <= maxPromptBudget) {
      selectedIndices = tentativeIndices;
    }
  }

  const compacted = buildCompactedMessages(sourceMessages, selectedIndices);
  const promptTokenCount = await countTokensWithFallback(options.config, renderTaskTranscript(compacted.messages));

  return {
    messages: compacted.messages,
    droppedMessageCount: compacted.droppedMessageCount,
    summaryInserted: compacted.summaryInserted,
    promptTokenCount,
  };
}
