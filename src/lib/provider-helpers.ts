/**
 * Shared helpers for provider communication: used by llama-cpp provider,
 * repo-search planner protocol, and future provider integrations.
 */
import { sleep } from './time.js';
import { toError } from './errors.js';
import { getNormalizedCompletionTokens } from './telemetry-metrics.js';
import { JsonRecordReader } from './json-record-reader.js';
import type { JsonObject, JsonValue, OptionalJsonValue } from './json-types.js';

// ---------------------------------------------------------------------------
// Network error serialization
// ---------------------------------------------------------------------------

export type SerializedNetworkError = {
  message: string;
  code: string | null;
  errno: string | number | null;
  syscall: string | null;
  address: string | null;
  port: number | null;
};

function readErrorString(error: Error, key: 'code' | 'syscall' | 'address'): string | null {
  if (!(key in error)) {
    return null;
  }
  const value = Reflect.get(error, key);
  return typeof value === 'string' ? value : null;
}

function readErrorStringOrNumber(error: Error, key: 'errno'): string | number | null {
  if (!(key in error)) {
    return null;
  }
  const value = Reflect.get(error, key);
  return typeof value === 'number' || typeof value === 'string' ? value : null;
}

function readErrorNumber(error: Error, key: 'port'): number | null {
  if (!(key in error)) {
    return null;
  }
  const parsed = Number(Reflect.get(error, key));
  return Number.isFinite(parsed) ? parsed : null;
}

export function serializeNetworkError(error: Error): SerializedNetworkError {
  return {
    message: error.message || 'unknown error',
    code: readErrorString(error, 'code'),
    errno: readErrorStringOrNumber(error, 'errno'),
    syscall: readErrorString(error, 'syscall'),
    address: readErrorString(error, 'address'),
    port: readErrorNumber(error, 'port'),
  };
}

export function buildProviderErrorMessage(
  options: { stage: string; method: string; url: string },
  details: SerializedNetworkError,
): string {
  const parts = [
    `provider request failed stage=${options.stage}`,
    `method=${options.method}`,
    `url=${options.url}`,
    `error=${details.message}`,
  ];
  if (details.code) parts.push(`code=${details.code}`);
  if (details.errno !== null) parts.push(`errno=${details.errno}`);
  if (details.syscall) parts.push(`syscall=${details.syscall}`);
  if (details.address) parts.push(`address=${details.address}`);
  if (details.port !== null) parts.push(`port=${details.port}`);
  return parts.join(' ');
}

// ---------------------------------------------------------------------------
// Transient error detection
// ---------------------------------------------------------------------------

const TRANSIENT_PROVIDER_ERROR_CODES = ['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EPIPE', 'ECONNABORTED'];
const TRANSIENT_PROVIDER_LOADING_MODEL_CODE = 'HTTP_503_LOADING_MODEL';

export class TransientProviderHttpError extends Error {
  public readonly code = TRANSIENT_PROVIDER_LOADING_MODEL_CODE;
}

export function isTransientProviderError(error: Error): boolean {
  const message = error.message.toUpperCase();
  const code = String(readErrorString(error, 'code') ?? '').toUpperCase();
  if (TRANSIENT_PROVIDER_ERROR_CODES.some((item) => message.includes(item) || code === item)) {
    return true;
  }
  if (code === TRANSIENT_PROVIDER_LOADING_MODEL_CODE) {
    return true;
  }
  return message.includes('HTTP 503')
    && (message.includes('LOADING MODEL') || message.includes('UNAVAILABLE_ERROR'));
}

export function isTransientProviderHttpResponse(statusCode: number, rawText: string): boolean {
  if (statusCode !== 503) {
    return false;
  }
  const responseText = String(rawText || '').toUpperCase();
  return responseText.includes('LOADING MODEL') || responseText.includes('UNAVAILABLE_ERROR');
}

export function buildTransientProviderHttpError(statusCode: number, rawText: string): Error {
  const detail = String(rawText || '').trim();
  return new TransientProviderHttpError(`HTTP ${statusCode}: ${detail || 'provider temporarily unavailable'}`);
}

const DEFAULT_PROVIDER_RETRY_MAX_WAIT_MS = 30_000;
const DEFAULT_PROVIDER_RETRY_DELAYS_MS = [250, 500, 1_000];

