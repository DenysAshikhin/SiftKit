import { getActiveModelPreset, type SiftConfig } from '../config/index.js';

/**
 * The single context reserve shared by thinking and output. Every generation path
 * draws from this one budget: it is both the floor guaranteed to the model and the
 * ceiling on what it may emit.
 */
export const RESPONSE_RESERVE_TOKENS = 15_000;

/** A reserve may never take more than this share of the context window. */
export const RESPONSE_RESERVE_MAX_CONTEXT_RATIO = 0.5;

/**
 * The active preset's output cap. The config is required: an unconfigured or
 * malformed preset must fail here rather than silently produce a bogus budget.
 */
export function getPresetMaxTokens(config: SiftConfig): number {
  const preset = getActiveModelPreset(config);
  if (!Number.isInteger(preset.MaxTokens) || preset.MaxTokens < 1) {
    throw new Error(`Active model preset "${preset.id}" has an invalid MaxTokens: ${preset.MaxTokens}.`);
  }
  return preset.MaxTokens;
}

export function computeResponseReserveTokens(options: {
  totalContextTokens: number;
  config: SiftConfig | null | undefined;
}): number {
  const totalContextTokens = Math.max(1, Math.floor(Number(options.totalContextTokens) || 0));
  const presetMaxTokens = options.config ? getPresetMaxTokens(options.config) : RESPONSE_RESERVE_TOKENS;
  return Math.max(1, Math.min(
    RESPONSE_RESERVE_TOKENS,
    presetMaxTokens,
    Math.floor(totalContextTokens * RESPONSE_RESERVE_MAX_CONTEXT_RATIO),
  ));
}
