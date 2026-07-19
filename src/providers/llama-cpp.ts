import {
  getConfiguredLlamaBaseUrl,
  getConfiguredLlamaNumCtx,
  type RuntimeLlamaCppConfig,
  type SiftConfig,
} from '../config/index.js';
import { estimatePromptTokenCountFromCharacters, getDynamicMaxOutputTokens } from '../lib/dynamic-output-cap.js';
import { ModelJson } from '../lib/model-json.js';
import { tryRecordAccurateCharTokenObservation } from '../state/observed-budget.js';
import { LlamaCppClient } from '../llm-protocol/llama-cpp-client.js';
import { getErrorMessage } from '../lib/errors.js';
import type { OptionalJsonValue } from '../lib/json-types.js';
import type {
  JsonObject,
  LlamaCppChatMessage as ProtocolLlamaCppChatMessage,
  LlamaCppResponseFormat,
  LlamaCppToolCall,
  LlamaCppToolDefinition,
  NormalizedLlamaCppChatResponse,
} from '../llm-protocol/types.js';
import {
  buildLlamaJsonSchemaResponseFormat,
  buildSummaryDecisionJsonSchema,
  buildSummaryPlannerActionJsonSchema,
  type StructuredOutputToolDefinition,
} from './structured-output-schema.js';
import { createTracer } from '../lib/trace.js';

function logLlamaCppError(operation: string, message: string): void {
  console.error(`llama.cpp ${operation} error: ${message}`);
}

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
      arguments?: OptionalJsonValue;
    };
  }>;
  tool_call_id?: string;
};

export type LlamaCppStructuredOutput =
  | { kind: 'none' }
  | { kind: 'siftkit-decision-json'; allowUnsupportedInput?: boolean }
  | { kind: 'siftkit-planner-action-json'; tools?: StructuredOutputToolDefinition[]; allowUnsupportedInput?: boolean };

type PlannerStructuredToolCall = {
  tool_name: string;
  args: JsonObject;
};

const traceLlamaCpp = createTracer('SIFTKIT_TRACE_SUMMARY', 'llama-cpp');
const llamaCppClient = new LlamaCppClient();

