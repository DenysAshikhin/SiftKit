import { getConfiguredLlamaBaseUrl, getConfiguredLlamaNumCtx, getConfiguredLlamaSetting, type RuntimeLlamaCppConfig, type SiftConfig } from '../config/index.js';
import { requestJsonFull, type FullJsonResponse } from '../lib/http.js';
import {
  buildTransientProviderHttpError,
  isTransientProviderHttpResponse,
  retryProviderRequest,
} from '../lib/provider-helpers.js';
import { estimatePromptTokenCountFromCharacters, getDynamicMaxOutputTokens } from '../lib/dynamic-output-cap.js';
import { getNormalizedCompletionTokens } from '../lib/telemetry-metrics.js';
import { tryRecordAccurateCharTokenObservation } from '../state/observed-budget.js';
import {
  buildLlamaJsonSchemaResponseFormat,
  buildSummaryDecisionJsonSchema,
  buildSummaryPlannerActionJsonSchema,
  type StructuredOutputToolDefinition,
} from './structured-output-schema.js';
import { createTracer } from '../lib/trace.js';

type LlamaCppModelListResponse = {
  data?: Array<{ id?: string }>;
};

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function logLlamaCppError(operation: string, message: string): void {
  console.error(`llama.cpp ${operation} error: ${message}`);
}

type LlamaCppTokenizeResponse = {
  tokens?: unknown[];
  count?: unknown;
  token_count?: unknown;
  n_tokens?: unknown;
};

export const DEFAULT_LLAMA_CPP_TOKENIZE_TIMEOUT_MS = 10_000;
export const DEFAULT_LLAMA_CPP_TOKENIZE_RETRY_MAX_WAIT_MS = 30_000;

export type CountLlamaCppTokensOptions = {
  timeoutMs?: number;
  retryMaxWaitMs?: number;
};

export type LlamaCppTokenCountResult = {
  tokenCount: number | null;
  elapsedMs: number;
  retryCount: number;
  timeoutMs: number;
  retryMaxWaitMs: number;
  status: 'completed' | 'empty' | 'http_error' | 'error';
  httpStatusCode: number | null;
  errorMessage: string | null;
};

type LlamaCppChatResponse = {
  choices?: Array<{
    message?: {
      role?: string;
      content?: string | Array<{ type?: string; text?: string }>;
      reasoning_content?: string | Array<{ type?: string; text?: string }>;
      tool_calls?: Array<{
        id?: string;
        type?: string;
        function?: {
          name?: string;
          arguments?: unknown;
        };
      }>;
      function_call?: {
        name?: string;
        arguments?: unknown;
      };
    };
    text?: string;
    tool_calls?: Array<{
      function?: {
        name?: string;
        arguments?: unknown;
      };
    }>;
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
    prompt_tokens_details?: {
      cached_tokens?: number;
    };
    input_tokens_details?: {
      cached_tokens?: number;
    };
    reasoning_tokens?: number;
    thinking_tokens?: number;
    completion_tokens_details?: {
      reasoning_tokens?: number;
      thinking_tokens?: number;
    };
    output_tokens_details?: {
      reasoning_tokens?: number;
      thinking_tokens?: number;
    };
  };
  timings?: {
    cache_n?: number;
    prompt_n?: number;
  };
};

type LlamaCppChatChoice = NonNullable<LlamaCppChatResponse['choices']>[number];

export type LlamaCppUsage = {
  promptTokens: number | null;
  completionTokens: number | null;
  totalTokens: number | null;
  thinkingTokens: number | null;
  promptCacheTokens: number | null;
  promptEvalTokens: number | null;
};

export type LlamaCppGenerateResult = {
  text: string;
  usage: LlamaCppUsage | null;
  reasoningText: string | null;
};

