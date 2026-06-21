import {
  getActiveManagedLlamaPreset,
  getConfiguredLlamaBaseUrl,
  getConfiguredLlamaSetting,
  type SiftConfig,
} from '../config/index.js';
import { httpClient, LlamaHttpError, type FullJsonResponse } from '../lib/http-client.js';
import {
  buildTransientProviderHttpError,
  buildProviderErrorMessage,
  getCompletionUsageFromResponseBody,
  getPromptUsageFromResponseBody,
  getTimingUsageFromResponseBody,
  isTransientProviderHttpResponse,
  serializeNetworkError,
  retryProviderRequest,
} from '../lib/provider-helpers.js';
import { getNormalizedCompletionTokens } from '../lib/telemetry-metrics.js';
import { z } from '../lib/zod.js';
import { JsonValueSchema, JsonObjectSchema, type OptionalJsonValue } from '../lib/json-types.js';
import type {
  JsonObject,
  LlamaCppChatMessage,
  LlamaCppChatRequest,
  LlamaCppToolDefinition,
  LlamaCppUsage,
  NormalizedLlamaCppChatResponse,
} from './types.js';
import { LlamaCppToolCallParser } from './tool-call-parser.js';

type LlamaCppHttpClient = Pick<typeof httpClient, 'requestJsonFull' | 'streamSse'>;

const RawContentPartSchema = z.object({
  type: z.string().optional(),
  text: z.string().optional(),
});

const RawToolCallSchema = z.object({
  id: z.string().optional(),
  type: z.string().optional(),
  function: z.object({
    name: z.string().optional(),
    arguments: z.string().optional(),
  }).optional(),
});

const RawTokenDetailsSchema = z.object({
  reasoning_tokens: z.number().optional(),
  thinking_tokens: z.number().optional(),
});

const RawCachedTokenDetailsSchema = z.object({
  cached_tokens: z.number().optional(),
});

const RawChatResponseSchema = z.object({
  choices: z.array(z.object({
    text: z.string().optional(),
    message: z.object({
      content: z.union([z.string(), z.array(RawContentPartSchema)]).optional(),
      reasoning_content: z.union([z.string(), z.array(RawContentPartSchema)]).optional(),
      tool_calls: z.array(RawToolCallSchema).optional(),
      function_call: z.object({
        name: z.string().optional(),
        arguments: z.string().optional(),
      }).optional(),
    }).optional(),
    tool_calls: z.array(RawToolCallSchema).optional(),
  })).optional(),
  usage: z.object({
    prompt_tokens: z.number().optional(),
    completion_tokens: z.number().optional(),
    total_tokens: z.number().optional(),
    reasoning_tokens: z.number().optional(),
    thinking_tokens: z.number().optional(),
    completion_tokens_details: RawTokenDetailsSchema.optional(),
    prompt_tokens_details: RawCachedTokenDetailsSchema.optional(),
    input_tokens_details: RawCachedTokenDetailsSchema.optional(),
    output_tokens_details: RawTokenDetailsSchema.optional(),
  }).optional(),
  timings: z.object({
    cache_n: z.number().optional(),
    prompt_n: z.number().optional(),
  }).optional(),
});
type RawChatResponse = z.infer<typeof RawChatResponseSchema>;

const RawTokenizeResponseSchema = z.object({
  count: z.number().optional(),
  token_count: z.number().optional(),
  n_tokens: z.number().optional(),
  tokens: z.array(JsonValueSchema).optional(),
});
type RawTokenizeResponse = z.infer<typeof RawTokenizeResponseSchema>;

const RawModelListResponseSchema = z.object({
  data: z.array(z.object({ id: z.string().optional(), model: z.string().optional() })).optional(),
  models: z.array(z.string()).optional(),
});
type RawModelListResponse = z.infer<typeof RawModelListResponseSchema>;

export type LlamaCppModelProbeResult = {
  statusCode: number;
  rawText: string;
  models: string[];
};

export type LlamaCppChatOptions = {
  config: SiftConfig;
  baseUrl?: string;
  model: string;
  messages: LlamaCppChatMessage[];
  tools: LlamaCppToolDefinition[];
  maxTokens: number;
  temperature?: number;
  cachePrompt?: boolean;
  slotId?: number;
  stream: boolean;
  responseFormat?: LlamaCppChatRequest['response_format'];
  reasoningOverride?: 'on' | 'off';
  allowedToolNames: string[];
  requestTimeoutSeconds?: number;
  retryMaxWaitMs?: number;
  abortSignal?: AbortSignal;
  extraBody?: JsonObject;
  onThinkingDelta?: (accumulatedThinking: string) => void;
  onContentDelta?: (accumulatedContent: string) => void;
};

