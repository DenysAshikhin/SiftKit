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
import { getErrorMessage, toError } from '../lib/errors.js';
import { throwIfAborted } from '../lib/abort.js';
import { createTemporaryTimingRecorderFromEnv, type TemporaryTimingRecorder } from '../lib/temporary-timing-recorder.js';
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
} from './chunking.js';
import { getSummaryDecision, getPolicyDecision } from './decision.js';
import { SummaryProgressReporter } from './progress-reporter.js';
import { invokeSummaryCore, type SummaryCoreResult } from './core-runner.js';
import { parseDeterministicTestOutput } from './test-output.js';
import { resolveSummaryProvider } from './types.js';
import type {
  SummaryProviderId,
  SummaryRequest,
  SummaryResult,
  SummarySourceKind,
} from './types.js';

type SummaryExecutionContext = {
  config: SiftConfig;
  backend: SummaryProviderId;
  model: string;
  sourceKind: SummarySourceKind;
  decision: ReturnType<typeof getSummaryDecision>;
};

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

/** Only the mock provider cannot chunk, so mock input above `maxInputCharacters` is rejected. */
export function isOversizedMockInput(
  backend: SummaryProviderId,
  inputLength: number,
  maxInputCharacters: number,
): boolean {
  return backend === 'mock' && inputLength > maxInputCharacters;
}

export class SummaryRequestRunner {
  private readonly request: SummaryRequest;
  private readonly inputText: string;
  private readonly requestId = randomUUID();
  private readonly requestStartedAtMs = Date.now();
  private readonly timingRecorder: TemporaryTimingRecorder | null;
  private timingStatus: 'completed' | 'failed' = 'failed';
  private config: SiftConfig | null = null;
  private readonly backend: SummaryProviderId;
  private readonly progress: SummaryProgressReporter;
  private model = 'unknown';

  constructor(request: SummaryRequest) {
    this.request = request;
    this.backend = resolveSummaryProvider(request.backend);
    this.inputText = normalizeInputText(request.inputText) ?? '';
    this.progress = new SummaryProgressReporter({
      requestId: this.requestId,
      onProgress: request.onProgress ?? null,
    });
    this.timingRecorder = createTemporaryTimingRecorderFromEnv({
      kind: 'summary',
      requestId: this.requestId,
      metadata: {
        inputChars: this.inputText.length,
        questionChars: request.question.length,
      },
    });
  }

  async run(): Promise<SummaryResult> {
    this.validateInput();
    this.logStart();
    const deterministicResult = await this.tryDeterministicTestOutput();
    if (deterministicResult) {
      return deterministicResult;
    }

    try {
      return await this.runRequest();
    } finally {
      await this.flushTiming();
    }
  }

  private validateInput(): void {
    if (!this.inputText || !this.inputText.trim()) {
      throw new Error('Provide --text, --file, or pipe input into siftkit.');
    }
  }

  private logStart(): void {
    traceSummary(`summarizeRequest start input_chars=${this.inputText.length}`);
    this.progress.start(this.inputText.length);
  }

  private async tryDeterministicTestOutput(): Promise<SummaryResult | null> {
    const sourceKindForFastPath = this.request.sourceKind || 'standalone';
    const deterministicTestSummary = sourceKindForFastPath === 'command-output' && isPassFailQuestion(this.request.question)
      ? parseDeterministicTestOutput({
        inputText: this.inputText,
        commandExitCode: this.request.commandExitCode,
      })
      : null;
    if (!deterministicTestSummary) {
      return null;
    }

    const model = this.request.model || 'unknown';
    const result: SummaryResult = {
      RequestId: this.requestId,
      WasSummarized: true,
      PolicyDecision: 'deterministic-test-output',
      Backend: this.backend,
      Model: model,
      Summary: deterministicTestSummary.summary,
      Classification: deterministicTestSummary.verdict === 'PASS' ? 'summary' : 'command_failure',
      RawReviewRequired: deterministicTestSummary.verdict === 'FAIL',
      ModelCallSucceeded: true,
      ProviderError: null,
    };
    await this.notifyDeterministicCompletion(result);
    await this.flushCompletedTiming();
    this.completeRequest(result);
    return result;
  }

  private async runRequest(): Promise<SummaryResult> {
    try {
      throwIfAborted(this.request.abortSignal);
      const context = await this.loadExecutionContext();
      const deterministicPassFailResult = await this.tryDeterministicPassFail(context);
      if (deterministicPassFailResult) {
        return deterministicPassFailResult;
      }
      throwIfAborted(this.request.abortSignal);
      return await this.invokeModelSummary(context);
    } catch (error) {
      await this.handleFailure(toError(error));
      throw error;
    }
  }