export type LlamaCppChatMessage = {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content?: string | Array<{ type?: string; text?: string }>;
  reasoning_content?: string | Array<{ type?: string; text?: string }>;
  tool_calls?: Array<{
    id?: string;
    type?: string;
    function?: {
      name?: string;
      arguments?: unknown;
    };
  }>;
  tool_call_id?: string;
  function_call?: {
    name?: string;
    arguments?: unknown;
  };
};

export type LlamaCppStructuredOutput =
  | { kind: 'none' }
  | { kind: 'siftkit-decision-json'; allowUnsupportedInput?: boolean }
  | { kind: 'siftkit-planner-action-json'; tools?: StructuredOutputToolDefinition[]; allowUnsupportedInput?: boolean };

type PlannerStructuredToolCall = {
  tool_name: string;
  args: Record<string, unknown>;
};

const traceLlamaCpp = createTracer('SIFTKIT_TRACE_SUMMARY', 'llama-cpp');

function getUsageValue(value: unknown): number | null {
  return Number.isFinite(value) && Number(value) >= 0 ? Number(value) : null;
}

function getThinkingTokenCount(usage: LlamaCppChatResponse['usage']): number | null {
  if (!usage) {
    return null;
  }

  const detailCandidates = [
    usage.completion_tokens_details,
    usage.output_tokens_details,
  ];
  for (const details of detailCandidates) {
    if (!details) {
      continue;
    }

    const reasoningTokens = getUsageValue(details.reasoning_tokens) ?? 0;
    const thinkingTokens = getUsageValue(details.thinking_tokens) ?? 0;
    if (
      Object.prototype.hasOwnProperty.call(details, 'reasoning_tokens')
      || Object.prototype.hasOwnProperty.call(details, 'thinking_tokens')
    ) {
      return reasoningTokens + thinkingTokens;
    }
  }

  const topLevelReasoningTokens = getUsageValue(usage.reasoning_tokens) ?? 0;
  const topLevelThinkingTokens = getUsageValue(usage.thinking_tokens) ?? 0;
  if (
    Object.prototype.hasOwnProperty.call(usage, 'reasoning_tokens')
    || Object.prototype.hasOwnProperty.call(usage, 'thinking_tokens')
  ) {
    return topLevelReasoningTokens + topLevelThinkingTokens;
  }

  return null;
}

function getStructuredOutputResponseFormat(
  structuredOutput: LlamaCppStructuredOutput | undefined
): Record<string, unknown> | null {
  if (!structuredOutput || structuredOutput.kind === 'none') {
    return null;
  }

  if (structuredOutput.kind === 'siftkit-decision-json') {
    return buildLlamaJsonSchemaResponseFormat({
      name: 'siftkit_decision',
      schema: buildSummaryDecisionJsonSchema({
        allowUnsupportedInput: structuredOutput.allowUnsupportedInput !== false,
      }),
    });
  }

  if (structuredOutput.kind === 'siftkit-planner-action-json') {
    const toolDefinitions = Array.isArray(structuredOutput.tools)
      ? structuredOutput.tools
      : [];
    return buildLlamaJsonSchemaResponseFormat({
      name: 'siftkit_summary_planner_action',
      schema: buildSummaryPlannerActionJsonSchema({
        toolDefinitions,
        allowUnsupportedInput: structuredOutput.allowUnsupportedInput !== false,
      }),
    });
  }

  return null;
}

// HTTP client delegated to shared lib/http.ts:requestJsonFull.
// Local alias keeps call sites unchanged.
const requestJson = requestJsonFull;
type JsonResponse<T> = FullJsonResponse<T>;

function getTextContent(content: string | Array<{ type?: string; text?: string }> | undefined): string {
  if (typeof content === 'string') {
    return content;
  }

  if (!Array.isArray(content)) {
    return '';
  }

  return content
    .map((part) => (part?.type === 'text' || !part?.type) ? String(part?.text || '') : '')
    .join('');
}