export class LlamaCppClient {
  constructor(private readonly client: LlamaCppHttpClient = httpClient) {}

  async countTokens(
    config: SiftConfig,
    content: string,
    options: { requestTimeoutSeconds?: number; retryMaxWaitMs?: number } = {},
  ): Promise<{ tokenCount: number; raw: JsonObject }> {
    const baseUrl = getConfiguredLlamaBaseUrl(config);
    const response = await retryProviderRequest(async () => {
      const nextResponse = await this.client.requestJsonFull({
        url: `${baseUrl.replace(/\/$/u, '')}/tokenize`,
        method: 'POST',
        timeoutMs: Math.max(1, options.requestTimeoutSeconds ?? 30) * 1000,
        body: JSON.stringify({ content }),
      }, RawTokenizeResponseSchema);
      if (isTransientProviderHttpResponse(nextResponse.statusCode, nextResponse.rawText)) {
        throw buildTransientProviderHttpError(nextResponse.statusCode, nextResponse.rawText);
      }
      return nextResponse;
    }, options.retryMaxWaitMs ? { maxWaitMs: options.retryMaxWaitMs } : undefined);
    if (response.statusCode >= 400) {
      throw new Error(`HTTP ${response.statusCode}: ${response.rawText.trim()}`);
    }
    const tokenCount = getUsageValue(response.body.count)
      ?? getUsageValue(response.body.token_count)
      ?? getUsageValue(response.body.n_tokens)
      ?? (Array.isArray(response.body.tokens) ? response.body.tokens.length : null)
      ?? 0;
    return { tokenCount, raw: toJsonObject(response.body) };
  }

  async listModels(config: SiftConfig): Promise<string[]> {
    const baseUrl = getConfiguredLlamaBaseUrl(config);
    return this.listModelsAtBaseUrl(baseUrl, 5000);
  }

  async listModelsAtBaseUrl(baseUrl: string, timeoutMs = 5000): Promise<string[]> {
    const response = await retryProviderRequest(async () => {
      const nextResponse = await this.probeModelsAtBaseUrl(baseUrl, timeoutMs);
      if (isTransientProviderHttpResponse(nextResponse.statusCode, nextResponse.rawText)) {
        throw buildTransientProviderHttpError(nextResponse.statusCode, nextResponse.rawText);
      }
      return nextResponse;
    });
    if (response.statusCode >= 400) {
      throw new Error(`HTTP ${response.statusCode}: ${response.rawText.trim()}`);
    }
    return response.models;
  }

  async probeModelsAtBaseUrl(baseUrl: string, timeoutMs = 5000): Promise<LlamaCppModelProbeResult> {
    const response = await this.client.requestJsonFull({
      url: `${baseUrl.replace(/\/$/u, '')}/v1/models`,
      method: 'GET',
      timeoutMs,
    }, RawModelListResponseSchema);
    const dataModels = (response.body.data || [])
      .map((model) => model.id || model.model || '')
      .filter((model) => model.trim());
    return {
      statusCode: response.statusCode,
      rawText: response.rawText,
      models: dataModels.length > 0 ? dataModels : (response.body.models || []).filter((model) => model.trim()),
    };
  }

  async getStatus(config: SiftConfig): Promise<{ ok: boolean; models: string[]; error: string | null }> {
    try {
      const models = await this.listModels(config);
      return { ok: true, models, error: null };
    } catch (error) {
      return { ok: false, models: [], error: error instanceof Error ? error.message : String(error) };
    }
  }

