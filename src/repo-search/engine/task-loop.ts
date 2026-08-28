import {
  SIFT_DEFAULT_LLAMA_REASONING_BUDGET_MESSAGE,
  getActiveModelPreset,
  getConfiguredLlamaNumCtx,
} from '../../config/index.js';
import { AgentLoop } from '../../agent-loop/agent-loop.js';
import type {
  AgentLoopAction,
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
  TurnPromptTokens,
} from '../../agent-loop/types.js';
import { NativePlannerResponseError, NativePlannerToolCallError } from '../../planner-protocol/native-actions.js';
import type { LlamaCppToolDefinition, NormalizedLlamaCppChatResponse } from '../../llm-protocol/types.js';
import { toProtocolTools } from '../../providers/llama-cpp.js';
import { buildIgnorePolicy, type IgnorePolicy } from '../command-safety.js';
import {
  PLANNER_REASONING_BUDGET_MESSAGE,
  captureExecutingPlannerRequest,
  requestApprovalVerdict as requestApprovalVerdictRequest,
  requestRepoSearchPlannerProtocolAction,
  serializeProtocolMessages,
  toProtocolChatMessages,
  type CompactionCacheOrigin,
  type ExecutingPlannerRequest,
  type ChatMessage,
  type PlannerActionResponse,
  type PlannerThinkingFlags,
} from '../planner-protocol.js';
import type { PlannerToolDefinition } from '../../planner-protocol/json-schema.js';
import {
  RepoSearchActionAdapter,
  RepoSearchPlannerModelClient,
  RepoSearchPromptAdapter,
  RepoSearchResultAssembler,
  RepoSearchToolAdapter,
} from '../agent-loop-adapter.js';
import {
  buildTaskInitialUserPrompt,
  buildTaskSystemPrompt,
  type TaskCommand,
} from '../prompts.js';
import { evaluateFinishAttempt } from '../../tool-loop-governor.js';
import {
  CHAT_GROUNDING_FINAL_ANSWER_INSTRUCTION,
  ChatGroundingPolicy,
} from '../chat-grounding-policy.js';
import { WebResearchTools } from '../../web-search/web-research-tools.js';
import { throwIfAborted } from '../../lib/abort.js';
import { SilentProgressWriter } from '../../lib/progress-writer.js';
import { DuplicateTracker } from './duplicate-tracker.js';
import { FINISH_VERIFICATION_MAX_CHALLENGES, FinishVerificationGate } from './finish-verification.js';
import { ForcedFinishController } from './forced-finish.js';
import { ProgressReporter } from './progress-reporter.js';
import { PromptPreparer } from './prompt-preparer.js';
import { ReadWindowGovernor } from './read-window-governor.js';
import {
  allocateLlamaCppSlotId,
  buildAssistantReplayMessage,
  buildWebToolsForTaskLoop,
  DEFAULT_MAX_INVALID_RESPONSES,
  DEFAULT_TIMEOUT_MS,
  isPlannerMaintainPerStepThinkingEnabled,
  resolvePlannerThinkingFlags,
  type LoopCounters,
  MIN_TOOL_CALLS_BEFORE_FINISH,
  type RunTaskLoopOptions,
  type TaskDefinition,
  type TaskResult,
  type TurnOutcome,
} from './task-loop-support.js';
import { TerminalSynthesizer } from './terminal-synthesizer.js';
import { ToolActionProcessor } from './tool-action-processor.js';
import { ToolResultBudgeter } from './tool-result-budgeter.js';
import { TokenUsageTracker, type ResolvedResponseTokens } from './token-usage.js';
import { ToolStatsRecorder } from './tool-stats.js';
import { TranscriptManager } from './transcript-manager.js';
import { TranscriptCompactor } from './transcript-compactor.js';
import { DEFAULT_MAX_TURNS, TurnBudget } from './turn-budget.js';
import { ThinkingRetentionPolicy } from '../../thinking-retention-policy.js';
import { resolveImageTokenBudget } from '../../llm-protocol/image-token-budget.js';
import type { ImageTokenBudget } from '@siftkit/contracts';
import type { ApprovalRequester } from './approval-gate.js';
import { LlmApprovalGate } from './llm-approval-gate.js';
import type { RepoSearchLoopKind } from '../task-kind.js';

export {
  DEFAULT_MAX_INVALID_RESPONSES,
  DEFAULT_TIMEOUT_MS,
  type RunTaskLoopOptions,
  type TaskDefinition,
  type TaskResult,
} from './task-loop-support.js';
export { DEFAULT_MAX_TURNS } from './turn-budget.js';