export type ProviderRetryEvent = {
  attempt: number;
  elapsedMs: number;
  nextDelayMs: number;
  error: SerializedNetworkError;
};

export type RetryProviderRequestOptions = {
  maxWaitMs?: number;
  delayStepsMs?: number[];
  onRetry?: (event: ProviderRetryEvent) => void;
  nowMs?: () => number;
  sleepMs?: (ms: number) => Promise<void>;
};

export async function retryProviderRequest<T>(
  requestFn: () => Promise<T>,
  options: RetryProviderRequestOptions = {},
): Promise<T> {
  const maxWaitMs = Number.isFinite(options.maxWaitMs) && Number(options.maxWaitMs) > 0
    ? Number(options.maxWaitMs)
    : DEFAULT_PROVIDER_RETRY_MAX_WAIT_MS;
  const delayStepsMs = Array.isArray(options.delayStepsMs) && options.delayStepsMs.length > 0
    ? options.delayStepsMs
      .map((value) => Number(value))
      .filter((value) => Number.isFinite(value) && value > 0)
    : DEFAULT_PROVIDER_RETRY_DELAYS_MS;
  const delaySchedule = delayStepsMs.length > 0 ? delayStepsMs : DEFAULT_PROVIDER_RETRY_DELAYS_MS;
  const nowMs = options.nowMs || Date.now;
  const sleepMs = options.sleepMs || sleep;
  const startedAt = nowMs();
  let attempt = 1;

  while (true) {
    try {
      return await requestFn();
    } catch (error) {
      const caughtError = toError(error);
      if (!isTransientProviderError(caughtError)) {
        throw error;
      }
      const elapsedMs = Math.max(0, nowMs() - startedAt);
      const nextDelayMs = delaySchedule[Math.min(attempt - 1, delaySchedule.length - 1)];
      if (elapsedMs + nextDelayMs > maxWaitMs) {
        throw error;
      }
      options.onRetry?.({
        attempt,
        elapsedMs,
        nextDelayMs,
        error: serializeNetworkError(caughtError),
      });
      await sleepMs(nextDelayMs);
      attempt += 1;
    }
  }
}

// ---------------------------------------------------------------------------
// Provider response text normalization
// ---------------------------------------------------------------------------

/**
 * Normalize content from a provider response. Handles both plain strings
 * and arrays of `{ type?: string; text?: string }` content parts.
 */
export function normalizeProviderText(value?: JsonValue): string {
  if (typeof value === 'string') return value.trim();
  if (Array.isArray(value)) {
    return value
      .map((part) => {
        if (typeof part === 'string') return part;
        const record = JsonRecordReader.asObject(part);
        const text = record?.text;
        return typeof text === 'string' ? text : '';
      })
      .join('')
      .trim();
  }
  return '';
}

// ---------------------------------------------------------------------------
// Usage / token counting helpers
// ---------------------------------------------------------------------------

