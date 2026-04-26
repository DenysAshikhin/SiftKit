import * as fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import {
  loadConfig,
  type SiftConfig,
  getChunkThresholdCharacters,
  getConfiguredLlamaBaseUrl,
  getConfiguredLlamaNumCtx,
  getConfiguredModel,
  getConfiguredPromptPrefix,
  notifyStatusBackend,
} from '../config/index.js';
import { acquireExecutionLock, releaseExecutionLock } from '../execution-lock.js';
import { getErrorMessage } from '../lib/errors.js';
import { decodeTextBuffer } from '../lib/text-encoding.js';
import { countLlamaCppTokens } from '../providers/llama-cpp.js';
import {
  getDeterministicExcerpt,
  getErrorSignalMetrics,
  isPassFailQuestion,
  normalizeInputText,
} from './measure.js';
import {
  buildCompactPrompt,
  buildPrompt,
} from './prompt.js';
import {
  buildConservativeChunkFallbackDecision,
  buildConservativeDirectFallbackDecision,
  isInternalChunkLeaf,
  normalizeStructuredDecision,
  parseStructuredModelDecision,
} from './structured.js';
import {
  attachSummaryFailureContext,
  buildFailedRequestArtifact,
  buildPlannerDebugArtifact,
  buildPlannerFailureErrorMessage,
  buildSummaryRequestArtifact,
  clearSummaryArtifactState,
  getSummaryFailureContext,
  traceSummary,
} from './artifacts.js';
import {
  allocateLlamaCppSlotId,
  getLlamaCppChunkThresholdCharacters,
  getPlannerActivationThresholdCharacters,
  getPlannerPromptBudget,
  sumTokenCounts,
} from './chunking.js';
import { getSummaryDecision, getPolicyDecision } from './decision.js';
import {
  invokeProviderSummary,
  type ProviderSummaryMetrics,
} from './provider-invoke.js';
import { invokePlannerMode } from './planner/mode.js';
import { parseDeterministicTestOutput } from './test-output.js';
import type {
  ChunkPromptContext,
  StructuredModelDecision,
  SummarySourceKind,
  SummaryPhase,
  SummaryRequest,
  SummaryResult,
} from './types.js';

type SummaryCompletionMetrics = {
  promptCharacterCount: number;
  inputTokens: number | null;
  outputCharacterCount: number | null;
  outputTokens: number | null;
  thinkingTokens: number | null;
  promptCacheTokens: number | null;
  promptEvalTokens: number | null;
  requestDurationMs: number;
  providerDurationMs: number;
  statusRunningMs: number;
};

type SummaryCoreResult = {
  decision: StructuredModelDecision;
  completionMetrics: SummaryCompletionMetrics | null;
};

function toSummaryCompletionMetrics(
  phase: SummaryPhase,
  chunkPath: string | null,
  metrics: ProviderSummaryMetrics,
): SummaryCompletionMetrics {
  const countOutputTokensAsThinking = phase === 'leaf' && chunkPath !== null;
  return {
    promptCharacterCount: metrics.promptCharacterCount,
    inputTokens: metrics.inputTokens,
    outputCharacterCount: metrics.outputCharacterCount,
    outputTokens: countOutputTokensAsThinking ? null : metrics.outputTokens,
    thinkingTokens: countOutputTokensAsThinking
      ? sumTokenCounts(metrics.thinkingTokens, metrics.outputTokens)
      : metrics.thinkingTokens,
    promptCacheTokens: metrics.promptCacheTokens,
    promptEvalTokens: metrics.promptEvalTokens,
    requestDurationMs: metrics.requestDurationMs,
    providerDurationMs: metrics.providerDurationMs,
    statusRunningMs: metrics.statusRunningMs,
  };
}

function getNonNegativeTiming(value: number | null | undefined): number {
  return Number.isFinite(value) && Number(value) >= 0 ? Math.trunc(Number(value)) : 0;
}

function getSummaryWallDurationMs(request: SummaryRequest, fallbackStartedAtMs: number): number {
  const startedAt = getNonNegativeTiming(request.timing?.processStartedAtMs) || fallbackStartedAtMs;
  return Math.max(0, Date.now() - startedAt);
}

