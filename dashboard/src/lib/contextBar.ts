import type { ChatStreamUsageEvent } from '@siftkit/contracts';
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
 * Drives the bar and label beneath the composer. At rest it mirrors the persisted usage.
 * While a turn streams it reads the newest usage frame, which is exact up to the last turn
 * boundary, and adds only the tail streamed since then, so the bar moves with the turn
 * instead of waiting for it to end.
 */
export function resolveLiveContextUsage(input: {
  contextUsage: ContextUsage | null;
  latestUsage: ChatStreamUsageEvent | null;
  streamedCharsSinceUsage: number;
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
  if (!input.busy || !input.latestUsage) {
    return finish(contextUsage.totalUsedTokens, true);
  }
  // The frame is exact up to the last turn boundary. Only the tail streamed since then is
  // estimated, sized by the ratio the previous turn actually measured.
  const usage = input.latestUsage;
  const tailTokens = Math.ceil(input.streamedCharsSinceUsage / usage.charsPerToken);
  return finish(usage.record.promptTokens + tailTokens, tailTokens === 0);
}