type RepoSearchModelData = AgentLoopModelData & {
  kind: 'repo-search';
  plannerResponse: PlannerActionResponse;
  resolvedTokens: ResolvedResponseTokens;
};

function isRepoSearchModelData(data: AgentLoopModelData | null): data is RepoSearchModelData {
  return data?.kind === 'repo-search';
}

function getRepoSearchModelData(context: AgentLoopResponseContext): RepoSearchModelData {
  const data = context.modelData;
  if (!isRepoSearchModelData(data)) {
    throw new Error('Repo-search AgentLoop context is missing planner response data.');
  }
  return data;
}

export function enforceToolCallLimit(
  actions: AgentLoopAction[],
  completedToolCalls: number,
  toolCallLimit: number,
): AgentLoopAction[] {
  const requestedToolCalls = actions.filter((action) => action.kind === 'tool').length;
  const remainingToolCalls = toolCallLimit - completedToolCalls;
  if (requestedToolCalls > remainingToolCalls) {
    throw new NativePlannerResponseError(
      `Planner requested ${requestedToolCalls} tool calls with ${Math.max(remainingToolCalls, 0)} remaining. Finish now.`,
    );
  }
  return actions;
}

// ---------------------------------------------------------------------------
// Task loop orchestrator
// ---------------------------------------------------------------------------

export class TaskLoop {
  private readonly task: TaskDefinition;
  private readonly options: RunTaskLoopOptions;
  private readonly taskStartedAt: number;
  private readonly maxTurns: number;
  private readonly toolCallLimit: number;
  private readonly maxInvalidResponses: number;
  private readonly webTools: WebResearchTools;
  private readonly tokenUsage: TokenUsageTracker;
  private readonly toolStats: ToolStatsRecorder;
  private readonly minToolCallsBeforeFinish: number;
  private readonly budget: TurnBudget;
  private readonly useEstimatedTokensOnly: boolean;
  private readonly plannerThinking: PlannerThinkingFlags;
  private readonly plannerMaintainPerStepThinking: boolean;
  private readonly loopKind: RepoSearchLoopKind;
  private readonly streamFinishAsAnswer: boolean;
  private readonly plannerBudgetMessageOverride: string | null;
  private readonly plannerToolDefinitions: readonly PlannerToolDefinition[];
  private readonly plannerProtocolTools: readonly LlamaCppToolDefinition[];
  private readonly allowedPlannerToolNames: string[];
  private readonly chatWebGroundingEnabled: boolean;
  private readonly chatWebGroundingPolicy: ChatGroundingPolicy;
  private readonly slotId: number;
  private readonly ignorePolicy: IgnorePolicy;
  private readonly successfulToolCalls: Array<{ toolName: string; promptResultText: string }> = [];
  private readonly mutatedPaths = new Set<string>();
  private readonly duplicates = new DuplicateTracker();
  private readonly forcedFinish = new ForcedFinishController();
  private readonly finishVerification: FinishVerificationGate;
  private readonly readWindows = new ReadWindowGovernor();
  private readonly visionEnabled: boolean;
  private readonly visionImageRetention: number;
  private readonly visionMaxImagePixels: number;
  private readonly imageTokenBudget: ImageTokenBudget;
  private readonly liveImagePathKeys = new Set<string>();
  private readonly progress: ProgressReporter;
  private readonly transcript: TranscriptManager;
  private readonly promptPreparer: PromptPreparer;
  private readonly toolActions: ToolActionProcessor;

  private readonly commands: TaskCommand[] = [];
  private readonly turnThinking: Record<number, string> = {};
  private readonly counters: LoopCounters = {
    invalidResponses: 0,
    rejectedCalls: 0,
    nonZeroExits: 0,
    safetyRejects: 0,
    reason: 'max_turns',
  };
  private finalOutput = '';
  private lastCompactionSummary = '';
  private turnsUsed = 0;
  private mockResponseIndex = 0;
  private executingPlannerRequest: ExecutingPlannerRequest | null = null;

