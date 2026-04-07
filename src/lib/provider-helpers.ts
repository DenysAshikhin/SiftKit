/**
 * Shared helpers for provider communication — used by llama-cpp provider,
 * repo-search planner protocol, and any future provider integrations.
 */

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

const TRANSIENT_PROVIDER_ERROR_CODES = ['ECONNRESET', 'ETIMEDOUT', 'EPIPE', 'ECONNABORTED'];

export function isTransientProviderError(error: unknown): boolean {
  const message = String(error instanceof Error ? error.message : (error ?? '')).toUpperCase();
  return TRANSIENT_PROVIDER_ERROR_CODES.some((code) => message.includes(code));
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