  private async loadExecutionContext(): Promise<SummaryExecutionContext> {
    const configSpan = this.timingRecorder?.start('summary.config.load', {
      provided: Boolean(this.request.config),
    });
    if (this.request.config) {
      traceSummary('normalize provided config start');
      this.progress.configStart('provided');
      this.config = await normalizeLoadedConfig(this.request.config);
      traceSummary('normalize provided config done');
    } else {
      traceSummary('loadConfig start');
      this.progress.configStart('load');
      this.config = await loadConfig({ ensure: true });
      traceSummary('loadConfig done');
    }
    configSpan?.end();
    getConfiguredLlamaBaseUrl(this.config);
    getConfiguredLlamaNumCtx(this.config);
    this.model = this.request.model || getConfiguredModel(this.config);
    this.progress.configDone(this.backend, this.model);
    this.config = await this.applyHostLlamaSettings(this.config);

    const riskLevel = this.request.policyProfile === 'risky-operation' ? 'risky' : 'informational';
    const sourceKind = this.request.sourceKind || 'standalone';
    this.rejectOversizedMockInput(this.config, this.backend);
    const decisionSpan = this.timingRecorder?.start('summary.decision');
    const decision = getSummaryDecision(this.inputText, this.request.question, riskLevel, this.config, {
      sourceKind,
      commandExitCode: this.request.commandExitCode,
    });
    decisionSpan?.end({
      rawReviewRequired: decision.RawReviewRequired,
      characterCount: decision.CharacterCount,
    });
    this.progress.decisionDone(this.backend, decision.RawReviewRequired, decision.CharacterCount);
    return {
      config: this.config,
      backend: this.backend,
      model: this.model,
      sourceKind,
      decision,
    };
  }

  private async applyHostLlamaSettings(config: SiftConfig): Promise<SiftConfig> {
    const localNumCtx = getConfiguredLlamaNumCtx(config);
    const hostConfig = await applyHostLlamaRuntimeSettings(config);
    const effectiveNumCtx = getConfiguredLlamaNumCtx(hostConfig);
    if (effectiveNumCtx !== localNumCtx) {
      this.progress.hostSync(localNumCtx, effectiveNumCtx);
    }
    return hostConfig;
  }

  private rejectOversizedMockInput(config: SiftConfig, backend: SummaryProviderId): void {
    const maxInputCharacters = getChunkThresholdCharacters(config) * 4;
    if (isOversizedMockInput(backend, this.inputText.length, maxInputCharacters)) {
      throw new Error(`Error: recieved input of ${this.inputText.length} characters, current maximum is ${maxInputCharacters} chars`);
    }
  }

  private async tryDeterministicPassFail(
    context: SummaryExecutionContext,
  ): Promise<SummaryResult | null> {
    const errorMetrics = getErrorSignalMetrics(this.inputText);
    if (
      context.sourceKind !== 'command-output'
      || !Number.isFinite(this.request.commandExitCode)
      || !isPassFailQuestion(this.request.question)
      || errorMetrics.ErrorLineCount !== 0
    ) {
      return null;
    }

    const excerpt = getDeterministicExcerpt(this.inputText, this.request.question)
      || this.inputText.trim().split(/\r?\n/u).slice(0, 3).join('\n');
    const passed = Number(this.request.commandExitCode) === 0;
    const result: SummaryResult = {
      RequestId: this.requestId,
      WasSummarized: true,
      PolicyDecision: 'deterministic-pass-fail',
      Backend: context.backend,
      Model: context.model,
      Summary: excerpt
        ? `${passed ? 'PASS' : 'FAIL'}: command exit code was ${Number(this.request.commandExitCode)} and the captured output contains no obvious error signals. Observed output: ${excerpt}`
        : `${passed ? 'PASS' : 'FAIL'}: command exit code was ${Number(this.request.commandExitCode)} and the captured output contains no obvious error signals.`,
      Classification: 'summary',
      RawReviewRequired: false,
      ModelCallSucceeded: true,
      ProviderError: null,
    };
    await this.notifyDeterministicCompletion(result);
    this.completeRequest(result);
    return result;
  }

