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
import { withExecutionLock } from '../execution-lock.js';
import { getErrorMessage } from '../lib/errors.js';
import { countLlamaCppTokens } from '../providers/llama-cpp.js';
import {
  getDeterministicExcerpt,
  getErrorSignalMetrics,
  isPassFailQuestion,
  normalizeInputText,
} from './measure.js';
import {
  appendChunkPath,
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
  buildPlannerFailureErrorMessage,
  clearSummaryArtifactState,
  finalizePlannerDebugDump,
  getSummaryFailureContext,
  traceSummary,
  writeFailedRequestDump,
  writeSummaryRequestDump,
} from './artifacts.js';
import {
  allocateLlamaCppSlotId,
  estimatePromptTokenCount,
  getLlamaCppChunkThresholdCharacters,
  getPlannerActivationThresholdCharacters,
  getPlannerPromptBudget,
  getTokenAwareChunkThreshold,
  planTokenAwareLlamaCppChunks,
  shouldRetryWithSmallerChunks,
  splitTextIntoChunks,
} from './chunking.js';
import { getSummaryDecision, getPolicyDecision } from './decision.js';
import { invokeProviderSummary } from './provider-invoke.js';
import { invokePlannerMode, PLANNER_FALLBACK_TO_CHUNKS } from './planner/mode.js';
import type {
  ChunkPromptContext,
  StructuredModelDecision,
  SummarySourceKind,
  SummaryPhase,
  SummaryRequest,
  SummaryResult,
} from './types.js';

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

  const useCompactPrompt = options.backend === 'llama.cpp'
    && phase === 'leaf'
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
