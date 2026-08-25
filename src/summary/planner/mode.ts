import { isReadExpansionEnabled, type SiftConfig } from '../../config/index.js';
import { buildUserContent } from '../../llm-protocol/image-attachments.js';
import { AgentLoop } from '../../agent-loop/agent-loop.js';
import { AgentLoopActionParser } from '../../agent-loop/action-parser.js';
import type {
  AgentLoopFinishAction,
  AgentLoopFinishEvaluation,
  AgentLoopInvalidResponseResult,
  AgentLoopModelData,
  AgentLoopModelResponse,
  AgentLoopPreparedTurn,
  AgentLoopResponseContext,
  AgentLoopToolAction,
  AgentLoopToolExecution,
  AgentLoopToolResult,
} from '../../agent-loop/types.js';
import type { LlamaCppToolCall, NormalizedLlamaCppChatResponse } from '../../llm-protocol/types.js';
import { createEmptyToolTypeStats } from '../../line-read-guidance.js';
import {
  countLlamaCppTokens,
  generateLlamaCppChatResponse,
  toProtocolMessages,
  type CountLlamaCppTokensOptions,
  type LlamaCppGenerateResult,
  type LlamaCppChatMessage,
} from '../../providers/llama-cpp.js';
import { getProcessedPromptTokens } from '../../lib/provider-helpers.js';
import { getErrorMessage, toError } from '../../lib/errors.js';
import { JsonObjectSchema, type JsonObject } from '../../lib/json-types.js';
import { NativePlannerToolCallError } from '../../planner-protocol/native-actions.js';
import { buildConservativeDirectFallbackDecision, normalizeStructuredDecision } from '../structured.js';
import {
  executePlannerTool,
  formatPlannerResult,
  formatPlannerToolResultHeader,
  type PlannerToolResult,
} from './tools.js';
import { createPlannerDebugRecorder, traceSummary } from '../artifacts.js';
import type { PlannerToolDefinition } from '../../planner-protocol/json-schema.js';
import {
  buildPlannerForcedFinishUserPrompt,
  buildPlannerInputSection,
  buildPlannerInvalidResponseUserPrompt,
  buildPlannerSystemPrompt,
  renderPlannerTranscript,
} from './prompts.js';
import { estimatePromptTokenCount, getPlannerPromptBudget } from '../chunking.js';
import { notifyStatusBackend } from '../../config/index.js';
import type { TemporaryTimingRecorder } from '../../lib/temporary-timing-recorder.js';
import type { PresetSystemContext } from '../../preset-system-context.js';
import {
  SummaryPlannerActionAdapter,
  SummaryPlannerModelClient,
  SummaryPlannerPromptAdapter,
  SummaryPlannerResultAssembler,
  SummaryPlannerToolAdapter,
  type SummaryPlannerLoopController,
} from './agent-loop-adapter.js';
import {
  allowsUnsupportedInput,
  type StructuredModelDecision,
  type SummaryProviderId,
  type SummarySourceKind,
} from '../types.js';
import {
  buildSummaryPlannerToolDefinitions,
  DEFAULT_SUMMARY_PLANNER_TOOL_NAMES,
  SummaryNativeToolCallSchema,
  type SummaryClassification,
  type SummaryPlannerToolName as PlannerToolName,
} from '../../planner-protocol/summary-tools.js';
import {
  buildRepeatedToolCallSummary,
  buildPromptToolResult,
  classifyToolOutputNovelty,
  fingerprintToolCall,
} from '../../tool-loop-governor.js';
import {
  appendToolCallExchange,
  appendToolBatchExchange,
  upsertTrailingUserMessage,
  type ToolBatchOutcome,
} from '../../tool-call-messages.js';
import { findContiguousUnreadRange, ToolOutputFitter, type ToolOutputTruncationUnit } from '../../tool-output-fit.js';

const MAX_PLANNER_TOOL_CALLS = 30;
const PLANNER_FORCED_FINISH_MAX_ATTEMPTS = 2;
const PLANNER_DUPLICATE_FORCE_THRESHOLD = 5;
// How many malformed model replies the planner tolerates before giving up.
// A couple of garbled responses should not abort a whole large-input request;
// each invalid reply is fed back with corrective guidance before retrying.
const MAX_PLANNER_INVALID_RESPONSES = 4;