  constructor(task: TaskDefinition, options: RunTaskLoopOptions) {
    this.task = task;
    this.options = options;
    const activePreset = getActiveModelPreset(options.config);
    this.visionEnabled = activePreset.VisionEnabled === true;
    this.visionImageRetention = activePreset.VisionImageRetention;
    this.visionMaxImagePixels = activePreset.VisionMaxImagePixels;
    this.imageTokenBudget = resolveImageTokenBudget(activePreset);
    this.taskStartedAt = Date.now();
    this.maxTurns = Math.max(1, Number(options.maxTurns || DEFAULT_MAX_TURNS));
    this.toolCallLimit = this.maxTurns;
    this.maxInvalidResponses = Math.max(1, Number(options.maxInvalidResponses || DEFAULT_MAX_INVALID_RESPONSES));
    this.webTools = buildWebToolsForTaskLoop(options.config);
    this.useEstimatedTokensOnly = Array.isArray(options.mockResponses);
    this.tokenUsage = new TokenUsageTracker(options.config, this.useEstimatedTokensOnly);
    this.toolStats = new ToolStatsRecorder();
    this.minToolCallsBeforeFinish = Math.max(0, Number(options.minToolCallsBeforeFinish ?? MIN_TOOL_CALLS_BEFORE_FINISH));
    this.budget = new TurnBudget({
      totalContextTokens: Math.max(1, Number(options.totalContextTokens || (options.config ? getConfiguredLlamaNumCtx(options.config) : 32000))),
      maxTurns: this.maxTurns,
      config: options.config,
    });
    this.plannerThinking = resolvePlannerThinkingFlags(options.config, options.thinkingEnabledOverride);
    this.plannerMaintainPerStepThinking = this.plannerThinking.thinkingEnabled
      ? isPlannerMaintainPerStepThinkingEnabled(options.config)
      : true;
    this.loopKind = options.runtimeProfile.loopKind;
    this.finishVerification = new FinishVerificationGate(this.loopKind === 'repo-agent');
    this.streamFinishAsAnswer = options.streamFinishAsAnswer === true;
    // A preset message that differs from the stock default is a deliberate user
    // choice and outranks the planner wording; chat answers the user directly,
    // so the answer-oriented preset/default message is already right there.
    const presetBudgetMessageCustomized = Boolean(activePreset.ReasoningBudgetMessage)
      && activePreset.ReasoningBudgetMessage !== SIFT_DEFAULT_LLAMA_REASONING_BUDGET_MESSAGE;
    this.plannerBudgetMessageOverride = this.loopKind === 'chat' || presetBudgetMessageCustomized
      ? null
      : PLANNER_REASONING_BUDGET_MESSAGE;
    if (this.loopKind !== 'chat'
      && activePreset.Backend === 'llama'
      && Number.isFinite(activePreset.ReasoningBudget)
      && activePreset.ReasoningBudget > 0) {
      // llama enforces the budget server-side with a launch-time message, so the
      // planner wording cannot apply there; surface the gap instead of hiding it.
      options.logger?.write({
        kind: 'planner_budget_backend_gap',
        taskId: task.id,
        warningText: 'llama backend injects the preset ReasoningBudgetMessage server-side on budget exhaustion; '
          + 'the planner action budget message cannot apply, so the model may still read it as "finish now".',
      });
    }
    this.plannerToolDefinitions = options.plannerToolDefinitions;
    this.plannerProtocolTools = toProtocolTools(this.plannerToolDefinitions);
    const activePlannerToolNames = this.plannerToolDefinitions.map((toolDefinition) => toolDefinition.function.name);
    this.allowedPlannerToolNames = activePlannerToolNames;
    this.chatWebGroundingEnabled = this.loopKind === 'chat'
      && this.allowedPlannerToolNames.includes('web_search')
      && this.allowedPlannerToolNames.includes('web_fetch');
    this.chatWebGroundingPolicy = new ChatGroundingPolicy({
      enabled: this.chatWebGroundingEnabled,
      retainedWebToolCalls: options.retainedWebToolCalls,
    });
    this.slotId = options.config ? allocateLlamaCppSlotId(options.config) : 0;
    this.ignorePolicy = buildIgnorePolicy(options.repoRoot);

    const baseSystemPrompt = typeof options.systemPromptOverride === 'string' && options.systemPromptOverride.trim()
      ? options.systemPromptOverride.trim()
      : buildTaskSystemPrompt(options.systemContext, this.plannerToolDefinitions);
    const systemPromptContent = this.chatWebGroundingEnabled
      ? `${baseSystemPrompt}\n\n${CHAT_GROUNDING_FINAL_ANSWER_INSTRUCTION}`
      : baseSystemPrompt;
    this.progress = new ProgressReporter({
      progressWriter: options.progressWriter ?? new SilentProgressWriter(),
      taskId: task.id,
      maxTurns: this.maxTurns,
      toolCallLimit: this.toolCallLimit,
      taskStartedAt: this.taskStartedAt,
    });
    this.transcript = new TranscriptManager({
      systemPromptContent,
      historyMessages: options.historyMessages || [],
      initialUserContent: this.loopKind === 'chat'
        ? task.question
        : buildTaskInitialUserPrompt(task.question),
      initialUserImages: options.initialUserImages || [],
      liveImagePathKeys: this.liveImagePathKeys,
    });
    this.promptPreparer = new PromptPreparer({
      taskId: task.id,
      model: String(options.model || ''),
      config: options.config,
      useEstimatedTokensOnly: this.useEstimatedTokensOnly,
      budget: this.budget,
      plannerTools: this.plannerProtocolTools,
      thinking: this.plannerThinking,
      transcript: this.transcript,
      runtimeProfile: options.runtimeProfile,
      compactor: new TranscriptCompactor({
        config: options.config,
        baseUrl: options.baseUrl,
        model: String(options.model || ''),
        timeoutMs: options.timeoutMs || DEFAULT_TIMEOUT_MS,
        totalContextTokens: this.budget.totalContextTokens,
        responseReserveTokens: this.budget.responseReserveTokens,
        useEstimatedTokensOnly: this.useEstimatedTokensOnly,
        mockResponses: options.mockResponses,
        tokenUsage: this.tokenUsage,
        logger: options.logger || null,
        abortSignal: options.abortSignal,
      }),
      progress: this.progress,
      logger: options.logger || null,
      timingRecorder: options.timingRecorder || null,
    });
    this.toolActions = this.buildToolActionProcessor(task, options);
  }