function parseToolArguments(argumentsValue: unknown): Record<string, unknown> | null {
  if (typeof argumentsValue === 'string') {
    try {
      const parsed = JSON.parse(argumentsValue) as unknown;
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? parsed as Record<string, unknown>
        : null;
    } catch {
      return null;
    }
  }

  if (argumentsValue && typeof argumentsValue === 'object' && !Array.isArray(argumentsValue)) {
    return argumentsValue as Record<string, unknown>;
  }

  return null;
}

function parseStructuredPlannerToolCall(toolCall: {
  function?: {
    name?: string;
    arguments?: unknown;
  };
} | null | undefined): PlannerStructuredToolCall | null {
  const toolName = typeof toolCall?.function?.name === 'string' ? toolCall.function.name.trim() : '';
  const args = parseToolArguments(toolCall?.function?.arguments);
  if (!toolName || !args) {
    return null;
  }
  return {
    tool_name: toolName,
    args,
  };
}

function getStructuredToolCallText(
  structuredOutput: LlamaCppStructuredOutput | undefined,
  choice: LlamaCppChatChoice | undefined,
): string {
  if (structuredOutput?.kind !== 'siftkit-planner-action-json') {
    return '';
  }

  const toolCalls = [
    ...((choice?.message?.tool_calls || []).map((toolCall) => parseStructuredPlannerToolCall(toolCall)).filter(Boolean) as PlannerStructuredToolCall[]),
    ...((choice?.tool_calls || []).map((toolCall) => parseStructuredPlannerToolCall(toolCall)).filter(Boolean) as PlannerStructuredToolCall[]),
  ];
  if (toolCalls.length === 0 && choice?.message?.function_call) {
    const toolCall = parseStructuredPlannerToolCall({ function: choice.message.function_call });
    if (toolCall) {
      toolCalls.push(toolCall);
    }
  }

  if (toolCalls.length === 0) {
    return '';
  }

  if (toolCalls.length === 1) {
    return JSON.stringify({
      action: 'tool',
      tool_name: toolCalls[0].tool_name,
      args: toolCalls[0].args,
    });
  }

  return JSON.stringify({
    action: 'tool_batch',
    tool_calls: toolCalls,
  });
}

function getPositiveTimeoutMs(value: number | undefined, fallback: number): number {
  const numericValue = Number(value);
  return Number.isFinite(numericValue) && numericValue > 0
    ? Math.max(1, Math.trunc(numericValue))
    : fallback;
}

export async function countLlamaCppTokens(
  config: SiftConfig,
  content: string,
  options: CountLlamaCppTokensOptions = {},
): Promise<number | null> {
  return (await countLlamaCppTokensDetailed(config, content, options)).tokenCount;
}

