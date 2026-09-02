import { type SiftConfig } from '../config/index.js';
import { getPresetMaxTokens, resolveContextTokenBudget } from './response-reserve.js';

/**
 * Preset MaxTokens is a hard upper bound on a fixed, non-context-derived output budget.
 * Context-derived budgets come from getDynamicMaxOutputTokens, which is already bounded.
 */
export function clampToPresetMaxTokens(config: SiftConfig, outputTokens: number): number {
  return Math.min(outputTokens, getPresetMaxTokens(config));
}

/**
 * The output half of the shared response reserve: the model may emit up to the reserve,
 * or whatever context is actually left after the prompt, whichever is smaller.
 */
export function getDynamicMaxOutputTokens(options: {
  totalContextTokens: number;
  promptTokenCount: number;
  config: SiftConfig | null | undefined;
}): number {
  const budget = resolveContextTokenBudget({
    totalContextTokens: options.totalContextTokens,
    config: options.config,
  });
  const promptTokenCount = Math.max(0, Math.floor(Number(options.promptTokenCount) || 0));
  const remainingContextTokens = Math.max(budget.totalContextTokens - promptTokenCount, 0);
  return Math.max(1, Math.min(budget.responseReserveTokens, remainingContextTokens));
}
