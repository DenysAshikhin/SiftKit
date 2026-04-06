import * as http from 'node:http';
import * as https from 'node:https';
import { getConfiguredLlamaBaseUrl, getConfiguredLlamaSetting, type RuntimeLlamaCppConfig, type SiftConfig } from '../config/index.js';

type JsonRequestOptions = {
  url: string;
  method: 'GET' | 'POST';
  timeoutMs: number;
  body?: string;
};

type JsonResponse<T> = {
  statusCode: number;
  body: T;
  rawText: string;
};

type LlamaCppModelListResponse = {
  data?: Array<{ id?: string }>;
};

type LlamaCppTokenizeResponse = {
  tokens?: unknown[];
  count?: unknown;
  token_count?: unknown;
  n_tokens?: unknown;
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
  | { kind: 'siftkit-planner-action-json'; tools?: unknown[] };

function traceLlamaCpp(message: string): void {
  if (process.env.SIFTKIT_TRACE_SUMMARY !== '1') {
    return;
  }

  process.stderr.write(`[siftkit-trace ${new Date().toISOString()}] llama-cpp ${message}\n`);
}

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

function subtractThinkingTokens(value: number | null, thinkingTokens: number | null): number | null {
  if (value === null) {
    return null;
  }

  return Math.max(value - (thinkingTokens ?? 0), 0);
}

function getStructuredOutputGrammar(
  structuredOutput: LlamaCppStructuredOutput | undefined
): string | null {
  if (!structuredOutput || structuredOutput.kind === 'none') {
    return null;
  }

  if (structuredOutput.kind === 'siftkit-decision-json') {
    const classificationOptions = structuredOutput.allowUnsupportedInput === false
      ? ['\\"summary\\"', '\\"command_failure\\"']
      : ['\\"summary\\"', '\\"command_failure\\"', '\\"unsupported_input\\"'];
    return [
      'root ::= object',
      'object ::= "{" ws "\\"classification\\"" ws ":" ws classification ws "," ws "\\"raw_review_required\\"" ws ":" ws boolean ws "," ws "\\"output\\"" ws ":" ws string ws "}"',
      `classification ::= ${classificationOptions.join(' | ')}`,
      'boolean ::= "true" | "false"',
      'string ::= "\\"" char* "\\""',
      'char ::= [^"\\\\\\x7F\\x00-\\x1F] | "\\\\" escape',
      'escape ::= ["\\\\/bfnrt] | "u" hex hex hex hex',
      'hex ::= [0-9a-fA-F]',
      'ws ::= [ \\t\\n\\r]*',
    ].join('\n');
  }

  if (structuredOutput.kind === 'siftkit-planner-action-json') {
    return [
      'root ::= tool_action | finish_action',
      'tool_action ::= "{" ws "\\"action\\"" ws ":" ws "\\"tool\\"" ws "," ws "\\"tool_name\\"" ws ":" ws tool_name ws "," ws "\\"args\\"" ws ":" ws value ws "}"',
      'finish_action ::= "{" ws "\\"action\\"" ws ":" ws "\\"finish\\"" ws "," ws "\\"classification\\"" ws ":" ws classification ws "," ws "\\"raw_review_required\\"" ws ":" ws boolean ws "," ws "\\"output\\"" ws ":" ws string ws "}"',
      'tool_name ::= "\\"find_text\\"" | "\\"read_lines\\"" | "\\"json_filter\\""',
      'classification ::= "\\"summary\\"" | "\\"command_failure\\"" | "\\"unsupported_input\\""',
      'value ::= object | array | string | number | boolean | "null"',
      'object ::= "{" ws members? ws "}"',
      'members ::= pair (ws "," ws pair)*',
      'pair ::= string ws ":" ws value',
      'array ::= "[" ws elements? ws "]"',
      'elements ::= value (ws "," ws value)*',
      'boolean ::= "true" | "false"',
      'number ::= "-"? int frac? exp?',
      'int ::= "0" | [1-9] [0-9]*',
      'frac ::= "." [0-9]+',
      'exp ::= [eE] [+-]? [0-9]+',
      'string ::= "\\"" char* "\\""',
      'char ::= [^"\\\\\\x7F\\x00-\\x1F] | "\\\\" escape',
      'escape ::= ["\\\\/bfnrt] | "u" hex hex hex hex',
      'hex ::= [0-9a-fA-F]',
      'ws ::= [ \\t\\n\\r]*',
    ].join('\n');
  }

  return null;
}

function requestJson<T>(options: JsonRequestOptions): Promise<JsonResponse<T>> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const resolveOnce = (value: JsonResponse<T>): void => {
      if (settled) {
        return;
      }

      settled = true;
      clearTimeout(timeoutHandle);
      resolve(value);
    };
    const rejectOnce = (error: unknown): void => {
      if (settled) {
        return;
      }

      settled = true;
      clearTimeout(timeoutHandle);
      reject(error);
    };
    const target = new URL(options.url);
    const transport = target.protocol === 'https:' ? https : http;
    const request = transport.request(
      {
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port || (target.protocol === 'https:' ? 443 : 80),
        path: `${target.pathname}${target.search}`,
        method: options.method,
        headers: options.body ? {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(options.body, 'utf8'),
        } : undefined,
      },
      (response) => {
        let responseText = '';
        response.setEncoding('utf8');
        response.on('data', (chunk: string) => {
          responseText += chunk;
        });
        response.on('end', () => {
          if (!responseText.trim()) {
            resolveOnce({ statusCode: response.statusCode || 0, body: {} as T, rawText: '' });
            return;
          }

          try {
            resolveOnce({
              statusCode: response.statusCode || 0,
              body: JSON.parse(responseText) as T,
              rawText: responseText,
            });
          } catch (error) {
            rejectOnce(error instanceof Error ? error : new Error(String(error)));
          }
        });
      }
    );

    const timeoutHandle = setTimeout(() => {
      request.destroy(new Error(`Request timed out after ${options.timeoutMs} ms.`));
    }, options.timeoutMs);
    if (typeof timeoutHandle.unref === 'function') {
      timeoutHandle.unref();
    }

    request.on('error', (error) => {
      rejectOnce(error);
    });
    if (options.body) {
      request.write(options.body);
    }
    request.end();
  });
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