  private buildToolActionProcessor(task: TaskDefinition, options: RunTaskLoopOptions): ToolActionProcessor {
    return new ToolActionProcessor({
      task,
      repoRoot: options.repoRoot,
      config: options.config,
      mockCommandResults: options.mockCommandResults,
      abortSignal: options.abortSignal,
      logger: options.logger || null,
      timingRecorder: options.timingRecorder || null,
      maxInvalidResponses: this.maxInvalidResponses,
      allowedPlannerToolNames: this.allowedPlannerToolNames,
      approvalGate: this.buildApprovalRequester(options),
      runtimeProfile: options.runtimeProfile,
      chatWebGroundingEnabled: this.chatWebGroundingEnabled,
      chatWebGroundingPolicy: this.chatWebGroundingPolicy,
      ignorePolicy: this.ignorePolicy,
      webTools: this.webTools,
      budget: this.budget,
      tokenUsage: this.tokenUsage,
      toolStats: this.toolStats,
      duplicates: this.duplicates,
      forcedFinish: this.forcedFinish,
      resultBudgeter: new ToolResultBudgeter({
        config: options.config,
        useEstimatedTokensOnly: this.useEstimatedTokensOnly,
        timingRecorder: options.timingRecorder || null,
      }),
      readWindows: this.readWindows,
      maintainPerStepThinking: this.plannerMaintainPerStepThinking,
      progress: this.progress,
      transcript: this.transcript,
      recentEvidenceKeys: new Set<string>(),
      mutatedPaths: this.mutatedPaths,
      successfulToolCalls: this.successfulToolCalls,
      commands: this.commands,
      counters: this.counters,
      visionEnabled: this.visionEnabled,
      visionImageRetention: this.visionImageRetention,
      visionMaxImagePixels: this.visionMaxImagePixels,
      imageTokenBudget: this.imageTokenBudget,
      liveImagePathKeys: this.liveImagePathKeys,
    });
  }

  private buildApprovalRequester(options: RunTaskLoopOptions): ApprovalRequester | null {
    if (options.approvalMode !== 'auto') {
      return options.approvalGate ?? null;
    }
    if (!options.approvalGate) {
      throw new Error('approvalMode "auto" requires an approvalGate for escalation.');
    }
    return new LlmApprovalGate({
      requestId: options.approvalGate.getRequestId(),
      humanGate: options.approvalGate,
      verdictRequester: this,
      progressWriter: options.progressWriter ?? new SilentProgressWriter(),
      logger: options.logger ?? null,
    });
  }

  /**
   * Ephemeral verdict call: executing planner prompt, pending assistant tool call, then one user
   * question, never appended to the transcript. The request layer verifies the prompt byte-extends
   * the executing planner request and throws otherwise.
   */
  async requestApprovalVerdict(
    question: string,
    pendingMessages: ChatMessage[],
  ): Promise<PlannerActionResponse> {
    const executing = this.executingPlannerRequest;
    if (!executing) {
      throw new Error('approval_verdict requested before any planner request; there is no executing prompt to extend.');
    }
    const response = await requestApprovalVerdictRequest({
      config: this.options.config,
      baseUrl: this.options.baseUrl,
      model: this.options.model,
      transcriptMessages: this.transcript.getMessages(),
      pendingMessages,
      question,
      executing,
      timeoutMs: this.options.timeoutMs || DEFAULT_TIMEOUT_MS,
      mockResponses: this.options.mockResponses,
      mockResponseIndex: this.mockResponseIndex,
      abortSignal: this.options.abortSignal,
      logger: this.options.logger || null,
    });
    if (typeof response.nextMockResponseIndex === 'number') {
      this.mockResponseIndex = response.nextMockResponseIndex;
    }
    return response;
  }

