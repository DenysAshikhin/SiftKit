import * as fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import {
  loadConfig,
  type SiftConfig,
  getChunkThresholdCharacters,
  getConfiguredLlamaBaseUrl,
  getConfiguredLlamaNumCtx,
  getConfiguredLlamaSetting,
  getEffectiveInputCharactersPerContextToken,
  getConfiguredModel,
  getConfiguredPromptPrefix,
  notifyStatusBackend,
} from './config.js';
import { withExecutionLock } from './execution-lock.js';
import { getErrorMessage } from './lib/errors.js';
import {
  countLlamaCppTokens,
  generateLlamaCppChatResponse,
  generateLlamaCppResponse,
  type LlamaCppChatMessage,
} from './providers/llama-cpp.js';
import {
  UNSUPPORTED_INPUT_MESSAGE,
  getDeterministicExcerpt,
  getErrorSignalMetrics,
  isPassFailQuestion,
  measureText,
  normalizeInputText,
} from './summary/measure.js';
import {
  appendChunkPath,
  buildPrompt,
} from './summary/prompt.js';
import {
  buildConservativeChunkFallbackDecision,
  buildConservativeDirectFallbackDecision,
  isInternalChunkLeaf,
  normalizeStructuredDecision,
  parseStructuredModelDecision,
  tryRecoverStructuredModelDecision,
} from './summary/structured.js';
import { getMockSummary } from './summary/mock.js';
import {
  buildPlannerToolDefinitions,
  executePlannerTool,
  formatPlannerResult,
  formatPlannerToolResultTokenGuardError,
} from './summary/planner/tools.js';
import { parsePlannerAction } from './summary/planner/parse.js';
import {
  appendTestProviderEvent,
  attachSummaryFailureContext,
  buildPlannerFailureErrorMessage,
  clearSummaryArtifactState,
  createPlannerDebugRecorder,
  finalizePlannerDebugDump,
  getSummaryFailureContext,
  traceSummary,
  writeFailedRequestDump,
  writeSummaryRequestDump,
} from './summary/artifacts.js';
import {
  buildPlannerAssistantToolMessage,
  buildPlannerInitialUserPrompt,
  buildPlannerInvalidResponseUserPrompt,
  buildPlannerSystemPrompt,
  renderPlannerTranscript,
} from './summary/planner/prompts.js';
import type {
  ChunkPromptContext,
  PlannerAction,
  PlannerPromptBudget,
  PlannerToolDefinition,
  PlannerToolName,
  StructuredModelDecision,
  SummaryClassification,
  SummaryDecision,
  SummaryPhase,
  SummaryPolicyProfile,
  SummaryRequest,
  SummaryResult,
  SummarySourceKind,
} from './summary/types.js';

export type {
  SummaryPolicyProfile,
  SummarySourceKind,
  SummaryClassification,
  SummaryRequest,
  SummaryResult,
};

export { UNSUPPORTED_INPUT_MESSAGE, getDeterministicExcerpt, buildPrompt };

function getCommandOutputRawReviewRequired(options: {
  text: string;
  riskLevel: 'informational' | 'debug' | 'risky';
  commandExitCode?: number | null;
  errorMetrics: ReturnType<typeof getErrorSignalMetrics>;
}): boolean {
  if (options.riskLevel !== 'informational') {
    return true;
  }

  if (Number.isFinite(options.commandExitCode) && Number(options.commandExitCode) !== 0) {
    return true;
  }

  if (/\b(fatal|panic|traceback|segmentation fault|core dumped|assert(?:ion)? failed|uncaught exception|out of memory)\b/iu.test(options.text)) {
    return true;
  }

  return (
    options.errorMetrics.ErrorLineCount >= 3
    || (
      options.errorMetrics.NonEmptyLineCount >= 6
      && options.errorMetrics.ErrorRatio >= 0.5
    )
  );
}

export function getSummaryDecision(
  text: string,
  question: string | null | undefined,
  riskLevel: 'informational' | 'debug' | 'risky',
  config: SiftConfig,
  options?: {
    sourceKind?: SummarySourceKind;
    commandExitCode?: number | null;
  },
): SummaryDecision {
  const metrics = measureText(text);
  const errorMetrics = getErrorSignalMetrics(text);
  const hasMaterialErrorSignals = (
    errorMetrics.ErrorLineCount > 0
    && (
      errorMetrics.NonEmptyLineCount <= 20
      || (errorMetrics.ErrorLineCount >= 5 && errorMetrics.ErrorRatio >= 0.25)
      || errorMetrics.ErrorRatio >= 0.25
    )
  );
  const isShort = (
    metrics.CharacterCount < Number(config.Thresholds.MinCharactersForSummary)
    && metrics.LineCount < Number(config.Thresholds.MinLinesForSummary)
  );
  const sourceKind = options?.sourceKind || 'standalone';
  const rawReviewRequired = sourceKind === 'command-output'
    ? getCommandOutputRawReviewRequired({
      text,
      riskLevel,
      commandExitCode: options?.commandExitCode,
      errorMetrics,
    })
    : (riskLevel !== 'informational' || hasMaterialErrorSignals);
  const reason = isShort
    ? 'model-first-short'
    : (rawReviewRequired ? 'model-first-risk-review' : 'model-first');

  return {
    ShouldSummarize: true,
    Reason: question ? reason : 'model-first',
    RawReviewRequired: rawReviewRequired,
    CharacterCount: metrics.CharacterCount,
    LineCount: metrics.LineCount,
  };
}

