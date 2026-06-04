import { formatNumber } from './format';
import type { ContextUsage } from '../types';

export type ContextBarVisual = {
  ratio: number;
  percent: number;
  fillColor: string;
  titleText: string;
};

export function computeContextBarVisual(used: number, total: number): ContextBarVisual {
  const ratio = total > 0 ? Math.min(1, Math.max(0, used / total)) : 0;
  const percent = ratio * 100;
  const hue = 120 - 120 * ratio;
  const fillColor = `hsl(${hue}, 70%, 45%)`;
  const titleText = `${formatNumber(used)} / ${formatNumber(total)} (${(ratio * 100).toFixed(1)}% used)`;
  return { ratio, percent, fillColor, titleText };
}

// Resolves the bar shown beneath the composer. While a turn is generating, the most
// truthful "context window fullness" signal is the backend prompt_tokens for the active
// tool step (liveToolPromptTokenCount); it is preferred over the persisted chat usage so
// the bar grows in realtime. A fresh session has no contextUsage until the turn completes,
// so the session's own window is used as the denominator during that first stream.
export function resolveContextBarVisual(
  usage: ContextUsage | null,
  sessionContextWindowTokens: number,
  liveToolPromptTokenCount: number | null,
  chatBusy: boolean,
): ContextBarVisual | null {
  const liveUsed = chatBusy
    && typeof liveToolPromptTokenCount === 'number'
    && Number.isFinite(liveToolPromptTokenCount)
    && liveToolPromptTokenCount > 0
    ? liveToolPromptTokenCount
    : null;
  if (!usage && liveUsed === null) {
    return null;
  }
  const total = usage ? usage.contextWindowTokens : sessionContextWindowTokens;
  if (total <= 0) {
    return null;
  }
  const baseUsed = usage ? usage.chatUsedTokens : 0;
  const used = liveUsed === null ? baseUsed : Math.max(baseUsed, liveUsed);
  return computeContextBarVisual(used, total);
}