  async run(): Promise<TaskResult> {
    const promptAdapter = new RepoSearchPromptAdapter(this);
    const actionAdapter = new RepoSearchActionAdapter(this.plannerToolDefinitions, this);
    const toolAdapter = new RepoSearchToolAdapter(this);
    await new AgentLoop({
      maxTurns: this.maxTurns,
      promptAdapter,
      actionAdapter,
      toolAdapter,
      modelClient: new RepoSearchPlannerModelClient(this),
    }).run();
    return new RepoSearchResultAssembler(this).assemble();
  }

  async prepareTurn(turn: number): Promise<AgentLoopPreparedTurn> {
    throwIfAborted(this.options.abortSignal);
    this.turnsUsed = turn;
    const inForcedFinishMode = this.forcedFinish.isActive();

    const cacheOrigin: CompactionCacheOrigin = this.executingPlannerRequest
      ? { kind: 'planner', executing: this.executingPlannerRequest }
      : {
          kind: 'new_epoch',
          flags: this.plannerThinking,
          tools: this.plannerProtocolTools,
          slotId: this.slotId,
        };
    const prepared = await this.promptPreparer.prepareTurn(
      turn,
      this.mockResponseIndex,
      cacheOrigin,
    );
    this.mockResponseIndex = prepared.nextMockResponseIndex;
    if (prepared.compactionSummary !== null) {
      this.lastCompactionSummary = prepared.compactionSummary;
    }

    this.options.logger?.write({ kind: 'turn_model_request', taskId: this.task.id, turn, thinkingEnabled: this.plannerThinking.thinkingEnabled });
    this.progress.llmStart(turn, prepared.promptTokens.reported, this.tokenUsage.snapshot().thinkingTokens);
    const newMessages = this.transcript.takeNewMessagesForLogging();
    this.options.logger?.write({ kind: 'turn_new_messages', taskId: this.task.id, turn, messages: newMessages, promptTokenCount: prepared.promptTokens.reported });

    return {
      outcome: 'continue',
      turnNumber: turn,
      promptTokens: prepared.promptTokens,
      maxOutputTokens: prepared.maxOutputTokens,
      messages: toProtocolChatMessages(this.transcript.getMessages()),
      toolDefinitions: [...this.plannerProtocolTools],
      inForcedFinishMode,
    };
  }

  async requestModelResponse(prepared: AgentLoopPreparedTurn): Promise<AgentLoopModelResponse> {
    const turn = prepared.turnNumber;
    const response = await this.requestPlanner(turn, prepared);

    if (typeof response.nextMockResponseIndex === 'number') {
      this.mockResponseIndex = response.nextMockResponseIndex;
    }

    const resolvedTokens = await this.tokenUsage.recordModelResponse(response, prepared.promptTokens.reported);
    // Emitted after the response is tallied so the line closing a turn already counts that turn's thinking.
    this.progress.llmEnd(turn, prepared.promptTokens.reported, this.tokenUsage.snapshot().thinkingTokens);

    this.options.logger?.write({
      kind: 'turn_model_response', taskId: this.task.id, turn,
      text: response.text, thinkingText: response.thinkingText || '',
      mockExhausted: Boolean(response.mockExhausted),
      promptTokens: prepared.promptTokens.reported,
      completionTokens: resolvedTokens.completionTokens,
      completionTokensEstimated: resolvedTokens.completionTokensEstimated,
      thinkingTokens: resolvedTokens.thinkingTokens,
      thinkingTokensEstimated: resolvedTokens.thinkingTokensEstimated,
      promptCacheTokens: Number.isFinite(response.promptCacheTokens) ? Number(response.promptCacheTokens) : null,
      promptEvalTokens: Number.isFinite(response.promptEvalTokens) ? Number(response.promptEvalTokens) : null,
      ...(response.thinkingBudgetExhausted ? { thinkingBudgetExhausted: true } : {}),
    });

    const turnThinkingText = String(response.thinkingText || '').trim();
    if (turnThinkingText) {
      new ThinkingRetentionPolicy(this.plannerMaintainPerStepThinking)
        .recordTurnThinking(this.turnThinking, turn, turnThinkingText);
    }

    // Emit native thinking text (from reasoning_content) to UI
    if (response.thinkingText && this.progress.liveTextEnabled) {
      this.progress.thinking(turn, response.thinkingText);
    }

    const data: RepoSearchModelData = {
      kind: 'repo-search',
      plannerResponse: response,
      resolvedTokens,
    };
    return {
      outcome: 'continue',
      response: this.toNormalizedResponse(response, resolvedTokens, prepared.promptTokens.reported),
      data,
    };
  }

