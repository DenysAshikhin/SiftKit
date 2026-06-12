import * as fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import {
  applyHostLlamaRuntimeSettings,
  loadConfig,
  normalizeLoadedConfig,
  type SiftConfig,
  getChunkThresholdCharacters,
  getConfiguredLlamaBaseUrl,
  getConfiguredLlamaNumCtx,
  getConfiguredModel,
  getConfiguredPromptPrefix,
  notifyStatusBackend,
} from '../config/index.js';
import type { NotifyStatusBackendOptions } from '../config/status-backend.js';
import { acquireExecutionLock, releaseExecutionLock } from '../execution-lock.js';
import { getErrorMessage } from '../lib/errors.js';
import { createTemporaryTimingRecorderFromEnv, type TemporaryTimingRecorder } from '../lib/temporary-timing-recorder.js';
import { decodeTextBuffer } from '../lib/text-encoding.js';
import {
  getDeterministicExcerpt,
  getErrorSignalMetrics,
  isPassFailQuestion,
  normalizeInputText,
} from './measure.js';
import {
  buildPlannerDebugArtifact,
  buildFailedRequestArtifact,
  buildSummaryRequestArtifact,
  clearSummaryArtifactState,
  getSummaryFailureContext,
  traceSummary,
} from './artifacts.js';
import {
  allocateLlamaCppSlotId,
  getPlannerPromptBudget,
} from './chunking.js';
import { getSummaryDecision, getPolicyDecision } from './decision.js';
import { logSummaryProgress } from './progress.js';
import { invokeSummaryCore, type SummaryCoreResult } from './core-runner.js';
import { parseDeterministicTestOutput } from './test-output.js';
import type {
  SummarySourceKind,
  SummaryRequest,
  SummaryResult,
} from './types.js';


async function notifySummaryTerminalStatus(
  options: NotifyStatusBackendOptions & { requestId: string; terminalState: 'completed' | 'failed' },
): Promise<void> {
  const startedAt = Date.now();
  try {
    await notifyStatusBackend(options);
    traceSummary(
      `terminal status post done request_id=${options.requestId} state=${options.terminalState} `
      + `duration_ms=${Date.now() - startedAt}`,
    );
  } catch {
    traceSummary(`terminal status post failed request_id=${options.requestId} state=${options.terminalState}`);
  }
}



function getNonNegativeTiming(value: number | null | undefined): number {
  return Number.isFinite(value) && Number(value) >= 0 ? Math.trunc(Number(value)) : 0;
}

function getSummaryWallDurationMs(request: SummaryRequest, fallbackStartedAtMs: number): number {
  const startedAt = getNonNegativeTiming(request.timing?.processStartedAtMs) || fallbackStartedAtMs;
  return Math.max(0, Date.now() - startedAt);
}



