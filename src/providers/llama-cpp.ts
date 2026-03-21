import * as http from 'node:http';
import * as https from 'node:https';
import { getConfiguredLlamaBaseUrl, getConfiguredLlamaSetting, type RuntimeLlamaCppConfig, type SiftConfig } from '../config.js';

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
};

type LlamaCppChatResponse = {
  choices?: Array<{
    message?: {
      content?: string | Array<{ type?: string; text?: string }>;
      reasoning_content?: string | Array<{ type?: string; text?: string }>;
    };
    text?: string;
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
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
};

export type LlamaCppUsage = {
  promptTokens: number | null;
  completionTokens: number | null;
  totalTokens: number | null;
  thinkingTokens: number | null;
};

export type LlamaCppGenerateResult = {
  text: string;
  usage: LlamaCppUsage | null;
};

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

function requestJson<T>(options: JsonRequestOptions): Promise<JsonResponse<T>> {
  return new Promise((resolve, reject) => {
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
            resolve({ statusCode: response.statusCode || 0, body: {} as T, rawText: '' });
            return;
          }

          try {
            resolve({
              statusCode: response.statusCode || 0,
              body: JSON.parse(responseText) as T,
              rawText: responseText,
            });
          } catch (error) {
            reject(error);
          }
        });
      }
    );

    request.setTimeout(options.timeoutMs, () => {
      request.destroy(new Error(`Request timed out after ${options.timeoutMs} ms.`));
    });
    request.on('error', reject);
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

async function countLlamaCppTokens(config: SiftConfig, content: string): Promise<number | null> {
  if (!content.trim()) {
    return 0;
  }

  try {
    const baseUrl = getConfiguredLlamaBaseUrl(config);
    const response = await requestJson<LlamaCppTokenizeResponse>({
      url: `${baseUrl.replace(/\/$/u, '')}/tokenize`,
      method: 'POST',
      timeoutMs: 10_000,
      body: JSON.stringify({ content }),
    });

    if (response.statusCode >= 400 || !Array.isArray(response.body.tokens)) {
      return null;
    }

    return response.body.tokens.length;
  } catch {
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

export async function getLlamaCppProviderStatus(config: SiftConfig): Promise<Record<string, unknown>> {
  const status: Record<string, unknown> = {
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
  const requestBody = JSON.stringify({
    model: options.model,
    messages: [
      {
        role: 'user',
        content: options.prompt,
      },
    ],
    ...(resolvedTemperature === undefined ? {} : { temperature: Number(resolvedTemperature) }),
    ...(resolvedTopP === undefined ? {} : { top_p: Number(resolvedTopP) }),
    ...(resolvedMaxTokens === undefined || resolvedMaxTokens === null ? {} : { max_tokens: Number(resolvedMaxTokens) }),
    extra_body: {
      ...(resolvedTopK === undefined ? {} : { top_k: Number(resolvedTopK) }),
      ...(resolvedMinP === undefined ? {} : { min_p: Number(resolvedMinP) }),
      ...(resolvedPresencePenalty === undefined ? {} : { presence_penalty: Number(resolvedPresencePenalty) }),
      ...(resolvedRepetitionPenalty === undefined ? {} : { repeat_penalty: Number(resolvedRepetitionPenalty) }),
    },
  });

  const response = await requestJson<LlamaCppChatResponse>({
    url: `${baseUrl.replace(/\/$/u, '')}/v1/chat/completions`,
    method: 'POST',
    timeoutMs: options.timeoutSeconds * 1000,
    body: requestBody,
  });

  if (response.statusCode >= 400) {
    const detail = response.rawText.trim();
    throw new Error(`llama.cpp generate failed with HTTP ${response.statusCode}${detail ? `: ${detail}` : '.'}`);
  }

  const firstChoice = response.body.choices?.[0];
  const messageText = getTextContent(firstChoice?.message?.content);
  const reasoningText = getTextContent(firstChoice?.message?.reasoning_content);
  const text = (messageText || firstChoice?.text || '').trim();
  if (!text) {
    throw new Error('llama.cpp did not return a response body.');
  }

  const rawUsage = response.body.usage;
  const thinkingTokens = getThinkingTokenCount(rawUsage) ?? await countLlamaCppTokens(options.config, reasoningText);
  const usage = rawUsage
    ? {
      promptTokens: getUsageValue(rawUsage.prompt_tokens),
      completionTokens: subtractThinkingTokens(getUsageValue(rawUsage.completion_tokens), thinkingTokens),
      totalTokens: getUsageValue(rawUsage.total_tokens),
      thinkingTokens,
    }
    : null;

  return {
    text,
    usage,
  };
}