function splitTextIntoChunks(text: string, chunkSize: number): string[] {
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

async function countPromptTokensForChunk(options: {
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

function shouldRetryWithSmallerChunks(options: {
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

const LLAMA_CPP_NON_THINKING_PROMPT_TOKEN_RESERVE = 10_000;
const LLAMA_CPP_THINKING_PROMPT_TOKEN_RESERVE = 15_000;
const LLAMA_CPP_PROMPT_TOKEN_TARGET_TOLERANCE = 2000;
const MAX_TOKEN_AWARE_CHUNK_ADJUSTMENTS = 8;
const MAX_PLANNER_TOOL_CALLS = 30;
const MIN_PLANNER_HEADROOM_TOKENS = 4000;
const PLANNER_HEADROOM_RATIO = 0.15;
const PLANNER_TRIGGER_CONTEXT_RATIO = 0.75;
const PLANNER_FALLBACK_TO_CHUNKS = 'fallback_to_chunks';
let nextLlamaCppSlotId = 0;

function getLlamaCppPromptTokenReserve(config: SiftConfig): number {
  const reasoning = getConfiguredLlamaSetting<'on' | 'off' | 'auto'>(config, 'Reasoning');
  return reasoning === 'off'
    ? LLAMA_CPP_NON_THINKING_PROMPT_TOKEN_RESERVE
    : LLAMA_CPP_THINKING_PROMPT_TOKEN_RESERVE;
}

function allocateLlamaCppSlotId(config: SiftConfig): number {
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

function estimatePromptTokenCount(config: SiftConfig, text: string): number {
  return Math.max(
    1,
    Math.ceil(text.length / Math.max(getEffectiveInputCharactersPerContextToken(config), 0.1)),
  );
}

function getLlamaCppChunkThresholdCharacters(config: SiftConfig): number {
  const reserveChars = Math.ceil(
    getLlamaCppPromptTokenReserve(config) * getEffectiveInputCharactersPerContextToken(config)
  );
  return Math.max(getChunkThresholdCharacters(config) - reserveChars, 1);
}

function getPlannerActivationThresholdCharacters(config: SiftConfig): number {
  return Math.max(
    1,
    Math.floor(getConfiguredLlamaNumCtx(config) * getEffectiveInputCharactersPerContextToken(config) * PLANNER_TRIGGER_CONTEXT_RATIO),
  );
}

function getTokenAwareChunkThreshold(options: {
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

// buildPlannerToolDefinitions + planner helpers moved to summary/planner/*
export { buildPlannerToolDefinitions };



function sumTokenCounts(...values: Array<number | null | undefined>): number | null {
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

async function invokeProviderSummary(options: {
  requestId: string;
  slotId: number | null;
  backend: string;
  config: SiftConfig;
  model: string;
  prompt: string;
  question: string;
  promptCharacterCount: number;
  promptTokenCount: number | null;
  rawInputCharacterCount: number;
  chunkInputCharacterCount: number;
  phase: SummaryPhase;
  chunkIndex: number | null;
  chunkTotal: number | null;
  chunkPath: string | null;
  reasoningOverride?: 'on' | 'off' | 'auto';
  requestTimeoutSeconds?: number;
  llamaCppOverrides?: SummaryRequest['llamaCppOverrides'];
}): Promise<string> {
  const chunkLabel = options.chunkPath ?? (
    options.chunkIndex !== null && options.chunkTotal !== null ? `${options.chunkIndex}/${options.chunkTotal}` : 'none'
  );
  traceSummary(
    `notify running=true phase=${options.phase} chunk=${chunkLabel} raw_chars=${options.rawInputCharacterCount} `
    + `chunk_chars=${options.chunkInputCharacterCount} prompt_chars=${options.promptCharacterCount}`
  );
  await notifyStatusBackend({
    running: true,
    requestId: options.requestId,
    promptCharacterCount: options.promptCharacterCount,
    promptTokenCount: options.promptTokenCount,
    rawInputCharacterCount: options.rawInputCharacterCount,
    chunkInputCharacterCount: options.chunkInputCharacterCount,
    budgetSource: options.config.Effective?.BudgetSource ?? null,
    inputCharactersPerContextToken: options.config.Effective?.InputCharactersPerContextToken ?? null,
    chunkThresholdCharacters: options.config.Effective?.ChunkThresholdCharacters ?? null,
    phase: options.phase,
    chunkIndex: options.chunkIndex,
    chunkTotal: options.chunkTotal,
    chunkPath: options.chunkPath,
  });
  const startedAt = Date.now();
  let inputTokens: number | null = null;
  let outputCharacterCount: number | null = null;
  let outputTokens: number | null = null;
  let thinkingTokens: number | null = null;
  let promptCacheTokens: number | null = null;
  let promptEvalTokens: number | null = null;
  try {
    if (options.backend === 'mock') {
      const rawSleep = process.env.SIFTKIT_TEST_PROVIDER_SLEEP_MS;
      const sleepMs = rawSleep ? Number.parseInt(rawSleep, 10) : 0;
      if (Number.isFinite(sleepMs) && sleepMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, sleepMs));
      }
      appendTestProviderEvent({
        backend: options.backend,
        model: options.model,
        phase: options.phase,
        question: options.question,
        rawInputCharacterCount: options.rawInputCharacterCount,
        chunkInputCharacterCount: options.chunkInputCharacterCount,
      });
      const mockSummary = getMockSummary(options.prompt, options.question, options.phase);
      outputCharacterCount = mockSummary.length;
      return mockSummary;
    }

    traceSummary(
      `provider start backend=${options.backend} model=${options.model} phase=${options.phase} `
      + `chunk=${chunkLabel} timeout_s=${options.requestTimeoutSeconds ?? 600}`
    );
    const response = await generateLlamaCppResponse({
      config: options.config,
      model: options.model,
      prompt: options.prompt,
      timeoutSeconds: options.requestTimeoutSeconds ?? 600,
      slotId: options.slotId ?? undefined,
      reasoningOverride: options.reasoningOverride,
      structuredOutput: {
        kind: 'siftkit-decision-json',
        allowUnsupportedInput: options.backend !== 'llama.cpp' || options.phase === 'leaf' && options.chunkPath !== null,
      },
      overrides: options.llamaCppOverrides,
    });
    inputTokens = response.usage?.promptTokens ?? null;
    outputCharacterCount = response.text.length;
    outputTokens = response.usage?.completionTokens ?? null;
    thinkingTokens = response.usage?.thinkingTokens ?? null;
    promptCacheTokens = response.usage?.promptCacheTokens ?? null;
    promptEvalTokens = response.usage?.promptEvalTokens ?? null;
    traceSummary(
      `provider done phase=${options.phase} chunk=${chunkLabel} output_chars=${outputCharacterCount} `
      + `output_tokens=${outputTokens ?? 'null'} thinking_tokens=${thinkingTokens ?? 'null'}`
    );
    return response.text.trim();
  } finally {
    const countOutputTokensAsThinking = options.phase === 'leaf' && options.chunkPath !== null;
    traceSummary(`notify running=false phase=${options.phase} chunk=${chunkLabel} duration_ms=${Date.now() - startedAt}`);
    await notifyStatusBackend({
      running: false,
      requestId: options.requestId,
      promptCharacterCount: options.promptCharacterCount,
      inputTokens,
      outputCharacterCount,
      outputTokens: countOutputTokensAsThinking ? null : outputTokens,
      thinkingTokens: countOutputTokensAsThinking
        ? sumTokenCounts(thinkingTokens, outputTokens)
        : thinkingTokens,
      promptCacheTokens,
      promptEvalTokens,
      requestDurationMs: Date.now() - startedAt,
    });
  }
}

async function invokePlannerProviderAction(options: {
  requestId: string;
  slotId: number | null;
  config: SiftConfig;
  model: string;
  messages: LlamaCppChatMessage[];
  promptText: string;
  promptTokenCount: number;
  rawInputCharacterCount: number;
  chunkInputCharacterCount: number;
  toolDefinitions: PlannerToolDefinition[];
  requestTimeoutSeconds?: number;
  llamaCppOverrides?: SummaryRequest['llamaCppOverrides'];
}): Promise<{
  text: string;
  reasoningText: string | null;
  inputTokens: number | null;
  outputCharacterCount: number | null;
  outputTokens: number | null;
  thinkingTokens: number | null;
  promptCacheTokens: number | null;
  promptEvalTokens: number | null;
  requestDurationMs: number;
}> {
  traceSummary(
    `notify running=true phase=planner chunk=none raw_chars=${options.rawInputCharacterCount} `
    + `chunk_chars=${options.chunkInputCharacterCount} prompt_chars=${options.promptText.length}`
  );
  await notifyStatusBackend({
    running: true,
    requestId: options.requestId,
    promptCharacterCount: options.promptText.length,
    promptTokenCount: options.promptTokenCount,
    rawInputCharacterCount: options.rawInputCharacterCount,
    chunkInputCharacterCount: options.chunkInputCharacterCount,
    budgetSource: options.config.Effective?.BudgetSource ?? null,
    inputCharactersPerContextToken: options.config.Effective?.InputCharactersPerContextToken ?? null,
    chunkThresholdCharacters: options.config.Effective?.ChunkThresholdCharacters ?? null,
    phase: 'planner',
  });
  const startedAt = Date.now();
  let inputTokens: number | null = null;
  let outputCharacterCount: number | null = null;
  let outputTokens: number | null = null;
  let thinkingTokens: number | null = null;
  let promptCacheTokens: number | null = null;
  let promptEvalTokens: number | null = null;
  try {
    const response = await generateLlamaCppChatResponse({
      config: options.config,
      model: options.model,
      messages: options.messages,
      timeoutSeconds: options.requestTimeoutSeconds ?? 600,
      slotId: options.slotId ?? undefined,
      cachePrompt: true,
      tools: options.toolDefinitions,
      structuredOutput: {
        kind: 'siftkit-planner-action-json',
        tools: options.toolDefinitions,
      },
      overrides: options.llamaCppOverrides,
    });
    inputTokens = response.usage?.promptTokens ?? null;
    outputCharacterCount = response.text.length;
    outputTokens = response.usage?.completionTokens ?? null;
    thinkingTokens = response.usage?.thinkingTokens ?? null;
    promptCacheTokens = response.usage?.promptCacheTokens ?? null;
    promptEvalTokens = response.usage?.promptEvalTokens ?? null;
    return {
      text: response.text,
      reasoningText: response.reasoningText,
      inputTokens,
      outputCharacterCount,
      outputTokens,
      thinkingTokens,
      promptCacheTokens,
      promptEvalTokens,
      requestDurationMs: Date.now() - startedAt,
    };
  } catch (error) {
    traceSummary(`notify running=false phase=planner chunk=none duration_ms=${Date.now() - startedAt}`);
    await notifyStatusBackend({
      running: false,
      requestId: options.requestId,
      promptCharacterCount: options.promptText.length,
      inputTokens,
      outputCharacterCount,
      outputTokens,
      thinkingTokens,
      promptCacheTokens,
      promptEvalTokens,
      requestDurationMs: Date.now() - startedAt,
    });
    throw error;
  }
}

async function invokePlannerMode(options: {
  requestId: string;
  slotId: number | null;
  question: string;
  inputText: string;
  format: 'text' | 'json';
  backend: string;
  model: string;
  config: SiftConfig;
  rawReviewRequired: boolean;
  sourceKind: SummarySourceKind;
  commandExitCode?: number | null;
  debugCommand?: string | null;
  promptPrefix?: string;
  requestTimeoutSeconds?: number;
  llamaCppOverrides?: SummaryRequest['llamaCppOverrides'];
}): Promise<StructuredModelDecision | null | typeof PLANNER_FALLBACK_TO_CHUNKS> {
  if (options.backend !== 'llama.cpp') {
    return null;
  }

  const promptBudget = getPlannerPromptBudget(options.config);
  if (promptBudget.plannerStopLineTokens <= 0) {
    return null;
  }

  const toolDefinitions = buildPlannerToolDefinitions();
  const toolResults: Array<{ toolName: PlannerToolName; args: Record<string, unknown>; result: unknown; resultText: string }> = [];
  const messages: LlamaCppChatMessage[] = [
    {
      role: 'system',
      content: buildPlannerSystemPrompt({
        promptPrefix: options.promptPrefix,
        sourceKind: options.sourceKind,
        commandExitCode: options.commandExitCode,
        rawReviewRequired: options.rawReviewRequired,
        toolDefinitions,
      }),
    },
    {
      role: 'user',
      content: buildPlannerInitialUserPrompt({
        question: options.question,
        inputText: options.inputText,
      }),
    },
  ];
  const debugRecorder = createPlannerDebugRecorder({
    requestId: options.requestId,
    question: options.question,
    inputText: options.inputText,
    sourceKind: options.sourceKind,
    commandExitCode: options.commandExitCode,
    commandText: options.debugCommand,
  });
  let invalidActionCount = 0;

  while (toolResults.length <= MAX_PLANNER_TOOL_CALLS) {
    const prompt = renderPlannerTranscript(messages);
    const promptTokenCount = (
      await countLlamaCppTokens(options.config, prompt)
    ) ?? estimatePromptTokenCount(options.config, prompt);
    debugRecorder.record({
      kind: 'planner_prompt',
      prompt,
      promptTokenCount,
      toolCallCount: toolResults.length,
      plannerBudget: promptBudget,
    });
    if (promptTokenCount > promptBudget.plannerStopLineTokens) {
      debugRecorder.finish({
        status: 'failed',
        reason: 'planner_headroom_exceeded',
        promptTokenCount,
        plannerBudget: promptBudget,
      });
      return null;
    }

    let providerResponse: {
      text: string;
      reasoningText: string | null;
      inputTokens: number | null;
      outputCharacterCount: number | null;
      outputTokens: number | null;
      thinkingTokens: number | null;
      promptCacheTokens: number | null;
      promptEvalTokens: number | null;
      requestDurationMs: number;
    };
    try {
      providerResponse = await invokePlannerProviderAction({
        requestId: options.requestId,
        slotId: options.slotId,
        config: options.config,
        model: options.model,
        messages,
        promptText: prompt,
        promptTokenCount,
        rawInputCharacterCount: options.inputText.length,
        chunkInputCharacterCount: options.inputText.length,
        toolDefinitions,
        requestTimeoutSeconds: options.requestTimeoutSeconds,
        llamaCppOverrides: options.llamaCppOverrides,
      });
    } catch (error) {
      debugRecorder.finish({
        status: 'failed',
        reason: getErrorMessage(error),
      });
      return null;
    }

    let countOutputTokens = false;
    try {
      debugRecorder.record({
        kind: 'planner_model_response',
        thinkingProcess: providerResponse.reasoningText,
        responseText: providerResponse.text,
      });

      let action: PlannerAction;
      try {
        action = parsePlannerAction(providerResponse.text);
      } catch (error) {
        if (toolResults.length === 0 && tryRecoverStructuredModelDecision(providerResponse.text)) {
          debugRecorder.finish({
            status: 'fallback',
            reason: 'planner_non_action_response',
          });
          return PLANNER_FALLBACK_TO_CHUNKS;
        }
        invalidActionCount += 1;
        const invalidResponseError = getErrorMessage(error);
        if (providerResponse.text.trim()) {
          messages.push({
            role: 'assistant',
            content: providerResponse.text,
          });
        }
        messages.push({
          role: 'user',
          content: buildPlannerInvalidResponseUserPrompt(invalidResponseError),
        });
        debugRecorder.record({
          kind: 'planner_invalid_response',
          error: invalidResponseError,
        });
        if (invalidActionCount >= 2) {
          debugRecorder.finish({
            status: 'failed',
            reason: 'planner_invalid_response_limit',
          });
          return null;
        }
        continue;
      }

      if (action.action === 'finish') {
        if (action.classification === 'unsupported_input' && options.sourceKind === 'command-output') {
          const fallbackDecision = normalizeStructuredDecision(
            buildConservativeDirectFallbackDecision({
              inputText: options.inputText,
              question: options.question,
              format: options.format,
              sourceKind: options.sourceKind,
            }),
            options.format,
          );
          debugRecorder.finish({
            status: 'completed',
            command: options.debugCommand ?? null,
            finalOutput: fallbackDecision.output,
            classification: fallbackDecision.classification,
            rawReviewRequired: fallbackDecision.rawReviewRequired,
          });
          return fallbackDecision;
        }

        countOutputTokens = true;
        const decision = normalizeStructuredDecision({
          classification: action.classification,
          rawReviewRequired: action.rawReviewRequired,
          output: action.output,
        }, options.format);
        debugRecorder.finish({
          status: 'completed',
          command: options.debugCommand ?? null,
          finalOutput: decision.output,
          classification: decision.classification,
          rawReviewRequired: decision.rawReviewRequired,
        });
        return decision;
      }

      if (toolResults.length >= MAX_PLANNER_TOOL_CALLS) {
        debugRecorder.finish({
          status: 'failed',
          reason: 'planner_tool_call_limit',
        });
        return null;
      }

      let result: Record<string, unknown>;
      try {
        result = executePlannerTool(options.inputText, action);
      } catch (error) {
        invalidActionCount += 1;
        const invalidResponseError = getErrorMessage(error);
        messages.push(buildPlannerAssistantToolMessage(action, `invalid_call_${invalidActionCount}`));
        messages.push({
          role: 'user',
          content: buildPlannerInvalidResponseUserPrompt(invalidResponseError),
        });
        debugRecorder.record({
          kind: 'planner_invalid_response',
          error: invalidResponseError,
          toolCall: action,
        });
        if (invalidActionCount >= 2) {
          debugRecorder.finish({
            status: 'failed',
            reason: 'planner_invalid_response_limit',
          });
          return null;
        }
        continue;
      }

      debugRecorder.record({
        kind: 'planner_tool',
        command: `${action.tool_name} ${JSON.stringify(action.args)}`,
        toolName: action.tool_name,
        args: action.args,
        output: result,
      });
      const formattedResultText = formatPlannerResult(result);
      const remainingPromptTokens = Math.max(promptBudget.plannerStopLineTokens - promptTokenCount, 0);
      const resultTokenCount = (
        await countLlamaCppTokens(options.config, formattedResultText)
      ) ?? estimatePromptTokenCount(options.config, formattedResultText);
      const normalizedResultTokenCount = Math.max(0, Math.ceil(resultTokenCount));
      const promptResultText = normalizedResultTokenCount > (remainingPromptTokens * 0.7)
        ? formatPlannerToolResultTokenGuardError(normalizedResultTokenCount)
        : formattedResultText;
      const toolCallId = `call_${toolResults.length + 1}`;
      messages.push(buildPlannerAssistantToolMessage(action, toolCallId));
      messages.push({
        role: 'tool',
        tool_call_id: toolCallId,
        content: promptResultText,
      });
      toolResults.push({
        toolName: action.tool_name,
        args: action.args,
        result,
        resultText: promptResultText,
      });
    } finally {
      traceSummary(`notify running=false phase=planner chunk=none duration_ms=${providerResponse.requestDurationMs}`);
      await notifyStatusBackend({
        running: false,
        requestId: options.requestId,
        promptCharacterCount: prompt.length,
        inputTokens: providerResponse.inputTokens,
        outputCharacterCount: providerResponse.outputCharacterCount,
        outputTokens: countOutputTokens ? providerResponse.outputTokens : null,
        thinkingTokens: countOutputTokens
          ? providerResponse.thinkingTokens
          : sumTokenCounts(providerResponse.thinkingTokens, providerResponse.outputTokens),
        promptCacheTokens: providerResponse.promptCacheTokens,
        promptEvalTokens: providerResponse.promptEvalTokens,
        requestDurationMs: providerResponse.requestDurationMs,
      });
    }
  }

  debugRecorder.finish({
    status: 'failed',
    reason: 'planner_exhausted_without_finish',
  });
  return null;
}

async function invokeSummaryCore(options: {
  requestId: string;
  slotId: number | null;
  question: string;
  inputText: string;
  format: 'text' | 'json';
  policyProfile: SummaryPolicyProfile;
  backend: string;
  model: string;
  config: SiftConfig;
  rawReviewRequired: boolean;
  sourceKind: SummarySourceKind;
  commandExitCode?: number | null;
  debugCommand?: string | null;
  rootInputCharacterCount?: number | null;
  phase?: SummaryPhase;
  chunkIndex?: number | null;
  chunkTotal?: number | null;
  chunkPath?: string | null;
  chunkThresholdOverride?: number | null;
  promptPrefix?: string;
  requestTimeoutSeconds?: number;
  llamaCppOverrides?: SummaryRequest['llamaCppOverrides'];
  chunkContext?: ChunkPromptContext;
}): Promise<StructuredModelDecision> {
  const rootInputCharacterCount = options.rootInputCharacterCount ?? options.inputText.length;
  const phase = options.phase ?? 'leaf';
  const chunkThreshold = Math.max(
    1,
    Math.floor(options.chunkThresholdOverride ?? (
      options.backend === 'llama.cpp'
        ? getLlamaCppChunkThresholdCharacters(options.config)
        : getChunkThresholdCharacters(options.config)
    ))
  );
  const llamaPromptBudget = options.backend === 'llama.cpp'
    ? getPlannerPromptBudget(options.config)
    : null;
  const plannerActivationThreshold = options.backend === 'llama.cpp'
    ? getPlannerActivationThresholdCharacters(options.config)
    : chunkThreshold;
  const enforceNonToolOneShot = options.backend === 'llama.cpp'
    && options.inputText.length <= plannerActivationThreshold;
  const chunkLabel = options.chunkPath ?? (
    options.chunkIndex !== null && options.chunkTotal !== null ? `${options.chunkIndex}/${options.chunkTotal}` : 'none'
  );
  traceSummary(
    `invokeSummaryCore start phase=${phase} chunk=${chunkLabel} input_chars=${options.inputText.length} `
    + `chunk_threshold=${chunkThreshold} planner_threshold=${plannerActivationThreshold}`
  );
  const isTopLevelLlamaPass = options.backend === 'llama.cpp'
    && phase === 'leaf'
    && !options.chunkContext
    && options.chunkThresholdOverride == null;
  const plannerBudgetAvailable = options.backend === 'llama.cpp'
    && (llamaPromptBudget?.plannerStopLineTokens ?? 0) > 0;
  if (
    isTopLevelLlamaPass
    && plannerBudgetAvailable
    && options.inputText.length > plannerActivationThreshold
  ) {
    const plannerDecision = await invokePlannerMode({
      requestId: options.requestId,
      slotId: options.slotId,
      question: options.question,
      inputText: options.inputText,
      format: options.format,
      backend: options.backend,
      model: options.model,
      config: options.config,
      rawReviewRequired: options.rawReviewRequired,
      sourceKind: options.sourceKind,
      commandExitCode: options.commandExitCode,
      debugCommand: options.debugCommand,
      promptPrefix: options.promptPrefix,
      requestTimeoutSeconds: options.requestTimeoutSeconds,
      llamaCppOverrides: options.llamaCppOverrides,
    });
    if (plannerDecision === PLANNER_FALLBACK_TO_CHUNKS) {
      // Fall through to normal chunking/provider flow.
    } else if (plannerDecision) {
      return plannerDecision;
    } else {
      throw new Error(buildPlannerFailureErrorMessage({
        requestId: options.requestId,
      }));
    }
  }
  if (
    options.inputText.length > chunkThreshold
    && !(options.backend === 'llama.cpp' && (llamaPromptBudget?.usablePromptBudgetTokens ?? 0) <= 0)
  ) {
    const plannedChunks = options.backend === 'llama.cpp'
      ? await planTokenAwareLlamaCppChunks({
        question: options.question,
        inputText: options.inputText,
        format: options.format,
        policyProfile: options.policyProfile,
        rawReviewRequired: options.rawReviewRequired,
        promptPrefix: options.promptPrefix,
        sourceKind: options.sourceKind,
        commandExitCode: options.commandExitCode,
        config: options.config,
        chunkThreshold,
        phase,
        chunkContext: options.chunkContext,
      })
      : null;
    const chunks = plannedChunks && plannedChunks.length > 1
      ? plannedChunks
      : splitTextIntoChunks(options.inputText, chunkThreshold);
    if (chunks.length > 1) {
      const chunkDecisions: StructuredModelDecision[] = [];
      for (let index = 0; index < chunks.length; index += 1) {
        const childChunkPath = appendChunkPath(options.chunkPath ?? null, index + 1, chunks.length);
        chunkDecisions.push(await invokeSummaryCore({
          ...options,
          inputText: chunks[index],
          phase,
        chunkIndex: index + 1,
        chunkTotal: chunks.length,
        chunkPath: childChunkPath,
        rootInputCharacterCount,
        chunkThresholdOverride: chunkThreshold,
        chunkContext: {
          isGeneratedChunk: true,
          mayBeTruncated: true,
            retryMode: 'default',
            chunkPath: childChunkPath,
          },
        }));
      }
      const mergeLines = chunkDecisions
        .map((decision, index) => JSON.stringify({
          chunk: index + 1,
          classification: decision.classification,
          raw_review_required: decision.rawReviewRequired,
          output: decision.output,
        }));
      const mergeRequiresRawReview = chunkDecisions.some((decision) => decision.rawReviewRequired);
      const mergeInput = [
        `raw_review_required=${mergeRequiresRawReview ? 'true' : 'false'}`,
        ...mergeLines,
      ].join('\n');
      return invokeSummaryCore({
        ...options,
        question: options.question,
        inputText: mergeInput,
        phase: 'merge',
        chunkIndex: options.chunkIndex ?? null,
        chunkTotal: options.chunkTotal ?? null,
        chunkPath: options.chunkPath ?? null,
        rootInputCharacterCount,
        chunkThresholdOverride: chunkThreshold,
        chunkContext: undefined,
      });
    }
  }

  const allowUnsupportedInput = options.sourceKind !== 'command-output'
    && (options.backend !== 'llama.cpp' || isInternalChunkLeaf(options));
  const prompt = buildPrompt({
    question: options.question,
    inputText: options.inputText,
    format: options.format,
    policyProfile: options.policyProfile,
    rawReviewRequired: options.rawReviewRequired,
    promptPrefix: options.promptPrefix,
    sourceKind: options.sourceKind,
    commandExitCode: options.commandExitCode,
    phase,
    chunkContext: options.chunkContext,
    allowUnsupportedInput,
  });
  const effectivePromptLimit = options.backend === 'llama.cpp'
    ? (llamaPromptBudget?.usablePromptBudgetTokens ?? 0)
    : null;
  traceSummary(
    `preflight start phase=${phase} chunk=${chunkLabel} prompt_chars=${prompt.length} `
    + `effective_prompt_limit=${effectivePromptLimit ?? 'null'}`
  );
  const promptTokenCount = effectivePromptLimit !== null && effectivePromptLimit > 0
    ? await countLlamaCppTokens(options.config, prompt)
    : null;
  traceSummary(
    `preflight done phase=${phase} chunk=${chunkLabel} prompt_tokens=${promptTokenCount ?? 'null'}`
  );
  const preflightChunkThreshold = effectivePromptLimit !== null && promptTokenCount !== null
    ? getTokenAwareChunkThreshold({
      inputLength: options.inputText.length,
      promptTokenCount,
      effectivePromptLimit,
    })
    : null;
  if (preflightChunkThreshold !== null) {
    traceSummary(
      `preflight recurse phase=${phase} chunk=${chunkLabel} reduced_chunk_threshold=${preflightChunkThreshold}`
    );
    return invokeSummaryCore({
      ...options,
      rootInputCharacterCount,
      chunkThresholdOverride: preflightChunkThreshold,
      chunkIndex: options.chunkIndex ?? null,
      chunkTotal: options.chunkTotal ?? null,
      chunkPath: options.chunkPath ?? null,
    });
  }

  try {
    const rawResponse = await invokeProviderSummary({
      requestId: options.requestId,
      slotId: options.slotId,
      backend: options.backend,
      config: options.config,
      model: options.model,
      prompt,
      question: options.question,
      promptCharacterCount: prompt.length,
      promptTokenCount,
      rawInputCharacterCount: rootInputCharacterCount,
      chunkInputCharacterCount: options.inputText.length,
      phase,
      chunkIndex: options.chunkIndex ?? null,
      chunkTotal: options.chunkTotal ?? null,
      chunkPath: options.chunkPath ?? null,
      reasoningOverride: enforceNonToolOneShot ? 'off' : undefined,
      requestTimeoutSeconds: options.requestTimeoutSeconds,
      llamaCppOverrides: options.llamaCppOverrides,
    });
    const parsedDecision = parseStructuredModelDecision(rawResponse);
    if (parsedDecision.classification === 'unsupported_input') {
      if (isInternalChunkLeaf(options)) {
        if (options.chunkContext?.retryMode !== 'strict') {
          return invokeSummaryCore({
            ...options,
            rootInputCharacterCount,
            chunkContext: {
              ...(options.chunkContext ?? {
                isGeneratedChunk: true,
                mayBeTruncated: true,
                chunkPath: options.chunkPath ?? null,
              }),
              retryMode: 'strict',
            },
          });
        }

        return normalizeStructuredDecision(
          buildConservativeChunkFallbackDecision({
            inputText: options.inputText,
            question: options.question,
            format: options.format,
          }),
          options.format,
        );
      }

      if (!allowUnsupportedInput) {
        return normalizeStructuredDecision(
          buildConservativeDirectFallbackDecision({
            inputText: options.inputText,
            question: options.question,
            format: options.format,
            sourceKind: options.sourceKind,
          }),
          options.format,
        );
      }
    }

    return normalizeStructuredDecision(parsedDecision, options.format);
  } catch (error) {
    const enrichedError = attachSummaryFailureContext(error, {
      requestId: options.requestId,
      promptCharacterCount: prompt.length,
      promptTokenCount,
      rawInputCharacterCount: rootInputCharacterCount,
      chunkInputCharacterCount: options.inputText.length,
      chunkIndex: options.chunkIndex ?? null,
      chunkTotal: options.chunkTotal ?? null,
      chunkPath: options.chunkPath ?? null,
    });
    if (!shouldRetryWithSmallerChunks({
      error: enrichedError,
      backend: options.backend,
      inputText: options.inputText,
      chunkThreshold,
    })) {
      throw enrichedError;
    }

    const reducedThreshold = (
      effectivePromptLimit !== null && promptTokenCount !== null
        ? getTokenAwareChunkThreshold({
          inputLength: options.inputText.length,
          promptTokenCount,
          effectivePromptLimit,
        })
        : null
    ) ?? Math.max(1, Math.min(chunkThreshold - 1, Math.floor(options.inputText.length / 2)));
    if (reducedThreshold >= options.inputText.length) {
      throw enrichedError;
    }

    return invokeSummaryCore({
      ...options,
      rootInputCharacterCount,
      chunkThresholdOverride: reducedThreshold,
      chunkIndex: options.chunkIndex ?? null,
      chunkTotal: options.chunkTotal ?? null,
      chunkPath: options.chunkPath ?? null,
    });
  }
}

function getPolicyDecision(classification: SummaryClassification): SummaryResult['PolicyDecision'] {
  if (classification === 'command_failure') {
    return 'model-command-failure';
  }
  if (classification === 'unsupported_input') {
    return 'model-unsupported-input';
  }
  return 'model-summary';
}

export async function summarizeRequest(request: SummaryRequest): Promise<SummaryResult> {
  const inputText = normalizeInputText(request.inputText);
  if (!inputText || !inputText.trim()) {
    throw new Error('Provide --text, --file, or pipe input into siftkit.');
  }

  const requestId = randomUUID();
  traceSummary(`summarizeRequest start input_chars=${inputText.length}`);
  return withExecutionLock(async () => {
    let config: SiftConfig | null = null;
    let backend = request.backend || 'unknown';
    let model = request.model || 'unknown';
    try {
      traceSummary('loadConfig start');
      config = await loadConfig({ ensure: true });
      traceSummary('loadConfig done');
      getConfiguredLlamaBaseUrl(config);
      getConfiguredLlamaNumCtx(config);
      backend = request.backend || config.Backend;
      model = request.model || getConfiguredModel(config);
      const riskLevel = request.policyProfile === 'risky-operation' ? 'risky' : 'informational';
      const sourceKind = request.sourceKind || 'standalone';
      const maxInputCharacters = getChunkThresholdCharacters(config) * 4;
      if (backend !== 'llama.cpp' && inputText.length > maxInputCharacters) {
        throw new Error(`Error: recieved input of ${inputText.length} characters, current maximum is ${maxInputCharacters} chars`);
      }
      const decision = getSummaryDecision(inputText, request.question, riskLevel, config, {
        sourceKind,
        commandExitCode: request.commandExitCode,
      });
      const errorMetrics = getErrorSignalMetrics(inputText);
      if (
        sourceKind === 'command-output'
        && Number.isFinite(request.commandExitCode)
        && isPassFailQuestion(request.question)
        && errorMetrics.ErrorLineCount === 0
      ) {
        const excerpt = getDeterministicExcerpt(inputText, request.question)
          || inputText.trim().split(/\r?\n/u).slice(0, 3).join('\n');
        const passed = Number(request.commandExitCode) === 0;
        const result: SummaryResult = {
          RequestId: requestId,
          WasSummarized: true,
          PolicyDecision: 'deterministic-pass-fail',
          Backend: backend,
          Model: model,
          Summary: excerpt
            ? `${passed ? 'PASS' : 'FAIL'}: command exit code was ${Number(request.commandExitCode)} and the captured output contains no obvious error signals. Observed output: ${excerpt}`
            : `${passed ? 'PASS' : 'FAIL'}: command exit code was ${Number(request.commandExitCode)} and the captured output contains no obvious error signals.`,
          Classification: 'summary',
          RawReviewRequired: false,
          ModelCallSucceeded: true,
          ProviderError: null,
        };
        await writeSummaryRequestDump({
          requestId,
          question: request.question,
          inputText,
          command: request.debugCommand ?? null,
          backend,
          model,
          classification: result.Classification,
          rawReviewRequired: result.RawReviewRequired,
          summary: result.Summary,
          providerError: result.ProviderError,
          error: null,
        });
        clearSummaryArtifactState(requestId);
        return result;
      }
      traceSummary(
        `decision ready backend=${backend} model=${model} raw_review_required=${decision.RawReviewRequired} `
        + `chars=${decision.CharacterCount} lines=${decision.LineCount}`
      );
      const slotId = backend === 'llama.cpp' ? allocateLlamaCppSlotId(config) : null;
      const effectivePromptPrefix = request.promptPrefix !== undefined
        ? request.promptPrefix
        : getConfiguredPromptPrefix(config);
      traceSummary('invokeSummaryCore start');
      const modelDecision = await invokeSummaryCore({
        requestId,
        slotId,
        question: request.question,
        inputText,
        format: request.format,
        policyProfile: request.policyProfile,
        backend,
        model,
        config,
        rawReviewRequired: decision.RawReviewRequired,
        sourceKind,
        commandExitCode: request.commandExitCode,
        debugCommand: request.debugCommand,
        promptPrefix: effectivePromptPrefix,
        requestTimeoutSeconds: request.requestTimeoutSeconds,
        llamaCppOverrides: request.llamaCppOverrides,
      });
      traceSummary(`invokeSummaryCore done classification=${modelDecision.classification}`);
      try {
        await notifyStatusBackend({
          running: false,
          requestId,
          terminalState: 'completed',
          rawInputCharacterCount: inputText.length,
        });
      } catch {
        traceSummary(`terminal status post failed request_id=${requestId} state=completed`);
      }

      await finalizePlannerDebugDump({
        requestId,
        finalOutput: modelDecision.output.trim(),
        classification: modelDecision.classification,
        rawReviewRequired: modelDecision.rawReviewRequired,
        providerError: null,
      });

      const result: SummaryResult = {
        RequestId: requestId,
        WasSummarized: modelDecision.classification !== 'unsupported_input',
        PolicyDecision: getPolicyDecision(modelDecision.classification),
        Backend: backend,
        Model: model,
        Summary: modelDecision.output.trim(),
        Classification: modelDecision.classification,
        RawReviewRequired: modelDecision.rawReviewRequired,
        ModelCallSucceeded: true,
        ProviderError: null,
      };
      await writeSummaryRequestDump({
        requestId,
        question: request.question,
        inputText,
        command: request.debugCommand ?? null,
        backend,
        model,
        classification: result.Classification,
        rawReviewRequired: result.RawReviewRequired,
        summary: result.Summary,
        providerError: result.ProviderError,
        error: null,
      });
      clearSummaryArtifactState(requestId);
      return result;
    } catch (error) {
      const failureContext = getSummaryFailureContext(error);
      if (config !== null) {
        try {
          await notifyStatusBackend({
            running: false,
            requestId,
            terminalState: 'failed',
            errorMessage: getErrorMessage(error),
            promptCharacterCount: failureContext?.promptCharacterCount ?? null,
            promptTokenCount: failureContext?.promptTokenCount ?? null,
            rawInputCharacterCount: failureContext?.rawInputCharacterCount ?? inputText.length,
            chunkInputCharacterCount: failureContext?.chunkInputCharacterCount ?? null,
            chunkIndex: failureContext?.chunkIndex ?? null,
            chunkTotal: failureContext?.chunkTotal ?? null,
            chunkPath: failureContext?.chunkPath ?? null,
          });
        } catch {
          traceSummary(`terminal status post failed request_id=${requestId} state=failed`);
        }
      }
      await finalizePlannerDebugDump({
        requestId,
        finalOutput: getErrorMessage(error),
        classification: 'command_failure',
        rawReviewRequired: true,
        providerError: getErrorMessage(error),
      });
      if (/planner/iu.test(getErrorMessage(error))) {
        await writeFailedRequestDump({
          requestId,
          question: request.question,
          inputText,
          command: request.debugCommand ?? null,
          error: getErrorMessage(error),
          providerError: getErrorMessage(error),
        });
      }
      clearSummaryArtifactState(requestId);
      throw error;
    }
  });
}

export function readSummaryInput(options: {
  text?: string;
  file?: string;
  stdinText?: string;
}): string | null {
  if (options.text !== undefined) {
    return normalizeInputText(options.text);
  }

  if (options.file) {
    if (!fs.existsSync(options.file)) {
      if (options.stdinText !== undefined) {
        return normalizeInputText(options.stdinText);
      }
      throw new Error(`Input file not found: ${options.file}`);
    }
    return normalizeInputText(fs.readFileSync(options.file, 'utf8'));
  }

  if (options.stdinText !== undefined) {
    return normalizeInputText(options.stdinText);
  }

  return null;
}
