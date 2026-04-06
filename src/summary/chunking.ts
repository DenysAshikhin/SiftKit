import type { SiftConfig } from '../config/index.js';
import {
  getChunkThresholdCharacters,
  getConfiguredLlamaNumCtx,
  getConfiguredLlamaSetting,
  getEffectiveInputCharactersPerContextToken,
} from '../config/index.js';
import { countLlamaCppTokens } from '../providers/llama-cpp.js';
import { buildPrompt } from './prompt.js';
import type {
  ChunkPromptContext,
  PlannerPromptBudget,
  SummaryPhase,
  SummaryPolicyProfile,
  SummarySourceKind,
} from './types.js';

const LLAMA_CPP_NON_THINKING_PROMPT_TOKEN_RESERVE = 10_000;
const LLAMA_CPP_THINKING_PROMPT_TOKEN_RESERVE = 15_000;
export const LLAMA_CPP_PROMPT_TOKEN_TARGET_TOLERANCE = 2000;
export const MAX_TOKEN_AWARE_CHUNK_ADJUSTMENTS = 8;
const MIN_PLANNER_HEADROOM_TOKENS = 4000;
const PLANNER_HEADROOM_RATIO = 0.15;
export const PLANNER_TRIGGER_CONTEXT_RATIO = 0.75;

let nextLlamaCppSlotId = 0;

export function splitTextIntoChunks(text: string, chunkSize: number): string[] {
  if (chunkSize <= 0) {
    throw new Error('ChunkSize must be greater than zero.');
  }

  if (text.length <= chunkSize) {
    return [text];
  }

  const chunks: string[] = [];
  for (let offset = 0; offset < text.length; offset += chunkSize) {
    chunks.push(text.substring(offset, Math.min(offset + chunkSize, text.length)));
  }
  return chunks;
}

export async function countPromptTokensForChunk(options: {
  question: string;
  inputText: string;
  format: 'text' | 'json';
  policyProfile: SummaryPolicyProfile;
  rawReviewRequired: boolean;
  promptPrefix?: string;
  sourceKind: SummarySourceKind;
  commandExitCode?: number | null;
  config: SiftConfig;
  phase: SummaryPhase;
  chunkContext?: ChunkPromptContext;
}): Promise<number | null> {
  const prompt = buildPrompt({
    question: options.question,
    inputText: options.inputText,
    format: options.format,
    policyProfile: options.policyProfile,
    rawReviewRequired: options.rawReviewRequired,
    promptPrefix: options.promptPrefix,
    sourceKind: options.sourceKind,
    commandExitCode: options.commandExitCode,
    phase: options.phase,
    chunkContext: options.chunkContext,
  });
  return countLlamaCppTokens(options.config, prompt);
}

export async function planTokenAwareLlamaCppChunks(options: {
  question: string;
  inputText: string;
  format: 'text' | 'json';
  policyProfile: SummaryPolicyProfile;
  rawReviewRequired: boolean;
  promptPrefix?: string;
  sourceKind: SummarySourceKind;
  commandExitCode?: number | null;
  config: SiftConfig;
  chunkThreshold: number;
  phase: SummaryPhase;
  chunkContext?: ChunkPromptContext;
}): Promise<string[] | null> {
  const effectivePromptLimit = getPlannerPromptBudget(options.config).usablePromptBudgetTokens;
  if (effectivePromptLimit <= 0) {
    return null;
  }

  const chunks: string[] = [];
  let offset = 0;
  while (offset < options.inputText.length) {
    const remainingLength = options.inputText.length - offset;
    const targetSlackTokens = Math.min(LLAMA_CPP_PROMPT_TOKEN_TARGET_TOLERANCE, effectivePromptLimit);
    let candidateLength = Math.min(options.chunkThreshold, remainingLength);
    let acceptedChunk: string | null = null;
    let acceptedLength = 0;
    let rejectedLength: number | null = null;
    let adjustmentCount = 0;

    while (candidateLength > 0 && adjustmentCount < MAX_TOKEN_AWARE_CHUNK_ADJUSTMENTS) {
      adjustmentCount += 1;
      const candidateText = options.inputText.substring(offset, offset + candidateLength);
      const promptTokenCount = await countPromptTokensForChunk({
        question: options.question,
        inputText: candidateText,
        format: options.format,
        policyProfile: options.policyProfile,
        rawReviewRequired: options.rawReviewRequired,
        promptPrefix: options.promptPrefix,
        sourceKind: options.sourceKind,
        commandExitCode: options.commandExitCode,
        config: options.config,
        phase: options.phase,
        chunkContext: options.chunkContext,
      });
      if (promptTokenCount === null) {
        return null;
      }

      if (promptTokenCount <= effectivePromptLimit) {
        acceptedChunk = candidateText;
        acceptedLength = candidateLength;
        const slackTokens = effectivePromptLimit - promptTokenCount;
        if (
          slackTokens <= targetSlackTokens
          || candidateLength >= remainingLength
          || rejectedLength === acceptedLength + 1
        ) {
          break;
        }

        if (rejectedLength !== null) {
          candidateLength = Math.max(
            acceptedLength + 1,
            Math.floor((acceptedLength + rejectedLength) / 2)
          );
          continue;
        }

        const grownLength = Math.min(
          remainingLength,
          Math.max(
            acceptedLength + 1,
            Math.floor(acceptedLength * (effectivePromptLimit / Math.max(promptTokenCount, 1)))
          )
        );
        if (grownLength <= acceptedLength) {
          break;
        }
        candidateLength = grownLength;
        continue;
      }

      rejectedLength = candidateLength;
      if (acceptedLength > 0) {
        candidateLength = Math.max(
          acceptedLength + 1,
          Math.floor((acceptedLength + rejectedLength) / 2)
        );
        continue;
      }

      const reducedLength = getTokenAwareChunkThreshold({
        inputLength: candidateLength,
        promptTokenCount,
        effectivePromptLimit,
      });
      if (reducedLength === null || reducedLength >= candidateLength) {
        return null;
      }

      candidateLength = reducedLength;
    }

    if (!acceptedChunk) {
      return null;
    }

    chunks.push(acceptedChunk);
    offset += acceptedChunk.length;
  }

  return chunks;
}