  private async invokeModelSummary(
    context: SummaryExecutionContext,
  ): Promise<SummaryResult> {
    traceSummary(
      `decision ready backend=${context.backend} model=${context.model} `
      + `raw_review_required=${context.decision.RawReviewRequired} chars=${context.decision.CharacterCount} `
      + `lines=${context.decision.LineCount}`
    );
    const slotId = context.backend === 'llama.cpp' ? allocateLlamaCppSlotId(context.config) : null;
    const effectivePromptPrefix = this.request.promptPrefix !== undefined
      ? this.request.promptPrefix
      : getConfiguredPromptPrefix(context.config);
    traceSummary('invokeSummaryCore start');
    this.progress.coreStart(context.backend);
    const coreSpan = this.timingRecorder?.start('summary.core');
    let summaryCore: SummaryCoreResult;
    try {
      summaryCore = await invokeSummaryCore({
        requestId: this.requestId,
        slotId,
        question: this.request.question,
        inputText: this.inputText,
        format: this.request.format,
        policyProfile: this.request.policyProfile,
        backend: context.backend,
        model: context.model,
        config: context.config,
        rawReviewRequired: context.decision.RawReviewRequired,
        sourceKind: context.sourceKind,
        commandExitCode: this.request.commandExitCode,
        debugCommand: this.request.debugCommand,
        promptPrefix: effectivePromptPrefix,
        allowedPlannerTools: this.request.allowedPlannerTools,
        requestTimeoutSeconds: this.request.requestTimeoutSeconds,
        llamaCppOverrides: this.request.llamaCppOverrides,
        statusBackendUrl: this.request.statusBackendUrl,
        timingRecorder: this.timingRecorder,
        progress: this.progress,
      });
    } finally {
      coreSpan?.end();
    }
    this.progress.coreDone(context.backend);
    traceSummary(`invokeSummaryCore done classification=${summaryCore.decision.classification}`);
    await this.notifyModelCompletion(summaryCore, context);
    const result = this.buildModelResult(summaryCore, context);
    this.completeRequest(result);
    return result;
  }

  private async notifyDeterministicCompletion(result: SummaryResult): Promise<void> {
    await notifySummaryTerminalStatus({
      running: false,
      taskKind: 'summary',
      statusBackendUrl: this.request.statusBackendUrl,
      requestId: this.requestId,
      terminalState: 'completed',
      deferredMetadata: {
        rawInputCharacterCount: this.inputText.length,
        requestDurationMs: 0,
        providerDurationMs: 0,
        wallDurationMs: getSummaryWallDurationMs(this.request, this.requestStartedAtMs),
        stdinWaitMs: getNonNegativeTiming(this.request.timing?.stdinWaitMs),
        serverPreflightMs: getNonNegativeTiming(this.request.timing?.serverPreflightMs),
        lockWaitMs: 0,
        statusRunningMs: 0,
        terminalStatusMs: 0,
      },
      deferredArtifacts: [
        buildSummaryRequestArtifact({
          requestId: this.requestId,
          question: this.request.question,
          inputText: this.inputText,
          command: this.request.debugCommand ?? null,
          backend: result.Backend,
          model: result.Model,
          classification: result.Classification,
          rawReviewRequired: result.RawReviewRequired,
          summary: result.Summary,
          providerError: result.ProviderError,
          error: null,
        }),
      ],
    });
  }

  private async notifyModelCompletion(
    summaryCore: SummaryCoreResult,
    context: SummaryExecutionContext,
  ): Promise<void> {
    const modelDecision = summaryCore.decision;
    await notifySummaryTerminalStatus({
      running: false,
      taskKind: 'summary',
      statusBackendUrl: this.request.statusBackendUrl,
      requestId: this.requestId,
      terminalState: 'completed',
      deferredMetadata: {
        rawInputCharacterCount: this.inputText.length,
        promptCharacterCount: summaryCore.completionMetrics?.promptCharacterCount ?? null,
        inputTokens: summaryCore.completionMetrics?.inputTokens ?? null,
        outputCharacterCount: summaryCore.completionMetrics?.outputCharacterCount ?? null,
        outputTokens: summaryCore.completionMetrics?.outputTokens ?? null,
        thinkingTokens: summaryCore.completionMetrics?.thinkingTokens ?? null,
        promptCacheTokens: summaryCore.completionMetrics?.promptCacheTokens ?? null,
        promptEvalTokens: summaryCore.completionMetrics?.promptEvalTokens ?? null,
        speculativeAcceptedTokens: summaryCore.completionMetrics?.speculativeAcceptedTokens ?? null,
        speculativeGeneratedTokens: summaryCore.completionMetrics?.speculativeGeneratedTokens ?? null,
        requestDurationMs: summaryCore.completionMetrics?.requestDurationMs ?? null,
        providerDurationMs: summaryCore.completionMetrics?.providerDurationMs ?? summaryCore.completionMetrics?.requestDurationMs ?? null,
        wallDurationMs: getSummaryWallDurationMs(this.request, this.requestStartedAtMs),
        stdinWaitMs: getNonNegativeTiming(this.request.timing?.stdinWaitMs),
        serverPreflightMs: getNonNegativeTiming(this.request.timing?.serverPreflightMs),
        lockWaitMs: 0,
        statusRunningMs: summaryCore.completionMetrics?.statusRunningMs ?? null,
        terminalStatusMs: 0,
      },
      deferredArtifacts: [
        buildPlannerDebugArtifact({
          requestId: this.requestId,
          finalOutput: modelDecision.output.trim(),
          classification: modelDecision.classification,
          rawReviewRequired: modelDecision.rawReviewRequired,
          providerError: null,
        }),
        buildSummaryRequestArtifact({
          requestId: this.requestId,
          question: this.request.question,
          inputText: this.inputText,
          command: this.request.debugCommand ?? null,
          backend: context.backend,
          model: context.model,
          classification: modelDecision.classification,
          rawReviewRequired: modelDecision.rawReviewRequired,
          summary: modelDecision.output.trim(),
          providerError: null,
          error: null,
        }),
      ].filter((artifact): artifact is NonNullable<typeof artifact> => artifact !== null),
    });
  }

