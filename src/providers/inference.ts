import {
  getConfiguredEngineBaseUrl,
  getConfiguredEngineNumCtx,
  type SiftConfig,
} from '../config/index.js';
import { resolveGenerationTokenLimit } from '../lib/context-token-budget.js';
import { estimateTokenCount, estimateTokenCountFromCharacters } from '../lib/token-estimate.js';
import { tryRecordAccurateCharTokenObservation } from '../state/observed-budget.js';
import { InferenceClient } from '../llm-protocol/inference-client.js';
import { getErrorMessage } from '../lib/errors.js';
import { HttpTimeoutError, InferenceHttpError } from '../lib/http-client.js';
import type {
  InferenceChatMessage as ProtocolInferenceChatMessage,
  InferenceResponseFormat,
  InferenceToolCall,
  InferenceToolDefinition,
  InferenceUsage,
  LiveContentResult,
  NormalizedInferenceChatResponse,
  StreamStop,
} from '../llm-protocol/types.js';
import { InferenceToolDefinitionSchema } from '../llm-protocol/types.js';
import {
  buildInferenceJsonSchemaResponseFormat,
  buildSummaryDecisionJsonSchema,
} from './structured-output-schema.js';
import type { PlannerToolDefinition } from '../planner-protocol/json-schema.js';
import { createTracer } from '../lib/trace.js';

function logInferenceError(operation: string, message: string): void {
  console.error(`inference ${operation} error: ${message}`);
}

export const DEFAULT_INFERENCE_TOKENIZE_TIMEOUT_MS = 10_000;
export const DEFAULT_INFERENCE_TOKENIZE_RETRY_MAX_WAIT_MS = 30_000;

export type CountInferenceTokensOptions = {
  timeoutMs?: number;
  retryMaxWaitMs?: number;
};

export type InferenceTokenCountResult = {
  tokenCount: number | null;
  elapsedMs: number;
  retryCount: number;
  timeoutMs: number;
  retryMaxWaitMs: number;
  status: 'completed' | 'empty' | 'http_error' | 'error';
  httpStatusCode: number | null;
  errorMessage: string | null;
};

export type InferenceGenerateResult = LiveContentResult & {
  toolCalls: InferenceToolCall[];
  usage: InferenceUsage | null;
  reasoningText: string | null;
  stop: StreamStop;
};

export type InferenceChatMessage = {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content?: string | Array<{ type?: string; text?: string; image_url?: { url: string } }>;
  reasoning_content?: string | Array<{ type?: string; text?: string }>;
  tool_calls?: Array<{
    id?: string;
    type?: string;
    function?: {
      name?: string;
      arguments?: string;
    };
  }>;
  tool_call_id?: string;
};

export type InferenceStructuredOutput =
  | { kind: 'none' }
  | { kind: 'siftkit-decision-json'; allowUnsupportedInput?: boolean };

const traceInference = createTracer('SIFTKIT_TRACE_SUMMARY', 'inference');
const inferenceClient = new InferenceClient();

function getStructuredOutputResponseFormat(
  structuredOutput: InferenceStructuredOutput | undefined
): InferenceResponseFormat | null {
  if (!structuredOutput || structuredOutput.kind === 'none') {
    return null;
  }

  if (structuredOutput.kind === 'siftkit-decision-json') {
    return buildInferenceJsonSchemaResponseFormat({
      name: 'siftkit_decision',
      schema: buildSummaryDecisionJsonSchema({
        allowUnsupportedInput: structuredOutput.allowUnsupportedInput !== false,
      }),
    });
  }

  return null;
}

function getTextContent(content: string | Array<{ type?: string; text?: string; image_url?: { url: string } }> | undefined): string {
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
  content: InferenceChatMessage['content'],
): ProtocolInferenceChatMessage['content'] {
  if (typeof content === 'string' || content === undefined) {
    return content ?? null;
  }
  return content.map((part) => ({
    type: typeof part.type === 'string' ? part.type : 'text',
    ...(typeof part.text === 'string' ? { text: part.text } : {}),
    ...(part.image_url ? { image_url: { url: part.image_url.url } } : {}),
  }));
}

