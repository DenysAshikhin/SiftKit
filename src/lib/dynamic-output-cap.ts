import {
  getActiveModelPreset,
  getConfiguredLlamaNumCtx,
  getEffectiveInputCharactersPerContextToken,
  type SiftConfig,
} from '../config/index.js';

/**
 * Preset MaxTokens is a hard upper bound on any computed output budget. The config is
 * required: an unconfigured caller must fail here rather than silently skip the cap.
 */
export function clampToPresetMaxTokens(config: SiftConfig, outputTokens: number): number {
  const preset = getActiveModelPreset(config);
  if (!Number.isInteger(preset.MaxTokens) || preset.MaxTokens < 1) {
    throw new Error(`Active model preset "${preset.id}" has an invalid MaxTokens: ${preset.MaxTokens}.`);
  }
  return Math.min(outputTokens, preset.MaxTokens);
}

export function estimatePromptTokenCountFromCharacters(
  config: SiftConfig | undefined,
  promptCharacters: number,
): number {
  const charsPerToken = config
    ? Math.max(Number(getEffectiveInputCharactersPerContextToken(config) || 4), 0.1)
    : 4;
  return Math.max(1, Math.ceil(Math.max(0, Number(promptCharacters) || 0) / charsPerToken));
}

export function getDynamicMaxOutputTokens(options: {
  totalContextTokens: number;
  promptTokenCount: number;
}): number {
  const totalContextTokens = Math.max(0, Math.floor(Number(options.totalContextTokens) || 0));
  const promptTokenCount = Math.max(0, Math.floor(Number(options.promptTokenCount) || 0));
  const remainingContextTokens = Math.max(totalContextTokens - promptTokenCount, 0);
  return Math.max(1, Math.min(25_000, Math.floor(remainingContextTokens * 0.9)));
}

export function getDynamicMaxOutputTokensForConfig(options: {
  config: SiftConfig;
  promptCharacters: number;
  promptTokenCount?: number | null;
}): number {
  const totalContextTokens = Math.max(1, Number(getConfiguredLlamaNumCtx(options.config) || 0));
  const promptTokenCount = Number.isFinite(options.promptTokenCount) && Number(options.promptTokenCount) > 0
    ? Number(options.promptTokenCount)
    : estimatePromptTokenCountFromCharacters(options.config, options.promptCharacters);
  return getDynamicMaxOutputTokens({ totalContextTokens, promptTokenCount });
}