  async chat(options: LlamaCppChatOptions): Promise<NormalizedLlamaCppChatResponse> {
    const baseUrl = options.baseUrl || getConfiguredLlamaBaseUrl(options.config);
    if (options.stream) {
      return this.streamChatAtBaseUrl(baseUrl, options);
    }
    const requestOnce = async (): Promise<FullJsonResponse<RawChatResponse>> => {
      const nextResponse = await this.client.requestJsonFull({
        url: `${baseUrl.replace(/\/$/u, '')}/v1/chat/completions`,
        method: 'POST',
        timeoutMs: Math.max(1, options.requestTimeoutSeconds ?? 300) * 1000,
        body: JSON.stringify(this.buildChatRequest(options)),
        abortSignal: options.abortSignal,
      }, RawChatResponseSchema);
      if (isTransientProviderHttpResponse(nextResponse.statusCode, nextResponse.rawText)) {
        throw buildTransientProviderHttpError(nextResponse.statusCode, nextResponse.rawText);
      }
      return nextResponse;
    };
    const response = options.retryMaxWaitMs === 0
      ? await requestOnce()
      : await retryProviderRequest(
        requestOnce,
        options.retryMaxWaitMs ? { maxWaitMs: options.retryMaxWaitMs } : undefined,
      );
    if (response.statusCode >= 400) {
      throw new Error(`HTTP ${response.statusCode}: ${response.rawText.trim()}`);
    }
    return this.normalizeChatResponse(response, options.allowedToolNames);
  }

  private buildChatRequest(options: LlamaCppChatOptions): LlamaCppChatRequest {
    const activePreset = getActiveManagedLlamaPreset(options.config);
    const resolvedReasoning = options.reasoningOverride
      ?? getConfiguredLlamaSetting(options.config, 'Reasoning')
      ?? activePreset?.Reasoning;
    const reasoningContentEnabled = resolvedReasoning === 'on' && activePreset?.ReasoningContent === true;
    const preserveThinkingEnabled = reasoningContentEnabled && activePreset?.PreserveThinking === true;
    return {
      model: options.model,
      messages: options.messages,
      cache_prompt: options.cachePrompt ?? true,
      ...(Number.isInteger(options.slotId) ? { id_slot: Number(options.slotId) } : {}),
      ...(typeof options.temperature === 'number' ? { temperature: options.temperature } : {}),
      ...(options.tools.length > 0 ? { tools: options.tools, parallel_tool_calls: true } : {}),
      max_tokens: options.maxTokens,
      stream: options.stream,
      ...(resolvedReasoning === undefined ? {} : {
        chat_template_kwargs: {
          enable_thinking: resolvedReasoning === 'on',
          ...(reasoningContentEnabled ? { reasoning_content: true } : {}),
          ...(preserveThinkingEnabled ? { preserve_thinking: true } : {}),
        },
      }),
      ...(options.responseFormat ? { response_format: options.responseFormat } : {}),
      ...(options.extraBody || {}),
    };
  }