function toProtocolReasoning(
  content: InferenceChatMessage['reasoning_content'],
): ProtocolInferenceChatMessage['reasoning_content'] {
  if (typeof content === 'string' || content === undefined) {
    return content;
  }
  return content.map((part) => ({
    ...(typeof part.type === 'string' ? { type: part.type } : {}),
    ...(typeof part.text === 'string' ? { text: part.text } : {}),
  }));
}

function toProtocolToolCalls(
  toolCalls: InferenceChatMessage['tool_calls'],
): InferenceToolCall[] | undefined {
  if (!Array.isArray(toolCalls)) {
    return undefined;
  }

  return toolCalls.flatMap((toolCall, index): InferenceToolCall[] => {
    const name = typeof toolCall.function?.name === 'string' ? toolCall.function.name : '';
    if (!name.trim()) {
      return [];
    }
    const args = toolCall.function?.arguments ?? '{}';
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

export function toProtocolMessages(messages: readonly InferenceChatMessage[]): ProtocolInferenceChatMessage[] {
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

export function toProtocolTools(tools: readonly PlannerToolDefinition[] | undefined): InferenceToolDefinition[] {
  if (!Array.isArray(tools)) {
    return [];
  }

  return tools.flatMap((tool): InferenceToolDefinition[] => {
    const name = tool.function.name.trim();
    const description = typeof tool.function.description === 'string' ? tool.function.description : '';
    if (!name) {
      return [];
    }
    return [InferenceToolDefinitionSchema.parse({
      type: 'function',
      function: {
        name,
        description,
        parameters: tool.function.parameters ?? { type: 'object', properties: {}, required: [] },
      },
    })];
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

function formatProviderHttpStatus(prefix: string, statusCode: number, detail: string): string {
  const trimmed = detail.trim();
  return `${prefix} with HTTP ${statusCode}${trimmed ? `: ${trimmed}` : '.'}`;
}

function formatProviderHttpError(prefix: string, message: string): string {
  const httpStatusCode = getHttpStatusCode(message);
  if (httpStatusCode === null) {
    return message;
  }
  return formatProviderHttpStatus(prefix, httpStatusCode, message.replace(/^HTTP \d{3}:?\s*/u, ''));
}

export async function countInferenceTokens(
  config: SiftConfig,
  content: string,
  options: CountInferenceTokensOptions = {},
): Promise<number | null> {
  return (await countInferenceTokensDetailed(config, content, options)).tokenCount;
}

export async function countInferenceTokensDetailed(
  config: SiftConfig,
  content: string,
  options: CountInferenceTokensOptions = {},
): Promise<InferenceTokenCountResult> {
  const timeoutMs = getPositiveTimeoutMs(options.timeoutMs, DEFAULT_INFERENCE_TOKENIZE_TIMEOUT_MS);
  const retryMaxWaitMs = getPositiveTimeoutMs(options.retryMaxWaitMs, DEFAULT_INFERENCE_TOKENIZE_RETRY_MAX_WAIT_MS);
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
  traceInference(`tokenize start chars=${content.length}`);
  try {
    const response = await inferenceClient.countTokens(config, content, {
      requestTimeoutSeconds: timeoutMs / 1000,
      retryMaxWaitMs,
    });
    tryRecordAccurateCharTokenObservation({
      chars: content.length,
      tokens: response.tokenCount,
      updatedAtUtc: new Date().toISOString(),
    });
    traceInference(`tokenize done elapsed_ms=${Date.now() - startedAt} tokens=${response.tokenCount}`);
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
    traceInference(`tokenize error elapsed_ms=${Date.now() - startedAt} message=${JSON.stringify(message)}`);
    logInferenceError('tokenize', message);
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

/**
 * The inference server lists every directory under its model root (TabbyAPI includes
 * .git/node_modules/datasets), so the inventory only trusts names a preset declares.
 */
export function filterModelInventory(
  serverModels: readonly string[],
  presetModels: readonly (string | null)[],
): string[] {
  const allowed = new Set(
    presetModels.filter((model): model is string => typeof model === 'string' && model.trim() !== ''),
  );
  return serverModels.filter((model) => allowed.has(model));
}

export async function listInferenceModels(config: SiftConfig): Promise<string[]> {
  const baseUrl = getConfiguredEngineBaseUrl(config);
  try {
    const serverModels = await inferenceClient.listModelsAtBaseUrl(baseUrl, 5000);
    return filterModelInventory(
      serverModels,
      config.Server.ModelPresets.Presets.map((preset) => preset.Model),
    );
  } catch (error) {
    const message = formatProviderHttpError('inference model list failed', getErrorMessage(error));
    logInferenceError('model_list', message);
    throw new Error(message);
  }
}

export type InferenceProviderStatus = {
  Available: boolean;
  Reachable: boolean;
  BaseUrl: string | null;
  Error: string | null;
};

export async function getInferenceProviderStatus(config: SiftConfig): Promise<InferenceProviderStatus> {
  const status: InferenceProviderStatus = {
    Available: true,
    Reachable: false,
    BaseUrl: null,
    Error: null,
  };

  try {
    status.BaseUrl = getConfiguredEngineBaseUrl(config);
    const response = await inferenceClient.probeModelsAtBaseUrl(status.BaseUrl, 500);
    if (response.statusCode >= 400) {
      const detail = response.rawText.trim();
      throw new Error(`inference model list failed with HTTP ${response.statusCode}${detail ? `: ${detail}` : '.'}`);
    }
    status.Reachable = true;
  } catch (error) {
    status.Error = getErrorMessage(error);
    logInferenceError('provider_status', status.Error);
  }

  return status;
}

export async function generateInferenceResponse(options: {
  config: SiftConfig;
  model: string;
  prompt: string;
  /** Maximum gap between SSE frames, not a total duration; the client derives the total deadline from maxTokens. */
  idleTimeoutSeconds: number;
  tools?: PlannerToolDefinition[];
  structuredOutput?: InferenceStructuredOutput;
  reasoningOverride?: 'on' | 'off';
  promptTokenCount?: number | null;
  operationMaxTokens?: number;
}): Promise<InferenceGenerateResult> {
  return generateInferenceChatResponse({
    config: options.config,
    model: options.model,
    messages: [
      {
        role: 'user',
        content: options.prompt,
      },
    ],
    idleTimeoutSeconds: options.idleTimeoutSeconds,
    tools: options.tools,
    structuredOutput: options.structuredOutput,
    reasoningOverride: options.reasoningOverride,
    promptTokenCount: options.promptTokenCount,
    operationMaxTokens: options.operationMaxTokens,
  });
}

export async function generateInferenceChatResponse(options: {
  config: SiftConfig;
  model: string;
  messages: InferenceChatMessage[];
  /** Maximum gap between SSE frames, not a total duration; the client derives the total deadline from maxTokens. */
  idleTimeoutSeconds: number;
  tools?: PlannerToolDefinition[];
  structuredOutput?: InferenceStructuredOutput;
  reasoningOverride?: 'on' | 'off';
  promptTokenCount?: number | null;
  operationMaxTokens?: number;
}): Promise<InferenceGenerateResult> {
  const baseUrl = getConfiguredEngineBaseUrl(options.config);
  const structuredOutputResponseFormat = getStructuredOutputResponseFormat(options.structuredOutput);
  const promptChars = options.messages.reduce((total, message) => {
    return total + getTextContent(message.content).length;
  }, 0);
  const maxTokens = resolveGenerationTokenLimit({
    totalContextTokens: getConfiguredEngineNumCtx(options.config),
    // A measured count when the caller has one; the local estimate is the fallback,
    // and both are whole tokens, so the budget rejects anything else as a bug.
    promptTokenCount: typeof options.promptTokenCount === 'number' && options.promptTokenCount > 0
      ? options.promptTokenCount
      : estimateTokenCountFromCharacters(options.config, promptChars),
    operationMaxTokens: options.operationMaxTokens,
  });

  let response: NormalizedInferenceChatResponse;
  const startedAt = Date.now();
  traceInference(
    `generate start model=${options.model} idle_timeout_s=${options.idleTimeoutSeconds} `
    + `prompt_chars=${promptChars} base_url=${baseUrl}`
  );
  try {
    const protocolTools = toProtocolTools(options.tools);
    const tools = structuredOutputResponseFormat === null ? protocolTools : [];
    response = await inferenceClient.chat({
      config: options.config,
      model: options.model,
      messages: toProtocolMessages(options.messages),
      tools,
      maxTokens,
      responseFormat: structuredOutputResponseFormat ?? undefined,
      reasoningOverride: options.reasoningOverride,
      allowedToolNames: protocolTools.map((tool) => tool.function.name),
      idleTimeoutSeconds: options.idleTimeoutSeconds,
    });
  } catch (error) {
    const message = getErrorMessage(error);
    traceInference(`generate error elapsed_ms=${Date.now() - startedAt} message=${JSON.stringify(message)}`);
    if (error instanceof HttpTimeoutError) {
      const timeoutMessage = `inference generate timed out after ${options.idleTimeoutSeconds} seconds.`;
      logInferenceError('generate', timeoutMessage);
      throw new Error(timeoutMessage);
    }
    const providerMessage = error instanceof InferenceHttpError
      ? formatProviderHttpStatus('inference generate failed', error.statusCode, error.rawText)
      : formatProviderHttpError('inference generate failed', message);
    logInferenceError('generate', providerMessage);
    throw new Error(providerMessage);
  }

  const text = response.text.trim();
  if (!text && response.toolCalls.length === 0) {
    const rawResponseText = JSON.stringify(response.raw);
    traceInference(`generate empty_body elapsed_ms=${Date.now() - startedAt} raw=${JSON.stringify(rawResponseText.slice(0, 2000))}`);
    const message = `inference did not return a response body. Raw response: ${rawResponseText.slice(0, 2000) || '<empty>'}`;
    logInferenceError('generate', message);
    throw new Error(message);
  }

  // Local counting owns what the model consumed and produced; the provider keeps
  // only the cache/prefill/timing stats it alone knows. Prompt counting tokenizes
  // the joined message contents, so it ignores chat-template overhead.
  const countLocally = async (content: string): Promise<number> => {
    const counted = await countInferenceTokensDetailed(options.config, content);
    return counted.status === 'completed' && counted.tokenCount !== null
      ? counted.tokenCount
      : estimateTokenCount(options.config, content);
  };
  // countInferenceTokensDetailed records its own char/token observation on the
  // exact path, so nothing here feeds estimates into the observed budget.
  const promptText = options.messages.map((message) => getTextContent(message.content)).join('\n');
  const promptTokens = await countLocally(promptText);
  const completionTokens = await countLocally(text || JSON.stringify(response.toolCalls));
  const thinkingTokens = response.reasoningText.trim() ? await countLocally(response.reasoningText) : null;
  const usage: InferenceUsage = {
    ...response.usage,
    promptTokens,
    completionTokens,
    outputTokens: completionTokens,
    thinkingTokens,
  };

  traceInference(
    `generate done elapsed_ms=${Date.now() - startedAt} prompt_tokens=${usage.promptTokens ?? 'null'} `
    + `completion_tokens=${usage.completionTokens ?? 'null'} thinking_tokens=${usage.thinkingTokens ?? 'null'} `
    + `cache_tokens=${usage.promptCacheTokens ?? 'null'} prompt_eval_tokens=${usage.promptEvalTokens ?? 'null'} `
    + `output_chars=${text.length}`
  );

  return {
    text,
    rawText: response.rawText.trim(),
    narrationText: response.narrationText.trim(),
    classification: response.classification,
    toolCalls: response.toolCalls,
    usage,
    reasoningText: response.reasoningText.trim() || null,
    stop: response.stop,
  };
}