function isEmptyDecisionOutputError(error: unknown): boolean {
  return /Provider returned an empty SiftKit decision output\./iu.test(getErrorMessage(error));
}

async function invokeSummaryCore(options: {
  requestId: string;
  slotId: number | null;
  question: string;
  inputText: string;
  format: 'text' | 'json';
  policyProfile: SummaryRequest['policyProfile'];
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
  allowedPlannerTools?: SummaryRequest['allowedPlannerTools'];
  requestTimeoutSeconds?: number;
  llamaCppOverrides?: SummaryRequest['llamaCppOverrides'];
  chunkContext?: ChunkPromptContext;
}): Promise<SummaryCoreResult> {
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
      allowedTools: options.allowedPlannerTools,
      requestTimeoutSeconds: options.requestTimeoutSeconds,
      llamaCppOverrides: options.llamaCppOverrides,
    });
    if (plannerDecision) {
      return {
        decision: plannerDecision,
        completionMetrics: null,
      };
    }
    throw new Error(buildPlannerFailureErrorMessage({
      requestId: options.requestId,
    }));
  }

  const useCompactPrompt = options.backend === 'llama.cpp'
    && phase === 'leaf'
    && options.policyProfile === 'general'
    && !options.chunkContext
    && options.inputText.length <= chunkThreshold;
  const allowUnsupportedInput = !useCompactPrompt
    && options.sourceKind !== 'command-output'
    && (options.backend !== 'llama.cpp' || isInternalChunkLeaf(options));
  const prompt = useCompactPrompt
    ? buildCompactPrompt({
      question: options.question,
      inputText: options.inputText,
      promptPrefix: options.promptPrefix,
    })
    : buildPrompt({
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
  if (
    options.backend === 'llama.cpp'
    && phase === 'leaf'
    && !options.chunkContext
    && effectivePromptLimit !== null
    && promptTokenCount !== null
    && promptTokenCount > effectivePromptLimit
  ) {
    traceSummary(
      `preflight planner handoff phase=${phase} chunk=${chunkLabel} prompt_tokens=${promptTokenCount} `
      + `effective_prompt_limit=${effectivePromptLimit}`
    );
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
      allowedTools: options.allowedPlannerTools,
      requestTimeoutSeconds: options.requestTimeoutSeconds,
      llamaCppOverrides: options.llamaCppOverrides,
    });
    if (plannerDecision) {
      return {
        decision: plannerDecision,
        completionMetrics: null,
      };
    }
    throw new Error(buildPlannerFailureErrorMessage({
      requestId: options.requestId,
    }));
  }

  let providerMetrics: ProviderSummaryMetrics | null = null;
  try {
    const invokeSummaryProvider = async (): Promise<string> => {
      const providerResult = await invokeProviderSummary({
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
        requestTimeoutSeconds: options.requestTimeoutSeconds,
        llamaCppOverrides: options.llamaCppOverrides,
      });
      providerMetrics = providerResult.metrics;
      return providerResult.text;
    };
    const rawResponse = await invokeSummaryProvider();
    let parsedDecision: StructuredModelDecision;
    try {
      parsedDecision = parseStructuredModelDecision(rawResponse);
    } catch (error) {
      if (!isEmptyDecisionOutputError(error)) {
        throw error;
      }
      traceSummary(
        `provider empty-output retry phase=${phase} chunk=${chunkLabel} request_id=${options.requestId}`
      );
      const retryRawResponse = await invokeSummaryProvider();
      parsedDecision = parseStructuredModelDecision(retryRawResponse);
    }
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

        return {
          decision: normalizeStructuredDecision(
            buildConservativeChunkFallbackDecision({
              inputText: options.inputText,
              question: options.question,
              format: options.format,
            }),
            options.format,
          ),
          completionMetrics: providerMetrics ? toSummaryCompletionMetrics(phase, options.chunkPath ?? null, providerMetrics) : null,
        };
      }

      if (!allowUnsupportedInput) {
        return {
          decision: normalizeStructuredDecision(
            buildConservativeDirectFallbackDecision({
              inputText: options.inputText,
              question: options.question,
              format: options.format,
              sourceKind: options.sourceKind,
            }),
            options.format,
          ),
          completionMetrics: providerMetrics ? toSummaryCompletionMetrics(phase, options.chunkPath ?? null, providerMetrics) : null,
        };
      }
    }

    return {
      decision: normalizeStructuredDecision(parsedDecision, options.format),
      completionMetrics: providerMetrics ? toSummaryCompletionMetrics(phase, options.chunkPath ?? null, providerMetrics) : null,
    };
  } catch (error) {
    const failureProviderMetrics = providerMetrics as ProviderSummaryMetrics | null;
    const enrichedError = attachSummaryFailureContext(error, {
      requestId: options.requestId,
      promptCharacterCount: prompt.length,
      promptTokenCount,
      rawInputCharacterCount: rootInputCharacterCount,
      chunkInputCharacterCount: options.inputText.length,
      chunkIndex: options.chunkIndex ?? null,
      chunkTotal: options.chunkTotal ?? null,
      chunkPath: options.chunkPath ?? null,
      inputTokens: failureProviderMetrics ? (failureProviderMetrics as ProviderSummaryMetrics).inputTokens : null,
      outputCharacterCount: failureProviderMetrics ? (failureProviderMetrics as ProviderSummaryMetrics).outputCharacterCount : null,
      outputTokens: failureProviderMetrics ? (failureProviderMetrics as ProviderSummaryMetrics).outputTokens : null,
      thinkingTokens: failureProviderMetrics ? (failureProviderMetrics as ProviderSummaryMetrics).thinkingTokens : null,
      promptCacheTokens: failureProviderMetrics ? (failureProviderMetrics as ProviderSummaryMetrics).promptCacheTokens : null,
      promptEvalTokens: failureProviderMetrics ? (failureProviderMetrics as ProviderSummaryMetrics).promptEvalTokens : null,
      requestDurationMs: failureProviderMetrics ? (failureProviderMetrics as ProviderSummaryMetrics).requestDurationMs : null,
      providerDurationMs: failureProviderMetrics ? (failureProviderMetrics as ProviderSummaryMetrics).providerDurationMs : null,
      statusRunningMs: failureProviderMetrics ? (failureProviderMetrics as ProviderSummaryMetrics).statusRunningMs : null,
    });
    if (
      options.backend === 'llama.cpp'
      && phase === 'leaf'
      && !options.chunkContext
      && /llama\.cpp generate failed with HTTP 400\b/iu.test(getErrorMessage(enrichedError))
    ) {
      traceSummary(`provider planner handoff phase=${phase} chunk=${chunkLabel} request_id=${options.requestId}`);
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
        allowedTools: options.allowedPlannerTools,
        requestTimeoutSeconds: options.requestTimeoutSeconds,
        llamaCppOverrides: options.llamaCppOverrides,
      });
      if (plannerDecision) {
        return {
          decision: plannerDecision,
          completionMetrics: null,
        };
      }
      throw new Error(buildPlannerFailureErrorMessage({
        requestId: options.requestId,
      }));
    }
    throw enrichedError;
  }
}

