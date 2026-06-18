import type { SiftConfig } from '../../config/index.js';
import { AgentLoop } from '../../agent-loop/agent-loop.js';
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
import type { NormalizedLlamaCppChatResponse } from '../../llm-protocol/types.js';
import {
  createEmptyToolTypeStats,
} from '../../line-read-guidance.js';
import {
  countLlamaCppTokens,
  generateLlamaCppChatResponse,
  type CountLlamaCppTokensOptions,
  type LlamaCppGenerateResult,
  type LlamaCppChatMessage,
} from '../../providers/llama-cpp.js';
import { getProcessedPromptTokens } from '../../lib/provider-helpers.js';
import { getErrorMessage } from '../../lib/errors.js';
import { ModelJson } from '../../lib/model-json.js';
import {
  buildConservativeDirectFallbackDecision,
  normalizeStructuredDecision,
} from '../structured.js';
import {
  buildPlannerToolDefinitions,
  executePlannerTool,
  formatPlannerResult,
  formatPlannerToolResultHeader,
} from './tools.js';
import {
  createPlannerDebugRecorder,
  buildPlannerFailureErrorMessage,
  traceSummary,
} from '../artifacts.js';
import {
  buildPlannerAssistantToolMessage,
  buildPlannerForcedFinishUserPrompt,
  buildPlannerInitialUserPrompt,
  buildPlannerInvalidResponseUserPrompt,
  buildPlannerSystemPrompt,
  renderPlannerTranscript,
} from './prompts.js';
import {
  estimatePromptTokenCount,
  getPlannerPromptBudget,
} from '../chunking.js';
import { notifyStatusBackend } from '../../config/index.js';
import type { TemporaryTimingRecorder } from '../../lib/temporary-timing-recorder.js';
import {
  SummaryPlannerActionAdapter,
  SummaryPlannerModelClient,
  SummaryPlannerPromptAdapter,
  SummaryPlannerResultAssembler,
  SummaryPlannerToolAdapter,
  type SummaryPlannerLoopController,
} from './agent-loop-adapter.js';
import type {
  PlannerAction,
  PlannerToolName,
  SummaryClassification,
  StructuredModelDecision,
  SummaryRequest,
  SummarySourceKind,
} from '../types.js';
import {
  buildRepeatedToolCallSummary,
  buildPromptToolResult,
  buildToolReplayFingerprint,
  classifyToolResultNovelty,
  fingerprintToolCall,
} from '../../tool-loop-governor.js';
import {
  appendToolCallExchange,
  appendToolBatchExchange,
  upsertTrailingUserMessage,
  type ToolBatchOutcome,
  type ToolTranscriptAction,
} from '../../tool-call-messages.js';
import {
  findContiguousUnreadRange,
  ToolOutputFitter,
  type ToolOutputTruncationUnit,
} from '../../tool-output-fit.js';

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

function tryParseSummaryDecision(providerText: string): StructuredModelDecision | null {
  try {
    return ModelJson.parseSummaryDecision(providerText);
  } catch {
    return null;
  }
}

