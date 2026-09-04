import { sumLiveTokenDisplays } from './format';
import type { ChatMessage, ContextUsage } from '../types';

/**
 * The backend prompt_tokens reported by the newest tool step, paired with the live bubble sum it
 * already covers. The two are only meaningful together, so they travel as one value.
 */
export type LiveToolPromptStep = {
  promptTokens: number;
  liveBaselineTokens: number;
};

export type LiveContextUsage = {
  usedTokens: number;
  contextWindowTokens: number;
  /** usedTokens / contextWindowTokens clamped to [0, 1]. */
  ratio: number;
  /** False while the count includes provisional live-bubble estimates. */
  exact: boolean;
};

/**
 * Drives the bar and label beneath the composer. At rest it mirrors the persisted usage.
 * While a turn streams it adds the provisional token counts of the live bubbles (the same
 * counter each bubble shows) and never drops below the backend prompt_tokens reported by the
 * latest tool step, so the bar moves with the counter instead of waiting for the turn to end.
 * The backend count is a floor, not a ceiling: bubbles streamed since that step are added on
 * top of it, measured against the baseline captured when the step arrived so nothing that the
 * step already counted is added twice.
 */
export function resolveLiveContextUsage(input: {
  contextUsage: ContextUsage | null;
  liveMessages: readonly ChatMessage[];
  liveToolPromptStep: LiveToolPromptStep | null;
  busy: boolean;
}): LiveContextUsage | null {
  const { contextUsage } = input;
  if (!contextUsage || contextUsage.contextWindowTokens <= 0) {
    return null;
  }
  const contextWindowTokens = contextUsage.contextWindowTokens;
  const finish = (usedTokens: number, exact: boolean): LiveContextUsage => ({
    usedTokens,
    contextWindowTokens,
    ratio: Math.min(1, Math.max(0, usedTokens / contextWindowTokens)),
    exact,
  });
  if (!input.busy) {
    return finish(contextUsage.totalUsedTokens, true);
  }
  const live = sumLiveTokenDisplays(input.liveMessages);
  const estimated = contextUsage.totalUsedTokens + live.tokenCount;
  const step = input.liveToolPromptStep;
  if (!step) {
    return finish(estimated, live.exact);
  }
  // Progress rows are replaced rather than appended, so the live sum can shrink below the
  // baseline; that only means the step already counts everything on screen.
  const streamedSinceToolStep = Math.max(0, live.tokenCount - step.liveBaselineTokens);
  const backendBacked = step.promptTokens + streamedSinceToolStep;
  return backendBacked > estimated
    ? finish(backendBacked, streamedSinceToolStep === 0 || live.exact)
    : finish(estimated, live.exact);
}