export async function countLlamaCppTokensDetailed(
  config: SiftConfig,
  content: string,
  options: CountLlamaCppTokensOptions = {},
): Promise<LlamaCppTokenCountResult> {
  const timeoutMs = getPositiveTimeoutMs(options.timeoutMs, DEFAULT_LLAMA_CPP_TOKENIZE_TIMEOUT_MS);
  const retryMaxWaitMs = getPositiveTimeoutMs(options.retryMaxWaitMs, DEFAULT_LLAMA_CPP_TOKENIZE_RETRY_MAX_WAIT_MS);
  if (!content.trim()) {
    return {
      tokenCount: 0,
      elapsedMs: 0,
      retryCount: 0,
      timeoutMs,
      retryMaxWaitMs,
      status: 'empty',
      httpStatusCode: null,
      errorMessage: null,
    };
  }

  const startedAt = Date.now();
  let retryCount = 0;
  let lastRetryErrorMessage: string | null = null;
  traceLlamaCpp(`tokenize start chars=${content.length}`);
  try {
    const baseUrl = getConfiguredLlamaBaseUrl(config);
    const response = await retryProviderRequest(async () => {
      const nextResponse = await requestJson<LlamaCppTokenizeResponse>({
        url: `${baseUrl.replace(/\/$/u, '')}/tokenize`,
        method: 'POST',
        timeoutMs,
        body: JSON.stringify({ content }),
      });
      if (isTransientProviderHttpResponse(nextResponse.statusCode, nextResponse.rawText)) {
        throw buildTransientProviderHttpError(nextResponse.statusCode, nextResponse.rawText);
      }
      return nextResponse;
    }, {
      maxWaitMs: retryMaxWaitMs,
      onRetry(event) {
        retryCount += 1;
        lastRetryErrorMessage = event.error.message;
        traceLlamaCpp(
          `tokenize retry attempt=${event.attempt} elapsed_ms=${event.elapsedMs} `
          + `next_delay_ms=${event.nextDelayMs} code=${event.error.code || 'none'}`
        );
      },
    });

    if (response.statusCode >= 400) {
      traceLlamaCpp(`tokenize http_error elapsed_ms=${Date.now() - startedAt} status=${response.statusCode}`);
      logLlamaCppError('tokenize', `HTTP ${response.statusCode}: ${response.rawText.trim()}`);
      return {
        tokenCount: null,
        elapsedMs: Date.now() - startedAt,
        retryCount,
        timeoutMs,
        retryMaxWaitMs,
        status: 'http_error',
        httpStatusCode: response.statusCode,
        errorMessage: `HTTP ${response.statusCode}`,
      };
    }

    const explicitCount = getUsageValue(response.body.count)
      ?? getUsageValue(response.body.token_count)
      ?? getUsageValue(response.body.n_tokens);
    if (explicitCount !== null) {
      tryRecordAccurateCharTokenObservation({
        chars: content.length,
        tokens: explicitCount,
        updatedAtUtc: new Date().toISOString(),
      });
      traceLlamaCpp(`tokenize done elapsed_ms=${Date.now() - startedAt} tokens=${explicitCount}`);
      return {
        tokenCount: explicitCount,
        elapsedMs: Date.now() - startedAt,
        retryCount,
        timeoutMs,
        retryMaxWaitMs,
        status: 'completed',
        httpStatusCode: response.statusCode,
        errorMessage: null,
      };
    }

    if (!Array.isArray(response.body.tokens)) {
      traceLlamaCpp(`tokenize done elapsed_ms=${Date.now() - startedAt} tokens=null`);
      return {
        tokenCount: null,
        elapsedMs: Date.now() - startedAt,
        retryCount,
        timeoutMs,
        retryMaxWaitMs,
        status: 'error',
        httpStatusCode: response.statusCode,
        errorMessage: 'Tokenize response did not include token count.',
      };
    }

    tryRecordAccurateCharTokenObservation({
      chars: content.length,
      tokens: response.body.tokens.length,
      updatedAtUtc: new Date().toISOString(),
    });
    traceLlamaCpp(`tokenize done elapsed_ms=${Date.now() - startedAt} tokens=${response.body.tokens.length}`);
    return {
      tokenCount: response.body.tokens.length,
      elapsedMs: Date.now() - startedAt,
      retryCount,
      timeoutMs,
      retryMaxWaitMs,
      status: 'completed',
      httpStatusCode: response.statusCode,
      errorMessage: null,
    };
  } catch (error) {
    const message = getErrorMessage(error);
    traceLlamaCpp(`tokenize error elapsed_ms=${Date.now() - startedAt} message=${JSON.stringify(message)}`);
    logLlamaCppError('tokenize', message);
    return {
      tokenCount: null,
      elapsedMs: Date.now() - startedAt,
      retryCount,
      timeoutMs,
      retryMaxWaitMs,
      status: 'error',
      httpStatusCode: null,
      errorMessage: message || lastRetryErrorMessage,
    };
  }
}

