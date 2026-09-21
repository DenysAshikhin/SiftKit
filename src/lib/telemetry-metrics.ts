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

const telemetryMetrics = {
  toNullableNonNegativeNumber,
  toNonNegativeNumber,
  toNullableNonNegativeInteger,
  getNormalizedCompletionTokens,
  getPromptCacheHitRate,
  getAcceptanceRate,
};

export default telemetryMetrics;