export async function summarizeRequest(request: SummaryRequest): Promise<SummaryResult> {
  const inputText = normalizeInputText(request.inputText);
  if (!inputText || !inputText.trim()) {
    throw new Error('Provide --text, --file, or pipe input into siftkit.');
  }

  const requestId = randomUUID();
  const requestStartedAt = Date.now();
  const timingRecorder = createTemporaryTimingRecorderFromEnv({
    kind: 'summary',
    requestId,
    metadata: {
      inputChars: inputText.length,
      questionChars: request.question.length,
    },
  });
  let timingStatus: 'completed' | 'failed' = 'failed';
  traceSummary(`summarizeRequest start input_chars=${inputText.length}`);
  logSummaryProgress(`start request_id=${requestId} input_chars=${inputText.length}`);
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
    await notifySummaryTerminalStatus({
      running: false,
      taskKind: 'summary',
      statusBackendUrl: request.statusBackendUrl,
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
    timingStatus = 'completed';
    if (timingRecorder) {
      await timingRecorder.flush({
        status: timingStatus,
        metadata: {
          durationMs: Date.now() - requestStartedAt,
        },
      }).catch((error: Error) => {
        traceSummary(`temp timing flush failed request_id=${requestId} error=${error.message}`);
      });
    }
    clearSummaryArtifactState(requestId);
    logSummaryProgress(`completed request_id=${requestId} classification=${result.Classification}`);
    return result;
  }
  const lockStartedAt = Date.now();
  const lock = request.skipExecutionLock ? null : await acquireExecutionLock();
  const lockWaitMs = request.skipExecutionLock ? 0 : Date.now() - lockStartedAt;
  try {
    let config: SiftConfig | null = null;
    let backend = request.backend || 'unknown';
    let model = request.model || 'unknown';
    try {
      const configSpan = timingRecorder?.start('summary.config.load', {
        provided: Boolean(request.config),
      });
      if (request.config) {
        traceSummary('normalize provided config start');
        logSummaryProgress(`config_start request_id=${requestId} source=provided`);
        config = await normalizeLoadedConfig(request.config);
        traceSummary('normalize provided config done');
      } else {
        traceSummary('loadConfig start');
        logSummaryProgress(`config_start request_id=${requestId} source=load`);
        config = await loadConfig({ ensure: true });
        traceSummary('loadConfig done');
      }
      configSpan?.end();
      getConfiguredLlamaBaseUrl(config);
      getConfiguredLlamaNumCtx(config);
      backend = request.backend || config.Backend;
      model = request.model || getConfiguredModel(config);
      logSummaryProgress(`config_done request_id=${requestId} backend=${backend} model=${model}`);
      if (backend === 'llama.cpp') {
        // In pass-through mode the prompt-budget math must use the host's real
        // context window, not this client's (possibly stale) local NumCtx.
        const localNumCtx = getConfiguredLlamaNumCtx(config);
        config = await applyHostLlamaRuntimeSettings(config);
        const effectiveNumCtx = getConfiguredLlamaNumCtx(config);
        if (effectiveNumCtx !== localNumCtx) {
          logSummaryProgress(
            `host_sync request_id=${requestId} num_ctx_local=${localNumCtx} num_ctx_host=${effectiveNumCtx}`,
          );
        }
      }
      const riskLevel = request.policyProfile === 'risky-operation' ? 'risky' : 'informational';
      const sourceKind = request.sourceKind || 'standalone';
      const maxInputCharacters = getChunkThresholdCharacters(config) * 4;
      if (backend !== 'llama.cpp' && inputText.length > maxInputCharacters) {
        throw new Error(`Error: recieved input of ${inputText.length} characters, current maximum is ${maxInputCharacters} chars`);
      }
      const decisionSpan = timingRecorder?.start('summary.decision');
      const decision = getSummaryDecision(inputText, request.question, riskLevel, config, {
        sourceKind,
        commandExitCode: request.commandExitCode,
      });
      decisionSpan?.end({
        rawReviewRequired: decision.RawReviewRequired,
        characterCount: decision.CharacterCount,
      });
      logSummaryProgress(
        `decision_done request_id=${requestId} backend=${backend} raw_review_required=${decision.RawReviewRequired} `
        + `chars=${decision.CharacterCount}`,
      );
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
        await notifySummaryTerminalStatus({
          running: false,
          taskKind: 'summary',
          statusBackendUrl: request.statusBackendUrl,
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
        timingStatus = 'completed';
        clearSummaryArtifactState(requestId);
        logSummaryProgress(`completed request_id=${requestId} classification=${result.Classification}`);
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
      logSummaryProgress(`core_start request_id=${requestId} backend=${backend}`);
      const coreSpan = timingRecorder?.start('summary.core');
      let summaryCore: SummaryCoreResult;
      try {
        summaryCore = await invokeSummaryCore({
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
          statusBackendUrl: request.statusBackendUrl,
          timingRecorder,
        });
      } finally {
        coreSpan?.end();
      }
      logSummaryProgress(`core_done request_id=${requestId} backend=${backend}`);
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
      await notifySummaryTerminalStatus({
        running: false,
        taskKind: 'summary',
        statusBackendUrl: request.statusBackendUrl,
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
      timingStatus = 'completed';
      logSummaryProgress(`completed request_id=${requestId} classification=${result.Classification}`);
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
        await notifySummaryTerminalStatus({
          running: false,
          taskKind: 'summary',
          statusBackendUrl: request.statusBackendUrl,
          requestId,
          terminalState: 'failed',
          errorMessage: getErrorMessage(error),
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
      }
      clearSummaryArtifactState(requestId);
      logSummaryProgress(`failed request_id=${requestId} error=${getErrorMessage(error)}`);
      throw error;
    }
  } finally {
    if (lock !== null) {
      await releaseExecutionLock(lock);
    }
    if (timingRecorder) {
      await timingRecorder.flush({
        status: timingStatus,
        metadata: {
          durationMs: Date.now() - requestStartedAt,
        },
      }).catch((error: Error) => {
        traceSummary(`temp timing flush failed request_id=${requestId} error=${error.message}`);
      });
    }
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