function getStructuredOutputResponseFormat(
  structuredOutput: LlamaCppStructuredOutput | undefined
): LlamaCppResponseFormat | null {
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

function toProtocolContent(
  content: LlamaCppChatMessage['content'],
): ProtocolLlamaCppChatMessage['content'] {
  if (typeof content === 'string' || content === undefined) {
    return content ?? null;
  }
  return content.map((part) => ({
    type: typeof part.type === 'string' ? part.type : 'text',
    ...(typeof part.text === 'string' ? { text: part.text } : {}),
  }));
}

function toProtocolReasoning(
  content: LlamaCppChatMessage['reasoning_content'],
): ProtocolLlamaCppChatMessage['reasoning_content'] {
  if (typeof content === 'string' || content === undefined) {
    return content;
  }
  return content.map((part) => ({
    ...(typeof part.type === 'string' ? { type: part.type } : {}),
    ...(typeof part.text === 'string' ? { text: part.text } : {}),
  }));
}

function toProtocolToolCalls(
  toolCalls: LlamaCppChatMessage['tool_calls'],
): LlamaCppToolCall[] | undefined {
  if (!Array.isArray(toolCalls)) {
    return undefined;
  }

  return toolCalls.flatMap((toolCall, index): LlamaCppToolCall[] => {
    const name = typeof toolCall.function?.name === 'string' ? toolCall.function.name : '';
    if (!name.trim()) {
      return [];
    }
    const rawArguments = toolCall.function?.arguments;
    const args = typeof rawArguments === 'string' ? rawArguments : JSON.stringify(rawArguments ?? {});
    return [{
      id: typeof toolCall.id === 'string' && toolCall.id.trim() ? toolCall.id : `call_${index}`,
      type: 'function',
      function: {
        name,
        arguments: args,
      },
    }];
  });
}

export function toProtocolMessages(messages: readonly LlamaCppChatMessage[]): ProtocolLlamaCppChatMessage[] {
  return messages.map((message) => {
    const reasoningContent = toProtocolReasoning(message.reasoning_content);
    const toolCalls = toProtocolToolCalls(message.tool_calls);
    return {
      role: message.role,
      content: toProtocolContent(message.content),
      ...(reasoningContent === undefined ? {} : { reasoning_content: reasoningContent }),
      ...(toolCalls === undefined ? {} : { tool_calls: toolCalls }),
      ...(message.tool_call_id === undefined ? {} : { tool_call_id: message.tool_call_id }),
    };
  });
}

export function toProtocolTools(tools: StructuredOutputToolDefinition[] | undefined): LlamaCppToolDefinition[] {
  if (!Array.isArray(tools)) {
    return [];
  }

  return tools.flatMap((tool): LlamaCppToolDefinition[] => {
    const name = tool.function.name.trim();
    const description = typeof tool.function.description === 'string' ? tool.function.description : '';
    if (!name) {
      return [];
    }
    return [{
      type: 'function',
      function: {
        name,
        description,
        parameters: tool.function.parameters ?? { type: 'object', properties: {}, required: [] },
      },
    }];
  });
}

function hasUsageValue(usage: NormalizedLlamaCppChatResponse['usage']): boolean {
  return usage.promptTokens !== null
    || usage.completionTokens !== null
    || usage.totalTokens !== null
    || usage.thinkingTokens !== null
    || usage.promptCacheTokens !== null
    || usage.promptEvalTokens !== null;
}

function parseStructuredPlannerToolCall(toolCall: LlamaCppToolCall | null | undefined): PlannerStructuredToolCall | null {
  const toolName = typeof toolCall?.function?.name === 'string' ? toolCall.function.name.trim() : '';
  const args = ModelJson.parseToolArguments(toolCall?.function?.arguments);
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
  toolCalls: readonly LlamaCppToolCall[],
): string {
  if (structuredOutput?.kind !== 'siftkit-planner-action-json') {
    return '';
  }

  const parsedToolCalls = toolCalls
    .map((toolCall) => parseStructuredPlannerToolCall(toolCall))
    .filter((toolCall): toolCall is PlannerStructuredToolCall => toolCall !== null);

  if (parsedToolCalls.length === 0) {
    return '';
  }

  if (parsedToolCalls.length === 1) {
    return JSON.stringify({
      action: parsedToolCalls[0].tool_name,
      ...parsedToolCalls[0].args,
    });
  }

  return JSON.stringify({
    action: 'tool_batch',
    calls: parsedToolCalls.map((toolCall) => ({
      action: toolCall.tool_name,
      ...toolCall.args,
    })),
  });
}

function getPositiveTimeoutMs(value: number | undefined, fallback: number): number {
  const numericValue = Number(value);
  return Number.isFinite(numericValue) && numericValue > 0
    ? Math.max(1, Math.trunc(numericValue))
    : fallback;
}

function getHttpStatusCode(message: string): number | null {
  const match = /^HTTP (\d{3})(?::|\b)/u.exec(message.trim());
  return match ? Number(match[1]) : null;
}

function formatProviderHttpError(prefix: string, message: string): string {
  const httpStatusCode = getHttpStatusCode(message);
  if (httpStatusCode === null) {
    return message;
  }
  const detail = message.replace(/^HTTP \d{3}:?\s*/u, '').trim();
  return `${prefix} with HTTP ${httpStatusCode}${detail ? `: ${detail}` : '.'}`;
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
  traceLlamaCpp(`tokenize start chars=${content.length}`);
  try {
    const response = await llamaCppClient.countTokens(config, content, {
      requestTimeoutSeconds: timeoutMs / 1000,
      retryMaxWaitMs,
    });
    tryRecordAccurateCharTokenObservation({
      chars: content.length,
      tokens: response.tokenCount,
      updatedAtUtc: new Date().toISOString(),
    });
    traceLlamaCpp(`tokenize done elapsed_ms=${Date.now() - startedAt} tokens=${response.tokenCount}`);
    return {
      tokenCount: response.tokenCount,
      elapsedMs: Date.now() - startedAt,
      retryCount: 0,
      timeoutMs,
      retryMaxWaitMs,
      status: 'completed',
      httpStatusCode: 200,
      errorMessage: null,
    };
  } catch (error) {
    const message = getErrorMessage(error);
    const httpStatusCode = getHttpStatusCode(message);
    traceLlamaCpp(`tokenize error elapsed_ms=${Date.now() - startedAt} message=${JSON.stringify(message)}`);
    logLlamaCppError('tokenize', message);
    return {
      tokenCount: null,
      elapsedMs: Date.now() - startedAt,
      retryCount: 0,
      timeoutMs,
      retryMaxWaitMs,
      status: httpStatusCode === null ? 'error' : 'http_error',
      httpStatusCode,
      errorMessage: httpStatusCode === null ? message : `HTTP ${httpStatusCode}`,
    };
  }
}

export async function listLlamaCppModels(config: SiftConfig): Promise<string[]> {
  const baseUrl = getConfiguredLlamaBaseUrl(config);
  try {
    return await llamaCppClient.listModelsAtBaseUrl(baseUrl, 5000);
  } catch (error) {
    const message = formatProviderHttpError('llama.cpp model list failed', getErrorMessage(error));
    logLlamaCppError('model_list', message);
    throw new Error(message);
  }
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
    const response = await llamaCppClient.probeModelsAtBaseUrl(status.BaseUrl, 500);
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

export async function generateLlamaCppChatResponse(options: {
  config: SiftConfig;
  model: string;
  messages: LlamaCppChatMessage[];
  timeoutSeconds: number;
  slotId?: number;
  cachePrompt?: boolean;
  tools?: StructuredOutputToolDefinition[];
  structuredOutput?: LlamaCppStructuredOutput;
  reasoningOverride?: 'on' | 'off';
  promptTokenCount?: number | null;
  overrides?: Pick<RuntimeLlamaCppConfig, 'MaxTokens'>;
}): Promise<LlamaCppGenerateResult> {
  const baseUrl = getConfiguredLlamaBaseUrl(options.config);
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

  let response: NormalizedLlamaCppChatResponse;
  const startedAt = Date.now();
  traceLlamaCpp(
    `generate start model=${options.model} timeout_s=${options.timeoutSeconds} `
    + `prompt_chars=${promptChars} base_url=${baseUrl}`
  );
  try {
    const structuredTools = options.structuredOutput?.kind === 'siftkit-planner-action-json'
      ? options.structuredOutput.tools
      : undefined;
    const protocolTools = toProtocolTools(options.tools ?? structuredTools);
    const tools = structuredOutputResponseFormat === null ? protocolTools : [];
    response = await llamaCppClient.chat({
      config: options.config,
      model: options.model,
      messages: toProtocolMessages(options.messages),
      tools,
      maxTokens,
      stream: false,
      responseFormat: structuredOutputResponseFormat ?? undefined,
      reasoningOverride: options.reasoningOverride,
      allowedToolNames: protocolTools.map((tool) => tool.function.name),
      requestTimeoutSeconds: options.timeoutSeconds,
      cachePrompt: options.cachePrompt ?? true,
      slotId: options.slotId,
    });
  } catch (error) {
    const message = getErrorMessage(error);
    traceLlamaCpp(`generate error elapsed_ms=${Date.now() - startedAt} message=${JSON.stringify(message)}`);
    if (/^Request timed out after \d+ ms\.$/u.test(message)) {
      const timeoutMessage = `llama.cpp generate timed out after ${options.timeoutSeconds} seconds.`;
      logLlamaCppError('generate', timeoutMessage);
      throw new Error(timeoutMessage);
    }
    const providerMessage = formatProviderHttpError('llama.cpp generate failed', message);
    logLlamaCppError('generate', providerMessage);
    throw new Error(providerMessage);
  }

  const toolCallText = getStructuredToolCallText(options.structuredOutput, response.toolCalls);
  const text = (response.text || toolCallText).trim();
  if (!text) {
    const rawResponseText = JSON.stringify(response.raw);
    traceLlamaCpp(`generate empty_body elapsed_ms=${Date.now() - startedAt} raw=${JSON.stringify(rawResponseText.slice(0, 2000))}`);
    const message = `llama.cpp did not return a response body. Raw response: ${rawResponseText.slice(0, 2000) || '<empty>'}`;
    logLlamaCppError('generate', message);
    throw new Error(message);
  }

  const promptTokens = response.usage.promptTokens;
  if (promptTokens !== null && promptTokens > 0) {
    tryRecordAccurateCharTokenObservation({
      chars: promptChars,
      tokens: promptTokens,
      updatedAtUtc: new Date().toISOString(),
    });
  }
  const thinkingTokens = response.usage.thinkingTokens
    ?? (response.reasoningText.trim() ? await countLlamaCppTokens(options.config, response.reasoningText) : null);
  const usage = hasUsageValue(response.usage) || thinkingTokens !== null
    ? {
      promptTokens,
      completionTokens: response.usage.completionTokens,
      totalTokens: response.usage.totalTokens,
      thinkingTokens,
      promptCacheTokens: response.usage.promptCacheTokens,
      promptEvalTokens: response.usage.promptEvalTokens,
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
    reasoningText: response.reasoningText.trim() || null,
  };
}