export function getUsageNumber(value: OptionalJsonValue): number | null {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

export type PromptUsage = {
  promptTokens: number | null;
  promptCacheTokens: number | null;
  promptEvalTokens: number | null;
};

export type CompletionUsage = {
  completionTokens: number | null;
  thinkingTokens: number | null;
};

export type TimingUsage = {
  promptEvalDurationMs: number | null;
  generationDurationMs: number | null;
  promptTokensPerSecond: number | null;
  generationTokensPerSecond: number | null;
};

export function getProcessedPromptTokens(
  inputTokens: OptionalJsonValue,
  promptCacheTokens: OptionalJsonValue,
  promptEvalTokens: OptionalJsonValue,
): number | null {
  const totalPromptTokens = Number.isFinite(Number(inputTokens)) ? Number(inputTokens) : null;
  const cacheTokens = Number.isFinite(Number(promptCacheTokens)) ? Number(promptCacheTokens) : 0;
  const evalTokens = Number.isFinite(Number(promptEvalTokens)) ? Number(promptEvalTokens) : null;
  if (evalTokens !== null) {
    if (evalTokens > 0) {
      return evalTokens;
    }
    if (totalPromptTokens === null) {
      return 0;
    }
    if (cacheTokens <= 0) {
      return totalPromptTokens;
    }
  }
  if (totalPromptTokens !== null) {
    return Math.max(totalPromptTokens - cacheTokens, 0);
  }
  return evalTokens;
}

/**
 * Extract prompt token usage from a provider response body. Handles
 * llama.cpp `usage`, `timings`, and `__verbose.timings` fields as well as
 * OpenAI-style `prompt_tokens_details` / `input_tokens_details`.
 */
export function getPromptUsageFromResponseBody(body: JsonValue): PromptUsage {
  const record = JsonRecordReader.asObject(body) ?? {};
  const usage = JsonRecordReader.asObject(record.usage) ?? {};
  const timings = JsonRecordReader.asObject(record.timings) ?? {};
  const verbose = JsonRecordReader.asObject(record.__verbose) ?? {};
  const verboseTimings = JsonRecordReader.asObject(verbose.timings) ?? {};
  const promptTokenDetails = JsonRecordReader.asObject(usage.prompt_tokens_details) ?? {};
  const inputTokenDetails = JsonRecordReader.asObject(usage.input_tokens_details) ?? {};

  const promptTokens = getUsageNumber(usage.prompt_tokens);
  const promptCacheTokens = getUsageNumber(timings.cache_n)
    ?? getUsageNumber(verboseTimings.cache_n)
    ?? getUsageNumber(promptTokenDetails.cached_tokens)
    ?? getUsageNumber(inputTokenDetails.cached_tokens);
  const promptEvalTokens = getUsageNumber(timings.prompt_n)
    ?? getUsageNumber(verboseTimings.prompt_n)
    ?? (promptTokens !== null && promptCacheTokens !== null ? Math.max(promptTokens - promptCacheTokens, 0) : null);

  return { promptTokens, promptCacheTokens, promptEvalTokens };
}

export function getTimingUsageFromResponseBody(body: JsonValue): TimingUsage {
  const record = JsonRecordReader.asObject(body) ?? {};
  const timings = JsonRecordReader.asObject(record.timings) ?? {};
  const verbose = JsonRecordReader.asObject(record.__verbose) ?? {};
  const verboseTimings = JsonRecordReader.asObject(verbose.timings) ?? {};
  return {
    promptEvalDurationMs: getUsageNumber(timings.prompt_ms) ?? getUsageNumber(verboseTimings.prompt_ms),
    generationDurationMs: getUsageNumber(timings.predicted_ms) ?? getUsageNumber(verboseTimings.predicted_ms),
    promptTokensPerSecond: getUsageNumber(timings.prompt_per_second) ?? getUsageNumber(verboseTimings.prompt_per_second),
    generationTokensPerSecond: getUsageNumber(timings.predicted_per_second) ?? getUsageNumber(verboseTimings.predicted_per_second),
  };
}

function getThinkingTokensFromUsage(usage: JsonObject): number | null {
  const completionDetails = JsonRecordReader.asObject(usage.completion_tokens_details);
  const outputDetails = JsonRecordReader.asObject(usage.output_tokens_details);
  const sources = [completionDetails, outputDetails, usage];
  for (const source of sources) {
    if (!source) {
      continue;
    }
    const reasoningTokens = getUsageNumber(source.reasoning_tokens) ?? 0;
    const thinkingTokens = getUsageNumber(source.thinking_tokens) ?? 0;
    if (
      Object.prototype.hasOwnProperty.call(source, 'reasoning_tokens')
      || Object.prototype.hasOwnProperty.call(source, 'thinking_tokens')
    ) {
      return reasoningTokens + thinkingTokens;
    }
  }
  return null;
}

/**
 * Extract completion/output usage from provider payloads.
 */
export function getCompletionUsageFromResponseBody(body: JsonValue): CompletionUsage {
  const record = JsonRecordReader.asObject(body) ?? {};
  const usage = JsonRecordReader.asObject(record.usage) ?? {};
  const timings = JsonRecordReader.asObject(record.timings) ?? {};
  const verboseBody = JsonRecordReader.asObject(record.__verbose) ?? {};
  const verboseTimings = JsonRecordReader.asObject(verboseBody.timings) ?? {};
  return {
    completionTokens: getNormalizedCompletionTokens(
      getUsageNumber(usage.completion_tokens)
      ?? getUsageNumber(usage.output_tokens)
      ?? getUsageNumber(timings.predicted_n)
      ?? getUsageNumber(verboseTimings.predicted_n)
      ?? getUsageNumber(verboseBody.tokens_predicted),
      getThinkingTokensFromUsage(usage),
    ),
    thinkingTokens: getThinkingTokensFromUsage(usage),
  };
}