  inspectModelResponse(context: AgentLoopResponseContext): 'continue' | 'stop' | null {
    if (getRepoSearchModelData(context).plannerResponse.mockExhausted) {
      this.counters.reason = 'mock_responses_exhausted';
      return 'stop';
    }
    const narration = context.response.text.trim();
    if (narration && context.response.toolCalls.length > 0) {
      this.options.logger?.write({
        kind: 'turn_progress',
        taskId: this.task.id,
        turn: context.turnNumber,
        text: narration,
      });
    }
    return null;
  }

  async handleInvalidResponse(context: AgentLoopResponseContext & { error: Error }): Promise<AgentLoopInvalidResponseResult> {
    const turn = context.turnNumber;
    const data = getRepoSearchModelData(context);
    this.handleInvalidParse(turn, data.plannerResponse, context.error, data.resolvedTokens);
    return { outcome: this.counters.reason === 'invalid_response_limit' ? 'stop' : 'continue' };
  }

  async evaluateFinish(action: AgentLoopFinishAction, context: AgentLoopResponseContext): Promise<AgentLoopFinishEvaluation> {
    const data = getRepoSearchModelData(context);
    const outcome = this.handleFinishAction(
      context.turnNumber,
      action,
      data.plannerResponse,
      data.resolvedTokens,
    );
    return {
      accepted: outcome === 'stop' && this.counters.reason === 'finish',
      outcome,
      finishText: this.finalOutput,
    };
  }

  validateActions(actions: AgentLoopAction[]): AgentLoopAction[] {
    return enforceToolCallLimit(actions, this.commands.length, this.toolCallLimit);
  }

  async executeTools(actions: readonly AgentLoopToolAction[], context: AgentLoopResponseContext): Promise<AgentLoopToolExecution> {
    this.finishVerification.recordNonFinishAction();
    const beforeCommandCount = this.commands.length;
    const response = getRepoSearchModelData(context).plannerResponse;
    const outcome = await this.toolActions.executeBatch(
      context.turnNumber,
      actions,
      String(response.thinkingText || '').trim(),
      context.preparedTurn.promptTokens,
      context.preparedTurn.inForcedFinishMode,
      response.text,
    );
    const newCommands = this.commands.slice(beforeCommandCount);
    return {
      outcome,
      results: newCommands.map((command, index): AgentLoopToolResult => {
        const sourceAction = actions[index];
        if (!sourceAction) {
          throw new Error(`Repo-search produced ${newCommands.length} command results for ${actions.length} tool actions.`);
        }
        return {
          callId: sourceAction.callId,
          toolName: sourceAction.toolName,
          args: sourceAction.args,
          text: String(command.promptOutput ?? command.output ?? ''),
          raw: {
            command: command.command,
            exitCode: command.exitCode,
            safe: command.safe,
          },
        };
      }),
    };
  }

  private toNormalizedResponse(
    response: PlannerActionResponse,
    resolvedTokens: ResolvedResponseTokens,
    promptTokenCount: number,
  ): NormalizedLlamaCppChatResponse {
    return {
      text: response.text,
      rawText: response.rawText,
      narrationText: response.narrationText,
      classification: response.classification,
      reasoningText: response.thinkingText || '',
      toolCalls: response.toolCalls,
      usage: {
        promptTokens: promptTokenCount,
        completionTokens: resolvedTokens.completionTokens,
        totalTokens: null,
        outputTokens: resolvedTokens.completionTokens,
        thinkingTokens: resolvedTokens.thinkingTokens,
        promptCacheTokens: response.promptCacheTokens ?? null,
        promptEvalTokens: response.promptEvalTokens ?? null,
        promptEvalDurationMs: response.promptEvalDurationMs ?? null,
        generationDurationMs: response.generationDurationMs ?? null,
        speculativeAcceptedTokens: response.speculativeAcceptedTokens ?? null,
        speculativeGeneratedTokens: response.speculativeGeneratedTokens ?? null,
      },
      raw: {
        text: response.text,
        thinkingText: response.thinkingText,
        mockExhausted: response.mockExhausted,
        nextMockResponseIndex: response.nextMockResponseIndex ?? null,
      },
      stoppedEarly: false,
      invalidFrameCount: 0,
    };
  }