function buildPlannerInvalidToolAction(providerText: string): ToolTranscriptAction {
  try {
    const recoveredAction = ModelJson.parseSummaryPlannerAction(providerText);
    if (recoveredAction.action === 'tool') {
      return recoveredAction;
    }
    if (recoveredAction.action === 'tool_batch') {
      const firstToolCall = recoveredAction.tool_calls[0];
      if (firstToolCall) {
        return {
          tool_name: firstToolCall.tool_name,
          args: firstToolCall.args,
        };
      }
    }
  } catch {
    // Invalid responses are fed back to the model as an explicit invalid tool call.
  }
  return {
    tool_name: 'invalid_tool_call',
    args: {
      rawResponseText: String(providerText || '').trim(),
    },
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
  format: 'text' | 'json';
  backend: string;
  model: string;
  config: SiftConfig;
  rawReviewRequired: boolean;
  sourceKind: SummarySourceKind;
  commandExitCode?: number | null;
  debugCommand?: string | null;
  promptPrefix?: string;
  allowedTools?: PlannerToolName[];
  requestTimeoutSeconds?: number;
  llamaCppOverrides?: SummaryRequest['llamaCppOverrides'];
  statusBackendUrl?: string | null;
  timingRecorder?: TemporaryTimingRecorder | null;
};

type PlannerPromptBudget = ReturnType<typeof getPlannerPromptBudget>;
type PlannerToolDefinition = ReturnType<typeof buildPlannerToolDefinitions>[number];
type SummaryPlannerDebugRecorder = ReturnType<typeof createPlannerDebugRecorder>;
type SummaryPlannerToolResultRecord = {
  toolName: PlannerToolName;
  args: Record<string, unknown>;
  result: unknown;
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
type SummaryPlannerToolAction = Extract<PlannerAction, { action: 'tool' }>;
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
  result: Record<string, unknown>;
  promptResultText: string;
  rawResultTokenCount: number;
  resolvedToolResultTokenCount: number;
  toolResultTokenEstimated: boolean;
};

function getSummaryPlannerModelData(context: AgentLoopResponseContext): SummaryPlannerModelData {
  if (context.modelData?.kind !== 'summary-planner') {
    throw new Error('Summary planner AgentLoop context is missing provider response data.');
  }
  return context.modelData as SummaryPlannerModelData;
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

  constructor(
    private readonly requestContext: SummaryPlannerRequestContext,
    private readonly transcriptState: SummaryPlannerTranscriptState,
    private readonly completionState: SummaryPlannerCompletionState,
  ) {
    this.tokenizeOptions = getPlannerTokenizeOptions(this.options.requestTimeoutSeconds);
  }

  private get options(): InvokePlannerModeOptions { return this.requestContext.options; }
  private get promptBudget(): PlannerPromptBudget { return this.requestContext.promptBudget; }
  private get allowedTools(): PlannerToolName[] { return this.requestContext.allowedTools; }
  private get toolDefinitions(): PlannerToolDefinition[] { return this.requestContext.toolDefinitions; }
  private get debugRecorder(): SummaryPlannerDebugRecorder { return this.requestContext.debugRecorder; }
  private get messages(): LlamaCppChatMessage[] { return this.transcriptState.messages; }
  private get toolResults(): SummaryPlannerToolResultRecord[] { return this.transcriptState.toolResults; }
  private get inputLines(): string[] { return this.transcriptState.inputLines; }
  private get readLinesReturnedRanges(): Array<{ start: number; end: number }> { return this.transcriptState.readLinesReturnedRanges; }
  private get recentEvidenceKeys(): Set<string> { return this.transcriptState.recentEvidenceKeys; }

  async prepareTurn(turnNumber: number): Promise<AgentLoopPreparedTurn> {
    const turn = this.toolResults.length + 1;
    if (this.toolResults.length > MAX_PLANNER_TOOL_CALLS) {
      return {
        outcome: 'stop',
        turnNumber,
        promptTokenCount: 0,
        maxOutputTokens: 0,
        messages: this.messages as AgentLoopPreparedTurn['messages'],
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
    this.promptTokenCount = (
      await countLlamaCppTokens(this.options.config, this.prompt, this.tokenizeOptions)
    ) ?? estimatePromptTokenCount(this.options.config, this.prompt);
    promptTokenSpan?.end({ promptTokenCount: this.promptTokenCount });
    this.debugRecorder.record({
      kind: 'planner_prompt',
      prompt: this.prompt,
      promptTokenCount: this.promptTokenCount,
      toolCallCount: this.toolResults.length,
      plannerBudget: this.promptBudget,
    });
    if (this.promptTokenCount > this.promptBudget.plannerStopLineTokens) {
      this.debugRecorder.finish({
        status: 'failed',
        reason: 'planner_headroom_exceeded',
        promptTokenCount: this.promptTokenCount,
        plannerBudget: this.promptBudget,
      });
      this.completionState.fail();
      return {
        outcome: 'stop',
        turnNumber: turn,
        promptTokenCount: this.promptTokenCount,
        maxOutputTokens: 0,
        messages: this.messages as AgentLoopPreparedTurn['messages'],
        toolDefinitions: this.toolDefinitions,
        inForcedFinishMode: this.transcriptState.forcedFinishAttemptsRemaining > 0,
      };
    }
    return {
      outcome: 'continue',
      turnNumber: turn,
      promptTokenCount: this.promptTokenCount,
      maxOutputTokens: 0,
      messages: this.messages as AgentLoopPreparedTurn['messages'],
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
      toolCalls: [],
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
    };
  }

  private async requestProviderAction(override?: {
    promptText: string;
    promptTokenCount: number;
  }): Promise<SummaryPlannerProviderResponse> {
    const promptText = override?.promptText ?? this.prompt;
    const promptTokenCount = override?.promptTokenCount ?? this.promptTokenCount;
    traceSummary(
      `notify running=true phase=planner chunk=none raw_chars=${this.options.inputText.length} `
      + `chunk_chars=${this.options.inputText.length} prompt_chars=${promptText.length}`
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

    const statusRunningMs = Date.now() - statusRunningStartedAt;
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
          timeoutSeconds: this.options.requestTimeoutSeconds ?? 600,
          slotId: this.options.slotId ?? undefined,
          cachePrompt: true,
          tools: this.toolDefinitions,
          structuredOutput: {
            kind: 'siftkit-planner-action-json',
            tools: this.toolDefinitions,
          },
          overrides: this.options.llamaCppOverrides,
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
      traceSummary(`notify running=false phase=planner chunk=none duration_ms=${Date.now() - startedAt}`);
      const notifyFailedSpan = this.options.timingRecorder?.start('summary.planner.status.notify_terminal', {
        terminalState: 'failed',
      });
      try {
        await notifyStatusBackend({
          running: false,
          taskKind: 'summary',
          requestId: this.options.requestId,
          statusBackendUrl: this.options.statusBackendUrl,
          promptCharacterCount: promptText.length,
          inputTokens,
          outputCharacterCount,
          outputTokens,
          thinkingTokens,
          promptCacheTokens,
          promptEvalTokens,
          requestDurationMs: Date.now() - startedAt,
        });
        notifyFailedSpan?.end({ ok: true });
      } catch {
        notifyFailedSpan?.end({ ok: false });
        traceSummary(`notify running=false failed phase=planner chunk=none request_id=${this.options.requestId}`);
      }
      throw error;
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
    }).catch(() => {
      notifyTerminalSpan?.end({ ok: false });
      traceSummary(`notify running=false failed phase=planner chunk=none request_id=${this.options.requestId}`);
    }).then(() => {
      notifyTerminalSpan?.end({ ok: true });
    });
  }

  async handleInvalidResponse(context: AgentLoopResponseContext & { error: Error }): Promise<AgentLoopInvalidResponseResult> {
    const providerResponse = getSummaryPlannerModelData(context).providerResponse;
    const recoveredDecision = this.toolResults.length === 0
      ? tryParseSummaryDecision(providerResponse.text)
      : null;
    if (recoveredDecision) {
      const decision = normalizeStructuredDecision(recoveredDecision, this.options.format);
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
        countOutputTokens: false,
        countToolTokens: false,
        toolStatsPayload: null,
      });
      return { outcome: 'stop' };
    }
    this.transcriptState.invalidActionCount += 1;
    const invalidResponseError = getErrorMessage(context.error);
    const invalidToolResultText = buildPlannerInvalidResponseUserPrompt(invalidResponseError);
    appendToolCallExchange(
      this.messages,
      buildPlannerInvalidToolAction(providerResponse.text),
      `invalid_call_${this.transcriptState.invalidActionCount}`,
      invalidToolResultText,
      providerResponse.reasoningText || '',
    );
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
    if (action.classification === 'unsupported_input' && this.options.sourceKind === 'command-output') {
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
      return { accepted: true, outcome: 'stop', finishText: fallbackDecision.output };
    }

    const decision = normalizeStructuredDecision({
      classification: normalizeAgentLoopSummaryClassification(action.classification),
      rawReviewRequired: action.rawReviewRequired === true,
      output: action.text,
    }, this.options.format);
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
    return actions.map((action) => ({
      action: 'tool' as const,
      tool_name: action.toolName as PlannerToolName,
      args: action.args,
    }));
  }

  private async notifyToolExecution(
    providerResponse: SummaryPlannerProviderResponse,
    toolStatsPayload: SummaryPlannerToolStatsPayload | null,
  ): Promise<void> {
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
        'Current evidence is already repeating and likely sufficient. Produce your final answer now.'
      );
      appendToolCallExchange(
        this.messages,
        rejectedToolAction,
        `forced_finish_call_${this.toolResults.length + 1}`,
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
      this.debugRecorder.finish({ status: 'failed', reason: 'planner_forced_finish_attempt_limit' });
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
    if ((this.toolResults.length + toolActions.length) <= MAX_PLANNER_TOOL_CALLS) {
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
        `tool_limit_call_${this.toolResults.length + 1}`,
        buildPlannerForcedFinishUserPrompt(),
        providerResponse.reasoningText || '',
      );
    }
    this.messages.push({ role: 'user', content: buildPlannerForcedFinishUserPrompt() });
    if (await this.tryCompleteForcedToolLimit(turn)) {
      await this.notifyToolExecution(providerResponse, null);
      return { outcome: 'stop', results: [] };
    }
    this.debugRecorder.finish({ status: 'failed', reason: 'planner_tool_call_limit' });
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
      const forcedPromptTokenCount = (
        await countLlamaCppTokens(this.options.config, forcedPrompt, this.tokenizeOptions)
      ) ?? estimatePromptTokenCount(this.options.config, forcedPrompt);
      forcedPromptTokenSpan?.end({ promptTokenCount: forcedPromptTokenCount });
      const forcedResponse = await this.requestProviderAction({
        promptText: forcedPrompt,
        promptTokenCount: forcedPromptTokenCount,
      });
      const forcedAction = ModelJson.parseSummaryPlannerAction(forcedResponse.text);
      if (forcedAction.action !== 'finish') {
        return false;
      }
      const forcedDecision = normalizeStructuredDecision({
        classification: forcedAction.classification,
        rawReviewRequired: forcedAction.rawReviewRequired,
        output: forcedAction.output,
      }, this.options.format);
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

  private getToolStats(ctx: SummaryPlannerToolBatchContext, toolName: PlannerToolName): ReturnType<typeof createEmptyToolTypeStats> {
    ctx.toolStatsPayload ||= {};
    const currentToolStats = ctx.toolStatsPayload[toolName] || createEmptyToolTypeStats();
    ctx.toolStatsPayload[toolName] = currentToolStats;
    return currentToolStats;
  }

  private handleDuplicateToolAction(ctx: SummaryPlannerToolBatchContext, toolAction: SummaryPlannerToolAction): boolean {
    const fingerprint = fingerprintToolCall({ toolName: toolAction.tool_name, args: toolAction.args });
    const readLinesExactRepeat = toolAction.tool_name === 'read_lines'
      && this.transcriptState.lastSuccessfulReadLinesArgsText === JSON.stringify(toolAction.args);
    if (readLinesExactRepeat || this.transcriptState.lastSuccessfulFingerprint !== fingerprint) {
      return false;
    }
    const isActiveDuplicate = this.transcriptState.duplicateReplayFingerprint === fingerprint
      && this.transcriptState.duplicateReplayToolMessageIndex >= 0
      && this.transcriptState.duplicateReplayToolMessageIndex < this.messages.length;
    this.transcriptState.duplicateReplayFingerprint = fingerprint;
    this.transcriptState.duplicateReplayCount = isActiveDuplicate ? (this.transcriptState.duplicateReplayCount + 1) : 2;
    this.recordDuplicateToolMessage(ctx, toolAction, isActiveDuplicate);
    this.recordDuplicateToolStats(ctx, toolAction, fingerprint);
    return true;
  }

  private recordDuplicateToolMessage(
    ctx: SummaryPlannerToolBatchContext,
    toolAction: SummaryPlannerToolAction,
    isActiveDuplicate: boolean,
  ): void {
    const duplicateSummary = buildRepeatedToolCallSummary(toolAction.tool_name, this.transcriptState.duplicateReplayCount);
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
      toolCallId: `duplicate_call_${this.toolResults.length + 1}`,
      toolContent: duplicateSummary,
    });
    ctx.batchDuplicateAnchorIndex = ctx.batchOutcomes.length - 1;
  }

  private recordDuplicateToolStats(
    ctx: SummaryPlannerToolBatchContext,
    toolAction: SummaryPlannerToolAction,
    fingerprint: string,
  ): void {
    const duplicateToolStats = this.getToolStats(ctx, toolAction.tool_name);
    ctx.toolStatsPayload![toolAction.tool_name] = {
      ...duplicateToolStats,
      semanticRepeatRejects: duplicateToolStats.semanticRepeatRejects + 1,
    };
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
    const currentToolStats = ctx.toolStatsPayload![toolAction.tool_name];
    ctx.toolStatsPayload![toolAction.tool_name] = {
      ...currentToolStats,
      forcedFinishFromStagnation: currentToolStats.forcedFinishFromStagnation + 1,
    };
  }

  private resolveEffectiveToolAction(toolAction: SummaryPlannerToolAction): SummaryPlannerEffectiveToolAction {
    if (toolAction.tool_name !== 'read_lines') {
      return { toolAction, effectiveToolAction: toolAction, readLinesNoUnread: false };
    }
    const requestedStart = Math.max(1, Math.trunc(Number(toolAction.args.startLine) || 1));
    const requestedEnd = Math.max(requestedStart, Math.trunc(Number(toolAction.args.endLine) || requestedStart));
    const requestedEndExclusive = Math.min(requestedEnd + 1, this.inputLines.length + 1);
    const hasReturnedRanges = this.readLinesReturnedRanges.length > 0;
    const unreadRange = findContiguousUnreadRange({
      requestedStart: Math.min(requestedStart, this.inputLines.length || 1),
      totalEnd: hasReturnedRanges ? this.inputLines.length + 1 : requestedEndExclusive,
      returnedRanges: this.readLinesReturnedRanges,
    });
    return {
      toolAction,
      readLinesNoUnread: !unreadRange.hasUnread,
      effectiveToolAction: {
        ...toolAction,
        args: unreadRange.hasUnread
          ? { ...toolAction.args, startLine: unreadRange.start, endLine: unreadRange.end - 1 }
          : { ...toolAction.args, startLine: unreadRange.start, endLine: unreadRange.end },
      },
    };
  }

  private executeEffectivePlannerTool(input: SummaryPlannerEffectiveToolAction): Record<string, unknown> {
    if (input.effectiveToolAction.tool_name === 'read_lines' && input.readLinesNoUnread) {
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
    error: unknown,
  ): Promise<AgentLoopToolExecution | null> {
    this.transcriptState.invalidActionCount += 1;
    const invalidResponseError = getErrorMessage(error);
    const invalidToolResultText = buildPlannerInvalidResponseUserPrompt(invalidResponseError);
    ctx.batchOutcomes.push({
      action: toolAction,
      toolCallId: `invalid_call_${this.transcriptState.invalidActionCount}`,
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
    appendToolBatchExchange(this.messages, ctx.batchOutcomes, ctx.providerResponse.reasoningText || '');
    this.debugRecorder.finish({ status: 'failed', reason: 'planner_invalid_response_limit' });
    this.completionState.fail();
    await this.notifyToolExecution(ctx.providerResponse, ctx.toolStatsPayload);
    return { outcome: 'stop', results: [] };
  }

  private async formatToolResultForPrompt(
    ctx: SummaryPlannerToolBatchContext,
    effectiveToolAction: SummaryPlannerToolAction,
    toolAction: SummaryPlannerToolAction,
    result: Record<string, unknown>,
  ): Promise<SummaryPlannerFormattedToolResult> {
    const formatSpan = this.options.timingRecorder?.start('summary.planner.tool.format', { turn: ctx.turn, toolName: toolAction.tool_name });
    const rawFormattedResultText = formatPlannerResult(result);
    const formattedResultText = buildPromptToolResult({ toolName: effectiveToolAction.tool_name, rawOutput: rawFormattedResultText });
    formatSpan?.end({ rawChars: rawFormattedResultText.length, formattedChars: formattedResultText.length });
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
      toolName: toolAction.tool_name,
      inputChars: rawFormattedResultText.length,
    });
    const rawResultTokenCount = (
      await countLlamaCppTokens(this.options.config, rawFormattedResultText, this.tokenizeOptions)
    ) ?? estimatePromptTokenCount(this.options.config, rawFormattedResultText);
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
      toolName: toolAction.tool_name,
      inputChars: formattedResultText.length,
    });
    const formattedTokenCountRaw = await countLlamaCppTokens(this.options.config, formattedResultText, this.tokenizeOptions);
    formattedTokenSpan?.end({ tokenCount: formattedTokenCountRaw ?? estimatePromptTokenCount(this.options.config, formattedResultText) });
    return formattedTokenCountRaw;
  }

  private async fitToolResultForPrompt(
    ctx: SummaryPlannerToolBatchContext,
    effectiveToolAction: SummaryPlannerToolAction,
    result: Record<string, unknown>,
    formattedResultText: string,
  ): Promise<{ promptResultText: string; tokenCount: number; estimated: boolean }> {
    const remainingPromptTokens = Math.max(this.promptBudget.plannerStopLineTokens - this.promptTokenCount, 0);
    const headerText = formatPlannerToolResultHeader(result);
    const resultBodyText = typeof result.text === 'string' ? result.text : formattedResultText;
    const unit: ToolOutputTruncationUnit = effectiveToolAction.tool_name === 'find_text' ? 'results' : 'lines';
    const separator = effectiveToolAction.tool_name === 'find_text' ? '\n\n' : '\n';
    const segments = effectiveToolAction.tool_name === 'find_text'
      ? resultBodyText.split(/\n\s*\n/u).filter((segment) => segment.trim().length > 0)
      : resultBodyText.split(/\r?\n/u).filter((line) => line.length > 0);
    const fitter = new ToolOutputFitter(new SummaryPlannerToolOutputTokenCounter(this.options.config, this.tokenizeOptions));
    const fitResult = await fitter.fitSegments({
      headerText: headerText || undefined,
      segments,
      separator,
      maxTokens: Math.max(1, Math.floor(remainingPromptTokens * 0.7)),
      unit,
    });
    const promptResultText = buildPromptToolResult({ toolName: effectiveToolAction.tool_name, rawOutput: fitResult.visibleText });
    const fitTokenSpan = this.options.timingRecorder?.start('summary.planner.tool.tokenize_prompt', {
      turn: ctx.turn,
      toolName: effectiveToolAction.tool_name,
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
    const fingerprint = fingerprintToolCall({ toolName: toolAction.tool_name, args: toolAction.args });
    const novelty = classifyToolResultNovelty({ promptResultText: formatted.promptResultText, recentEvidenceKeys: this.recentEvidenceKeys });
    for (const evidenceKey of novelty.evidenceKeys) this.recentEvidenceKeys.add(evidenceKey);
    ctx.toolStatsPayload![toolAction.tool_name].newEvidenceCalls += novelty.hasNewEvidence ? 1 : 0;
    ctx.toolStatsPayload![toolAction.tool_name].noNewEvidenceCalls += novelty.hasNewEvidence ? 0 : 1;
    this.transcriptState.duplicateReplayFingerprint = null;
    this.transcriptState.duplicateReplayCount = 0;
    this.transcriptState.duplicateReplayToolMessageIndex = -1;
    this.transcriptState.lastSuccessfulFingerprint = fingerprint;
    this.transcriptState.lastSuccessfulReadLinesArgsText = effectiveToolAction.tool_name === 'read_lines' ? JSON.stringify(toolAction.args) : null;
    this.transcriptState.consecutiveNoNewEvidence = novelty.hasNewEvidence ? 0 : (this.transcriptState.consecutiveNoNewEvidence + 1);
    ctx.batchOutcomes.push({
      action: effectiveToolAction,
      toolCallId: `call_${this.toolResults.length + 1}`,
      toolContent: formatted.promptResultText,
    });
    this.toolResults.push({
      toolName: effectiveToolAction.tool_name,
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
    const readLineCount = toolAction.tool_name === 'read_lines' && Number.isFinite((formatted.result as { lineCount?: unknown }).lineCount)
      ? Number((formatted.result as { lineCount?: unknown }).lineCount)
      : 0;
    const currentToolStats = this.getToolStats(ctx, toolAction.tool_name);
    ctx.toolStatsPayload![toolAction.tool_name] = {
      ...currentToolStats,
      calls: currentToolStats.calls + 1,
      outputCharsTotal: currentToolStats.outputCharsTotal + formatted.promptResultText.length,
      outputTokensTotal: currentToolStats.outputTokensTotal + Math.max(0, Math.ceil(formatted.resolvedToolResultTokenCount)),
      outputTokensEstimatedCount: currentToolStats.outputTokensEstimatedCount + (formatted.toolResultTokenEstimated ? 1 : 0),
      lineReadCalls: currentToolStats.lineReadCalls + (readLineCount > 0 ? 1 : 0),
      lineReadLinesTotal: currentToolStats.lineReadLinesTotal + readLineCount,
      lineReadTokensTotal: currentToolStats.lineReadTokensTotal + (readLineCount > 0 ? formatted.rawResultTokenCount : 0),
      promptInsertedTokens: currentToolStats.promptInsertedTokens + Math.max(0, Math.ceil(formatted.resolvedToolResultTokenCount)),
      rawToolResultTokens: currentToolStats.rawToolResultTokens + formatted.rawResultTokenCount,
    };
  }

  private recordReadLinesRange(
    effectiveToolAction: SummaryPlannerToolAction,
    result: Record<string, unknown>,
    promptResultText: string,
  ): void {
    if (effectiveToolAction.tool_name !== 'read_lines') {
      return;
    }
    const returnedLineCount = promptResultText.split(/\r?\n/u).filter((line) => /^\d+:/u.test(line)).length;
    const returnedStartLine = Math.max(1, Math.trunc(Number(result.startLine) || 1));
    if (returnedLineCount > 0) {
      this.readLinesReturnedRanges.push({ start: returnedStartLine, end: returnedStartLine + returnedLineCount });
    }
  }

  private async executeSingleToolAction(
    ctx: SummaryPlannerToolBatchContext,
    toolAction: SummaryPlannerToolAction,
  ): Promise<AgentLoopToolExecution | null> {
    if (this.handleDuplicateToolAction(ctx, toolAction)) {
      return null;
    }
    const effective = this.resolveEffectiveToolAction(toolAction);
    const toolExecutionSpan = this.options.timingRecorder?.start('summary.planner.tool.execute', {
      turn: ctx.turn,
      toolName: effective.effectiveToolAction.tool_name,
    });
    let result: Record<string, unknown>;
    try {
      result = this.executeEffectivePlannerTool(effective);
      toolExecutionSpan?.end({ ok: true });
    } catch (error) {
      toolExecutionSpan?.end({ ok: false });
      return this.handleInvalidToolExecution(ctx, toolAction, error);
    }
    this.debugRecorder.record({
      kind: 'planner_tool',
      command: `${toolAction.tool_name} ${JSON.stringify(toolAction.args)}`,
      toolName: toolAction.tool_name,
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
    appendToolBatchExchange(this.messages, ctx.batchOutcomes, ctx.providerResponse.reasoningText || '');
    appendSpan?.end({ afterMessageCount: this.messages.length });
    if (ctx.batchDuplicateAnchorIndex !== null && ctx.batchOutcomes.length > 0) {
      this.transcriptState.duplicateReplayToolMessageIndex = preAppendMessagesLength + 1 + ctx.batchDuplicateAnchorIndex;
    }
    for (const userMessage of ctx.pendingModeChangeUserMessages) {
      this.messages.push({ role: 'user', content: userMessage });
    }
  }

  private buildAgentLoopToolResults(beforeToolResultCount: number): AgentLoopToolResult[] {
    return this.toolResults.slice(beforeToolResultCount).map((result, index): AgentLoopToolResult => ({
      callId: `call_${beforeToolResultCount + index + 1}`,
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
    return { outcome: 'continue', results: this.buildAgentLoopToolResults(beforeToolResultCount) };
  }
}


export async function invokePlannerMode(options: InvokePlannerModeOptions): Promise<StructuredModelDecision | null> {
  if (options.backend !== 'llama.cpp') {
    return null;
  }

  const promptBudget = getPlannerPromptBudget(options.config);
  if (promptBudget.plannerStopLineTokens <= 0) {
    return null;
  }

  const allowedTools: PlannerToolName[] = Array.isArray(options.allowedTools) && options.allowedTools.length > 0
    ? options.allowedTools
    : ['find_text', 'read_lines', 'json_filter'];
  const toolDefinitions = buildPlannerToolDefinitions(allowedTools);
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
  const actionAdapter = new SummaryPlannerActionAdapter(runtime);
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
