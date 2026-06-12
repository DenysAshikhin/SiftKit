import { getErrorMessage } from '../lib/errors.js';
import { ModelJson } from '../lib/model-json.js';
import { logSummaryProgress } from './progress.js';
import {
  DEFAULT_LLAMA_CPP_TOKENIZE_RETRY_MAX_WAIT_MS,
  DEFAULT_LLAMA_CPP_TOKENIZE_TIMEOUT_MS,
  countLlamaCppTokensDetailed,
  type CountLlamaCppTokensOptions,
} from '../providers/llama-cpp.js';
import type { SiftConfig } from '../config/index.js';
import {
  getChunkThresholdCharacters,
} from '../config/index.js';
import {
  buildCompactPrompt,
  buildPrompt,
} from './prompt.js';
import {
  buildConservativeChunkFallbackDecision,
  buildConservativeDirectFallbackDecision,
  isInternalChunkLeaf,
  normalizeStructuredDecision,
} from './structured.js';
import {
  attachSummaryFailureContext,
  buildPlannerFailureErrorMessage,
  traceSummary,
} from './artifacts.js';
import {
  getLlamaCppChunkThresholdCharacters,
  getPlannerActivationThresholdCharacters,
  getPlannerPromptBudget,
  sumTokenCounts,
} from './chunking.js';
import {
  invokeProviderSummary,
  type ProviderSummaryMetrics,
} from './provider-invoke.js';
import { invokePlannerMode } from './planner/mode.js';
import type {
  ChunkPromptContext,
  StructuredModelDecision,
  SummaryPhase,
  SummaryRequest,
  SummarySourceKind,
} from './types.js';
import type { TemporaryTimingRecorder } from '../lib/temporary-timing-recorder.js';