export async function summarizeRequest(request: SummaryRequest): Promise<SummaryResult> {
  const inputText = normalizeInputText(request.inputText);
  if (!inputText || !inputText.trim()) {
    throw new Error('Provide --text, --file, or pipe input into siftkit.');
  }

  const requestId = randomUUID();
  const requestStartedAt = Date.now();
  traceSummary(`summarizeRequest start input_chars=${inputText.length}`);
  const sourceKindForFastPath = request.sourceKind || 'standalone';
  const deterministicTestSummary = sourceKindForFastPath === 'command-output' && isPassFailQuestion(request.question)
    ? parseDeterministicTestOutput({
      inputText,
      commandExitCode: request.commandExitCode,
    })
    : null;
  if (deterministicTestSummary) {
    const backend = request.backend || 'unknown';
    const model = request.model || 'unknown';
    const result: SummaryResult = {
      RequestId: requestId,
      WasSummarized: true,
      PolicyDecision: 'deterministic-test-output',
      Backend: backend,
      Model: model,
      Summary: deterministicTestSummary.summary,
      Classification: deterministicTestSummary.verdict === 'PASS' ? 'summary' : 'command_failure',
      RawReviewRequired: deterministicTestSummary.verdict === 'FAIL',
      ModelCallSucceeded: true,
      ProviderError: null,
    };
    const deferredArtifacts = [
      buildSummaryRequestArtifact({
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
      }),
    ];
    await notifyStatusBackend({
      running: false,
      taskKind: 'summary',
      requestId,
      terminalState: 'completed',
      deferredMetadata: {
        rawInputCharacterCount: inputText.length,
        requestDurationMs: 0,
        providerDurationMs: 0,
        wallDurationMs: getSummaryWallDurationMs(request, requestStartedAt),
        stdinWaitMs: getNonNegativeTiming(request.timing?.stdinWaitMs),
        serverPreflightMs: getNonNegativeTiming(request.timing?.serverPreflightMs),
        lockWaitMs: 0,
        statusRunningMs: 0,
        terminalStatusMs: 0,
      },
      deferredArtifacts,
    });
    clearSummaryArtifactState(requestId);
    return result;
  }
  const lockStartedAt = Date.now();
  const lock = await acquireExecutionLock();
  const lockWaitMs = Date.now() - lockStartedAt;
  try {
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
        const deferredArtifacts = [
          buildSummaryRequestArtifact({
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
          }),
        ];
        await notifyStatusBackend({
          running: false,
          taskKind: 'summary',
          requestId,
          terminalState: 'completed',
          deferredMetadata: {
            rawInputCharacterCount: inputText.length,
            requestDurationMs: 0,
            providerDurationMs: 0,
            wallDurationMs: getSummaryWallDurationMs(request, requestStartedAt),
            stdinWaitMs: getNonNegativeTiming(request.timing?.stdinWaitMs),
            serverPreflightMs: getNonNegativeTiming(request.timing?.serverPreflightMs),
            lockWaitMs,
            statusRunningMs: 0,
            terminalStatusMs: 0,
          },
          deferredArtifacts,
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
      const summaryCore = await invokeSummaryCore({
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
        allowedPlannerTools: request.allowedPlannerTools,
        requestTimeoutSeconds: request.requestTimeoutSeconds,
        llamaCppOverrides: request.llamaCppOverrides,
      });
      const modelDecision = summaryCore.decision;
      traceSummary(`invokeSummaryCore done classification=${modelDecision.classification}`);
      const deferredArtifacts = [
        buildPlannerDebugArtifact({
          requestId,
          finalOutput: modelDecision.output.trim(),
          classification: modelDecision.classification,
          rawReviewRequired: modelDecision.rawReviewRequired,
          providerError: null,
        }),
        buildSummaryRequestArtifact({
          requestId,
          question: request.question,
          inputText,
          command: request.debugCommand ?? null,
          backend,
          model,
          classification: modelDecision.classification,
          rawReviewRequired: modelDecision.rawReviewRequired,
          summary: modelDecision.output.trim(),
          providerError: null,
          error: null,
        }),
      ].filter((artifact): artifact is NonNullable<typeof artifact> => artifact !== null);
      try {
        await notifyStatusBackend({
          running: false,
          taskKind: 'summary',
          requestId,
          terminalState: 'completed',
          deferredMetadata: {
            rawInputCharacterCount: inputText.length,
            promptCharacterCount: summaryCore.completionMetrics?.promptCharacterCount ?? null,
            inputTokens: summaryCore.completionMetrics?.inputTokens ?? null,
            outputCharacterCount: summaryCore.completionMetrics?.outputCharacterCount ?? null,
            outputTokens: summaryCore.completionMetrics?.outputTokens ?? null,
            thinkingTokens: summaryCore.completionMetrics?.thinkingTokens ?? null,
            promptCacheTokens: summaryCore.completionMetrics?.promptCacheTokens ?? null,
            promptEvalTokens: summaryCore.completionMetrics?.promptEvalTokens ?? null,
            requestDurationMs: summaryCore.completionMetrics?.requestDurationMs ?? null,
            providerDurationMs: summaryCore.completionMetrics?.providerDurationMs ?? summaryCore.completionMetrics?.requestDurationMs ?? null,
            wallDurationMs: getSummaryWallDurationMs(request, requestStartedAt),
            stdinWaitMs: getNonNegativeTiming(request.timing?.stdinWaitMs),
            serverPreflightMs: getNonNegativeTiming(request.timing?.serverPreflightMs),
            lockWaitMs,
            statusRunningMs: summaryCore.completionMetrics?.statusRunningMs ?? null,
            terminalStatusMs: 0,
          },
          deferredArtifacts,
        });
      } catch {
        traceSummary(`terminal status post failed request_id=${requestId} state=completed`);
      }

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
      clearSummaryArtifactState(requestId);
      return result;
    } catch (error) {
      const failureContext = getSummaryFailureContext(error);
      const deferredArtifacts = [
        buildPlannerDebugArtifact({
          requestId,
          finalOutput: getErrorMessage(error),
          classification: 'command_failure',
          rawReviewRequired: true,
          providerError: getErrorMessage(error),
        }),
        ...(/planner/iu.test(getErrorMessage(error))
          ? [buildFailedRequestArtifact({
            requestId,
            question: request.question,
            inputText,
            command: request.debugCommand ?? null,
            error: getErrorMessage(error),
            providerError: getErrorMessage(error),
          })]
          : []),
      ].filter((artifact): artifact is NonNullable<typeof artifact> => artifact !== null);
      if (config !== null) {
        try {
          await notifyStatusBackend({
            running: false,
            taskKind: 'summary',
            requestId,
            terminalState: 'failed',
            deferredMetadata: {
              errorMessage: getErrorMessage(error),
              promptCharacterCount: failureContext?.promptCharacterCount ?? null,
              promptTokenCount: failureContext?.promptTokenCount ?? null,
              rawInputCharacterCount: failureContext?.rawInputCharacterCount ?? inputText.length,
              chunkInputCharacterCount: failureContext?.chunkInputCharacterCount ?? null,
              chunkIndex: failureContext?.chunkIndex ?? null,
              chunkTotal: failureContext?.chunkTotal ?? null,
              chunkPath: failureContext?.chunkPath ?? null,
              inputTokens: failureContext?.inputTokens ?? null,
              outputCharacterCount: failureContext?.outputCharacterCount ?? null,
              outputTokens: failureContext?.outputTokens ?? null,
              thinkingTokens: failureContext?.thinkingTokens ?? null,
              promptCacheTokens: failureContext?.promptCacheTokens ?? null,
              promptEvalTokens: failureContext?.promptEvalTokens ?? null,
              requestDurationMs: failureContext?.requestDurationMs ?? null,
              providerDurationMs: failureContext?.providerDurationMs ?? failureContext?.requestDurationMs ?? null,
              wallDurationMs: failureContext?.wallDurationMs ?? getSummaryWallDurationMs(request, requestStartedAt),
              stdinWaitMs: failureContext?.stdinWaitMs ?? getNonNegativeTiming(request.timing?.stdinWaitMs),
              serverPreflightMs: failureContext?.serverPreflightMs ?? getNonNegativeTiming(request.timing?.serverPreflightMs),
              lockWaitMs: failureContext?.lockWaitMs ?? lockWaitMs,
              statusRunningMs: failureContext?.statusRunningMs ?? null,
              terminalStatusMs: failureContext?.terminalStatusMs ?? 0,
            },
            deferredArtifacts,
          });
        } catch {
          traceSummary(`terminal status post failed request_id=${requestId} state=failed`);
        }
      }
      clearSummaryArtifactState(requestId);
      throw error;
    }
  } finally {
    await releaseExecutionLock(lock);
  }
}

export function readSummaryInput(options: {
  text?: string;
  file?: string;
  stdinText?: string | Buffer;
}): string | null {
  if (options.text !== undefined) {
    return normalizeInputText(options.text);
  }

  if (options.file) {
    if (!fs.existsSync(options.file)) {
      if (options.stdinText !== undefined) {
        return normalizeInputText(
          Buffer.isBuffer(options.stdinText)
            ? decodeTextBuffer(options.stdinText)
            : options.stdinText,
        );
      }
      throw new Error(`Input file not found: ${options.file}`);
    }
    return normalizeInputText(decodeTextBuffer(fs.readFileSync(options.file)));
  }

  if (options.stdinText !== undefined) {
    return normalizeInputText(
      Buffer.isBuffer(options.stdinText)
        ? decodeTextBuffer(options.stdinText)
        : options.stdinText,
    );
  }

  return null;
}
