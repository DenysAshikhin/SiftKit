import type { ChatStreamPromptEvent } from '@siftkit/contracts';
import type { ContextUsage } from '../types';

export type LiveContextUsage = {
  usedTokens: number;
  contextWindowTokens: number;
  /** usedTokens / contextWindowTokens clamped to [0, 1]. */
  ratio: number;
  /** False while the count includes the in-flight streaming tail estimate. */
  exact: boolean;
};

/**
 * Drives the bar and label beneath the composer. At rest it mirrors the persisted usage. While
 * a run streams it sits on the base the backend measured for the turn now generating and adds
 * the tail streamed since, so the bar moves from the first character. The base is never
 * estimated: a turn publishes its prompt frame before it emits any text, so a tail only ever
 * exists on top of a measured base.
 */
export function resolveLiveContextUsage(input: {
  contextUsage: ContextUsage | null;
  liveTokenBase: ChatStreamPromptEvent | null;
  streamedCharsSinceBase: number;
  busy: boolean;
}): LiveContextUsage | null {
  const { contextUsage, liveTokenBase } = input;
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
  if (!input.busy || !liveTokenBase) {
    return finish(contextUsage.totalUsedTokens, true);
  }
  const tailTokens = Math.ceil(input.streamedCharsSinceBase / liveTokenBase.charsPerToken);
  return finish(liveTokenBase.promptTokens + tailTokens, tailTokens === 0);
}

/** The one rule for showing a live count: an estimated tail is marked, an exact one is not. */
export function formatLiveContextTokens(
  usage: LiveContextUsage,
  formatTokens: (tokens: number) => string,
): string {
  return `${usage.exact ? '' : '~'}${formatTokens(usage.usedTokens)}`;
}
