import { getActiveInferenceBackend, getConfiguredLlamaNumCtx } from '../../config/index.js';
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
import { JsonObjectSchema } from '../../lib/json-types.js';
import { toProtocolTools } from '../../providers/llama-cpp.js';
import { ModelJson } from '../../lib/model-json.js';
import { buildIgnorePolicy, type IgnorePolicy } from '../command-safety.js';
import {
  getRepoSearchToolNamesForParsing,
  requestRepoSearchPlannerProtocolAction,
  resolveRepoSearchPlannerToolDefinitions,
  toProtocolChatMessages,
  type FinishAction,
  type PlannerActionResponse,
  type ToolAction,
} from '../planner-protocol.js';
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
  scanRepoFiles,
  type TaskCommand,
} from '../prompts.js';
import { evaluateFinishAttempt } from '../../tool-loop-governor.js';
import {
  CHAT_GROUNDING_FINAL_ANSWER_INSTRUCTION,
  ChatGroundingPolicy,
} from '../chat-grounding-policy.js';
import { WebResearchTools } from '../../web-search/web-research-tools.js';
import { throwIfAborted } from './abort.js';
import { DuplicateTracker } from './duplicate-tracker.js';
import { ForcedFinishController } from './forced-finish.js';
import { ProgressReporter } from './progress-reporter.js';
import { PromptPreparer } from './prompt-preparer.js';
import { ReadWindowGovernor } from './read-window-governor.js';
import {
  allocateLlamaCppSlotId,
  buildAssistantReplayMessage,
  buildInvalidToolCallActionFromResponseText,
  buildWebToolsForTaskLoop,
  DEFAULT_MAX_INVALID_RESPONSES,
  DEFAULT_MAX_TURNS,
  DEFAULT_TIMEOUT_MS,
  evaluateTaskSignals,
  isPlannerPreserveThinkingEnabled,
  isPlannerMaintainPerStepThinkingEnabled,
  isPlannerReasoningContentEnabled,
  isPlannerReasoningEnabled,
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
import { TurnBudget } from './turn-budget.js';
import { ThinkingRetentionPolicy } from '../../thinking-retention-policy.js';

export {
  DEFAULT_MAX_INVALID_RESPONSES,
  DEFAULT_MAX_TURNS,
  DEFAULT_TIMEOUT_MS,
  evaluateTaskSignals,
  type RunTaskLoopOptions,
  type TaskDefinition,
  type TaskResult,
} from './task-loop-support.js';

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

// ---------------------------------------------------------------------------
// Task loop orchestrator
// ---------------------------------------------------------------------------

export class TaskLoop {
  private readonly task: TaskDefinition;
  private readonly options: RunTaskLoopOptions;
  private readonly taskStartedAt: number;
  private readonly maxTurns: number;
  private readonly maxInvalidResponses: number;
  private readonly webTools: WebResearchTools;
  private readonly tokenUsage: TokenUsageTracker;
  private readonly toolStats: ToolStatsRecorder;
  private readonly minToolCallsBeforeFinish: number;
  private readonly budget: TurnBudget;
  private readonly useEstimatedTokensOnly: boolean;
  private readonly plannerThinkingEnabled: boolean;
  private readonly plannerReasoningContentEnabled: boolean;
  private readonly plannerPreserveThinkingEnabled: boolean;
  private readonly plannerMaintainPerStepThinking: boolean;
  private readonly loopKind: 'repo-search' | 'chat';
  private readonly streamFinishAsAnswer: boolean;
  private readonly plannerToolDefinitions: ReturnType<typeof resolveRepoSearchPlannerToolDefinitions>;
  private readonly allowedPlannerToolNames: string[];
  private readonly chatWebGroundingEnabled: boolean;
  private readonly chatWebGroundingPolicy: ChatGroundingPolicy;
  private readonly slotId: number;
  private readonly ignorePolicy: IgnorePolicy;
  private readonly successfulToolCalls: Array<{ toolName: string; promptResultText: string }> = [];
  private readonly duplicates = new DuplicateTracker();
  private readonly forcedFinish = new ForcedFinishController();
  private readonly readWindows = new ReadWindowGovernor();
  private readonly progress: ProgressReporter;
  private readonly transcript: TranscriptManager;
  private readonly promptPreparer: PromptPreparer;
  private readonly toolActions: ToolActionProcessor;

  private readonly commands: TaskCommand[] = [];
  private readonly turnThinking: Record<number, string> = {};
  private readonly counters: LoopCounters = {
    invalidResponses: 0,
    commandFailures: 0,
    safetyRejects: 0,
    reason: 'max_turns',
  };
  private finalOutput = '';
  private turnsUsed = 0;
  private mockResponseIndex = 0;

  constructor(task: TaskDefinition, options: RunTaskLoopOptions) {
    this.task = task;
    this.options = options;
    this.taskStartedAt = Date.now();
    this.maxTurns = Math.max(1, Number(options.maxTurns || DEFAULT_MAX_TURNS));
    this.maxInvalidResponses = Math.max(1, Number(options.maxInvalidResponses || DEFAULT_MAX_INVALID_RESPONSES));
    this.webTools = buildWebToolsForTaskLoop(options.config);
    this.useEstimatedTokensOnly = Array.isArray(options.mockResponses);
    this.tokenUsage = new TokenUsageTracker(options.config, this.useEstimatedTokensOnly);
    this.toolStats = new ToolStatsRecorder();
    this.minToolCallsBeforeFinish = Math.max(0, Number(options.minToolCallsBeforeFinish ?? MIN_TOOL_CALLS_BEFORE_FINISH));
    this.budget = new TurnBudget({
      totalContextTokens: Math.max(1, Number(options.totalContextTokens || (options.config ? getConfiguredLlamaNumCtx(options.config) : 32000))),
      maxTurns: this.maxTurns,
    });
    this.plannerThinkingEnabled = typeof options.thinkingEnabledOverride === 'boolean'
      ? options.thinkingEnabledOverride
      : isPlannerReasoningEnabled(options.config);
    this.plannerReasoningContentEnabled = this.plannerThinkingEnabled && isPlannerReasoningContentEnabled(options.config);
    this.plannerPreserveThinkingEnabled = this.plannerReasoningContentEnabled && isPlannerPreserveThinkingEnabled(options.config);
    this.plannerMaintainPerStepThinking = this.plannerThinkingEnabled
      ? isPlannerMaintainPerStepThinkingEnabled(options.config)
      : true;
    this.loopKind = options.loopKind === 'chat' ? 'chat' : 'repo-search';
    this.streamFinishAsAnswer = options.streamFinishAsAnswer === true;
    this.plannerToolDefinitions = Array.isArray(options.plannerToolDefinitions)
      ? options.plannerToolDefinitions
      : resolveRepoSearchPlannerToolDefinitions();
    const activePlannerToolNames = this.plannerToolDefinitions.map((toolDefinition) => toolDefinition.function.name);
    this.allowedPlannerToolNames = this.loopKind === 'chat'
      ? activePlannerToolNames
      : Array.from(new Set<string>([
        ...activePlannerToolNames,
        ...getRepoSearchToolNamesForParsing(),
      ]));
    this.chatWebGroundingEnabled = this.loopKind === 'chat'
      && this.allowedPlannerToolNames.includes('web_search')
      && this.allowedPlannerToolNames.includes('web_fetch');
    this.chatWebGroundingPolicy = new ChatGroundingPolicy({
      enabled: this.chatWebGroundingEnabled,
      retainedWebToolCalls: options.retainedWebToolCalls,
    });
    this.slotId = options.config ? allocateLlamaCppSlotId(options.config) : 0;
    this.ignorePolicy = buildIgnorePolicy(options.repoRoot);
    const bootstrapFileListSpan = options.timingRecorder?.start('repo.bootstrap.file_listing', {
      taskId: task.id,
      enabled: options.includeRepoFileListing !== false,
    });
    const bootstrapFileList = options.includeRepoFileListing === false
      ? undefined
      : (scanRepoFiles(options.repoRoot, this.ignorePolicy) || undefined);
    bootstrapFileListSpan?.end({
      fileCount: Array.isArray(bootstrapFileList) ? bootstrapFileList.length : 0,
    });

    const baseSystemPrompt = typeof options.systemPromptOverride === 'string' && options.systemPromptOverride.trim()
      ? options.systemPromptOverride.trim()
      : buildTaskSystemPrompt(options.repoRoot, {
        includeAgentsMd: options.includeAgentsMd,
        includeRepoFileListing: options.includeRepoFileListing,
      });
    const systemPromptContent = this.chatWebGroundingEnabled
      ? `${baseSystemPrompt}\n\n${CHAT_GROUNDING_FINAL_ANSWER_INSTRUCTION}`
      : baseSystemPrompt;
    this.progress = new ProgressReporter({
      onProgress: options.onProgress || null,
      taskId: task.id,
      maxTurns: this.maxTurns,
      taskStartedAt: this.taskStartedAt,
    });
    this.transcript = new TranscriptManager({
      systemPromptContent,
      historyMessages: options.historyMessages || [],
      initialUserContent: this.loopKind === 'chat'
        ? task.question
        : buildTaskInitialUserPrompt(task.question, bootstrapFileList, {
          includeRepoFileListing: options.includeRepoFileListing,
        }),
    });
    this.promptPreparer = new PromptPreparer({
      taskId: task.id,
      model: String(options.model || ''),
      config: options.config,
      useEstimatedTokensOnly: this.useEstimatedTokensOnly,
      budget: this.budget,
      plannerToolDefinitions: this.plannerToolDefinitions,
      thinkingEnabled: this.plannerThinkingEnabled,
      reasoningContentEnabled: this.plannerReasoningContentEnabled,
      preserveThinking: this.plannerPreserveThinkingEnabled,
      transcript: this.transcript,
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
      successfulToolCalls: this.successfulToolCalls,
      commands: this.commands,
      counters: this.counters,
    });
  }

  async run(): Promise<TaskResult> {
    const promptAdapter = new RepoSearchPromptAdapter(this);
    const actionAdapter = new RepoSearchActionAdapter(this.allowedPlannerToolNames, this);
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

    const prepared = await this.promptPreparer.prepareTurn(turn);

    this.options.logger?.write({ kind: 'turn_model_request', taskId: this.task.id, turn, thinkingEnabled: this.plannerThinkingEnabled });
    this.progress.llmStart(turn, prepared.promptTokenCount);
    const newMessages = this.transcript.takeNewMessagesForLogging();
    this.options.logger?.write({ kind: 'turn_new_messages', taskId: this.task.id, turn, messages: newMessages, promptTokenCount: prepared.promptTokenCount });

    return {
      outcome: 'continue',
      turnNumber: turn,
      promptTokenCount: prepared.promptTokenCount,
      maxOutputTokens: prepared.maxOutputTokens,
      messages: toProtocolChatMessages(this.transcript.getMessages()),
      toolDefinitions: toProtocolTools(this.plannerToolDefinitions),
      inForcedFinishMode,
    };
  }

  async requestModelResponse(prepared: AgentLoopPreparedTurn): Promise<AgentLoopModelResponse> {
    const turn = prepared.turnNumber;
    const response = await this.requestPlanner(turn, prepared);

    this.progress.llmEnd(turn, prepared.promptTokenCount);
    if (typeof response.nextMockResponseIndex === 'number') {
      this.mockResponseIndex = response.nextMockResponseIndex;
    }

    this.options.logger?.write({
      kind: 'turn_model_response', taskId: this.task.id, turn,
      text: response.text, thinkingText: response.thinkingText || '',
      mockExhausted: Boolean(response.mockExhausted),
      promptTokens: Number.isFinite(response.promptTokens) ? Number(response.promptTokens) : null,
      completionTokens: Number.isFinite(response.completionTokens) ? Number(response.completionTokens) : null,
      usageThinkingTokens: Number.isFinite(response.usageThinkingTokens) ? Number(response.usageThinkingTokens) : null,
      promptCacheTokens: Number.isFinite(response.promptCacheTokens) ? Number(response.promptCacheTokens) : null,
      promptEvalTokens: Number.isFinite(response.promptEvalTokens) ? Number(response.promptEvalTokens) : null,
    });

    const turnThinkingText = String(response.thinkingText || '').trim();
    if (turnThinkingText) {
      new ThinkingRetentionPolicy(this.plannerMaintainPerStepThinking)
        .recordTurnThinking(this.turnThinking, turn, turnThinkingText);
    }

    const resolvedTokens = await this.tokenUsage.recordModelResponse(response);

    // Emit native thinking text (from reasoning_content) to UI
    if (response.thinkingText) {
      this.progress.thinking(turn, response.thinkingText);
    }

    const data: RepoSearchModelData = {
      kind: 'repo-search',
      plannerResponse: response,
      resolvedTokens,
    };
    return {
      outcome: 'continue',
      response: this.toNormalizedResponse(response),
      data,
    };
  }

  inspectModelResponse(context: AgentLoopResponseContext): 'continue' | 'stop' | null {
    if (getRepoSearchModelData(context).plannerResponse.mockExhausted) {
      this.counters.reason = 'mock_responses_exhausted';
      return 'stop';
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
      { action: 'finish', output: action.text },
      data.plannerResponse,
      data.resolvedTokens,
    );
    return {
      accepted: outcome === 'stop' && this.counters.reason === 'finish',
      outcome,
      finishText: this.finalOutput,
    };
  }

  async executeTools(actions: readonly AgentLoopToolAction[], context: AgentLoopResponseContext): Promise<AgentLoopToolExecution> {
    const beforeCommandCount = this.commands.length;
    const response = getRepoSearchModelData(context).plannerResponse;
    const toolActions: ToolAction[] = actions.map((action) => ({
      action: 'tool',
      tool_name: action.toolName,
      args: JsonObjectSchema.parse(action.args),
    }));
    const outcome = await this.toolActions.executeBatch(
      context.turnNumber,
      toolActions,
      String(response.thinkingText || '').trim(),
      context.preparedTurn.promptTokenCount,
      context.preparedTurn.inForcedFinishMode,
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
          callId: `call_${beforeCommandCount + index + 1}`,
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

  private toNormalizedResponse(response: PlannerActionResponse): NormalizedLlamaCppChatResponse {
    return {
      text: response.text,
      reasoningText: response.thinkingText || '',
      toolCalls: [],
      usage: {
        promptTokens: response.promptTokens ?? null,
        completionTokens: response.completionTokens ?? null,
        totalTokens: null,
        outputTokens: response.completionTokens ?? null,
        thinkingTokens: response.usageThinkingTokens ?? null,
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
    };
  }

  private async requestPlanner(turn: number, prepared: { promptTokenCount: number; maxOutputTokens: number }): Promise<PlannerActionResponse> {
    const providerSpan = this.options.timingRecorder?.start('repo.llama.request', {
      taskId: this.task.id,
      turn,
      promptTokenCount: prepared.promptTokenCount,
      maxOutputTokens: prepared.maxOutputTokens,
      mock: Array.isArray(this.options.mockResponses),
    });
    try {
      return await requestRepoSearchPlannerProtocolAction({
        backend: this.options.config ? getActiveInferenceBackend(this.options.config) : undefined,
        baseUrl: this.options.baseUrl,
        model: this.options.model,
        messages: this.transcript.getMessages(),
        slotId: this.slotId,
        timeoutMs: this.options.timeoutMs || DEFAULT_TIMEOUT_MS,
        maxTokens: prepared.maxOutputTokens,
        thinkingEnabled: this.plannerThinkingEnabled,
        reasoningContentEnabled: this.plannerReasoningContentEnabled,
        preserveThinking: this.plannerPreserveThinkingEnabled,
        stream: this.progress.enabled,
        onThinkingDelta: this.progress.enabled
          ? (accThinking) => { this.progress.thinking(turn, accThinking); }
          : undefined,
        onContentDelta: this.progress.enabled
          ? (accContent) => {
              if (this.streamFinishAsAnswer) {
                const finishOutput = ModelJson.extractStreamingFinishOutput(accContent);
                if (finishOutput !== null) {
                  this.progress.answer(turn, finishOutput);
                }
              } else {
                const finishOutput = ModelJson.extractStreamingFinishOutput(accContent) ?? accContent;
                this.progress.thinking(turn, finishOutput);
              }
            }
          : undefined,
        mockResponses: this.options.mockResponses,
        mockResponseIndex: this.mockResponseIndex,
        abortSignal: this.options.abortSignal,
        logger: this.options.logger || null,
        toolDefinitions: this.plannerToolDefinitions,
      });
    } finally {
      providerSpan?.end();
    }
  }

  private handleInvalidParse(turn: number, response: PlannerActionResponse, error: Error, resolvedTokens: ResolvedResponseTokens): TurnOutcome {
    this.tokenUsage.addOutputTokens(resolvedTokens.completionTokens, resolvedTokens.completionTokensEstimated);
    this.counters.invalidResponses += 1;
    const invalidActionMessage = `Invalid action: ${error instanceof Error ? error.message : String(error)}. Return a valid JSON finish action or tool action payload.`;
    const invalidToolAction = buildInvalidToolCallActionFromResponseText(String(response.text || ''), this.allowedPlannerToolNames);
    this.transcript.appendToolExchange(
      invalidToolAction,
      `invalid_call_${this.counters.invalidResponses}`,
      invalidActionMessage,
      String(response.thinkingText || '').trim(),
    );
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

  private handleFinishAction(turn: number, action: FinishAction, response: PlannerActionResponse, resolvedTokens: ResolvedResponseTokens): TurnOutcome {
    this.tokenUsage.addOutputTokens(resolvedTokens.completionTokens, resolvedTokens.completionTokensEstimated);
    const finishEvaluation = evaluateFinishAttempt({
      loopKind: this.loopKind,
      finalOutput: action.output,
      successfulToolCalls: this.successfulToolCalls,
    });
    if (!finishEvaluation.allowed) {
      const warning = finishEvaluation.warning || 'Need stronger repository evidence before finishing.';
      this.toolStats.recordFinishRejection();
      this.transcript.pushAssistant(buildAssistantReplayMessage(response.text, String(response.thinkingText || '').trim()));
      this.transcript.pruneThinking(this.plannerMaintainPerStepThinking);
      this.transcript.pushUser(warning);
      this.options.logger?.write({ kind: 'turn_finish_rejected', taskId: this.task.id, turn, toolCallTurns: this.commands.length, minToolCallsBeforeFinish: this.minToolCallsBeforeFinish, warning });
      return 'continue';
    }
    const groundingDecision = this.chatWebGroundingPolicy.evaluateFinish();
    if (groundingDecision.kind === 'reject') {
      this.toolStats.recordFinishRejection();
      this.transcript.pushAssistant(buildAssistantReplayMessage(response.text, String(response.thinkingText || '').trim()));
      this.transcript.pruneThinking(this.plannerMaintainPerStepThinking);
      this.transcript.pushUser(groundingDecision.message);
      this.options.logger?.write({
        kind: 'chat_grounding_finish_rejected',
        taskId: this.task.id,
        turn,
        status: this.chatWebGroundingPolicy.getStatus(),
      });
      return 'continue';
    }
    this.finalOutput = action.output;
    if (this.streamFinishAsAnswer) {
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
        thinkingEnabled: this.plannerThinkingEnabled,
        reasoningContentEnabled: this.plannerReasoningContentEnabled,
        preserveThinking: this.plannerPreserveThinkingEnabled,
        streamFinishAsAnswer: this.streamFinishAsAnswer,
        logger: this.options.logger || null,
        progress: this.progress,
        tokenUsage: this.tokenUsage,
      });
      const synthesis = await synthesizer.synthesize({
        taskId: this.task.id,
        question: this.task.question,
        reason: this.counters.reason,
        transcript: this.transcript.renderTail(2),
        turnsUsed: this.turnsUsed,
        mockResponses: this.options.mockResponses,
        mockResponseIndex: this.mockResponseIndex,
      });
      this.finalOutput = synthesis.finalOutput;
      this.mockResponseIndex = synthesis.nextMockResponseIndex;
    }

    const evidenceParts = [this.finalOutput, ...this.commands.map((item) => item.output)];
    const signalCheck = evaluateTaskSignals(this.task, evidenceParts.join('\n'));
    const passed = signalCheck.passed && this.counters.commandFailures === 0;

    this.options.logger?.write({
      kind: 'task_done', taskId: this.task.id, reason: this.counters.reason, turnsUsed: this.turnsUsed, safetyRejects: this.counters.safetyRejects,
      invalidResponses: this.counters.invalidResponses, commandFailures: this.counters.commandFailures, passed, missingSignals: signalCheck.missingSignals,
    });

    return {
      id: this.task.id, question: this.task.question, reason: this.counters.reason, turnsUsed: this.turnsUsed, safetyRejects: this.counters.safetyRejects,
      invalidResponses: this.counters.invalidResponses, commandFailures: this.counters.commandFailures, commands: this.commands, turnThinking: this.turnThinking, finalOutput: this.finalOutput, passed,
      ...(this.chatWebGroundingEnabled ? { groundingStatus: this.chatWebGroundingPolicy.getStatus() } : {}),
      missingSignals: signalCheck.missingSignals,
      ...this.tokenUsage.snapshot(),
      toolStats: this.toolStats.snapshot(),
      readOverlapSummary: this.readWindows.summary(),
    };
  }
}
