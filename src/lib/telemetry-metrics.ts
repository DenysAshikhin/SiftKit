import type { OptionalJsonValue } from './json-types.js';

export function toNullableNonNegativeNumber(value: OptionalJsonValue): number | null {
  if (value === null || value === undefined || value === '') {
    return null;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

export function toNonNegativeNumber(value: OptionalJsonValue): number {
  return toNullableNonNegativeNumber(value) ?? 0;
}

export function toNullableNonNegativeInteger(value: OptionalJsonValue): number | null {
  const parsed = toNullableNonNegativeNumber(value);
  return parsed === null ? null : Math.trunc(parsed);
}

export function getNormalizedCompletionTokens(rawCompletionTokens: OptionalJsonValue, thinkingTokens: OptionalJsonValue): number | null {
  const completionTokens = toNullableNonNegativeNumber(rawCompletionTokens);
  if (completionTokens === null) {
    return null;
  }
  return Math.max(completionTokens - toNonNegativeNumber(thinkingTokens), 0);
}

export function getGenerationTokens(outputTokens: OptionalJsonValue, thinkingTokens: OptionalJsonValue): number {
  return toNonNegativeNumber(outputTokens) + toNonNegativeNumber(thinkingTokens);
}

export function getPromptCacheHitRate(promptCacheTokens: OptionalJsonValue, promptEvalTokens: OptionalJsonValue): number | null {
  const cacheTokens = toNonNegativeNumber(promptCacheTokens);
  const evalTokens = toNonNegativeNumber(promptEvalTokens);
  const totalPromptTokens = cacheTokens + evalTokens;
  return totalPromptTokens > 0 ? (cacheTokens / totalPromptTokens) : null;
}

export function getAcceptanceRate(speculativeAcceptedTokens: OptionalJsonValue, speculativeGeneratedTokens: OptionalJsonValue): number | null {
  const acceptedTokens = toNullableNonNegativeNumber(speculativeAcceptedTokens);
  const generatedTokens = toNullableNonNegativeNumber(speculativeGeneratedTokens);
  return acceptedTokens !== null && generatedTokens !== null && generatedTokens > 0
    ? (acceptedTokens / generatedTokens)
    : null;
}

export function getPromptTokensPerSecond(promptEvalTokens: OptionalJsonValue, promptEvalDurationMs: OptionalJsonValue): number | null {
  const promptTokens = toNullableNonNegativeNumber(promptEvalTokens);
  const durationMs = toNullableNonNegativeNumber(promptEvalDurationMs);
  return promptTokens !== null && durationMs !== null && promptTokens > 0 && durationMs > 0
    ? (promptTokens / (durationMs / 1000))
    : null;
}

export function getGenerationTokensPerSecond(
  outputTokens: OptionalJsonValue,
  thinkingTokens: OptionalJsonValue,
  generationDurationMs: OptionalJsonValue,
): number | null {
  const durationMs = toNullableNonNegativeNumber(generationDurationMs);
  const generatedTokens = getGenerationTokens(outputTokens, thinkingTokens);
  return durationMs !== null && generatedTokens > 0 && durationMs > 0
    ? (generatedTokens / (durationMs / 1000))
    : null;
}

const telemetryMetrics = {
  toNullableNonNegativeNumber,
  toNonNegativeNumber,
  toNullableNonNegativeInteger,
  getNormalizedCompletionTokens,
  getGenerationTokens,
  getPromptCacheHitRate,
  getAcceptanceRate,
  getPromptTokensPerSecond,
  getGenerationTokensPerSecond,
};

export default telemetryMetrics;