  private async requestPlanner(turn: number, prepared: { promptTokens: TurnPromptTokens; maxOutputTokens: number }): Promise<PlannerActionResponse> {
    const providerSpan = this.options.timingRecorder?.start('repo.llama.request', {
      taskId: this.task.id,
      turn,
      promptTokenCount: prepared.promptTokens.reported,
      maxOutputTokens: prepared.maxOutputTokens,
      mock: Array.isArray(this.options.mockResponses),
    });
    try {
      // One serialization: the snapshot and the request share the same array, so
      // the verdict guard proves an extension of the bytes actually sent.
      const serializedMessages = serializeProtocolMessages(
        this.transcript.getMessages(),
        this.plannerThinking.reasoningContentEnabled,
      );
      this.executingPlannerRequest = captureExecutingPlannerRequest(
        serializedMessages,
        this.plannerThinking,
        this.plannerProtocolTools,
        this.slotId,
      );
      return await requestRepoSearchPlannerProtocolAction({
        config: this.options.config,
        baseUrl: this.options.baseUrl,
        model: this.options.model,
        messages: serializedMessages,
        slotId: this.slotId,
        timeoutMs: this.options.timeoutMs || DEFAULT_TIMEOUT_MS,
        maxTokens: prepared.maxOutputTokens,
        ...this.plannerThinking,
        ...(this.plannerBudgetMessageOverride === null
          ? {}
          : { reasoningBudgetMessage: this.plannerBudgetMessageOverride }),
        onThinkingDelta: this.progress.liveTextEnabled
          ? (accThinking) => { this.progress.thinking(turn, accThinking); }
          : undefined,
    onContentDelta: this.progress.liveTextEnabled
      ? (snapshot) => {
        if (snapshot.rawText) this.progress.progressUpdate(turn, snapshot.rawText);
        if (snapshot.classification === 'narration' && snapshot.narrationText) {
          this.progress.narration(turn, snapshot.narrationText);
        }
      }
      : undefined,
        mockResponses: this.options.mockResponses,
        mockResponseIndex: this.mockResponseIndex,
        abortSignal: this.options.abortSignal,
        logger: this.options.logger || null,
        stage: 'planner_action',
        tools: this.plannerProtocolTools,
        responseSchema: null,
      });
    } finally {
      providerSpan?.end();
    }
  }

  private handleInvalidParse(turn: number, response: PlannerActionResponse, error: Error, resolvedTokens: ResolvedResponseTokens): TurnOutcome {
    this.tokenUsage.addOutputTokens(resolvedTokens.completionTokens, resolvedTokens.completionTokensEstimated);
    this.counters.invalidResponses += 1;
    const invalidActionMessage = error instanceof NativePlannerToolCallError
      ? error.message
      : `Previous response was invalid: ${error.message} Return content to finish or call one of the provided tools with valid arguments.`;
    const invalidToolAction = error instanceof NativePlannerToolCallError
      ? { toolName: error.toolName, args: error.args }
      : null;
    if (error instanceof NativePlannerToolCallError) {
      this.transcript.appendToolExchange(
        { toolName: error.toolName, args: error.args },
        error.callId,
        invalidActionMessage,
        String(response.thinkingText || '').trim(),
      );
    } else {
      this.transcript.pushAssistant(buildAssistantReplayMessage(
        response.text,
        String(response.thinkingText || '').trim(),
      ));
      this.transcript.pushUser(invalidActionMessage);
    }
    this.transcript.pruneThinking(this.plannerMaintainPerStepThinking);
    this.options.logger?.write({
      kind: 'turn_action_invalid',
      taskId: this.task.id,
      turn,
      invalidResponses: this.counters.invalidResponses,
      error: error instanceof Error ? error.message : String(error),
      toolAction: invalidToolAction,
      toolResultText: invalidActionMessage,
    });
    if (this.counters.invalidResponses >= this.maxInvalidResponses) {
      this.counters.reason = 'invalid_response_limit';
      return 'stop';
    }
    return 'continue';
  }

  /** Replays the finish back into the transcript with a rejection message so the loop continues. */
  private rejectFinish(response: PlannerActionResponse, message: string): void {
    this.toolStats.recordFinishRejection();
    this.transcript.pushAssistant(buildAssistantReplayMessage(response.text, String(response.thinkingText || '').trim()));
    this.transcript.pruneThinking(this.plannerMaintainPerStepThinking);
    this.transcript.pushUser(message);
  }

