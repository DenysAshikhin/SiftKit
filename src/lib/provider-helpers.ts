/**
 * Shared helpers for provider communication — used by llama-cpp provider,
 * repo-search planner protocol, and any future provider integrations.
 */
import { sleep } from './time.js';

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

export function serializeNetworkError(error: unknown): SerializedNetworkError {
  const source = error && typeof error === 'object' ? error as Record<string, unknown> : {};
  const message = error instanceof Error ? error.message : String(error || '');
  return {
    message: message || 'unknown error',
    code: typeof source.code === 'string' ? source.code : null,
    errno: typeof source.errno === 'number' || typeof source.errno === 'string' ? source.errno as string | number : null,
    syscall: typeof source.syscall === 'string' ? source.syscall : null,
    address: typeof source.address === 'string' ? source.address : null,
    port: Number.isFinite(Number(source.port)) ? Number(source.port) : null,
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

export function isTransientProviderError(error: unknown): boolean {
  const source = error && typeof error === 'object' ? error as Record<string, unknown> : {};
  const message = String(error instanceof Error ? error.message : (error ?? '')).toUpperCase();
  const code = String(typeof source.code === 'string' ? source.code : '').toUpperCase();
  return TRANSIENT_PROVIDER_ERROR_CODES.some((item) => message.includes(item) || code === item);
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
      if (!isTransientProviderError(error)) {
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
        error: serializeNetworkError(error),
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
 * Normalize content from a provider response — handles both plain strings
 * and arrays of `{ type?: string; text?: string }` content parts.
 */
export function normalizeProviderText(value: unknown): string {
  if (typeof value === 'string') return value.trim();
  if (Array.isArray(value)) {
    return value
      .map((part) => {
        if (typeof part === 'string') return part;
        if (part && typeof part === 'object' && typeof (part as { text?: string }).text === 'string') {
          return (part as { text: string }).text;
        }
        return '';
      })
      .join('')
      .trim();
  }
  return '';
}

// ---------------------------------------------------------------------------
// Usage / token counting helpers
// ---------------------------------------------------------------------------

export function getUsageNumber(value: unknown): number | null {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

export type PromptUsage = {
  promptTokens: number | null;
  promptCacheTokens: number | null;
  promptEvalTokens: number | null;
};

/**
 * Extract prompt token usage from a provider response body.  Handles
 * llama.cpp `usage`, `timings`, and `__verbose.timings` fields as well as
 * OpenAI-style `prompt_tokens_details` / `input_tokens_details`.
 */
export function getPromptUsageFromResponseBody(body: Record<string, unknown>): PromptUsage {
  const usage = body?.usage as Record<string, unknown> | undefined;
  const timings = body?.timings as Record<string, unknown> | undefined;
  const verboseTimings = body?.__verbose && typeof body.__verbose === 'object'
    ? (body.__verbose as Record<string, unknown>).timings as Record<string, unknown> | undefined
    : undefined;

  const promptTokens = getUsageNumber(usage?.prompt_tokens);
  const promptCacheTokens = getUsageNumber(timings?.cache_n)
    ?? getUsageNumber(verboseTimings?.cache_n)
    ?? getUsageNumber((usage?.prompt_tokens_details as Record<string, unknown> | undefined)?.cached_tokens)
    ?? getUsageNumber((usage?.input_tokens_details as Record<string, unknown> | undefined)?.cached_tokens);
  const promptEvalTokens = getUsageNumber(timings?.prompt_n)
    ?? getUsageNumber(verboseTimings?.prompt_n)
    ?? (promptTokens !== null && promptCacheTokens !== null ? Math.max(promptTokens - promptCacheTokens, 0) : null);

  return { promptTokens, promptCacheTokens, promptEvalTokens };
}