export async function listLlamaCppModels(config: SiftConfig): Promise<string[]> {
  const baseUrl = getConfiguredLlamaBaseUrl(config);
  let response: JsonResponse<LlamaCppModelListResponse>;
  try {
    response = await retryProviderRequest(async () => {
      const nextResponse = await requestJson<LlamaCppModelListResponse>({
        url: `${baseUrl.replace(/\/$/u, '')}/v1/models`,
        method: 'GET',
        timeoutMs: 5000,
      });
      if (isTransientProviderHttpResponse(nextResponse.statusCode, nextResponse.rawText)) {
        throw buildTransientProviderHttpError(nextResponse.statusCode, nextResponse.rawText);
      }
      return nextResponse;
    }, {
      onRetry(event) {
        traceLlamaCpp(
          `model_list retry attempt=${event.attempt} elapsed_ms=${event.elapsedMs} `
          + `next_delay_ms=${event.nextDelayMs} code=${event.error.code || 'none'}`
        );
      },
    });
  } catch (error) {
    logLlamaCppError('model_list', getErrorMessage(error));
    throw error;
  }

  if (response.statusCode >= 400) {
    const detail = response.rawText.trim();
    const message = `llama.cpp model list failed with HTTP ${response.statusCode}${detail ? `: ${detail}` : '.'}`;
    logLlamaCppError('model_list', message);
    throw new Error(message);
  }

  return (response.body.data || [])
    .map((entry) => entry.id)
    .filter((value): value is string => Boolean(value && value.trim()));
}

export type LlamaCppProviderStatus = {
  Available: boolean;
  Reachable: boolean;
  BaseUrl: string | null;
  Error: string | null;
};

export async function getLlamaCppProviderStatus(config: SiftConfig): Promise<LlamaCppProviderStatus> {
  const status: LlamaCppProviderStatus = {
    Available: true,
    Reachable: false,
    BaseUrl: null,
    Error: null,
  };

  try {
    status.BaseUrl = getConfiguredLlamaBaseUrl(config);
    const response = await requestJson<LlamaCppModelListResponse>({
      url: `${status.BaseUrl.replace(/\/$/u, '')}/v1/models`,
      method: 'GET',
      timeoutMs: 500,
    });
    if (response.statusCode >= 400) {
      const detail = response.rawText.trim();
      throw new Error(`llama.cpp model list failed with HTTP ${response.statusCode}${detail ? `: ${detail}` : '.'}`);
    }
    status.Reachable = true;
  } catch (error) {
    status.Error = getErrorMessage(error);
    logLlamaCppError('provider_status', status.Error);
  }

  return status;
}

export async function generateLlamaCppResponse(options: {
  config: SiftConfig;
  model: string;
  prompt: string;
  timeoutSeconds: number;
  slotId?: number;
  structuredOutput?: LlamaCppStructuredOutput;
  reasoningOverride?: 'on' | 'off';
  promptTokenCount?: number | null;
  overrides?: Pick<RuntimeLlamaCppConfig, 'MaxTokens'>;
}): Promise<LlamaCppGenerateResult> {
  return generateLlamaCppChatResponse({
    config: options.config,
    model: options.model,
    messages: [
      {
        role: 'user',
        content: options.prompt,
      },
    ],
    timeoutSeconds: options.timeoutSeconds,
    slotId: options.slotId,
    structuredOutput: options.structuredOutput,
    reasoningOverride: options.reasoningOverride,
    promptTokenCount: options.promptTokenCount,
    overrides: options.overrides,
  });
}

function getPromptTimingValue(value: unknown): number | null {
  return Number.isFinite(value) && Number(value) >= 0 ? Number(value) : null;
}

