import type { SiftConfig } from '../config/index.js';
import {
  getChunkThresholdCharacters,
  getConfiguredEngineNumCtx,
  getEffectiveInputCharactersPerContextToken,
} from '../config/index.js';
import { resolveContextTokenBudget } from '../lib/context-token-budget.js';
import { countInferenceTokens } from '../providers/inference.js';
import { buildSummaryPrompt } from './prompt.js';
import type { PresetSystemContext } from '../preset-system-context.js';
import type {
  ChunkPromptContext,
  PlannerPromptBudget,
  SummaryPhase,
  SummaryPolicyProfile,
  SummaryProviderId,
  SummarySourceKind,
} from './types.js';

export const INFERENCE_PROMPT_TOKEN_TARGET_TOLERANCE = 2000;
export const MAX_TOKEN_AWARE_CHUNK_ADJUSTMENTS = 8;
export const PLANNER_TRIGGER_CONTEXT_RATIO = 0.75;

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
  presetPromptPrefix: string;
  additionalPromptPrefix: string;
  systemContext: PresetSystemContext;
  sourceKind: SummarySourceKind;
  commandExitCode?: number | null;
  config: SiftConfig;
  phase: SummaryPhase;
  chunkContext?: ChunkPromptContext;
}): Promise<number | null> {
  const prompt = buildSummaryPrompt({
    question: options.question,
    inputText: options.inputText,
    format: options.format,
    policyProfile: options.policyProfile,
    rawReviewRequired: options.rawReviewRequired,
    presetPromptPrefix: options.presetPromptPrefix,
    additionalPromptPrefix: options.additionalPromptPrefix,
    systemContext: options.systemContext,
    sourceKind: options.sourceKind,
    commandExitCode: options.commandExitCode,
    phase: options.phase,
    chunkContext: options.chunkContext,
  });
  return countInferenceTokens(options.config, prompt);
}

export async function planTokenAwareInferenceChunks(options: {
  question: string;
  inputText: string;
  format: 'text' | 'json';
  policyProfile: SummaryPolicyProfile;
  rawReviewRequired: boolean;
  presetPromptPrefix: string;
  additionalPromptPrefix: string;
  systemContext: PresetSystemContext;
  sourceKind: SummarySourceKind;
  commandExitCode?: number | null;
  config: SiftConfig;
  chunkThreshold: number;
  phase: SummaryPhase;
  chunkContext?: ChunkPromptContext;
}): Promise<string[] | null> {
  const effectivePromptLimit = getPlannerPromptBudget(options.config).plannerStopLineTokens;
  if (effectivePromptLimit <= 0) {
    return null;
  }

  const chunks: string[] = [];
  let offset = 0;
  while (offset < options.inputText.length) {
    const remainingLength = options.inputText.length - offset;
    const targetSlackTokens = Math.min(INFERENCE_PROMPT_TOKEN_TARGET_TOLERANCE, effectivePromptLimit);
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
        presetPromptPrefix: options.presetPromptPrefix,
        additionalPromptPrefix: options.additionalPromptPrefix,
        systemContext: options.systemContext,
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
  error: Error;
  provider: SummaryProviderId;
  inputText: string;
  chunkThreshold: number;
}): boolean {
  if (options.provider !== 'real') {
    return false;
  }

  if (options.chunkThreshold <= 1 || options.inputText.length <= 1) {
    return false;
  }

  return /inference generate failed with HTTP 400\b/iu.test(options.error.message);
}

export function getPlannerPromptBudget(config: SiftConfig): PlannerPromptBudget {
  const budget = resolveContextTokenBudget({ totalContextTokens: getConfiguredEngineNumCtx(config) });
  return {
    numCtxTokens: budget.totalContextTokens,
    compactionReserveTokens: budget.compactionReserveTokens,
    plannerStopLineTokens: budget.maxPromptTokens,
  };
}

export function estimatePromptTokenCount(config: SiftConfig, text: string): number {
  return Math.max(
    1,
    Math.ceil(text.length / Math.max(getEffectiveInputCharactersPerContextToken(config), 0.1)),
  );
}

export function getInferenceChunkThresholdCharacters(config: SiftConfig): number {
  const reserveChars = Math.ceil(
    getPlannerPromptBudget(config).compactionReserveTokens * getEffectiveInputCharactersPerContextToken(config)
  );
  return Math.max(getChunkThresholdCharacters(config) - reserveChars, 1);
}

export function getPlannerActivationThresholdCharacters(config: SiftConfig): number {
  return Math.max(
    1,
    Math.floor(getConfiguredEngineNumCtx(config) * getEffectiveInputCharactersPerContextToken(config) * PLANNER_TRIGGER_CONTEXT_RATIO),
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
