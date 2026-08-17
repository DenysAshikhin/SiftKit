import { getEffectiveInputCharactersPerContextToken, type SiftConfig } from '../config/index.js';

/**
 * The local characters-per-token fallback used wherever a server tokenizer is
 * unavailable or too expensive. Single owner: no layer keeps its own copy.
 */
export function estimateTokenCountFromCharacters(config: SiftConfig | undefined, characterCount: number): number {
  const charsPerToken = config
    ? Math.max(Number(getEffectiveInputCharactersPerContextToken(config) || 4), 0.1)
    : 4;
  return Math.max(1, Math.ceil(Math.max(0, Number(characterCount) || 0) / charsPerToken));
}

export function estimateTokenCount(config: SiftConfig | undefined, text: string): number {
  return estimateTokenCountFromCharacters(config, String(text || '').length);
}