export async function generateLlamaCppChatResponse(options: {
  config: SiftConfig;
  model: string;
  messages: LlamaCppChatMessage[];
  timeoutSeconds: number;
  slotId?: number;
  cachePrompt?: boolean;
  tools?: unknown[];
  structuredOutput?: LlamaCppStructuredOutput;
  reasoningOverride?: 'on' | 'off';
  promptTokenCount?: number | null;
  overrides?: Pick<RuntimeLlamaCppConfig, 'MaxTokens'>;
}): Promise<LlamaCppGenerateResult> {
  const baseUrl = getConfiguredLlamaBaseUrl(options.config);
  const resolvedReasoning = options.reasoningOverride
    ?? getConfiguredLlamaSetting<'on' | 'off'>(options.config, 'Reasoning');
  const serverLlama = (
    options.config.Server?.LlamaCpp
    && typeof options.config.Server.LlamaCpp === 'object'
    && !Array.isArray(options.config.Server.LlamaCpp)
  ) ? options.config.Server.LlamaCpp : null;
  const reasoningContentEnabled = resolvedReasoning === 'on' && serverLlama?.ReasoningContent === true;
  const preserveThinkingEnabled = reasoningContentEnabled && serverLlama?.PreserveThinking === true;
  const structuredOutputResponseFormat = getStructuredOutputResponseFormat(options.structuredOutput);
  const promptChars = options.messages.reduce((total, message) => {
    return total + getTextContent(message.content).length;
  }, 0);
  const maxTokens = getDynamicMaxOutputTokens({
    totalContextTokens: Math.max(1, Number(getConfiguredLlamaNumCtx(options.config) || 0)),
    promptTokenCount: Number.isFinite(options.promptTokenCount) && Number(options.promptTokenCount) > 0
      ? Number(options.promptTokenCount)
      : estimatePromptTokenCountFromCharacters(options.config, promptChars),
  });
  const requestBody = JSON.stringify({
    model: options.model,
    messages: options.messages,
    cache_prompt: options.cachePrompt ?? true,
    ...(Number.isInteger(options.slotId) ? { id_slot: Number(options.slotId) } : {}),
    ...(
      Array.isArray(options.tools)
      && options.tools.length > 0
        ? { tools: options.tools }
        : options.structuredOutput?.kind === 'siftkit-planner-action-json'
          && Array.isArray(options.structuredOutput.tools)
          && options.structuredOutput.tools.length > 0
        ? { tools: options.structuredOutput.tools }
        : {}
    ),
    ...(
      (
        Array.isArray(options.tools) && options.tools.length > 0
      ) || (
        options.structuredOutput?.kind === 'siftkit-planner-action-json'
        && Array.isArray(options.structuredOutput.tools)
        && options.structuredOutput.tools.length > 0
      )
        ? { parallel_tool_calls: true }
        : {}
    ),
    max_tokens: maxTokens,
    ...(resolvedReasoning === undefined ? {} : {
      chat_template_kwargs: {
        enable_thinking: resolvedReasoning === 'on',
        ...(reasoningContentEnabled ? { reasoning_content: true } : {}),
        ...(preserveThinkingEnabled ? { preserve_thinking: true } : {}),
      },
    }),
    ...(structuredOutputResponseFormat === null ? {} : { response_format: structuredOutputResponseFormat }),
  });

  let response: JsonResponse<LlamaCppChatResponse>;
  const startedAt = Date.now();
  traceLlamaCpp(
    `generate start model=${options.model} timeout_s=${options.timeoutSeconds} `
    + `prompt_chars=${promptChars} base_url=${baseUrl}`
  );
  try {
    response = await retryProviderRequest(async () => {
      const nextResponse = await requestJson<LlamaCppChatResponse>({
        url: `${baseUrl.replace(/\/$/u, '')}/v1/chat/completions`,
        method: 'POST',
        timeoutMs: options.timeoutSeconds * 1000,
        body: requestBody,
      });
      if (isTransientProviderHttpResponse(nextResponse.statusCode, nextResponse.rawText)) {
        throw buildTransientProviderHttpError(nextResponse.statusCode, nextResponse.rawText);
      }
      return nextResponse;
    }, {
      onRetry(event) {
        traceLlamaCpp(
          `generate retry attempt=${event.attempt} elapsed_ms=${event.elapsedMs} `
          + `next_delay_ms=${event.nextDelayMs} code=${event.error.code || 'none'}`
        );
      },
    });
  } catch (error) {
    const message = getErrorMessage(error);
    traceLlamaCpp(`generate error elapsed_ms=${Date.now() - startedAt} message=${JSON.stringify(message)}`);
    if (/^Request timed out after \d+ ms\.$/u.test(message)) {
      const timeoutMessage = `llama.cpp generate timed out after ${options.timeoutSeconds} seconds.`;
      logLlamaCppError('generate', timeoutMessage);
      throw new Error(timeoutMessage);
    }
    logLlamaCppError('generate', message);
    throw error;
  }

  if (response.statusCode >= 400) {
    const detail = response.rawText.trim();
    traceLlamaCpp(`generate http_error elapsed_ms=${Date.now() - startedAt} status=${response.statusCode}`);
    const message = `llama.cpp generate failed with HTTP ${response.statusCode}${detail ? `: ${detail}` : '.'}`;
    logLlamaCppError('generate', message);
    throw new Error(message);
  }

  const firstChoice = response.body.choices?.[0];
  const messageText = getTextContent(firstChoice?.message?.content);
  const reasoningText = getTextContent(firstChoice?.message?.reasoning_content);
  const toolCallText = getStructuredToolCallText(options.structuredOutput, firstChoice);
  const text = (messageText || toolCallText || firstChoice?.text || '').trim();
  if (!text) {
    const rawResponseText = response.rawText.trim();
    traceLlamaCpp(`generate empty_body elapsed_ms=${Date.now() - startedAt} raw=${JSON.stringify(rawResponseText.slice(0, 2000))}`);
    const message = `llama.cpp did not return a response body. Raw response: ${rawResponseText.slice(0, 2000) || '<empty>'}`;
    logLlamaCppError('generate', message);
    throw new Error(message);
  }

  const rawUsage = response.body.usage;
  const promptTokens = getUsageValue(rawUsage?.prompt_tokens);
  if (promptTokens !== null && promptTokens > 0) {
    tryRecordAccurateCharTokenObservation({
      chars: promptChars,
      tokens: promptTokens,
      updatedAtUtc: new Date().toISOString(),
    });
  }
  const promptCacheTokens = getPromptTimingValue(response.body.timings?.cache_n)
    ?? getUsageValue(rawUsage?.prompt_tokens_details?.cached_tokens)
    ?? getUsageValue(rawUsage?.input_tokens_details?.cached_tokens);
  const promptEvalTokens = getPromptTimingValue(response.body.timings?.prompt_n)
    ?? (promptTokens !== null && promptCacheTokens !== null ? Math.max(promptTokens - promptCacheTokens, 0) : null);
  const thinkingTokens = getThinkingTokenCount(rawUsage)
    ?? (reasoningText.trim() ? await countLlamaCppTokens(options.config, reasoningText) : null);
  const usage = (rawUsage || promptCacheTokens !== null || promptEvalTokens !== null)
    ? {
      promptTokens,
      completionTokens: getNormalizedCompletionTokens(getUsageValue(rawUsage?.completion_tokens), thinkingTokens),
      totalTokens: getUsageValue(rawUsage?.total_tokens),
      thinkingTokens,
      promptCacheTokens,
      promptEvalTokens,
    }
    : null;

  traceLlamaCpp(
    `generate done elapsed_ms=${Date.now() - startedAt} prompt_tokens=${usage?.promptTokens ?? 'null'} `
    + `completion_tokens=${usage?.completionTokens ?? 'null'} thinking_tokens=${usage?.thinkingTokens ?? 'null'} `
    + `cache_tokens=${usage?.promptCacheTokens ?? 'null'} prompt_eval_tokens=${usage?.promptEvalTokens ?? 'null'} `
    + `output_chars=${text.length}`
  );

  return {
    text,
    usage,
    reasoningText: reasoningText.trim() || null,
  };
}