  private buildModelResult(summaryCore: SummaryCoreResult, context: SummaryExecutionContext): SummaryResult {
    const modelDecision = summaryCore.decision;
    return {
      RequestId: this.requestId,
      WasSummarized: modelDecision.classification !== 'unsupported_input',
      PolicyDecision: getPolicyDecision(modelDecision.classification),
      Backend: context.backend,
      Model: context.model,
      Summary: modelDecision.output.trim(),
      Classification: modelDecision.classification,
      RawReviewRequired: modelDecision.rawReviewRequired,
      ModelCallSucceeded: true,
      ProviderError: null,
    };
  }

  private async handleFailure(error: Error): Promise<void> {
    const failureContext = getSummaryFailureContext(error);
    if (this.config !== null) {
      await notifySummaryTerminalStatus({
        running: false,
        taskKind: 'summary',
        statusBackendUrl: this.request.statusBackendUrl,
        requestId: this.requestId,
        terminalState: 'failed',
        errorMessage: getErrorMessage(error),
        deferredMetadata: {
          errorMessage: getErrorMessage(error),
          promptCharacterCount: failureContext?.promptCharacterCount ?? null,
          promptTokenCount: failureContext?.promptTokenCount ?? null,
          rawInputCharacterCount: failureContext?.rawInputCharacterCount ?? this.inputText.length,
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
          wallDurationMs: failureContext?.wallDurationMs ?? getSummaryWallDurationMs(this.request, this.requestStartedAtMs),
          stdinWaitMs: failureContext?.stdinWaitMs ?? getNonNegativeTiming(this.request.timing?.stdinWaitMs),
          serverPreflightMs: failureContext?.serverPreflightMs ?? getNonNegativeTiming(this.request.timing?.serverPreflightMs),
          lockWaitMs: failureContext?.lockWaitMs ?? 0,
          statusRunningMs: failureContext?.statusRunningMs ?? null,
          terminalStatusMs: failureContext?.terminalStatusMs ?? 0,
        },
        deferredArtifacts: this.buildFailureArtifacts(error),
      });
    }
    clearSummaryArtifactState(this.requestId);
    this.progress.failed(getErrorMessage(error));
  }

  private buildFailureArtifacts(error: Error): NonNullable<NotifyStatusBackendOptions['deferredArtifacts']> {
    return [
      buildPlannerDebugArtifact({
        requestId: this.requestId,
        finalOutput: getErrorMessage(error),
        classification: 'command_failure',
        rawReviewRequired: true,
        providerError: getErrorMessage(error),
      }),
      ...(/planner/iu.test(getErrorMessage(error))
        ? [buildFailedRequestArtifact({
          requestId: this.requestId,
          question: this.request.question,
          inputText: this.inputText,
          command: this.request.debugCommand ?? null,
          error: getErrorMessage(error),
          providerError: getErrorMessage(error),
        })]
        : []),
    ].filter((artifact): artifact is NonNullable<typeof artifact> => artifact !== null);
  }

  private completeRequest(result: SummaryResult): void {
    this.timingStatus = 'completed';
    clearSummaryArtifactState(this.requestId);
    this.progress.completed(result.Classification);
  }

  private async flushCompletedTiming(): Promise<void> {
    this.timingStatus = 'completed';
    await this.flushTiming();
  }

  private async flushTiming(): Promise<void> {
    if (!this.timingRecorder) {
      return;
    }
    await this.timingRecorder.flush({
      status: this.timingStatus,
      metadata: {
        durationMs: Date.now() - this.requestStartedAtMs,
      },
    }).catch((error: Error) => {
      traceSummary(`temp timing flush failed request_id=${this.requestId} error=${error.message}`);
    });
  }
}