function getPlannerTokenizeOptions(requestTimeoutSeconds: number | undefined): CountLlamaCppTokensOptions | undefined {
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

function normalizeAgentLoopSummaryClassification(value: string | undefined): SummaryClassification {
  if (value === 'command_failure' || value === 'unsupported_input') {
    return value;
  }
  return 'summary';
}

export type InvokePlannerModeOptions = {
  requestId: string;
  slotId: number | null;
  question: string;
  inputText: string;
  images: readonly string[];
  format: 'text' | 'json';
  provider: SummaryProviderId;
  model: string;
  config: SiftConfig;
  rawReviewRequired: boolean;
  sourceKind: SummarySourceKind;
  commandExitCode?: number | null;
  debugCommand?: string | null;
  presetPromptPrefix: string;
  additionalPromptPrefix: string;
  systemContext: PresetSystemContext;
  allowedTools?: PlannerToolName[];
  requestTimeoutSeconds?: number;
  statusBackendUrl?: string | null;
  timingRecorder?: TemporaryTimingRecorder | null;
};

type PlannerPromptBudget = ReturnType<typeof getPlannerPromptBudget>;
type SummaryPlannerDebugRecorder = ReturnType<typeof createPlannerDebugRecorder>;
type SummaryPlannerToolResultRecord = {
  callId: string;
  toolName: PlannerToolName;
  args: JsonObject;
  result: PlannerToolResult;
  resultText: string;
};

export class SummaryPlannerCompletionState {
  private finished = false;
  private decision: StructuredModelDecision | null = null;

  complete(decision: StructuredModelDecision): void {
    this.finished = true;
    this.decision = decision;
  }

  fail(): void {
    this.finished = true;
    this.decision = null;
  }

  isFinished(): boolean {
    return this.finished;
  }

  getDecision(): StructuredModelDecision | null {
    return this.decision;
  }
}

type SummaryPlannerRequestContextInput = {
  options: InvokePlannerModeOptions;
  promptBudget: PlannerPromptBudget;
  allowedTools: PlannerToolName[];
  toolDefinitions: PlannerToolDefinition[];
  debugRecorder: SummaryPlannerDebugRecorder;
};

export class SummaryPlannerRequestContext {
  readonly options: InvokePlannerModeOptions;
  readonly promptBudget: PlannerPromptBudget;
  readonly allowedTools: PlannerToolName[];
  readonly toolDefinitions: PlannerToolDefinition[];
  readonly debugRecorder: SummaryPlannerDebugRecorder;

  constructor(input: SummaryPlannerRequestContextInput) {
    this.options = input.options;
    this.promptBudget = input.promptBudget;
    this.allowedTools = input.allowedTools;
    this.toolDefinitions = input.toolDefinitions;
    this.debugRecorder = input.debugRecorder;
  }
}

type SummaryPlannerTranscriptStateInput = {
  messages: LlamaCppChatMessage[];
  toolResults: SummaryPlannerToolResultRecord[];
  inputText: string;
};

export class SummaryPlannerTranscriptState {
  readonly messages: LlamaCppChatMessage[];
  readonly toolResults: SummaryPlannerToolResultRecord[];
  readonly inputLines: string[];
  readonly readLinesReturnedRanges: Array<{ start: number; end: number }> = [];
  readonly recentEvidenceKeys = new Set<string>();
  invalidActionCount = 0;
  forcedFinishAttemptsRemaining = 0;
  consecutiveNoNewEvidence = 0;
  lastSuccessfulFingerprint: string | null = null;
  duplicateReplayFingerprint: string | null = null;
  duplicateReplayCount = 0;
  duplicateReplayToolMessageIndex = -1;
  forcedFinishCountdownUserMessageIndex = -1;
  lastSuccessfulReadLinesArgsText: string | null = null;

  constructor(input: SummaryPlannerTranscriptStateInput) {
    this.messages = input.messages;
    this.toolResults = input.toolResults;
    this.inputLines = input.inputText.replace(/\r\n/gu, '\n').split('\n');
  }

  getToolResultCount(): number {
    return this.toolResults.length;
  }
}

type SummaryPlannerProviderResponse = {
  text: string;
  reasoningText: string | null;
  toolCalls: LlamaCppToolCall[];
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
type SummaryPlannerModelData = AgentLoopModelData & {
  kind: 'summary-planner';
  providerResponse: SummaryPlannerProviderResponse;
};
type SummaryPlannerToolStatsPayload = Record<string, ReturnType<typeof createEmptyToolTypeStats>>;
type SummaryPlannerToolAction = AgentLoopToolAction & { toolName: PlannerToolName };
type SummaryPlannerEffectiveToolAction = {
  toolAction: SummaryPlannerToolAction;
  effectiveToolAction: SummaryPlannerToolAction;
  readLinesNoUnread: boolean;
};
type SummaryPlannerToolBatchContext = {
  turn: number;
  providerResponse: SummaryPlannerProviderResponse;
  batchOutcomes: ToolBatchOutcome[];
  pendingModeChangeUserMessages: string[];
  batchDuplicateAnchorIndex: number | null;
  toolStatsPayload: SummaryPlannerToolStatsPayload | null;
};
type SummaryPlannerFormattedToolResult = {
  result: PlannerToolResult;
  promptResultText: string;
  rawResultTokenCount: number;
  resolvedToolResultTokenCount: number;
  toolResultTokenEstimated: boolean;
};

function isSummaryPlannerModelData(data: AgentLoopModelData | null): data is SummaryPlannerModelData {
  return data?.kind === 'summary-planner';
}

function getSummaryPlannerModelData(context: AgentLoopResponseContext): SummaryPlannerModelData {
  const data = context.modelData;
  if (!isSummaryPlannerModelData(data)) {
    throw new Error('Summary planner AgentLoop context is missing provider response data.');
  }
  return data;
}

class SummaryPlannerToolOutputTokenCounter {
  constructor(
    private readonly config: SiftConfig,
    private readonly tokenizeOptions: CountLlamaCppTokensOptions | undefined,
  ) {}

  async countToolOutputTokens(textToCount: string): Promise<number> {
    const tokenCountRaw = await countLlamaCppTokens(this.config, textToCount, this.tokenizeOptions);
    return tokenCountRaw ?? estimatePromptTokenCount(this.config, textToCount);
  }
}

export class SummaryPlannerLoopRuntime implements SummaryPlannerLoopController {
  private prompt = '';
  private promptTokenCount = 0;
  private readonly tokenizeOptions: CountLlamaCppTokensOptions | undefined;

  static computeReadLinesRange(input: {
    startLine: number;
    endLine: number;
    inputLineCount: number;
    returnedRanges: ReadonlyArray<{ start: number; end: number }>;
    expandReads: boolean;
  }): { hasUnread: boolean; start: number; end: number } {
    const requestedStart = Math.max(1, Math.trunc(input.startLine || 1));
    const requestedEnd = Math.max(requestedStart, Math.trunc(input.endLine || requestedStart));
    const requestedEndExclusive = Math.min(requestedEnd + 1, input.inputLineCount + 1);
    const hasReturnedRanges = input.returnedRanges.length > 0;
    return findContiguousUnreadRange({
      requestedStart: Math.min(requestedStart, input.inputLineCount || 1),
      totalEnd: input.expandReads && hasReturnedRanges ? input.inputLineCount + 1 : requestedEndExclusive,
      returnedRanges: input.expandReads ? input.returnedRanges : [],
    });
  }

  constructor(
    private readonly requestContext: SummaryPlannerRequestContext,
    private readonly transcriptState: SummaryPlannerTranscriptState,
    private readonly completionState: SummaryPlannerCompletionState,
  ) {
    this.tokenizeOptions = getPlannerTokenizeOptions(this.options.requestTimeoutSeconds);
  }

  private get options(): InvokePlannerModeOptions {
    return this.requestContext.options;
  }
  private get promptBudget(): PlannerPromptBudget {
    return this.requestContext.promptBudget;
  }
  private get allowedTools(): PlannerToolName[] {
    return this.requestContext.allowedTools;
  }
  private get toolDefinitions(): PlannerToolDefinition[] {
    return this.requestContext.toolDefinitions;
  }

  get allowUnsupportedInput(): boolean {
    return allowsUnsupportedInput(this.options.sourceKind);
  }
  private get debugRecorder(): SummaryPlannerDebugRecorder {
    return this.requestContext.debugRecorder;
  }
  private get messages(): LlamaCppChatMessage[] {
    return this.transcriptState.messages;
  }
  private get toolResults(): SummaryPlannerToolResultRecord[] {
    return this.transcriptState.toolResults;
  }
  private get inputLines(): string[] {
    return this.transcriptState.inputLines;
  }
  private get readLinesReturnedRanges(): Array<{ start: number; end: number }> {
    return this.transcriptState.readLinesReturnedRanges;
  }
  private get recentEvidenceKeys(): Set<string> {
    return this.transcriptState.recentEvidenceKeys;
  }

  async prepareTurn(turnNumber: number): Promise<AgentLoopPreparedTurn> {
    const turn = this.toolResults.length + 1;
    if (this.toolResults.length > MAX_PLANNER_TOOL_CALLS) {
      return {
        outcome: 'stop',
        turnNumber,
        promptTokens: { reported: 0, budgeted: 0 },
        maxOutputTokens: 0,
        messages: toProtocolMessages(this.messages),
        toolDefinitions: this.toolDefinitions,
        inForcedFinishMode: false,
      };
    }
    const promptRenderSpan = this.options.timingRecorder?.start('summary.planner.prompt.render', {
      turn,
      messageCount: this.messages.length,
    });
    this.prompt = renderPlannerTranscript(this.messages);
    promptRenderSpan?.end({ promptChars: this.prompt.length });
    const promptTokenSpan = this.options.timingRecorder?.start('summary.planner.prompt.tokenize', {
      turn,
      promptChars: this.prompt.length,
    });
    this.promptTokenCount =
      (await countLlamaCppTokens(this.options.config, this.prompt, this.tokenizeOptions)) ?? estimatePromptTokenCount(this.options.config, this.prompt);
    promptTokenSpan?.end({ promptTokenCount: this.promptTokenCount });
    this.debugRecorder.record({
      kind: 'planner_prompt',
      promptChars: this.prompt.length,
      promptTokens: { reported: this.promptTokenCount, budgeted: this.promptTokenCount },
      toolCallCount: this.toolResults.length,
      plannerBudget: this.promptBudget,
    });
    if (this.promptTokenCount > this.promptBudget.plannerStopLineTokens) {
      this.debugRecorder.finish({
        status: 'failed',
        reason: 'planner_headroom_exceeded',
        promptTokens: { reported: this.promptTokenCount, budgeted: this.promptTokenCount },
        plannerBudget: this.promptBudget,
      });
      this.completionState.fail();
      return {
        outcome: 'stop',
        turnNumber: turn,
        promptTokens: { reported: this.promptTokenCount, budgeted: this.promptTokenCount },
        maxOutputTokens: 0,
        messages: toProtocolMessages(this.messages),
        toolDefinitions: this.toolDefinitions,
        inForcedFinishMode: this.transcriptState.forcedFinishAttemptsRemaining > 0,
      };
    }
    return {
      outcome: 'continue',
      turnNumber: turn,
      promptTokens: { reported: this.promptTokenCount, budgeted: this.promptTokenCount },
      maxOutputTokens: 0,
      messages: toProtocolMessages(this.messages),
      toolDefinitions: this.toolDefinitions,
      inForcedFinishMode: this.transcriptState.forcedFinishAttemptsRemaining > 0,
    };
  }

  async requestModelResponse(_preparedTurn: AgentLoopPreparedTurn): Promise<AgentLoopModelResponse> {
    let providerResponse: SummaryPlannerProviderResponse;
    try {
      providerResponse = await this.requestProviderAction();
    } catch (error) {
      this.debugRecorder.finish({
        status: 'failed',
        reason: getErrorMessage(error),
      });
      this.completionState.fail();
      return { outcome: 'stop', data: null };
    }
    this.debugRecorder.record({
      kind: 'planner_model_response',
      thinkingProcess: providerResponse.reasoningText,
      responseText: providerResponse.text,
    });
    const data: SummaryPlannerModelData = {
      kind: 'summary-planner',
      providerResponse,
    };
    return {
      outcome: 'continue',
      response: this.toNormalizedResponse(providerResponse),
      data,
    };
  }

  inspectModelResponse(_context: AgentLoopResponseContext): 'continue' | 'stop' | null {
    return null;
  }

  private toNormalizedResponse(response: SummaryPlannerProviderResponse): NormalizedLlamaCppChatResponse {
    return {
      text: response.text,
      reasoningText: response.reasoningText || '',
      toolCalls: response.toolCalls,
      usage: {
        promptTokens: response.inputTokens,
        completionTokens: response.outputTokens,
        totalTokens: null,
        outputTokens: response.outputTokens,
        thinkingTokens: response.thinkingTokens,
        promptCacheTokens: response.promptCacheTokens,
        promptEvalTokens: response.promptEvalTokens,
      },
      raw: {
        requestDurationMs: response.requestDurationMs,
        providerDurationMs: response.providerDurationMs,
        statusRunningMs: response.statusRunningMs,
        outputCharacterCount: response.outputCharacterCount,
      },
      stoppedEarly: false,
      invalidFrameCount: 0,
    };
  }

  private async notifyPlannerRunning(promptText: string, promptTokenCount: number): Promise<number> {
    traceSummary(
      `notify running=true phase=planner chunk=none raw_chars=${this.options.inputText.length} ` +
        `chunk_chars=${this.options.inputText.length} prompt_chars=${promptText.length}`,
    );
    const statusRunningStartedAt = Date.now();
    const notifyRunningSpan = this.options.timingRecorder?.start('summary.planner.status.notify_running', {
      promptChars: promptText.length,
    });
    try {
      await notifyStatusBackend({
        running: true,
        taskKind: 'summary',
        statusBackendUrl: this.options.statusBackendUrl,
        requestId: this.options.requestId,
        promptCharacterCount: promptText.length,
        promptTokenCount,
        rawInputCharacterCount: this.options.inputText.length,
        chunkInputCharacterCount: this.options.inputText.length,
        budgetSource: this.options.config.Effective?.BudgetSource ?? null,
        inputCharactersPerContextToken: this.options.config.Effective?.InputCharactersPerContextToken ?? null,
        chunkThresholdCharacters: this.options.config.Effective?.ChunkThresholdCharacters ?? null,
        phase: 'planner',
      });
      notifyRunningSpan?.end({ ok: true });
    } catch {
      notifyRunningSpan?.end({ ok: false });
      traceSummary(`notify running=true failed phase=planner chunk=none request_id=${this.options.requestId}`);
    }
    return Date.now() - statusRunningStartedAt;
  }

  private async requestProviderAction(override?: { promptText: string; promptTokenCount: number }): Promise<SummaryPlannerProviderResponse> {
    const promptText = override?.promptText ?? this.prompt;
    const promptTokenCount = override?.promptTokenCount ?? this.promptTokenCount;
    const statusRunningMs = await this.notifyPlannerRunning(promptText, promptTokenCount);
    const startedAt = Date.now();
    let inputTokens: number | null = null;
    let outputCharacterCount: number | null = null;
    let outputTokens: number | null = null;
    let thinkingTokens: number | null = null;
    let promptCacheTokens: number | null = null;
    let promptEvalTokens: number | null = null;
    try {
      const llamaSpan = this.options.timingRecorder?.start('summary.planner.llama.request', {
        promptTokenCount,
        toolDefinitionCount: this.toolDefinitions.length,
      });
      let response: LlamaCppGenerateResult;
      try {
        response = await generateLlamaCppChatResponse({
          config: this.options.config,
          model: this.options.model,
          messages: this.messages,
          // The config knob predates streaming: requestTimeoutSeconds now bounds the idle gap between frames.
          idleTimeoutSeconds: this.options.requestTimeoutSeconds ?? 600,
          slotId: this.options.slotId ?? undefined,
          cachePrompt: true,
          tools: this.toolDefinitions,
        });
      } finally {
        llamaSpan?.end();
      }
      inputTokens = getProcessedPromptTokens(
        response.usage?.promptTokens ?? null,
        response.usage?.promptCacheTokens ?? null,
        response.usage?.promptEvalTokens ?? null,
      );
      outputCharacterCount = response.text.length;
      outputTokens = response.usage?.completionTokens ?? null;
      thinkingTokens = response.usage?.thinkingTokens ?? null;
      promptCacheTokens = response.usage?.promptCacheTokens ?? null;
      promptEvalTokens = response.usage?.promptEvalTokens ?? null;
      const providerDurationMs = Date.now() - startedAt;
      return {
        text: response.text,
        reasoningText: response.reasoningText,
        toolCalls: response.toolCalls,
        inputTokens,
        outputCharacterCount,
        outputTokens,
        thinkingTokens,
        promptCacheTokens,
        promptEvalTokens,
        requestDurationMs: providerDurationMs,
        providerDurationMs,
        statusRunningMs,
      };
    } catch (error) {
      await this.notifyPlannerRequestFailed({
        promptText,
        startedAt,
        inputTokens,
        outputCharacterCount,
        outputTokens,
        thinkingTokens,
        promptCacheTokens,
        promptEvalTokens,
      });
      throw error;
    }
  }

  private async notifyPlannerRequestFailed(args: {
    promptText: string;
    startedAt: number;
    inputTokens: number | null;
    outputCharacterCount: number | null;
    outputTokens: number | null;
    thinkingTokens: number | null;
    promptCacheTokens: number | null;
    promptEvalTokens: number | null;
  }): Promise<void> {
    traceSummary(`notify running=false phase=planner chunk=none duration_ms=${Date.now() - args.startedAt}`);
    const notifyFailedSpan = this.options.timingRecorder?.start('summary.planner.status.notify_terminal', {
      terminalState: 'failed',
    });
    try {
      await notifyStatusBackend({
        running: false,
        taskKind: 'summary',
        requestId: this.options.requestId,
        statusBackendUrl: this.options.statusBackendUrl,
        promptCharacterCount: args.promptText.length,
        inputTokens: args.inputTokens,
        outputCharacterCount: args.outputCharacterCount,
        outputTokens: args.outputTokens,
        thinkingTokens: args.thinkingTokens,
        promptCacheTokens: args.promptCacheTokens,
        promptEvalTokens: args.promptEvalTokens,
        requestDurationMs: Date.now() - args.startedAt,
      });
      notifyFailedSpan?.end({ ok: true });
    } catch {
      notifyFailedSpan?.end({ ok: false });
      traceSummary(`notify running=false failed phase=planner chunk=none request_id=${this.options.requestId}`);
    }
  }

  private async notifyIteration(optionsForNotify: {
    providerResponse: SummaryPlannerProviderResponse;
    countOutputTokens: boolean;
    countToolTokens: boolean;
    toolStatsPayload: SummaryPlannerToolStatsPayload | null;
  }): Promise<void> {
    const { providerResponse, countOutputTokens, countToolTokens, toolStatsPayload } = optionsForNotify;
    traceSummary(`notify running=false phase=planner chunk=none duration_ms=${providerResponse.requestDurationMs}`);
    const notifyTerminalSpan = this.options.timingRecorder?.start('summary.planner.status.notify_terminal', {
      terminalState: 'iteration',
    });
    void notifyStatusBackend({
      running: false,
      taskKind: 'summary',
      statusBackendUrl: this.options.statusBackendUrl,
      requestId: this.options.requestId,
      promptCharacterCount: this.prompt.length,
      inputTokens: providerResponse.inputTokens,
      outputCharacterCount: providerResponse.outputCharacterCount,
      outputTokens: countOutputTokens ? providerResponse.outputTokens : null,
      toolTokens: countToolTokens ? providerResponse.outputTokens : null,
      thinkingTokens: providerResponse.thinkingTokens,
      toolStats: toolStatsPayload,
      promptCacheTokens: providerResponse.promptCacheTokens,
      promptEvalTokens: providerResponse.promptEvalTokens,
      requestDurationMs: providerResponse.requestDurationMs,
      providerDurationMs: providerResponse.providerDurationMs,
      statusRunningMs: providerResponse.statusRunningMs,
    })
      .catch(() => {
        notifyTerminalSpan?.end({ ok: false });
        traceSummary(`notify running=false failed phase=planner chunk=none request_id=${this.options.requestId}`);
      })
      .then(() => {
        notifyTerminalSpan?.end({ ok: true });
      });
  }

  async handleInvalidResponse(context: AgentLoopResponseContext & { error: Error }): Promise<AgentLoopInvalidResponseResult> {
    const providerResponse = getSummaryPlannerModelData(context).providerResponse;
    this.transcriptState.invalidActionCount += 1;
    const invalidResponseError = getErrorMessage(context.error);
    const invalidToolResultText = buildPlannerInvalidResponseUserPrompt(invalidResponseError);
    if (context.error instanceof NativePlannerToolCallError) {
      appendToolCallExchange(
        this.messages,
        { toolName: context.error.toolName, args: context.error.args },
        context.error.callId,
        invalidToolResultText,
        providerResponse.reasoningText || '',
      );
    } else {
      this.messages.push({
        role: 'assistant',
        content: providerResponse.text,
        ...(providerResponse.reasoningText
          ? { reasoning_content: providerResponse.reasoningText }
          : {}),
      });
      this.messages.push({ role: 'user', content: invalidToolResultText });
    }
    this.debugRecorder.record({
      kind: 'planner_invalid_response',
      error: invalidResponseError,
      toolResultText: invalidToolResultText,
    });
    if (this.transcriptState.invalidActionCount >= MAX_PLANNER_INVALID_RESPONSES) {
      this.debugRecorder.finish({
        status: 'failed',
        reason: 'planner_invalid_response_limit',
      });
      this.completionState.fail();
      await this.notifyIteration({
        providerResponse,
        countOutputTokens: false,
        countToolTokens: false,
        toolStatsPayload: null,
      });
      return { outcome: 'stop' };
    }
    await this.notifyIteration({
      providerResponse,
      countOutputTokens: false,
      countToolTokens: false,
      toolStatsPayload: null,
    });
    return { outcome: 'continue' };
  }

  async evaluateFinish(action: AgentLoopFinishAction, context: AgentLoopResponseContext): Promise<AgentLoopFinishEvaluation> {
    const providerResponse = getSummaryPlannerModelData(context).providerResponse;
    if (action.classification === 'unsupported_input' && !this.allowUnsupportedInput) {
      const fallbackDecision = normalizeStructuredDecision(
        buildConservativeDirectFallbackDecision({
          inputText: this.options.inputText,
          question: this.options.question,
          format: this.options.format,
          sourceKind: this.options.sourceKind,
        }),
        this.options.format,
      );
      this.debugRecorder.finish({
        status: 'completed',
        command: this.options.debugCommand ?? null,
        finalOutput: fallbackDecision.output,
        classification: fallbackDecision.classification,
        rawReviewRequired: fallbackDecision.rawReviewRequired,
      });
      this.completionState.complete(fallbackDecision);
      await this.notifyIteration({
        providerResponse,
        countOutputTokens: true,
        countToolTokens: false,
        toolStatsPayload: null,
      });
      return {
        accepted: true,
        outcome: 'stop',
        finishText: fallbackDecision.output,
      };
    }

    const decision = normalizeStructuredDecision(
      {
        classification: normalizeAgentLoopSummaryClassification(action.classification),
        rawReviewRequired: action.rawReviewRequired === true,
        output: action.text,
      },
      this.options.format,
    );
    this.debugRecorder.finish({
      status: 'completed',
      command: this.options.debugCommand ?? null,
      finalOutput: decision.output,
      classification: decision.classification,
      rawReviewRequired: decision.rawReviewRequired,
    });
    this.completionState.complete(decision);
    await this.notifyIteration({
      providerResponse,
      countOutputTokens: true,
      countToolTokens: false,
      toolStatsPayload: null,
    });
    return { accepted: true, outcome: 'stop', finishText: decision.output };
  }

  private buildToolActions(actions: readonly AgentLoopToolAction[]): SummaryPlannerToolAction[] {
    return actions.map((action) => {
      const parsed = SummaryNativeToolCallSchema.parse({
        toolName: action.toolName,
        args: JsonObjectSchema.parse(action.args),
      });
      return {
        ...action,
        toolName: parsed.toolName,
        args: JsonObjectSchema.parse(parsed.args),
      };
    });
  }

  private async notifyToolExecution(providerResponse: SummaryPlannerProviderResponse, toolStatsPayload: SummaryPlannerToolStatsPayload | null): Promise<void> {
    await this.notifyIteration({
      providerResponse,
      countOutputTokens: false,
      countToolTokens: true,
      toolStatsPayload,
    });
  }

  private async handleForcedFinishAttempt(
    toolActions: readonly SummaryPlannerToolAction[],
    providerResponse: SummaryPlannerProviderResponse,
  ): Promise<AgentLoopToolExecution | null> {
    if (this.transcriptState.forcedFinishAttemptsRemaining <= 0) {
      return null;
    }
    this.transcriptState.forcedFinishAttemptsRemaining = Math.max(this.transcriptState.forcedFinishAttemptsRemaining - 1, 0);
    const rejectedToolAction = toolActions[0];
    if (rejectedToolAction) {
      const forcedToolResultText = buildPlannerForcedFinishUserPrompt(
        'Current evidence is already repeating and likely sufficient. Produce your final answer now.',
      );
      appendToolCallExchange(
        this.messages,
        rejectedToolAction,
        rejectedToolAction.callId,
        forcedToolResultText,
        providerResponse.reasoningText || '',
      );
      this.transcriptState.forcedFinishCountdownUserMessageIndex = upsertTrailingUserMessage(
        this.messages,
        this.transcriptState.forcedFinishCountdownUserMessageIndex,
        `Forced finish attempts remaining: ${this.transcriptState.forcedFinishAttemptsRemaining}. Produce your final answer now.`,
      );
      this.debugRecorder.record({
        kind: 'planner_forced_finish_reprompt',
        attemptsRemaining: this.transcriptState.forcedFinishAttemptsRemaining,
        toolCall: rejectedToolAction,
        toolResultText: forcedToolResultText,
      });
    }
    if (this.transcriptState.forcedFinishAttemptsRemaining === 0) {
      this.debugRecorder.finish({
        status: 'failed',
        reason: 'planner_forced_finish_attempt_limit',
      });
      this.completionState.fail();
      await this.notifyToolExecution(providerResponse, null);
      return { outcome: 'stop', results: [] };
    }
    await this.notifyToolExecution(providerResponse, null);
    return { outcome: 'continue', results: [] };
  }

  private async handleToolCallLimit(
    toolActions: readonly SummaryPlannerToolAction[],
    turn: number,
    providerResponse: SummaryPlannerProviderResponse,
  ): Promise<AgentLoopToolExecution | null> {
    if (this.toolResults.length + toolActions.length <= MAX_PLANNER_TOOL_CALLS) {
      return null;
    }
    this.debugRecorder.record({
      kind: 'planner_forced_finish',
      reason: 'planner_tool_call_limit',
      toolCallCount: this.toolResults.length,
    });
    const limitedToolAction = toolActions[0];
    if (limitedToolAction) {
      appendToolCallExchange(
        this.messages,
        limitedToolAction,
        limitedToolAction.callId,
        buildPlannerForcedFinishUserPrompt(),
        providerResponse.reasoningText || '',
      );
    }
    this.messages.push({
      role: 'user',
      content: buildPlannerForcedFinishUserPrompt(),
    });
    if (await this.tryCompleteForcedToolLimit(turn)) {
      await this.notifyToolExecution(providerResponse, null);
      return { outcome: 'stop', results: [] };
    }
    this.debugRecorder.finish({
      status: 'failed',
      reason: 'planner_tool_call_limit',
    });
    this.completionState.fail();
    await this.notifyToolExecution(providerResponse, null);
    return { outcome: 'stop', results: [] };
  }

  private async tryCompleteForcedToolLimit(turn: number): Promise<boolean> {
    try {
      const forcedPrompt = renderPlannerTranscript(this.messages);
      const forcedPromptTokenSpan = this.options.timingRecorder?.start('summary.planner.prompt.tokenize_forced', {
        turn,
        promptChars: forcedPrompt.length,
      });
      const forcedPromptTokenCount =
        (await countLlamaCppTokens(this.options.config, forcedPrompt, this.tokenizeOptions)) ?? estimatePromptTokenCount(this.options.config, forcedPrompt);
      forcedPromptTokenSpan?.end({ promptTokenCount: forcedPromptTokenCount });
      const forcedResponse = await this.requestProviderAction({
        promptText: forcedPrompt,
        promptTokenCount: forcedPromptTokenCount,
      });
      const forcedActions = new AgentLoopActionParser().parseSummaryPlannerActions(
        this.toNormalizedResponse(forcedResponse),
        {
          toolDefinitions: this.toolDefinitions,
        },
      );
      const forcedAction = forcedActions.find((action) => action.kind === 'finish');
      if (!forcedAction) {
        return false;
      }
      const forcedDecision = normalizeStructuredDecision(
        {
          classification: normalizeAgentLoopSummaryClassification(forcedAction.classification),
          rawReviewRequired: forcedAction.rawReviewRequired === true,
          output: forcedAction.text,
        },
        this.options.format,
      );
      this.debugRecorder.finish({
        status: 'completed',
        command: this.options.debugCommand ?? null,
        finalOutput: forcedDecision.output,
        classification: forcedDecision.classification,
        rawReviewRequired: forcedDecision.rawReviewRequired,
      });
      this.completionState.complete(forcedDecision);
      return true;
    } catch {
      return false;
    }
  }

  private createToolBatchContext(turn: number, providerResponse: SummaryPlannerProviderResponse): SummaryPlannerToolBatchContext {
    return {
      turn,
      providerResponse,
      batchOutcomes: [],
      pendingModeChangeUserMessages: [],
      batchDuplicateAnchorIndex: null,
      toolStatsPayload: null,
    };
  }

  private getToolStats(
    ctx: SummaryPlannerToolBatchContext,
    toolName: PlannerToolName,
  ): ReturnType<typeof createEmptyToolTypeStats> {
    ctx.toolStatsPayload ??= {};
    const current = ctx.toolStatsPayload[toolName] ?? createEmptyToolTypeStats();
    ctx.toolStatsPayload[toolName] = current;
    return current;
  }

  private handleDuplicateToolAction(ctx: SummaryPlannerToolBatchContext, toolAction: SummaryPlannerToolAction): boolean {
    const fingerprint = fingerprintToolCall({
      toolName: toolAction.toolName,
      args: toolAction.args,
    });
    const readLinesExactRepeat =
      toolAction.toolName === 'read_lines' && this.transcriptState.lastSuccessfulReadLinesArgsText === JSON.stringify(toolAction.args);
    if (readLinesExactRepeat || this.transcriptState.lastSuccessfulFingerprint !== fingerprint) {
      return false;
    }
    const isActiveDuplicate =
      this.transcriptState.duplicateReplayFingerprint === fingerprint &&
      this.transcriptState.duplicateReplayToolMessageIndex >= 0 &&
      this.transcriptState.duplicateReplayToolMessageIndex < this.messages.length;
    this.transcriptState.duplicateReplayFingerprint = fingerprint;
    this.transcriptState.duplicateReplayCount = isActiveDuplicate ? this.transcriptState.duplicateReplayCount + 1 : 2;
    this.recordDuplicateToolMessage(ctx, toolAction, isActiveDuplicate);
    this.recordDuplicateToolStats(ctx, toolAction, fingerprint);
    return true;
  }

  private recordDuplicateToolMessage(ctx: SummaryPlannerToolBatchContext, toolAction: SummaryPlannerToolAction, isActiveDuplicate: boolean): void {
    const duplicateSummary = buildRepeatedToolCallSummary(toolAction.toolName, this.transcriptState.duplicateReplayCount);
    if (isActiveDuplicate) {
      const previousToolMessage = this.messages[this.transcriptState.duplicateReplayToolMessageIndex];
      this.messages[this.transcriptState.duplicateReplayToolMessageIndex] = {
        role: 'tool',
        tool_call_id: previousToolMessage?.tool_call_id,
        content: duplicateSummary,
      };
      return;
    }
    ctx.batchOutcomes.push({
      action: toolAction,
      toolCallId: toolAction.callId,
      toolContent: duplicateSummary,
    });
    ctx.batchDuplicateAnchorIndex = ctx.batchOutcomes.length - 1;
  }

  private recordDuplicateToolStats(ctx: SummaryPlannerToolBatchContext, toolAction: SummaryPlannerToolAction, fingerprint: string): void {
    const duplicateToolStats = this.getToolStats(ctx, toolAction.toolName);
    duplicateToolStats.semanticRepeatRejects += 1;
    this.debugRecorder.record({
      kind: 'planner_semantic_repeat',
      toolCall: toolAction,
      fingerprint,
      repeats: this.transcriptState.duplicateReplayCount,
    });
    if (this.transcriptState.duplicateReplayCount < PLANNER_DUPLICATE_FORCE_THRESHOLD || this.transcriptState.forcedFinishAttemptsRemaining !== 0) {
      return;
    }
    this.transcriptState.forcedFinishAttemptsRemaining = PLANNER_FORCED_FINISH_MAX_ATTEMPTS;
    ctx.pendingModeChangeUserMessages.push(
      buildPlannerForcedFinishUserPrompt('You repeated the same tool call too many times. Produce your final answer now.'),
    );
    duplicateToolStats.forcedFinishFromStagnation += 1;
  }

  private resolveEffectiveToolAction(toolAction: SummaryPlannerToolAction): SummaryPlannerEffectiveToolAction {
    if (toolAction.toolName !== 'read_lines') {
      return {
        toolAction,
        effectiveToolAction: toolAction,
        readLinesNoUnread: false,
      };
    }
    const unreadRange = SummaryPlannerLoopRuntime.computeReadLinesRange({
      startLine: Number(toolAction.args.startLine) || 1,
      endLine: Number(toolAction.args.endLine) || (Number(toolAction.args.startLine) || 1),
      inputLineCount: this.inputLines.length,
      returnedRanges: this.readLinesReturnedRanges,
      expandReads: isReadExpansionEnabled(this.options.config),
    });
    return {
      toolAction,
      readLinesNoUnread: !unreadRange.hasUnread,
      effectiveToolAction: {
        ...toolAction,
        args: unreadRange.hasUnread
          ? {
              ...toolAction.args,
              startLine: unreadRange.start,
              endLine: unreadRange.end - 1,
            }
          : {
              ...toolAction.args,
              startLine: unreadRange.start,
              endLine: unreadRange.end,
            },
      },
    };
  }

  private executeEffectivePlannerTool(input: SummaryPlannerEffectiveToolAction): PlannerToolResult {
    if (input.effectiveToolAction.toolName === 'read_lines' && input.readLinesNoUnread) {
      return {
        tool: 'read_lines',
        startLine: input.effectiveToolAction.args.startLine,
        endLine: input.effectiveToolAction.args.endLine,
        lineCount: 0,
        text: 'No unread lines remain for input text.',
      };
    }
    return executePlannerTool(this.options.inputText, input.effectiveToolAction, this.allowedTools);
  }

  private async handleInvalidToolExecution(
    ctx: SummaryPlannerToolBatchContext,
    toolAction: SummaryPlannerToolAction,
    error: Error,
  ): Promise<AgentLoopToolExecution | null> {
    this.transcriptState.invalidActionCount += 1;
    const invalidResponseError = getErrorMessage(error);
    const invalidToolResultText = buildPlannerInvalidResponseUserPrompt(invalidResponseError);
    ctx.batchOutcomes.push({
      action: toolAction,
      toolCallId: toolAction.callId,
      toolContent: invalidToolResultText,
    });
    this.debugRecorder.record({
      kind: 'planner_invalid_response',
      error: invalidResponseError,
      toolCall: toolAction,
      toolResultText: invalidToolResultText,
    });
    if (this.transcriptState.invalidActionCount < MAX_PLANNER_INVALID_RESPONSES) {
      return null;
    }
    appendToolBatchExchange(
      this.messages,
      ctx.batchOutcomes,
      ctx.providerResponse.reasoningText || '',
      ctx.providerResponse.text,
    );
    this.debugRecorder.finish({
      status: 'failed',
      reason: 'planner_invalid_response_limit',
    });
    this.completionState.fail();
    await this.notifyToolExecution(ctx.providerResponse, ctx.toolStatsPayload);
    return { outcome: 'stop', results: [] };
  }

  private async formatToolResultForPrompt(
    ctx: SummaryPlannerToolBatchContext,
    effectiveToolAction: SummaryPlannerToolAction,
    toolAction: SummaryPlannerToolAction,
    result: PlannerToolResult,
  ): Promise<SummaryPlannerFormattedToolResult> {
    const formatSpan = this.options.timingRecorder?.start('summary.planner.tool.format', {
      turn: ctx.turn,
      toolName: toolAction.toolName,
    });
    const rawFormattedResultText = formatPlannerResult(result);
    const formattedResultText = buildPromptToolResult({
      toolName: effectiveToolAction.toolName,
      output: rawFormattedResultText,
    });
    formatSpan?.end({
      rawChars: rawFormattedResultText.length,
      formattedChars: formattedResultText.length,
    });
    const rawResultTokenCount = await this.countRawToolResultTokens(ctx, toolAction, rawFormattedResultText);
    const formattedTokenCountRaw = await this.countFormattedToolResultTokens(ctx, toolAction, formattedResultText);
    const formattedTokenCountEstimated = formattedTokenCountRaw === null;
    const resultTokenCount = formattedTokenCountRaw ?? estimatePromptTokenCount(this.options.config, formattedResultText);
    if (Math.max(0, Math.ceil(resultTokenCount)) <= Math.max(this.promptBudget.plannerStopLineTokens - this.promptTokenCount, 0) * 0.7) {
      return {
        result,
        promptResultText: formattedResultText,
        rawResultTokenCount: Math.max(0, Math.ceil(rawResultTokenCount)),
        resolvedToolResultTokenCount: resultTokenCount,
        toolResultTokenEstimated: formattedTokenCountEstimated,
      };
    }
    const fitResult = await this.fitToolResultForPrompt(ctx, effectiveToolAction, result, formattedResultText);
    return {
      result,
      promptResultText: fitResult.promptResultText,
      rawResultTokenCount: Math.max(0, Math.ceil(rawResultTokenCount)),
      resolvedToolResultTokenCount: fitResult.tokenCount,
      toolResultTokenEstimated: fitResult.estimated,
    };
  }

  private async countRawToolResultTokens(
    ctx: SummaryPlannerToolBatchContext,
    toolAction: SummaryPlannerToolAction,
    rawFormattedResultText: string,
  ): Promise<number> {
    const rawTokenSpan = this.options.timingRecorder?.start('summary.planner.tool.tokenize_raw', {
      turn: ctx.turn,
      toolName: toolAction.toolName,
      inputChars: rawFormattedResultText.length,
    });
    const rawResultTokenCount =
      (await countLlamaCppTokens(this.options.config, rawFormattedResultText, this.tokenizeOptions)) ??
      estimatePromptTokenCount(this.options.config, rawFormattedResultText);
    rawTokenSpan?.end({ tokenCount: rawResultTokenCount });
    return rawResultTokenCount;
  }

  private async countFormattedToolResultTokens(
    ctx: SummaryPlannerToolBatchContext,
    toolAction: SummaryPlannerToolAction,
    formattedResultText: string,
  ): Promise<number | null> {
    const formattedTokenSpan = this.options.timingRecorder?.start('summary.planner.tool.tokenize_formatted', {
      turn: ctx.turn,
      toolName: toolAction.toolName,
      inputChars: formattedResultText.length,
    });
    const formattedTokenCountRaw = await countLlamaCppTokens(this.options.config, formattedResultText, this.tokenizeOptions);
    formattedTokenSpan?.end({
      tokenCount: formattedTokenCountRaw ?? estimatePromptTokenCount(this.options.config, formattedResultText),
    });
    return formattedTokenCountRaw;
  }

  private async fitToolResultForPrompt(
    ctx: SummaryPlannerToolBatchContext,
    effectiveToolAction: SummaryPlannerToolAction,
    result: PlannerToolResult,
    formattedResultText: string,
  ): Promise<{
    promptResultText: string;
    tokenCount: number;
    estimated: boolean;
  }> {
    const remainingPromptTokens = Math.max(this.promptBudget.plannerStopLineTokens - this.promptTokenCount, 0);
    const headerText = formatPlannerToolResultHeader(result);
    const resultBodyText = typeof result.text === 'string' ? result.text : formattedResultText;
    const unit: ToolOutputTruncationUnit = effectiveToolAction.toolName === 'find_text' ? 'results' : 'lines';
    const separator = effectiveToolAction.toolName === 'find_text' ? '\n\n' : '\n';
    const segments =
      effectiveToolAction.toolName === 'find_text'
        ? resultBodyText.split(/\n\s*\n/u).filter((segment) => segment.trim().length > 0)
        : resultBodyText.split(/\r?\n/u).filter((line) => line.length > 0);
    const fitter = new ToolOutputFitter(new SummaryPlannerToolOutputTokenCounter(this.options.config, this.tokenizeOptions));
    const fitResult = await fitter.fitSegments({
      headerText: headerText || undefined,
      segments,
      separator,
      maxTokens: Math.max(1, Math.floor(remainingPromptTokens * 0.7)),
      unit,
      keep: 'head',
    });
    const promptResultText = buildPromptToolResult({
      toolName: effectiveToolAction.toolName,
      output: fitResult.visibleText,
    });
    const fitTokenSpan = this.options.timingRecorder?.start('summary.planner.tool.tokenize_prompt', {
      turn: ctx.turn,
      toolName: effectiveToolAction.toolName,
      inputChars: promptResultText.length,
    });
    const fitTokenCountRaw = await countLlamaCppTokens(this.options.config, promptResultText, this.tokenizeOptions);
    fitTokenSpan?.end({ tokenCount: fitTokenCountRaw ?? -1 });
    return {
      promptResultText,
      estimated: fitTokenCountRaw === null,
      tokenCount: fitTokenCountRaw ?? estimatePromptTokenCount(this.options.config, promptResultText),
    };
  }

  private recordSuccessfulToolResult(
    ctx: SummaryPlannerToolBatchContext,
    toolAction: SummaryPlannerToolAction,
    effectiveToolAction: SummaryPlannerToolAction,
    formatted: SummaryPlannerFormattedToolResult,
  ): void {
    this.recordSuccessfulToolStats(ctx, toolAction, formatted);
    this.recordReadLinesRange(effectiveToolAction, formatted.result, formatted.promptResultText);
    const fingerprint = fingerprintToolCall({
      toolName: toolAction.toolName,
      args: toolAction.args,
    });
    const novelty = classifyToolOutputNovelty({
      baseOutput: formatted.result.text,
      promptResultText: formatted.promptResultText,
      recentEvidenceKeys: this.recentEvidenceKeys,
    });
    for (const evidenceKey of novelty.evidenceKeys) this.recentEvidenceKeys.add(evidenceKey);
    const noveltyToolStats = this.getToolStats(ctx, toolAction.toolName);
    noveltyToolStats.newEvidenceCalls += novelty.hasNewEvidence ? 1 : 0;
    noveltyToolStats.noNewEvidenceCalls += novelty.hasNewEvidence ? 0 : 1;
    this.transcriptState.duplicateReplayFingerprint = null;
    this.transcriptState.duplicateReplayCount = 0;
    this.transcriptState.duplicateReplayToolMessageIndex = -1;
    this.transcriptState.lastSuccessfulFingerprint = fingerprint;
    this.transcriptState.lastSuccessfulReadLinesArgsText = effectiveToolAction.toolName === 'read_lines' ? JSON.stringify(toolAction.args) : null;
    this.transcriptState.consecutiveNoNewEvidence = novelty.hasNewEvidence ? 0 : this.transcriptState.consecutiveNoNewEvidence + 1;
    ctx.batchOutcomes.push({
      action: effectiveToolAction,
      toolCallId: toolAction.callId,
      toolContent: formatted.promptResultText,
    });
    this.toolResults.push({
      callId: toolAction.callId,
      toolName: effectiveToolAction.toolName,
      args: effectiveToolAction.args,
      result: formatted.result,
      resultText: formatted.promptResultText,
    });
  }

  private recordSuccessfulToolStats(
    ctx: SummaryPlannerToolBatchContext,
    toolAction: SummaryPlannerToolAction,
    formatted: SummaryPlannerFormattedToolResult,
  ): void {
    const readLineCount = toolAction.toolName === 'read_lines' && Number.isFinite(formatted.result.lineCount) ? Number(formatted.result.lineCount) : 0;
    const currentToolStats = this.getToolStats(ctx, toolAction.toolName);
    const resolvedToolResultTokens = Math.max(0, Math.ceil(formatted.resolvedToolResultTokenCount));
    currentToolStats.calls += 1;
    currentToolStats.outputCharsTotal += formatted.promptResultText.length;
    currentToolStats.outputTokensTotal += resolvedToolResultTokens;
    currentToolStats.outputTokensEstimatedCount += formatted.toolResultTokenEstimated ? 1 : 0;
    currentToolStats.lineReadCalls += readLineCount > 0 ? 1 : 0;
    currentToolStats.lineReadLinesTotal += readLineCount;
    currentToolStats.lineReadTokensTotal += readLineCount > 0 ? formatted.rawResultTokenCount : 0;
    currentToolStats.promptInsertedTokens += resolvedToolResultTokens;
    currentToolStats.rawToolResultTokens += formatted.rawResultTokenCount;
  }

  private recordReadLinesRange(effectiveToolAction: SummaryPlannerToolAction, result: PlannerToolResult, promptResultText: string): void {
    if (effectiveToolAction.toolName !== 'read_lines') {
      return;
    }
    const returnedLineCount = promptResultText.split(/\r?\n/u).filter((line) => /^\d+:/u.test(line)).length;
    const returnedStartLine = Math.max(1, Math.trunc(Number(result.startLine) || 1));
    if (returnedLineCount > 0) {
      this.readLinesReturnedRanges.push({
        start: returnedStartLine,
        end: returnedStartLine + returnedLineCount,
      });
    }
  }

  private async executeSingleToolAction(ctx: SummaryPlannerToolBatchContext, toolAction: SummaryPlannerToolAction): Promise<AgentLoopToolExecution | null> {
    if (this.handleDuplicateToolAction(ctx, toolAction)) {
      return null;
    }
    const effective = this.resolveEffectiveToolAction(toolAction);
    const toolExecutionSpan = this.options.timingRecorder?.start('summary.planner.tool.execute', {
      turn: ctx.turn,
      toolName: effective.effectiveToolAction.toolName,
    });
    let result: PlannerToolResult;
    try {
      result = this.executeEffectivePlannerTool(effective);
      toolExecutionSpan?.end({ ok: true });
    } catch (error) {
      toolExecutionSpan?.end({ ok: false });
      return this.handleInvalidToolExecution(ctx, toolAction, toError(error));
    }
    this.debugRecorder.record({
      kind: 'planner_tool',
      command: `${toolAction.toolName} ${JSON.stringify(toolAction.args)}`,
      toolName: toolAction.toolName,
      args: toolAction.args,
      output: result,
    });
    const formatted = await this.formatToolResultForPrompt(ctx, effective.effectiveToolAction, toolAction, result);
    this.recordSuccessfulToolResult(ctx, toolAction, effective.effectiveToolAction, formatted);
    return null;
  }

  private async executeToolBatch(
    ctx: SummaryPlannerToolBatchContext,
    toolActions: readonly SummaryPlannerToolAction[],
  ): Promise<AgentLoopToolExecution | null> {
    for (const toolAction of toolActions) {
      const stopResult = await this.executeSingleToolAction(ctx, toolAction);
      if (stopResult) {
        return stopResult;
      }
    }
    return null;
  }

  private appendToolBatchToTranscript(ctx: SummaryPlannerToolBatchContext): void {
    const preAppendMessagesLength = this.messages.length;
    const appendSpan = this.options.timingRecorder?.start('summary.planner.tool.append', {
      turn: ctx.turn,
      outcomeCount: ctx.batchOutcomes.length,
      beforeMessageCount: this.messages.length,
    });
    appendToolBatchExchange(
      this.messages,
      ctx.batchOutcomes,
      ctx.providerResponse.reasoningText || '',
      ctx.providerResponse.text,
    );
    appendSpan?.end({ afterMessageCount: this.messages.length });
    if (ctx.batchDuplicateAnchorIndex !== null && ctx.batchOutcomes.length > 0) {
      this.transcriptState.duplicateReplayToolMessageIndex = preAppendMessagesLength + 1 + ctx.batchDuplicateAnchorIndex;
    }
    for (const userMessage of ctx.pendingModeChangeUserMessages) {
      this.messages.push({ role: 'user', content: userMessage });
    }
  }

  private buildAgentLoopToolResults(beforeToolResultCount: number): AgentLoopToolResult[] {
    return this.toolResults.slice(beforeToolResultCount).map((result): AgentLoopToolResult => ({
      callId: result.callId,
      toolName: result.toolName,
      args: result.args,
      text: result.resultText,
      raw: result.result,
    }));
  }

  async executeTools(actions: readonly AgentLoopToolAction[], context: AgentLoopResponseContext): Promise<AgentLoopToolExecution> {
    const providerResponse = getSummaryPlannerModelData(context).providerResponse;
    const beforeToolResultCount = this.toolResults.length;
    const turn = this.toolResults.length + 1;
    const toolActions = this.buildToolActions(actions);
    const forcedFinishResult = await this.handleForcedFinishAttempt(toolActions, providerResponse);
    if (forcedFinishResult) return forcedFinishResult;
    const limitResult = await this.handleToolCallLimit(toolActions, turn, providerResponse);
    if (limitResult) return limitResult;
    const batchContext = this.createToolBatchContext(turn, providerResponse);
    const batchStopResult = await this.executeToolBatch(batchContext, toolActions);
    if (batchStopResult) return batchStopResult;
    this.appendToolBatchToTranscript(batchContext);
    await this.notifyToolExecution(providerResponse, batchContext.toolStatsPayload);
    return {
      outcome: 'continue',
      results: this.buildAgentLoopToolResults(beforeToolResultCount),
    };
  }
}

export async function invokePlannerMode(options: InvokePlannerModeOptions): Promise<StructuredModelDecision | null> {
  if (options.provider !== 'real') {
    return null;
  }

  const promptBudget = getPlannerPromptBudget(options.config);
  if (promptBudget.plannerStopLineTokens <= 0) {
    return null;
  }

  const allowedTools: PlannerToolName[] =
    Array.isArray(options.allowedTools) && options.allowedTools.length > 0
      ? options.allowedTools
      : [...DEFAULT_SUMMARY_PLANNER_TOOL_NAMES];
  const toolDefinitions = buildSummaryPlannerToolDefinitions(
    allowedTools,
    allowsUnsupportedInput(options.sourceKind),
  );
  const toolResults: SummaryPlannerToolResultRecord[] = [];
  const messages: LlamaCppChatMessage[] = [
    {
      role: 'system',
      content: buildPlannerSystemPrompt({
        presetPromptPrefix: options.presetPromptPrefix,
        additionalPromptPrefix: options.additionalPromptPrefix,
        systemContext: options.systemContext,
        sourceKind: options.sourceKind,
        commandExitCode: options.commandExitCode,
        rawReviewRequired: options.rawReviewRequired,
        toolDefinitions,
      }),
    },
    {
      role: 'user',
      content: buildUserContent(
        buildPlannerInputSection({
          question: options.question,
          inputText: options.inputText,
        }),
        options.images,
      ),
    },
  ];
  const debugRecorder = createPlannerDebugRecorder({
    requestId: options.requestId,
    question: options.question,
    sourceKind: options.sourceKind,
    commandExitCode: options.commandExitCode,
    commandText: options.debugCommand,
  });
  const requestContext = new SummaryPlannerRequestContext({
    options,
    promptBudget,
    allowedTools,
    toolDefinitions,
    debugRecorder,
  });
  const transcriptState = new SummaryPlannerTranscriptState({
    messages,
    toolResults,
    inputText: options.inputText,
  });
  const completionState = new SummaryPlannerCompletionState();
  const runtime = new SummaryPlannerLoopRuntime(requestContext, transcriptState, completionState);
  const promptAdapter = new SummaryPlannerPromptAdapter(runtime);
  const actionAdapter = new SummaryPlannerActionAdapter(runtime, toolDefinitions);
  const toolAdapter = new SummaryPlannerToolAdapter(runtime);
  await new AgentLoop({
    maxTurns: MAX_PLANNER_TOOL_CALLS + 1,
    promptAdapter,
    actionAdapter,
    toolAdapter,
    modelClient: new SummaryPlannerModelClient(runtime),
  }).run();

  if (completionState.isFinished()) {
    return new SummaryPlannerResultAssembler(completionState.getDecision()).assemble();
  }

  debugRecorder.finish({
    status: 'failed',
    reason: 'planner_exhausted_without_finish',
  });
  return null;
}