function getStructuredToolCallText(
  structuredOutput: LlamaCppStructuredOutput | undefined,
  choice: LlamaCppChatChoice | undefined,
): string {
  if (structuredOutput?.kind !== 'siftkit-planner-action-json') {
    return '';
  }

  const toolCall = choice?.message?.tool_calls?.[0]
    ?? choice?.tool_calls?.[0]
    ?? (choice?.message?.function_call ? { function: choice.message.function_call } : undefined);
  const toolName = typeof toolCall?.function?.name === 'string' ? toolCall.function.name.trim() : '';
  const args = parseToolArguments(toolCall?.function?.arguments);
  if (!toolName || !args) {
    return '';
  }

  return JSON.stringify({
    action: 'tool',
    tool_name: toolName,
    args,
  });
}

export async function countLlamaCppTokens(config: SiftConfig, content: string): Promise<number | null> {
  if (!content.trim()) {
    return 0;
  }

  const startedAt = Date.now();
  traceLlamaCpp(`tokenize start chars=${content.length}`);
  try {
    const baseUrl = getConfiguredLlamaBaseUrl(config);
    const response = await requestJson<LlamaCppTokenizeResponse>({
      url: `${baseUrl.replace(/\/$/u, '')}/tokenize`,
      method: 'POST',
      timeoutMs: 10_000,
      body: JSON.stringify({ content }),
    });

    if (response.statusCode >= 400) {
      traceLlamaCpp(`tokenize http_error elapsed_ms=${Date.now() - startedAt} status=${response.statusCode}`);
      return null;
    }

    const explicitCount = getUsageValue(response.body.count)
      ?? getUsageValue(response.body.token_count)
      ?? getUsageValue(response.body.n_tokens);
    if (explicitCount !== null) {
      traceLlamaCpp(`tokenize done elapsed_ms=${Date.now() - startedAt} tokens=${explicitCount}`);
      return explicitCount;
    }

    if (!Array.isArray(response.body.tokens)) {
      traceLlamaCpp(`tokenize done elapsed_ms=${Date.now() - startedAt} tokens=null`);
      return null;
    }

    traceLlamaCpp(`tokenize done elapsed_ms=${Date.now() - startedAt} tokens=${response.body.tokens.length}`);
    return response.body.tokens.length;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    traceLlamaCpp(`tokenize error elapsed_ms=${Date.now() - startedAt} message=${JSON.stringify(message)}`);
    return null;
  }
}

