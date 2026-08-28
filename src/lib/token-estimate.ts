import { getEffectiveInputCharactersPerContextToken, type SiftConfig } from '../config/index.js';

/**
 * The local characters-per-token fallback used wherever a server tokenizer is
 * unavailable or too expensive. Single owner: no layer keeps its own copy.
 */
export function estimateTokenCountFromCharacters(config: SiftConfig | undefined, characterCount: number): number {
  const charsPerToken = getTokenEstimateCharactersPerToken(config);
  return Math.max(1, Math.ceil(Math.max(0, Number(characterCount) || 0) / charsPerToken));
}

export function getTokenEstimateCharactersPerToken(config: SiftConfig | undefined): number {
  return config
    ? Math.max(Number(getEffectiveInputCharactersPerContextToken(config) || 4), 0.1)
    : 4;
}

export function estimateTokenCount(config: SiftConfig | undefined, text: string): number {
  return estimateTokenCountFromCharacters(config, String(text || '').length);
}

/**
 * How many thinking tokens a stream has spent. The provider's own count wins when
 * it reports one, because the character estimate is coarse enough to misprice a
 * whole continuation. A reported zero is not a count: backends that emit
 * `reasoning_tokens: 0` on every frame and the real figure only in the final usage
 * payload would otherwise read as having spent nothing.
 */
export function resolveSpentThinkingTokens(
  config: SiftConfig | undefined,
  reportedThinkingTokens: number | null,
  reasoningText: string,
): number {
  if (reportedThinkingTokens !== null && reportedThinkingTokens > 0) {
    return Math.floor(reportedThinkingTokens);
  }
  return reasoningText.length === 0 ? 0 : estimateTokenCountFromCharacters(config, reasoningText.length);
}
