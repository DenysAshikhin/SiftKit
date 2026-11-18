import type { PromptCacheBreak } from '@siftkit/contracts';
import { formatInteger } from '../../lib/text-format.ts';

/** Absorbs differences between SiftKit's prompt token count and the engine's. */
export const PROMPT_CACHE_BREAK_TOLERANCE_TOKENS = 500;

export type PromptCacheObservation = {
  turn: number;
  promptTokens: number;
  promptEvalTokens: number | null;
  promptCacheTokens: number | null;
};

/** Flags a response whose prefill exceeds the prompt's growth since the previous response. */
export class PromptCacheWatch {
  private previousPromptTokens: number | null = null;

  /** The next response starts a new cache epoch, so it is not checked. */
  noteCompaction(): void {
    this.previousPromptTokens = null;
  }

  observe(observation: PromptCacheObservation): PromptCacheBreak | null {
    const previousPromptTokens = this.previousPromptTokens;
    this.previousPromptTokens = observation.promptTokens;
    if (previousPromptTokens === null || observation.promptEvalTokens === null) return null;
    const growth = observation.promptTokens - previousPromptTokens;
    if (observation.promptEvalTokens <= growth + PROMPT_CACHE_BREAK_TOLERANCE_TOKENS) return null;
    return {
      turn: observation.turn,
      promptTokens: observation.promptTokens,
      previousPromptTokens,
      promptEvalTokens: observation.promptEvalTokens,
      promptCacheTokens: observation.promptCacheTokens,
    };
  }
}

const growthOf = (cacheBreak: PromptCacheBreak): string => formatInteger(cacheBreak.promptTokens - cacheBreak.previousPromptTokens);

/** The live warning shown on the run. */
export function describePromptCacheBreak(cacheBreak: PromptCacheBreak): string {
  return `Prompt cache broke on turn ${cacheBreak.turn}: re-prefilled ${formatInteger(cacheBreak.promptEvalTokens)} tokens where the prompt grew ${growthOf(cacheBreak)}.`;
}

/** The one-line engine-event summary. */
export function summarizePromptCacheBreak(cacheBreak: PromptCacheBreak): string {
  return `Turn ${cacheBreak.turn} re-prefilled ${formatInteger(cacheBreak.promptEvalTokens)} tokens; the prompt grew ${growthOf(cacheBreak)}`;
}

export function formatPromptCacheBreakDetail(cacheBreak: PromptCacheBreak): string {
  return [
    `turn: ${cacheBreak.turn}`,
    `prompt tokens: ${formatInteger(cacheBreak.promptTokens)}`,
    `previous prompt tokens: ${formatInteger(cacheBreak.previousPromptTokens)}`,
    `re-prefilled tokens: ${formatInteger(cacheBreak.promptEvalTokens)}`,
    `cached tokens: ${formatInteger(cacheBreak.promptCacheTokens)}`,
  ].join('\n');
}