export async function listLlamaCppModels(config: SiftConfig): Promise<string[]> {
  const baseUrl = getConfiguredLlamaBaseUrl(config);
  const response = await requestJson<LlamaCppModelListResponse>({
    url: `${baseUrl.replace(/\/$/u, '')}/v1/models`,
    method: 'GET',
    timeoutMs: 5000,
  });

  if (response.statusCode >= 400) {
    const detail = response.rawText.trim();
    throw new Error(`llama.cpp model list failed with HTTP ${response.statusCode}${detail ? `: ${detail}` : '.'}`);
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
    await listLlamaCppModels(config);
    status.Reachable = true;
  } catch (error) {
    status.Error = error instanceof Error ? error.message : String(error);
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
  reasoningOverride?: 'on' | 'off' | 'auto';
  overrides?: Pick<
    RuntimeLlamaCppConfig,
    'Temperature' | 'TopP' | 'TopK' | 'MinP' | 'PresencePenalty' | 'RepetitionPenalty' | 'MaxTokens'
  >;
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
  reasoningOverride?: 'on' | 'off' | 'auto';
  overrides?: Pick<
    RuntimeLlamaCppConfig,
    'Temperature' | 'TopP' | 'TopK' | 'MinP' | 'PresencePenalty' | 'RepetitionPenalty' | 'MaxTokens'
  >;
}): Promise<LlamaCppGenerateResult> {
  const baseUrl = getConfiguredLlamaBaseUrl(options.config);
  const resolvedTemperature = options.overrides?.Temperature ?? getConfiguredLlamaSetting<number>(options.config, 'Temperature');
  const resolvedTopP = options.overrides?.TopP ?? getConfiguredLlamaSetting<number>(options.config, 'TopP');
  const resolvedMaxTokens = options.overrides?.MaxTokens ?? getConfiguredLlamaSetting<number | null>(options.config, 'MaxTokens');
  const resolvedTopK = options.overrides?.TopK ?? getConfiguredLlamaSetting<number>(options.config, 'TopK');
  const resolvedMinP = options.overrides?.MinP ?? getConfiguredLlamaSetting<number>(options.config, 'MinP');
  const resolvedPresencePenalty = options.overrides?.PresencePenalty ?? getConfiguredLlamaSetting<number>(options.config, 'PresencePenalty');
  const resolvedRepetitionPenalty = options.overrides?.RepetitionPenalty ?? getConfiguredLlamaSetting<number>(options.config, 'RepetitionPenalty');
  const resolvedReasoning = options.reasoningOverride
    ?? getConfiguredLlamaSetting<'on' | 'off' | 'auto'>(options.config, 'Reasoning');
  const structuredOutputGrammar = getStructuredOutputGrammar(options.structuredOutput);
  const promptChars = options.messages.reduce((total, message) => {
    return total + getTextContent(message.content).length;
  }, 0);
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
    ...(resolvedTemperature === undefined ? {} : { temperature: Number(resolvedTemperature) }),
    ...(resolvedTopP === undefined ? {} : { top_p: Number(resolvedTopP) }),
    ...(resolvedMaxTokens === undefined || resolvedMaxTokens === null ? {} : { max_tokens: Number(resolvedMaxTokens) }),
    ...(resolvedReasoning === 'auto' || resolvedReasoning === undefined ? {} : {
      chat_template_kwargs: {
        enable_thinking: resolvedReasoning === 'on',
      },
    }),
    extra_body: {
      ...(resolvedTopK === undefined ? {} : { top_k: Number(resolvedTopK) }),
      ...(resolvedMinP === undefined ? {} : { min_p: Number(resolvedMinP) }),
      ...(resolvedPresencePenalty === undefined ? {} : { presence_penalty: Number(resolvedPresencePenalty) }),
      ...(resolvedRepetitionPenalty === undefined ? {} : { repeat_penalty: Number(resolvedRepetitionPenalty) }),
      ...(resolvedReasoning === 'off' ? { reasoning_budget: 0 } : {}),
      ...(structuredOutputGrammar === null ? {} : { grammar: structuredOutputGrammar }),
    },
  });

  let response: JsonResponse<LlamaCppChatResponse>;
  const startedAt = Date.now();
  traceLlamaCpp(
    `generate start model=${options.model} timeout_s=${options.timeoutSeconds} `
    + `prompt_chars=${promptChars} base_url=${baseUrl}`
  );
  try {
    response = await requestJson<LlamaCppChatResponse>({
      url: `${baseUrl.replace(/\/$/u, '')}/v1/chat/completions`,
      method: 'POST',
      timeoutMs: options.timeoutSeconds * 1000,
      body: requestBody,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    traceLlamaCpp(`generate error elapsed_ms=${Date.now() - startedAt} message=${JSON.stringify(message)}`);
    if (/^Request timed out after \d+ ms\.$/u.test(message)) {
      throw new Error(`llama.cpp generate timed out after ${options.timeoutSeconds} seconds.`);
    }
    throw error;
  }

  if (response.statusCode >= 400) {
    const detail = response.rawText.trim();
    traceLlamaCpp(`generate http_error elapsed_ms=${Date.now() - startedAt} status=${response.statusCode}`);
    throw new Error(`llama.cpp generate failed with HTTP ${response.statusCode}${detail ? `: ${detail}` : '.'}`);
  }

  const firstChoice = response.body.choices?.[0];
  const messageText = getTextContent(firstChoice?.message?.content);
  const reasoningText = getTextContent(firstChoice?.message?.reasoning_content);
  const toolCallText = getStructuredToolCallText(options.structuredOutput, firstChoice);
  const text = (messageText || toolCallText || firstChoice?.text || '').trim();
  if (!text) {
    const rawResponseText = response.rawText.trim();
    traceLlamaCpp(`generate empty_body elapsed_ms=${Date.now() - startedAt} raw=${JSON.stringify(rawResponseText.slice(0, 2000))}`);
    throw new Error(`llama.cpp did not return a response body. Raw response: ${rawResponseText.slice(0, 2000) || '<empty>'}`);
  }

  const rawUsage = response.body.usage;
  const promptTokens = getUsageValue(rawUsage?.prompt_tokens);
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
      completionTokens: subtractThinkingTokens(getUsageValue(rawUsage?.completion_tokens), thinkingTokens),
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