export type SummaryCompletionMetrics = {
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

export type SummaryCoreResult = {
  decision: StructuredModelDecision;
  completionMetrics: SummaryCompletionMetrics | null;
};

export type InvokeSummaryCoreOptions = {
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
  statusBackendUrl?: string | null;
  chunkContext?: ChunkPromptContext;
  timingRecorder?: TemporaryTimingRecorder | null;
};

type SummaryCoreState = {
  rootInputCharacterCount: number;
  phase: SummaryPhase;
  chunkThreshold: number;
  llamaPromptBudget: ReturnType<typeof getPlannerPromptBudget> | null;
  plannerActivationThreshold: number;
  chunkLabel: string;
  isTopLevelLlamaPass: boolean;
};

type SummaryPromptContext = {
  state: SummaryCoreState;
  prompt: string;
  promptTokenCount: number | null;
  allowUnsupportedInput: boolean;
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

function getSummaryTokenizeOptions(requestTimeoutSeconds: number | undefined): CountLlamaCppTokensOptions | undefined {
  const timeoutSeconds = Number(requestTimeoutSeconds);
  if (!Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0) {
    return undefined;
  }
  const timeoutMs = Math.max(1, Math.trunc(timeoutSeconds * 1000));
  return {
    timeoutMs,
    retryMaxWaitMs: timeoutMs,
  };
}

function isEmptyDecisionOutputError(error: unknown): boolean {
  return /Provider returned an empty SiftKit decision output\./iu.test(getErrorMessage(error));
}

class SummaryCoreRunner {
  private readonly options: InvokeSummaryCoreOptions;
  private providerMetrics: ProviderSummaryMetrics | null = null;

  constructor(options: InvokeSummaryCoreOptions) {
    this.options = options;
  }

  async run(): Promise<SummaryCoreResult> {
    const state = this.buildState();
    this.traceStart(state);
    if (this.shouldStartInPlannerMode(state)) {
      return this.invokePlanner();
    }

    const promptContext = await this.preparePrompt(state);
    if (this.shouldHandoffAfterPreflight(promptContext)) {
      traceSummary(
        `preflight planner handoff phase=${state.phase} chunk=${state.chunkLabel} `
        + `prompt_tokens=${promptContext.promptTokenCount} `
        + `effective_prompt_limit=${this.effectivePromptLimit(state)}`
      );
      return this.invokePlanner();
    }

    return this.invokeProviderAndNormalize(promptContext);
  }

  private buildState(): SummaryCoreState {
    const rootInputCharacterCount = this.options.rootInputCharacterCount ?? this.options.inputText.length;
    const phase = this.options.phase ?? 'leaf';
    const chunkThreshold = Math.max(
      1,
      Math.floor(this.options.chunkThresholdOverride ?? (
        this.options.backend === 'llama.cpp'
          ? getLlamaCppChunkThresholdCharacters(this.options.config)
          : getChunkThresholdCharacters(this.options.config)
      ))
    );
    const llamaPromptBudget = this.options.backend === 'llama.cpp'
      ? getPlannerPromptBudget(this.options.config)
      : null;
    return {
      rootInputCharacterCount,
      phase,
      chunkThreshold,
      llamaPromptBudget,
      plannerActivationThreshold: this.options.backend === 'llama.cpp'
        ? getPlannerActivationThresholdCharacters(this.options.config)
        : chunkThreshold,
      chunkLabel: this.options.chunkPath ?? (
        this.options.chunkIndex !== null && this.options.chunkTotal !== null
          ? `${this.options.chunkIndex}/${this.options.chunkTotal}`
          : 'none'
      ),
      isTopLevelLlamaPass: this.options.backend === 'llama.cpp'
        && phase === 'leaf'
        && !this.options.chunkContext
        && this.options.chunkThresholdOverride == null,
    };
  }

  private traceStart(state: SummaryCoreState): void {
    traceSummary(
      `invokeSummaryCore start phase=${state.phase} chunk=${state.chunkLabel} `
      + `input_chars=${this.options.inputText.length} chunk_threshold=${state.chunkThreshold} `
      + `planner_threshold=${state.plannerActivationThreshold}`
    );
  }

  private shouldStartInPlannerMode(state: SummaryCoreState): boolean {
    return state.isTopLevelLlamaPass
      && (state.llamaPromptBudget?.plannerStopLineTokens ?? 0) > 0
      && this.options.inputText.length > state.plannerActivationThreshold;
  }

  private async invokePlanner(): Promise<SummaryCoreResult> {
    const plannerDecision = await invokePlannerMode({
      requestId: this.options.requestId,
      slotId: this.options.slotId,
      question: this.options.question,
      inputText: this.options.inputText,
      format: this.options.format,
      backend: this.options.backend,
      model: this.options.model,
      config: this.options.config,
      rawReviewRequired: this.options.rawReviewRequired,
      sourceKind: this.options.sourceKind,
      commandExitCode: this.options.commandExitCode,
      debugCommand: this.options.debugCommand,
      promptPrefix: this.options.promptPrefix,
      allowedTools: this.options.allowedPlannerTools,
      requestTimeoutSeconds: this.options.requestTimeoutSeconds,
      llamaCppOverrides: this.options.llamaCppOverrides,
      statusBackendUrl: this.options.statusBackendUrl,
      timingRecorder: this.options.timingRecorder || null,
    });
    if (plannerDecision) {
      return {
        decision: plannerDecision,
        completionMetrics: null,
      };
    }
    throw new Error(buildPlannerFailureErrorMessage({
      requestId: this.options.requestId,
    }));
  }

  private async preparePrompt(state: SummaryCoreState): Promise<SummaryPromptContext> {
    const useCompactPrompt = this.shouldUseCompactPrompt(state);
    const allowUnsupportedInput = this.shouldAllowUnsupportedInput(useCompactPrompt);
    const prompt = this.renderPrompt(state, useCompactPrompt, allowUnsupportedInput);
    const promptTokenCount = await this.countPromptTokens(state, prompt);
    return {
      state,
      prompt,
      promptTokenCount,
      allowUnsupportedInput,
    };
  }

  private shouldUseCompactPrompt(state: SummaryCoreState): boolean {
    return this.options.backend === 'llama.cpp'
      && state.phase === 'leaf'
      && this.options.policyProfile === 'general'
      && !this.options.chunkContext
      && this.options.inputText.length <= state.chunkThreshold;
  }

  private shouldAllowUnsupportedInput(useCompactPrompt: boolean): boolean {
    return !useCompactPrompt
      && this.options.sourceKind !== 'command-output'
      && (this.options.backend !== 'llama.cpp' || isInternalChunkLeaf(this.options));
  }

  private renderPrompt(
    state: SummaryCoreState,
    useCompactPrompt: boolean,
    allowUnsupportedInput: boolean,
  ): string {
    const promptRenderSpan = this.options.timingRecorder?.start('summary.prompt.render', {
      phase: state.phase,
      chunk: state.chunkLabel,
      compact: useCompactPrompt,
    });
    const prompt = useCompactPrompt
      ? buildCompactPrompt({
        question: this.options.question,
        inputText: this.options.inputText,
        promptPrefix: this.options.promptPrefix,
      })
      : buildPrompt({
        question: this.options.question,
        inputText: this.options.inputText,
        format: this.options.format,
        policyProfile: this.options.policyProfile,
        rawReviewRequired: this.options.rawReviewRequired,
        promptPrefix: this.options.promptPrefix,
        sourceKind: this.options.sourceKind,
        commandExitCode: this.options.commandExitCode,
        phase: state.phase,
        chunkContext: this.options.chunkContext,
        allowUnsupportedInput,
      });
    promptRenderSpan?.end({ promptChars: prompt.length });
    return prompt;
  }

  private async countPromptTokens(state: SummaryCoreState, prompt: string): Promise<number | null> {
    const effectivePromptLimit = this.effectivePromptLimit(state);
    traceSummary(
      `preflight start phase=${state.phase} chunk=${state.chunkLabel} prompt_chars=${prompt.length} `
      + `effective_prompt_limit=${effectivePromptLimit ?? 'null'}`
    );
    const promptTokenSpan = this.options.timingRecorder?.start('summary.prompt.tokenize', {
      phase: state.phase,
      chunk: state.chunkLabel,
      enabled: effectivePromptLimit !== null && effectivePromptLimit > 0,
    });
    const tokenCountResult = effectivePromptLimit !== null && effectivePromptLimit > 0
      ? await this.countLlamaPromptTokens(state, prompt)
      : null;
    const promptTokenCount = tokenCountResult?.tokenCount ?? null;
    promptTokenSpan?.end({ promptTokenCount: promptTokenCount ?? -1 });
    this.logTokenizeEnd(state, tokenCountResult);
    traceSummary(
      `preflight done phase=${state.phase} chunk=${state.chunkLabel} `
      + `prompt_tokens=${promptTokenCount ?? 'null'}`
    );
    return promptTokenCount;
  }

  private async countLlamaPromptTokens(
    state: SummaryCoreState,
    prompt: string,
  ): Promise<Awaited<ReturnType<typeof countLlamaCppTokensDetailed>>> {
    const tokenizeOptions = getSummaryTokenizeOptions(this.options.requestTimeoutSeconds);
    const tokenizeTimeoutMs = tokenizeOptions?.timeoutMs ?? DEFAULT_LLAMA_CPP_TOKENIZE_TIMEOUT_MS;
    const tokenizeRetryMaxWaitMs = tokenizeOptions?.retryMaxWaitMs ?? DEFAULT_LLAMA_CPP_TOKENIZE_RETRY_MAX_WAIT_MS;
    logSummaryProgress(
      `preflight_tokenize_start request_id=${this.options.requestId} phase=${state.phase} `
      + `chunk=${state.chunkLabel} prompt_chars=${prompt.length} timeout_ms=${tokenizeTimeoutMs} `
      + `retry_max_wait_ms=${tokenizeRetryMaxWaitMs}`,
    );
    return countLlamaCppTokensDetailed(this.options.config, prompt, tokenizeOptions);
  }

  private logTokenizeEnd(
    state: SummaryCoreState,
    tokenCountResult: Awaited<ReturnType<typeof countLlamaCppTokensDetailed>> | null,
  ): void {
    const effectivePromptLimit = this.effectivePromptLimit(state);
    if (effectivePromptLimit === null || effectivePromptLimit <= 0) {
      return;
    }
    const promptTokenCount = tokenCountResult?.tokenCount ?? null;
    const tokenSource = promptTokenCount === null ? 'unavailable' : 'llama.cpp';
    const tokenErrorSuffix = tokenCountResult?.errorMessage ? ` error=${JSON.stringify(tokenCountResult.errorMessage)}` : '';
    logSummaryProgress(
      `preflight_tokenize_done request_id=${this.options.requestId} phase=${state.phase} `
      + `chunk=${state.chunkLabel} prompt_tokens=${promptTokenCount ?? 'null'} source=${tokenSource} `
      + `elapsed_ms=${tokenCountResult?.elapsedMs ?? 0} retry_count=${tokenCountResult?.retryCount ?? 0} `
      + `status=${tokenCountResult?.status ?? 'unknown'}`
      + tokenErrorSuffix,
    );
  }

  private effectivePromptLimit(state: SummaryCoreState): number | null {
    return this.options.backend === 'llama.cpp'
      ? (state.llamaPromptBudget?.usablePromptBudgetTokens ?? 0)
      : null;
  }

  private shouldHandoffAfterPreflight(promptContext: SummaryPromptContext): boolean {
    const effectivePromptLimit = this.effectivePromptLimit(promptContext.state);
    return this.options.backend === 'llama.cpp'
      && promptContext.state.phase === 'leaf'
      && !this.options.chunkContext
      && effectivePromptLimit !== null
      && promptContext.promptTokenCount !== null
      && promptContext.promptTokenCount > effectivePromptLimit;
  }

  private async invokeProviderAndNormalize(promptContext: SummaryPromptContext): Promise<SummaryCoreResult> {
    try {
      const parsedDecision = await this.parseProviderDecision(promptContext);
      if (parsedDecision.classification === 'unsupported_input') {
        const fallbackResult = await this.resolveUnsupportedDecision(promptContext);
        if (fallbackResult) {
          return fallbackResult;
        }
      }
      return {
        decision: normalizeStructuredDecision(parsedDecision, this.options.format),
        completionMetrics: this.completionMetrics(promptContext.state),
      };
    } catch (error) {
      return this.handleProviderError(error, promptContext);
    }
  }

  private async parseProviderDecision(promptContext: SummaryPromptContext): Promise<StructuredModelDecision> {
    const rawResponse = await this.invokeProvider(promptContext);
    try {
      return ModelJson.parseSummaryDecision(rawResponse);
    } catch (error) {
      if (!isEmptyDecisionOutputError(error)) {
        throw error;
      }
      traceSummary(
        `provider empty-output retry phase=${promptContext.state.phase} `
        + `chunk=${promptContext.state.chunkLabel} request_id=${this.options.requestId}`
      );
      return ModelJson.parseSummaryDecision(await this.invokeProvider(promptContext));
    }
  }

  private async invokeProvider(promptContext: SummaryPromptContext): Promise<string> {
    const reasoningOverride = this.options.backend === 'llama.cpp' && !this.options.chunkContext
      ? 'off'
      : undefined;
    const providerSpan = this.options.timingRecorder?.start('summary.provider.request', {
      phase: promptContext.state.phase,
      chunk: promptContext.state.chunkLabel,
      backend: this.options.backend,
      promptChars: promptContext.prompt.length,
      promptTokenCount: promptContext.promptTokenCount ?? -1,
    });
    let providerResult: { text: string; metrics: ProviderSummaryMetrics };
    try {
      providerResult = await invokeProviderSummary({
        requestId: this.options.requestId,
        slotId: this.options.slotId,
        backend: this.options.backend,
        config: this.options.config,
        model: this.options.model,
        prompt: promptContext.prompt,
        question: this.options.question,
        promptCharacterCount: promptContext.prompt.length,
        promptTokenCount: promptContext.promptTokenCount,
        rawInputCharacterCount: promptContext.state.rootInputCharacterCount,
        chunkInputCharacterCount: this.options.inputText.length,
        phase: promptContext.state.phase,
        chunkIndex: this.options.chunkIndex ?? null,
        chunkTotal: this.options.chunkTotal ?? null,
        chunkPath: this.options.chunkPath ?? null,
        reasoningOverride,
        requestTimeoutSeconds: this.options.requestTimeoutSeconds,
        llamaCppOverrides: this.options.llamaCppOverrides,
        statusBackendUrl: this.options.statusBackendUrl,
        timingRecorder: this.options.timingRecorder || null,
      });
    } finally {
      providerSpan?.end();
    }
    this.providerMetrics = providerResult.metrics;
    return providerResult.text;
  }

  private async resolveUnsupportedDecision(promptContext: SummaryPromptContext): Promise<SummaryCoreResult | null> {
    if (isInternalChunkLeaf(this.options)) {
      return this.resolveUnsupportedChunk(promptContext);
    }
    if (!promptContext.allowUnsupportedInput) {
      return {
        decision: normalizeStructuredDecision(
          buildConservativeDirectFallbackDecision({
            inputText: this.options.inputText,
            question: this.options.question,
            format: this.options.format,
            sourceKind: this.options.sourceKind,
          }),
          this.options.format,
        ),
        completionMetrics: this.completionMetrics(promptContext.state),
      };
    }
    return null;
  }

  private async resolveUnsupportedChunk(promptContext: SummaryPromptContext): Promise<SummaryCoreResult> {
    if (this.options.chunkContext?.retryMode !== 'strict') {
      return new SummaryCoreRunner({
        ...this.options,
        rootInputCharacterCount: promptContext.state.rootInputCharacterCount,
        chunkContext: {
          ...(this.options.chunkContext ?? {
            isGeneratedChunk: true,
            mayBeTruncated: true,
            chunkPath: this.options.chunkPath ?? null,
          }),
          retryMode: 'strict',
        },
      }).run();
    }

    return {
      decision: normalizeStructuredDecision(
        buildConservativeChunkFallbackDecision({
          inputText: this.options.inputText,
          question: this.options.question,
          format: this.options.format,
        }),
        this.options.format,
      ),
      completionMetrics: this.completionMetrics(promptContext.state),
    };
  }

  private completionMetrics(state: SummaryCoreState): SummaryCompletionMetrics | null {
    return this.providerMetrics
      ? toSummaryCompletionMetrics(state.phase, this.options.chunkPath ?? null, this.providerMetrics)
      : null;
  }

  private async handleProviderError(
    error: unknown,
    promptContext: SummaryPromptContext,
  ): Promise<SummaryCoreResult> {
    const enrichedError = attachSummaryFailureContext(error, {
      requestId: this.options.requestId,
      promptCharacterCount: promptContext.prompt.length,
      promptTokenCount: promptContext.promptTokenCount,
      rawInputCharacterCount: promptContext.state.rootInputCharacterCount,
      chunkInputCharacterCount: this.options.inputText.length,
      chunkIndex: this.options.chunkIndex ?? null,
      chunkTotal: this.options.chunkTotal ?? null,
      chunkPath: this.options.chunkPath ?? null,
      inputTokens: this.providerMetrics?.inputTokens ?? null,
      outputCharacterCount: this.providerMetrics?.outputCharacterCount ?? null,
      outputTokens: this.providerMetrics?.outputTokens ?? null,
      thinkingTokens: this.providerMetrics?.thinkingTokens ?? null,
      promptCacheTokens: this.providerMetrics?.promptCacheTokens ?? null,
      promptEvalTokens: this.providerMetrics?.promptEvalTokens ?? null,
      requestDurationMs: this.providerMetrics?.requestDurationMs ?? null,
      providerDurationMs: this.providerMetrics?.providerDurationMs ?? null,
      statusRunningMs: this.providerMetrics?.statusRunningMs ?? null,
    });
    if (this.shouldHandoffProviderErrorToPlanner(enrichedError, promptContext.state)) {
      traceSummary(
        `provider planner handoff phase=${promptContext.state.phase} `
        + `chunk=${promptContext.state.chunkLabel} request_id=${this.options.requestId}`
      );
      return this.invokePlanner();
    }
    throw enrichedError;
  }

  private shouldHandoffProviderErrorToPlanner(error: unknown, state: SummaryCoreState): boolean {
    return this.options.backend === 'llama.cpp'
      && state.phase === 'leaf'
      && !this.options.chunkContext
      && /llama\.cpp generate failed with HTTP 400\b/iu.test(getErrorMessage(error));
  }
}

export async function invokeSummaryCore(options: InvokeSummaryCoreOptions): Promise<SummaryCoreResult> {
  return new SummaryCoreRunner(options).run();
}