export function shouldRetryWithSmallerChunks(options: {
  error: unknown;
  backend: string;
  inputText: string;
  chunkThreshold: number;
}): boolean {
  if (options.backend !== 'llama.cpp') {
    return false;
  }

  if (options.chunkThreshold <= 1 || options.inputText.length <= 1) {
    return false;
  }

  const message = options.error instanceof Error ? options.error.message : String(options.error);
  return /llama\.cpp generate failed with HTTP 400\b/iu.test(message);
}

export function getLlamaCppPromptTokenReserve(config: SiftConfig): number {
  const reasoning = getConfiguredLlamaSetting<'on' | 'off' | 'auto'>(config, 'Reasoning');
  return reasoning === 'off'
    ? LLAMA_CPP_NON_THINKING_PROMPT_TOKEN_RESERVE
    : LLAMA_CPP_THINKING_PROMPT_TOKEN_RESERVE;
}

export function allocateLlamaCppSlotId(config: SiftConfig): number {
  const configuredSlots = getConfiguredLlamaSetting<number | null>(config, 'ParallelSlots');
  const slotCount = Math.max(1, Math.floor(Number(configuredSlots) || 1));
  const slotId = nextLlamaCppSlotId % slotCount;
  nextLlamaCppSlotId = (nextLlamaCppSlotId + 1) % slotCount;
  return slotId;
}

export function getPlannerPromptBudget(config: SiftConfig): PlannerPromptBudget {
  const numCtxTokens = getConfiguredLlamaNumCtx(config);
  const promptReserveTokens = getLlamaCppPromptTokenReserve(config);
  const usablePromptBudgetTokens = Math.max(numCtxTokens - promptReserveTokens, 0);
  const plannerHeadroomTokens = Math.max(
    Math.ceil(usablePromptBudgetTokens * PLANNER_HEADROOM_RATIO),
    MIN_PLANNER_HEADROOM_TOKENS,
  );
  return {
    numCtxTokens,
    promptReserveTokens,
    usablePromptBudgetTokens,
    plannerHeadroomTokens,
    plannerStopLineTokens: Math.max(usablePromptBudgetTokens - plannerHeadroomTokens, 0),
  };
}

export function estimatePromptTokenCount(config: SiftConfig, text: string): number {
  return Math.max(
    1,
    Math.ceil(text.length / Math.max(getEffectiveInputCharactersPerContextToken(config), 0.1)),
  );
}

export function getLlamaCppChunkThresholdCharacters(config: SiftConfig): number {
  const reserveChars = Math.ceil(
    getLlamaCppPromptTokenReserve(config) * getEffectiveInputCharactersPerContextToken(config)
  );
  return Math.max(getChunkThresholdCharacters(config) - reserveChars, 1);
}

export function getPlannerActivationThresholdCharacters(config: SiftConfig): number {
  return Math.max(
    1,
    Math.floor(getConfiguredLlamaNumCtx(config) * getEffectiveInputCharactersPerContextToken(config) * PLANNER_TRIGGER_CONTEXT_RATIO),
  );
}

export function getTokenAwareChunkThreshold(options: {
  inputLength: number;
  promptTokenCount: number;
  effectivePromptLimit: number;
}): number | null {
  if (
    options.inputLength <= 1
    || options.promptTokenCount <= options.effectivePromptLimit
    || options.effectivePromptLimit <= 0
  ) {
    return null;
  }

  const scaledThreshold = Math.floor(
    options.inputLength * (options.effectivePromptLimit / options.promptTokenCount) * 0.95
  );
  const reducedThreshold = Math.max(1, Math.min(options.inputLength - 1, scaledThreshold));
  return reducedThreshold < options.inputLength ? reducedThreshold : null;
}

export function sumTokenCounts(...values: Array<number | null | undefined>): number | null {
  let total = 0;
  let hasValue = false;
  for (const value of values) {
    if (Number.isFinite(value)) {
      total += Number(value);
      hasValue = true;
    }
  }
  return hasValue ? total : null;
}