  private async streamChatAtBaseUrl(baseUrl: string, options: LlamaCppChatOptions): Promise<NormalizedLlamaCppChatResponse> {
    const startedAt = Date.now();
    const url = `${baseUrl.replace(/\/$/u, '')}/v1/chat/completions`;
    const body = JSON.stringify({ ...this.buildChatRequest(options), stream: true, timings_per_token: true });
    const parser = new LlamaCppToolCallParser(options.allowedToolNames);
    const toolChunks = new Map<number, { id: string; name: string; argumentsText: string }>();
    let contentText = '';
    let reasoningText = '';
    let promptTokens: number | null = null;
    let completionTokens: number | null = null;
    let thinkingTokens: number | null = null;
    let promptCacheTokens: number | null = null;
    let promptEvalTokens: number | null = null;
    let generationStartedAt: number | null = null;
    let promptEvalDurationMs: number | null = null;
    let generationDurationMs: number | null = null;
    let earlyStopReason: string | null = null;

    try {
      await this.client.streamSse(
        { url, body, timeoutMs: Math.max(1, options.requestTimeoutSeconds ?? 300) * 1000, abortSignal: options.abortSignal },
        (packet) => {
          const promptUsage = getPromptUsageFromResponseBody(packet);
          const completionUsage = getCompletionUsageFromResponseBody(packet);
          const timingUsage = getTimingUsageFromResponseBody(packet);
          promptTokens = promptUsage.promptTokens ?? promptTokens;
          promptCacheTokens = promptUsage.promptCacheTokens ?? promptCacheTokens;
          promptEvalTokens = promptUsage.promptEvalTokens ?? promptEvalTokens;
          completionTokens = completionUsage.completionTokens ?? completionTokens;
          thinkingTokens = completionUsage.thinkingTokens ?? thinkingTokens;
          promptEvalDurationMs = timingUsage.promptEvalDurationMs ?? promptEvalDurationMs;
          generationDurationMs = timingUsage.generationDurationMs ?? generationDurationMs;

          const firstChoice = Array.isArray(packet.choices) ? packet.choices[0] : undefined;
          const choice = isRecord(firstChoice) ? firstChoice : undefined;
          const delta = choice && isRecord(choice.delta) ? choice.delta : {};
          const deltaReasoning = getString(delta.reasoning_content) || getString(delta.thinking) || getString(delta.reasoning);
          const deltaContent = getString(delta.content);
          if (deltaReasoning || deltaContent || Array.isArray(delta.tool_calls)) {
            generationStartedAt ??= Date.now();
          }
          if (deltaReasoning) {
            reasoningText += deltaReasoning;
            const completedAction = findFirstCompleteJsonObjectText(reasoningText);
            if (completedAction && /"action"\s*:/u.test(completedAction)) {
              contentText = completedAction;
              reasoningText = '';
              earlyStopReason = 'planner action completed in streamed reasoning';
              return 'stop';
            }
            options.onThinkingDelta?.(reasoningText);
          }
          if (deltaContent) {
            contentText += deltaContent;
          }
          if (Array.isArray(delta.tool_calls)) {
            for (const rawToolCall of delta.tool_calls) {
              if (!isRecord(rawToolCall)) continue;
              const index = Number.isInteger(rawToolCall.index) ? Number(rawToolCall.index) : toolChunks.size;
              const fn = isRecord(rawToolCall.function) ? rawToolCall.function : {};
              const current = toolChunks.get(index) || { id: `call_${index}`, name: '', argumentsText: '' };
              toolChunks.set(index, {
                id: getString(rawToolCall.id) || current.id,
                name: current.name + getString(fn.name),
                argumentsText: current.argumentsText + getString(fn.arguments),
              });
            }
          }

          const repetition = getRecentTokenRepetition(contentText) || getRecentTokenRepetition(reasoningText);
          if (repetition) {
            earlyStopReason = repetition.reason;
            if (contentText) contentText = repetition.truncatedText;
            options.onContentDelta?.(contentText);
            return 'stop';
          }
          const structural = getRunawayStructuralTail(contentText) || getRunawayStructuralTail(reasoningText);
          if (structural) {
            earlyStopReason = structural.reason;
            if (contentText) contentText = structural.truncatedText;
            options.onContentDelta?.(contentText);
            return 'stop';
          }
          if (deltaContent) {
            options.onContentDelta?.(contentText);
          }
          return undefined;
        },
      );
    } catch (error) {
      if (error instanceof LlamaHttpError && isTransientProviderHttpResponse(error.statusCode, error.rawText)) {
        throw buildTransientProviderHttpError(error.statusCode, error.rawText);
      }
      throw error instanceof Error ? error : new Error(String(error));
    }

    const finishedAt = Date.now();
    const toolCalls = Array.from(toolChunks.entries())
      .sort(([left], [right]) => left - right)
      .map(([, toolCall]) => parser.parseToolCall({
        id: toolCall.id,
        type: 'function',
        function: { name: toolCall.name, arguments: toolCall.argumentsText },
      }))
      .filter((toolCall): toolCall is NonNullable<typeof toolCall> => toolCall !== null);
    const promptEvalDuration = promptEvalDurationMs ?? (generationStartedAt === null ? null : Math.max(generationStartedAt - startedAt, 0));
    const generationDuration = generationDurationMs ?? (generationStartedAt === null ? null : Math.max(finishedAt - generationStartedAt, 0));
    return {
      text: contentText,
      reasoningText,
      toolCalls,
      usage: {
        promptTokens,
        completionTokens,
        totalTokens: null,
        outputTokens: completionTokens,
        thinkingTokens,
        promptCacheTokens,
        promptEvalTokens,
        promptEvalDurationMs: promptEvalDuration,
        generationDurationMs: generationDuration,
      },
      raw: {},
      stoppedEarly: earlyStopReason !== null,
      ...(earlyStopReason ? { earlyStopReason } : {}),
    };
  }

