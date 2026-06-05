import { formatNumber } from './format';
import type { ContextUsage } from '../types';

export type ContextBarSectionKind = 'provider-overhead' | 'used' | 'free' | 'warn';

export type ContextBarSection = {
  kind: ContextBarSectionKind;
  tokenCount: number;
  percent: number;
  titleText: string;
};

export type ContextBarVisual = {
  ratio: number;
  percent: number;
  fillColor: string;
  titleText: string;
  sections: ContextBarSection[];
};

export function computeContextBarVisual(used: number, total: number): Omit<ContextBarVisual, 'sections'> {
  const ratio = total > 0 ? Math.min(1, Math.max(0, used / total)) : 0;
  const percent = ratio * 100;
  const hue = 120 - 120 * ratio;
  const fillColor = `hsl(${hue}, 70%, 45%)`;
  const titleText = `${formatNumber(used)} / ${formatNumber(total)} (${(ratio * 100).toFixed(1)}% used)`;
  return { ratio, percent, fillColor, titleText };
}

function getNonNegativeInteger(value: unknown): number {
  const numberValue = Number(value);
  return Number.isFinite(numberValue) && numberValue > 0 ? Math.trunc(numberValue) : 0;
}

function getSectionPercent(tokenCount: number, total: number): number {
  return total > 0 ? Math.max(0, Math.min(100, (tokenCount / total) * 100)) : 0;
}

function appendSection(sections: ContextBarSection[], kind: ContextBarSectionKind, tokenCount: number, total: number, titleText: string): void {
  if (tokenCount <= 0) {
    return;
  }
  sections.push({
    kind,
    tokenCount,
    percent: getSectionPercent(tokenCount, total),
    titleText,
  });
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
  const visual = computeContextBarVisual(used, total);
  const providerOverheadTokens = getNonNegativeInteger(usage?.providerOverheadTokens);
  const warnThresholdTokens = getNonNegativeInteger(usage?.warnThresholdTokens);
  const providerTokens = Math.min(providerOverheadTokens, total);
  const usedTokens = Math.min(used, Math.max(total - providerTokens, 0));
  const warnTokens = Math.min(warnThresholdTokens, Math.max(total - providerTokens - usedTokens, 0));
  const freeTokens = Math.max(total - providerTokens - usedTokens - warnTokens, 0);
  const sections: ContextBarSection[] = [];
  appendSection(
    sections,
    'provider-overhead',
    providerTokens,
    total,
    `Provider overhead reserve: ${formatNumber(providerTokens)} tokens used by request framing, model options, and chat template metadata.`,
  );
  appendSection(
    sections,
    'used',
    usedTokens,
    total,
    visual.titleText,
  );
  appendSection(
    sections,
    'free',
    freeTokens,
    total,
    `${formatNumber(freeTokens)} tokens currently free.`,
  );
  appendSection(
    sections,
    'warn',
    warnTokens,
    total,
    `Warning zone: the last ${formatNumber(warnThresholdTokens)} tokens. When used context reaches here the session should be condensed. Chatting further risks the model's response being cut off if the context window fills up.`,
  );
  return { ...visual, sections };
}