  private handleFinishAction(turn: number, action: AgentLoopFinishAction, response: PlannerActionResponse, resolvedTokens: ResolvedResponseTokens): TurnOutcome {
    this.tokenUsage.addOutputTokens(resolvedTokens.completionTokens, resolvedTokens.completionTokensEstimated);
    const finishEvaluation = evaluateFinishAttempt({
      loopKind: this.loopKind,
      finalOutput: action.text,
      successfulToolCalls: this.successfulToolCalls,
    });
    if (!finishEvaluation.allowed) {
      const warning = finishEvaluation.warning || 'Need stronger repository evidence before finishing.';
      this.rejectFinish(response, warning);
      this.options.logger?.write({ kind: 'turn_finish_rejected', taskId: this.task.id, turn, toolCallTurns: this.commands.length, minToolCallsBeforeFinish: this.minToolCallsBeforeFinish, warning });
      return 'continue';
    }
    const groundingDecision = this.chatWebGroundingPolicy.evaluateFinish();
    if (groundingDecision.kind === 'reject') {
      this.rejectFinish(response, groundingDecision.message);
      this.options.logger?.write({
        kind: 'chat_grounding_finish_rejected',
        taskId: this.task.id,
        turn,
        status: this.chatWebGroundingPolicy.getStatus(),
      });
      return 'continue';
    }
    if (!this.forcedFinish.isActive()) {
      const verification = this.finishVerification.evaluateFinish();
      if (verification.kind === 'challenge') {
        this.rejectFinish(response, verification.message);
        this.options.logger?.write({
          kind: 'turn_finish_challenged',
          taskId: this.task.id,
          turn,
          challengesIssued: verification.challengesIssued,
          maxChallenges: FINISH_VERIFICATION_MAX_CHALLENGES,
        });
        return 'continue';
      }
      if (verification.mode) {
        this.options.logger?.write({
          kind: 'turn_finish_verified',
          taskId: this.task.id,
          turn,
          mode: verification.mode,
        });
      }
    }
    this.finalOutput = action.text;
    if (this.streamFinishAsAnswer && this.progress.liveTextEnabled) {
      this.progress.answer(turn, this.finalOutput);
    }
    this.counters.reason = 'finish';
    return 'stop';
  }

  async buildAgentLoopResult(): Promise<TaskResult> {
    // Terminal synthesis if no final output — retry up to 3 times then hard-fail.
    if (!String(this.finalOutput || '').trim()) {
      const synthesizer = new TerminalSynthesizer({
        baseUrl: this.options.baseUrl,
        model: this.options.model,
        timeoutMs: this.options.timeoutMs || DEFAULT_TIMEOUT_MS,
        config: this.options.config,
        useEstimatedTokensOnly: this.useEstimatedTokensOnly,
        totalContextTokens: this.budget.totalContextTokens,
        streamFinishAsAnswer: this.streamFinishAsAnswer,
        logger: this.options.logger || null,
        progress: this.progress,
        tokenUsage: this.tokenUsage,
      });
      const executing = this.executingPlannerRequest;
      if (!executing) {
        throw new Error('terminal_synthesis requires an executing planner prompt-cache prefix');
      }
      const synthesis = await synthesizer.synthesize({
        taskId: this.task.id,
        reason: this.counters.reason,
        messages: this.transcript.getMessages(),
        executing,
        turnsUsed: this.turnsUsed,
        mockResponses: this.options.mockResponses,
        mockResponseIndex: this.mockResponseIndex,
      });
      this.finalOutput = synthesis.finalOutput;
      this.mockResponseIndex = synthesis.nextMockResponseIndex;
    }

    this.options.logger?.write({
      kind: 'task_done', taskId: this.task.id, reason: this.counters.reason, turnsUsed: this.turnsUsed, safetyRejects: this.counters.safetyRejects,
      invalidResponses: this.counters.invalidResponses, rejectedCalls: this.counters.rejectedCalls, nonZeroExits: this.counters.nonZeroExits,
      finishChallenges: this.finishVerification.issuedCount,
    });

    return {
      id: this.task.id, question: this.task.question, reason: this.counters.reason, turnsUsed: this.turnsUsed, safetyRejects: this.counters.safetyRejects,
      invalidResponses: this.counters.invalidResponses, rejectedCalls: this.counters.rejectedCalls, nonZeroExits: this.counters.nonZeroExits,
      finishChallenges: this.finishVerification.issuedCount,
      commands: this.commands, turnThinking: this.turnThinking, finalOutput: this.finalOutput,
      compactionSummary: this.lastCompactionSummary,
      mutatedPaths: [...this.mutatedPaths],
      ...(this.chatWebGroundingEnabled ? { groundingStatus: this.chatWebGroundingPolicy.getStatus() } : {}),
      ...this.tokenUsage.snapshot(),
      toolStats: this.toolStats.snapshot(),
      readOverlapSummary: this.readWindows.summary(),
    };
  }
}