  private normalizeChatResponse(response: FullJsonResponse<RawChatResponse>, allowedToolNames: string[]): NormalizedLlamaCppChatResponse {
    const firstChoice = response.body.choices?.[0] || {};
    const message = firstChoice.message;
    const reasoningText = getTextContent(message?.reasoning_content);
    const text = getTextContent(message?.content) || firstChoice.text || '';
    const thinkingTokens = getThinkingTokens(response.body.usage);
    const promptTokens = getUsageValue(response.body.usage?.prompt_tokens);
    const promptCacheTokens = getUsageValue(response.body.timings?.cache_n)
      ?? getUsageValue(response.body.usage?.prompt_tokens_details?.cached_tokens)
      ?? getUsageValue(response.body.usage?.input_tokens_details?.cached_tokens);
    const usage: LlamaCppUsage = {
      promptTokens,
      completionTokens: getNormalizedCompletionTokens(getUsageValue(response.body.usage?.completion_tokens), thinkingTokens),
      totalTokens: getUsageValue(response.body.usage?.total_tokens),
      outputTokens: getUsageValue(response.body.usage?.completion_tokens),
      thinkingTokens,
      promptCacheTokens,
      promptEvalTokens: getUsageValue(response.body.timings?.prompt_n)
        ?? (promptTokens !== null && promptCacheTokens !== null ? Math.max(promptTokens - promptCacheTokens, 0) : null),
    };
    return {
      text,
      reasoningText,
      toolCalls: new LlamaCppToolCallParser(allowedToolNames).parseFromChoice(firstChoice),
      usage,
      raw: toJsonObject(response.body),
      stoppedEarly: false,
    };
  }
}

function getTextContent(content: string | Array<{ type?: string; text?: string }> | undefined): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((part) => typeof part.text === 'string' ? part.text : '').join('');
}

function getString(value: OptionalJsonValue): string {
  return typeof value === 'string' ? value : '';
}

function isRecord(value: OptionalJsonValue): value is JsonObject {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function getRunawayStructuralTail(text: string): { reason: string; truncatedText: string } | null {
  if (!/"action"\s*:/u.test(text)) return null;
  const lastChar = text.at(-1) || '';
  if (lastChar !== '}' && lastChar !== ']') return null;
  let repeated = 0;
  for (let index = text.length - 1; index >= 0 && text[index] === lastChar; index -= 1) {
    repeated += 1;
  }
  if (repeated < 96) return null;
  return {
    reason: `runaway streamed planner content repeated '${lastChar}' ${repeated} times`,
    truncatedText: text.slice(0, text.length - repeated + 96),
  };
}

function getRecentTokenRepetition(text: string): { reason: string; truncatedText: string } | null {
  const repeatedArgTag = /(?:<\/arg_value>){48,}$/u.exec(text);
  if (repeatedArgTag?.index !== undefined) {
    return {
      reason: 'recent planner content tokens repeated every 1 tokens across the last 48 tokens after 200 tokens',
      truncatedText: text.slice(0, repeatedArgTag.index).trim(),
    };
  }
  const tokens = text.trim().split(/\s+/u).filter(Boolean);
  if (tokens.length < 200) return null;
  for (let period = 1; period <= 32; period += 1) {
    const tail = tokens.slice(-period).join(' ');
    if (!tail || tail.length < 48) continue;
    const repeated = Array.from({ length: 3 }, () => tail).join(' ');
    if (tokens.slice(-(period * 3)).join(' ') === repeated) {
      const keepTokens = tokens.slice(0, tokens.length - (period * 2));
      return {
        reason: `recent planner content tokens repeated every ${period} tokens across the last ${period * 3} tokens after ${tokens.length} tokens`,
        truncatedText: keepTokens.join(' '),
      };
    }
  }
  return null;
}

function findFirstCompleteJsonObjectText(text: string): string | null {
  const startIndex = text.indexOf('{');
  if (startIndex < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = startIndex; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }
    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === '{') {
      depth += 1;
      continue;
    }
    if (char === '}') {
      depth -= 1;
      if (depth === 0) return text.slice(startIndex, index + 1).trim();
      if (depth < 0) return null;
    }
  }
  return null;
}

function getUsageValue(value: OptionalJsonValue): number | null {
  return Number.isFinite(value) && Number(value) >= 0 ? Number(value) : null;
}

function getThinkingTokens(usage: RawChatResponse['usage']): number | null {
  for (const details of [usage?.completion_tokens_details, usage?.output_tokens_details]) {
    const detailReasoning = getUsageValue(details?.reasoning_tokens);
    const detailThinking = getUsageValue(details?.thinking_tokens);
    if (detailReasoning !== null || detailThinking !== null) {
      return (detailReasoning ?? 0) + (detailThinking ?? 0);
    }
  }
  const topReasoning = getUsageValue(usage?.reasoning_tokens);
  const topThinking = getUsageValue(usage?.thinking_tokens);
  if (topReasoning !== null || topThinking !== null) {
    return (topReasoning ?? 0) + (topThinking ?? 0);
  }
  return null;
}

function toJsonObject(value: object): JsonObject {
  return JsonObjectSchema.parse(JSON.parse(JSON.stringify(value)));
}
