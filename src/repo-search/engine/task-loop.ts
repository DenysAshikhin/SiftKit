import {
  getActiveManagedLlamaPreset,
  getConfiguredLlamaNumCtx,
  getConfiguredLlamaSetting,
  type SiftConfig,
} from '../../config/index.js';
import {
  getRepoSearchLineReadStats,
  readLatestIdleSummaryToolStats,
} from '../../line-read-guidance.js';
import { ModelJson } from '../../lib/model-json.js';
import type { TemporaryTimingRecorder } from '../../lib/temporary-timing-recorder.js';
import type { ToolTypeStats } from '../../status-server/metrics.js';
import {
  buildIgnorePolicy,
  classifySearchExit,
  evaluateCommandSafety,
  getFirstCommandToken,
  type IgnorePolicy,
  type NormalizedCommand,
  normalizePlannerCommand,
} from '../command-safety.js';
import {
  getRepoSearchCommandTokenForToolName,
  isRepoSearchCommandToolName,
  isRepoSearchNativeToolName,
  getRepoSearchToolNamesForParsing,
  resolveRepoSearchPlannerToolDefinitions,
  requestPlannerAction,
  type ChatMessage,
  type FinishAction,
  type PlannerActionResponse,
  type ToolAction,
} from '../planner-protocol.js';
import { estimateTokenCount } from '../prompt-budget.js';
import {
  type LineReadAdjustment,
  type ParsedGetContentReadWindow,
  parseGetContentReadWindowCommand,
  type ReadOverlapSummary,
} from './read-overlap.js';
import {
  buildTaskInitialUserPrompt,
  buildTaskSystemPrompt,
  scanRepoFiles,
  type TaskCommand,
} from '../prompts.js';
import {
  buildRepeatedToolCallSummary,
  buildPromptToolResult,
  classifyToolResultNovelty,
  evaluateFinishAttempt,
  fingerprintToolCall,
} from '../../tool-loop-governor.js';
import {
  CHAT_GROUNDING_FINAL_ANSWER_INSTRUCTION,
  ChatGroundingPolicy,
  type ChatGroundingStatus,
} from '../chat-grounding-policy.js';
import type {
  JsonLogger,
  RetainedWebToolCall,
  RepoSearchMockCommandResult,
  RepoSearchProgressEvent,
} from '../types.js';
import {
  type ToolBatchOutcome,
  type ToolTranscriptAction,
} from '../../tool-call-messages.js';
import {
  detectRecentTokenRepetition,
  type TokenRepetitionDetection,
} from '../repetition-guard.js';
import { WebResearchTools } from '../../web-search/web-research-tools.js';
import type { WebSearchConfig } from '../../web-search/types.js';
import { throwIfAborted } from './abort.js';
import { executeRepoCommand, normalizeToolTypeFromCommand } from './command-execution.js';
import {
  buildEffectiveTranscriptAction,
  buildNativeRepoToolRequestedCommand,
  buildRepoReadFileCommand,
  buildRepoReadFileExecution,
  executeNativeRepoTool,
  isFailedRepoReadFilePlan,
  planRepoReadFile,
  type NativeRepoToolExecution,
} from './native-tools.js';
import { DuplicateTracker } from './duplicate-tracker.js';
import { FORCED_FINISH_MAX_ATTEMPTS, FORCED_FINISH_MODE_MESSAGE, ForcedFinishController } from './forced-finish.js';
import { ProgressReporter } from './progress-reporter.js';
import { PromptPreparer } from './prompt-preparer.js';
import { ReadWindowGovernor, type ReadExecutionMetrics } from './read-window-governor.js';
import { TerminalSynthesizer } from './terminal-synthesizer.js';
import { ToolResultBudgeter } from './tool-result-budgeter.js';
import { TokenUsageTracker } from './token-usage.js';
import { ToolStatsRecorder } from './tool-stats.js';
import { TranscriptManager } from './transcript-manager.js';
import { TurnBudget } from './turn-budget.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const DEFAULT_MAX_TURNS = 45;
export const DEFAULT_MAX_INVALID_RESPONSES = 3;
export const DEFAULT_TIMEOUT_MS = 120_000;
const MIN_TOOL_CALLS_BEFORE_FINISH = 5;

const DEFAULT_ENGINE_WEB_SEARCH_CONFIG: WebSearchConfig = {
  EnabledDefault: false,
  Providers: {
    tavily: { Enabled: false, ApiKey: '' },
    firecrawl: { Enabled: false, ApiKey: '' },
  },
  ProviderOrder: ['tavily', 'firecrawl'],
  ResultCount: 5,
  FetchMaxPages: 3,
  TimeoutMs: 15000,
  FetchMaxCharacters: 12000,
};

function buildWebToolsForTaskLoop(config?: SiftConfig): WebResearchTools {
  return new WebResearchTools(config?.WebSearch ?? DEFAULT_ENGINE_WEB_SEARCH_CONFIG);
}

function buildToolOutputRepetitionWarning(detection: TokenRepetitionDetection): string {
  return `SiftKit stopped tool output early: recent tokens repeated every ${detection.periodTokens} tokens across the last ${detection.windowTokens} tokens after ${detection.totalTokens} tokens.`;
}

function applyToolOutputRepetitionGuard(text: string): string {
  const detection = detectRecentTokenRepetition(text);
  if (!detection) {
    return text;
  }
  return [
    buildToolOutputRepetitionWarning(detection),
    detection.truncatedText,
  ].filter((part) => part.trim().length > 0).join('\n').trim();
}

// ---------------------------------------------------------------------------
// Slot allocation
// ---------------------------------------------------------------------------

let nextLlamaCppSlotId = 0;

function allocateLlamaCppSlotId(config: SiftConfig): number {
  const configuredSlots = getConfiguredLlamaSetting<number>(config, 'ParallelSlots');
  const slotCount = Math.max(1, Math.floor(Number(configuredSlots) || 1));
  const slotId = nextLlamaCppSlotId % slotCount;
  nextLlamaCppSlotId = (nextLlamaCppSlotId + 1) % slotCount;
  return slotId;
}

// ---------------------------------------------------------------------------
// Task definitions
// ---------------------------------------------------------------------------

export type TaskDefinition = {
  id: string;
  question: string;
  signals: string[];
};

export function evaluateTaskSignals(task: TaskDefinition, evidenceText: string): {
  passed: boolean;
  missingSignals: string[];
} {
  const missingSignals: string[] = [];
  for (const signal of task.signals) {
    const regex = new RegExp(signal, 'iu');
    if (!regex.test(evidenceText)) {
      missingSignals.push(signal);
    }
  }
  return { passed: missingSignals.length === 0, missingSignals };
}

// ---------------------------------------------------------------------------
// Task result type
// ---------------------------------------------------------------------------

export type TaskResult = {
  id: string;
  question: string;
  reason: string;
  turnsUsed: number;
  safetyRejects: number;
  invalidResponses: number;
  commandFailures: number;
  commands: TaskCommand[];
  turnThinking: Record<number, string>;
  finalOutput: string;
  groundingStatus?: ChatGroundingStatus;
  passed: boolean;
  missingSignals: string[];
  promptTokens: number;
  outputTokens: number;
  toolTokens: number;
  thinkingTokens: number;
  promptCacheTokens: number;
  promptEvalTokens: number;
  promptEvalDurationMs: number;
  generationDurationMs: number;
  toolStats: Record<string, ToolTypeStats>;
  readOverlapSummary: ReadOverlapSummary;
};

// ---------------------------------------------------------------------------
// Task loop options
// ---------------------------------------------------------------------------

export type RunTaskLoopOptions = {
  repoRoot: string;
  model: string;
  baseUrl: string;
  config?: SiftConfig;
  totalContextTokens?: number;
  timeoutMs?: number;
  maxTurns?: number;
  maxInvalidResponses?: number;
  minToolCallsBeforeFinish?: number;
  loopKind?: 'repo-search' | 'chat';
  streamFinishAsAnswer?: boolean;
  thinkingEnabledOverride?: boolean;
  systemPromptOverride?: string;
  historyMessages?: ChatMessage[];
  plannerToolDefinitions?: ReturnType<typeof resolveRepoSearchPlannerToolDefinitions>;
  includeAgentsMd?: boolean;
  includeRepoFileListing?: boolean;
  mockResponses?: string[];
  mockCommandResults?: Record<string, RepoSearchMockCommandResult>;
  retainedWebToolCalls?: RetainedWebToolCall[];
  abortSignal?: AbortSignal;
  logger?: JsonLogger | null;
  onProgress?: ((event: RepoSearchProgressEvent) => void) | null;
  timingRecorder?: TemporaryTimingRecorder | null;
};

function isPlannerReasoningEnabled(config: SiftConfig | undefined): boolean {
  return getConfiguredLlamaSetting(config || {} as SiftConfig, 'Reasoning') === 'on';
}

function isPlannerReasoningContentEnabled(config: SiftConfig | undefined): boolean {
  return isPlannerReasoningEnabled(config)
    && (config ? getActiveManagedLlamaPreset(config)?.ReasoningContent === true : false);
}

function isPlannerPreserveThinkingEnabled(config: SiftConfig | undefined): boolean {
  return isPlannerReasoningContentEnabled(config)
    && (config ? getActiveManagedLlamaPreset(config)?.PreserveThinking === true : false);
}

function buildAssistantReplayMessage(content: string, thinkingText: string): ChatMessage {
  return {
    role: 'assistant',
    content,
    ...(thinkingText ? { reasoning_content: thinkingText } : {}),
  };
}

function buildInvalidToolCallActionFromResponseText(
  responseText: string,
  allowedToolNames: readonly string[]
): ToolTranscriptAction {
  try {
    const action = ModelJson.parseRepoSearchPlannerAction(responseText, { allowedToolNames });
    if (action.action === 'tool') {
      return action;
    }
    if (action.action === 'tool_batch') {
      const firstToolCall = action.tool_calls[0];
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
      rawResponseText: String(responseText || '').trim(),
    },
  };
}

// ---------------------------------------------------------------------------
// Per-turn batch state and per-action contexts
// ---------------------------------------------------------------------------

type TurnOutcome = 'continue' | 'stop';
type ToolActionOutcome = 'next' | 'stop_batch';

type TurnBatchState = {
  batchOutcomes: ToolBatchOutcome[];
  pendingModeChangeUserMessages: string[];
  pendingForcedFinishCountdownText: string | null;
  batchDuplicateAnchorIndex: number | null;
  acceptedToolPromptTokensThisTurn: number;
};

type ValidatedToolAction = {
  normalizedToolName: string;
  isCommandTool: boolean;
  isNativeTool: boolean;
  command: string;
};

type AcceptedToolContext = ValidatedToolAction & {
  toolAction: ToolAction;
  normalized: NormalizedCommand;
  fingerprint: string;
  normalizedKey: string;
  nativeExecution: NativeRepoToolExecution | null;
};

type ExecutedToolContext = AcceptedToolContext & {
  requestedCommand: string;
  commandToRun: string;
  lineReadAdjustment: LineReadAdjustment | null;
  parsedReadWindow: ParsedGetContentReadWindow | null;
  executedReadWindow: ParsedGetContentReadWindow | null;
  executed: { exitCode: number; output: string };
  baseOutput: string;
  searchExit: ReturnType<typeof classifySearchExit>;
  readMetrics: ReadExecutionMetrics;
  outputWithRewriteNote: string;
  outputForPrompt: string;
  zeroOutputWarningText: string;
  progressToolCallId: string;
};

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
  private readonly loopKind: 'repo-search' | 'chat';
  private readonly streamFinishAsAnswer: boolean;
  private readonly plannerToolDefinitions: ReturnType<typeof resolveRepoSearchPlannerToolDefinitions>;
  private readonly allowedPlannerToolNames: string[];
  private readonly chatWebGroundingEnabled: boolean;
  private readonly chatWebGroundingPolicy: ChatGroundingPolicy;
  private readonly slotId: number;
  private readonly ignorePolicy: IgnorePolicy;
  private readonly historicalToolStats: Record<string, ToolTypeStats>;
  private readonly recentEvidenceKeys = new Set<string>();
  private readonly successfulToolCalls: Array<{ toolName: string; promptResultText: string }> = [];
  private readonly duplicates = new DuplicateTracker();
  private readonly forcedFinish = new ForcedFinishController();
  private readonly resultBudgeter: ToolResultBudgeter;
  private readonly readWindows = new ReadWindowGovernor();
  private readonly progress: ProgressReporter;
  private readonly transcript: TranscriptManager;
  private readonly promptPreparer: PromptPreparer;

  private readonly commands: TaskCommand[] = [];
  private readonly turnThinking: Record<number, string> = {};
  private finalOutput = '';
  private invalidResponses = 0;
  private commandFailures = 0;
  private safetyRejects = 0;
  private reason = 'max_turns';
  private turnsUsed = 0;
  private mockResponseIndex = 0;
  private progressToolCallSeq = 0;
  private forcedFinishCountdownUserMessageIndex = -1;

  constructor(task: TaskDefinition, options: RunTaskLoopOptions) {
    this.task = task;
    this.options = options;
    this.taskStartedAt = Date.now();
    this.maxTurns = Math.max(1, Number(options.maxTurns || DEFAULT_MAX_TURNS));
    this.maxInvalidResponses = Math.max(1, Number(options.maxInvalidResponses || DEFAULT_MAX_INVALID_RESPONSES));
    this.webTools = buildWebToolsForTaskLoop(options.config);
    this.tokenUsage = new TokenUsageTracker(options.config);
    this.toolStats = new ToolStatsRecorder();
    this.minToolCallsBeforeFinish = Math.max(0, Number(options.minToolCallsBeforeFinish ?? MIN_TOOL_CALLS_BEFORE_FINISH));
    this.budget = new TurnBudget({
      totalContextTokens: Math.max(1, Number(options.totalContextTokens || (options.config ? getConfiguredLlamaNumCtx(options.config) : 32000))),
      maxTurns: this.maxTurns,
    });
    this.useEstimatedTokensOnly = Array.isArray(options.mockResponses);
    this.plannerThinkingEnabled = typeof options.thinkingEnabledOverride === 'boolean'
      ? options.thinkingEnabledOverride
      : isPlannerReasoningEnabled(options.config);
    this.plannerReasoningContentEnabled = this.plannerThinkingEnabled && isPlannerReasoningContentEnabled(options.config);
    this.plannerPreserveThinkingEnabled = this.plannerReasoningContentEnabled && isPlannerPreserveThinkingEnabled(options.config);
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
    this.historicalToolStats = readLatestIdleSummaryToolStats();
    this.resultBudgeter = new ToolResultBudgeter({
      config: options.config,
      useEstimatedTokensOnly: this.useEstimatedTokensOnly,
      timingRecorder: options.timingRecorder || null,
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
  }

  async run(): Promise<TaskResult> {
    for (let turn = 1; turn <= this.maxTurns; turn += 1) {
      throwIfAborted(this.options.abortSignal);
      this.turnsUsed = turn;
      const outcome = await this.runTurn(turn);
      if (outcome === 'stop') {
        break;
      }
    }
    return this.buildResult();
  }

  private async runTurn(turn: number): Promise<TurnOutcome> {
    const inForcedFinishMode = this.forcedFinish.isActive();

    const prepared = await this.promptPreparer.prepareTurn(turn);

    this.options.logger?.write({ kind: 'turn_model_request', taskId: this.task.id, turn, thinkingEnabled: this.plannerThinkingEnabled });
    this.progress.llmStart(turn, prepared.promptTokenCount);
    const newMessages = this.transcript.takeNewMessagesForLogging();
    this.options.logger?.write({ kind: 'turn_new_messages', taskId: this.task.id, turn, messages: newMessages, promptTokenCount: prepared.promptTokenCount });

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
      this.turnThinking[turn] = turnThinkingText;
    }

    const resolvedCompletionTokens = this.tokenUsage.recordModelResponse(response).completionTokens;

    if (response.mockExhausted) {
      this.reason = 'mock_responses_exhausted';
      return 'stop';
    }

    let action;
    const parseSpan = this.options.timingRecorder?.start('repo.response.parse', {
      taskId: this.task.id,
      turn,
      responseChars: String(response.text || '').length,
    });
    try {
      action = ModelJson.parseRepoSearchPlannerAction(response.text, { allowedToolNames: this.allowedPlannerToolNames });
      parseSpan?.end({ ok: true });
      this.options.logger?.write({ kind: 'turn_action_parsed', taskId: this.task.id, turn, action });
    } catch (error) {
      parseSpan?.end({ ok: false });
      return this.handleInvalidParse(turn, response, error, resolvedCompletionTokens);
    }

    // Emit native thinking text (from reasoning_content) to UI
    if (response.thinkingText) {
      this.progress.thinking(turn, response.thinkingText);
    }

    if (action.action === 'finish') {
      return this.handleFinishAction(turn, action, response, resolvedCompletionTokens);
    }

    const toolActions: ToolAction[] = action.action === 'tool_batch'
      ? action.tool_calls.map((toolCall) => ({
        action: 'tool' as const,
        tool_name: toolCall.tool_name,
        args: toolCall.args,
      }))
      : [action];
    return this.executeToolActions(turn, toolActions, response, prepared.promptTokenCount, inForcedFinishMode);
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
      return await requestPlannerAction({
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

  private handleInvalidParse(turn: number, response: PlannerActionResponse, error: unknown, resolvedCompletionTokens: number): TurnOutcome {
    this.tokenUsage.addOutputTokens(resolvedCompletionTokens);
    this.invalidResponses += 1;
    const invalidActionMessage = `Invalid action: ${error instanceof Error ? error.message : String(error)}. Return a valid JSON finish action or tool action payload.`;
    const invalidToolAction = buildInvalidToolCallActionFromResponseText(String(response.text || ''), this.allowedPlannerToolNames);
    this.transcript.appendToolExchange(
      invalidToolAction,
      `invalid_call_${this.invalidResponses}`,
      invalidActionMessage,
      String(response.thinkingText || '').trim(),
    );
    this.options.logger?.write({
      kind: 'turn_action_invalid',
      taskId: this.task.id,
      turn,
      invalidResponses: this.invalidResponses,
      error: error instanceof Error ? error.message : String(error),
      toolAction: invalidToolAction,
      toolResultText: invalidActionMessage,
    });
    if (this.invalidResponses >= this.maxInvalidResponses) {
      this.reason = 'invalid_response_limit';
      return 'stop';
    }
    return 'continue';
  }

  private handleFinishAction(turn: number, action: FinishAction, response: PlannerActionResponse, resolvedCompletionTokens: number): TurnOutcome {
    this.tokenUsage.addOutputTokens(resolvedCompletionTokens);
    const finishEvaluation = evaluateFinishAttempt({
      loopKind: this.loopKind,
      finalOutput: action.output,
      successfulToolCalls: this.successfulToolCalls,
    });
    if (!finishEvaluation.allowed) {
      const warning = finishEvaluation.warning || 'Need stronger repository evidence before finishing.';
      this.toolStats.recordFinishRejection();
      this.transcript.pushAssistant(buildAssistantReplayMessage(response.text, String(response.thinkingText || '').trim()));
      this.transcript.pushUser(warning);
      this.options.logger?.write({ kind: 'turn_finish_rejected', taskId: this.task.id, turn, toolCallTurns: this.commands.length, minToolCallsBeforeFinish: this.minToolCallsBeforeFinish, warning });
      return 'continue';
    }
    const groundingDecision = this.chatWebGroundingPolicy.evaluateFinish();
    if (groundingDecision.kind === 'reject') {
      this.toolStats.recordFinishRejection();
      this.transcript.pushAssistant(buildAssistantReplayMessage(response.text, String(response.thinkingText || '').trim()));
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
    this.reason = 'finish';
    return 'stop';
  }

  private async executeToolActions(
    turn: number,
    toolActions: ToolAction[],
    response: PlannerActionResponse,
    promptTokenCount: number,
    inForcedFinishMode: boolean,
  ): Promise<TurnOutcome> {
    const state: TurnBatchState = {
      batchOutcomes: [],
      pendingModeChangeUserMessages: [],
      pendingForcedFinishCountdownText: null,
      batchDuplicateAnchorIndex: null,
      acceptedToolPromptTokensThisTurn: 0,
    };

    for (const toolAction of toolActions) {
      const outcome = await this.processToolAction(turn, toolAction, state, promptTokenCount, inForcedFinishMode);
      if (outcome === 'stop_batch') {
        break;
      }
    }

    const appendSpan = this.options.timingRecorder?.start('repo.tool.append', {
      taskId: this.task.id,
      turn,
      outcomeCount: state.batchOutcomes.length,
      beforeMessageCount: this.transcript.length,
    });
    const preAppendMessagesLength = this.transcript.appendBatchExchange(
      state.batchOutcomes,
      String(response.thinkingText || '').trim(),
    );
    appendSpan?.end({ afterMessageCount: this.transcript.length });
    if (state.batchDuplicateAnchorIndex !== null && state.batchOutcomes.length > 0) {
      this.duplicates.setReplayToolMessageIndex(preAppendMessagesLength + 1 + state.batchDuplicateAnchorIndex);
    }
    for (const userMessage of state.pendingModeChangeUserMessages) {
      this.transcript.pushUser(userMessage);
    }
    if (state.pendingForcedFinishCountdownText !== null) {
      this.forcedFinishCountdownUserMessageIndex = this.transcript.upsertTrailingUser(
        this.forcedFinishCountdownUserMessageIndex,
        state.pendingForcedFinishCountdownText,
      );
    }
    return this.reason === 'forced_finish_attempt_limit' ? 'stop' : 'continue';
  }

  private async processToolAction(
    turn: number,
    toolAction: ToolAction,
    state: TurnBatchState,
    promptTokenCount: number,
    inForcedFinishMode: boolean,
  ): Promise<ToolActionOutcome> {
    const validated = this.validateToolAction(turn, toolAction, state);
    if (validated === 'next' || validated === 'stop_batch') {
      return validated;
    }
    const { normalizedToolName, isNativeTool, command } = validated;

    if (inForcedFinishMode) {
      const attempt = this.forcedFinish.consumeAttempt();
      this.commandFailures += 1;
      this.commands.push({ command, turn, safe: false, reason: attempt.rejectionReason, exitCode: null, output: `Rejected command: ${attempt.rejectionReason}` });
      state.batchOutcomes.push({
        action: buildEffectiveTranscriptAction({
          toolName: normalizedToolName,
          rawArgs: toolAction.args,
          isNativeTool,
          commandToRun: command,
        }),
        toolCallId: `forced_finish_call_${this.commands.length}`,
        toolContent: `Rejected command: ${attempt.rejectionReason}`,
      });
      state.pendingForcedFinishCountdownText = attempt.countdownText;
      if (attempt.exhausted) {
        this.reason = 'forced_finish_attempt_limit';
        return 'stop_batch';
      }
      return 'next';
    }

    const normalized: NormalizedCommand = isNativeTool
      ? { command, rewritten: false, note: '', rejected: false }
      : normalizePlannerCommand(command, { repoRoot: this.options.repoRoot, ignorePolicy: this.ignorePolicy });
    const fingerprint = isNativeTool
      ? fingerprintToolCall({ toolName: normalizedToolName, command })
      : normalized.rejected
        ? ''
        : fingerprintToolCall({ toolName: normalizedToolName, command: normalized.command });
    const prospectiveToolType = isNativeTool
      ? normalizedToolName
      : normalized.rejected
        ? 'loop'
        : normalizeToolTypeFromCommand(normalized.command);

    // Duplicate check on the normalized command so auto-appended flags don't confuse dedup
    const normalizedKey = isNativeTool
      ? command
      : normalized.rejected
        ? command
        : normalized.command;
    const screened = this.screenWebAndDuplicates(turn, {
      ...validated,
      toolAction,
      normalized,
      fingerprint,
      normalizedKey,
      nativeExecution: null,
    }, prospectiveToolType, state);
    if (screened !== null) {
      return screened;
    }

    const nativeExecution = isNativeTool
      ? await this.runNativeExecution(normalizedToolName, toolAction, command)
      : null;
    const context: AcceptedToolContext = {
      ...validated,
      toolAction,
      normalized,
      fingerprint,
      normalizedKey,
      nativeExecution,
    };
    const rejection = this.screenRejection(turn, context, state);
    if (rejection !== null) {
      return rejection;
    }

    return this.executeAcceptedTool(turn, context, state, promptTokenCount);
  }

  private validateToolAction(turn: number, toolAction: ToolAction, state: TurnBatchState): ValidatedToolAction | ToolActionOutcome {
    const normalizedToolName = String(toolAction.tool_name || '').trim().toLowerCase();
    const isCommandTool = isRepoSearchCommandToolName(normalizedToolName);
    const isNativeTool = isRepoSearchNativeToolName(normalizedToolName);
    if (!isCommandTool && !isNativeTool) {
      this.invalidResponses += 1;
      const unsupportedToolMessage = `Invalid action: unsupported planner tool "${toolAction.tool_name}" for repo-search. Use one of: ${this.allowedPlannerToolNames.join(', ')}.`;
      state.batchOutcomes.push({
        action: { tool_name: String(toolAction.tool_name || '').trim() || 'invalid_tool_call', args: toolAction.args },
        toolCallId: `invalid_call_${this.invalidResponses}`,
        toolContent: unsupportedToolMessage,
      });
      this.options.logger?.write({
        kind: 'turn_action_invalid',
        taskId: this.task.id,
        turn,
        invalidResponses: this.invalidResponses,
        error: unsupportedToolMessage,
        toolAction,
        toolResultText: unsupportedToolMessage,
      });
      if (this.invalidResponses >= this.maxInvalidResponses) {
        this.reason = 'invalid_response_limit';
        return 'stop_batch';
      }
      return 'next';
    }
    const command = isCommandTool
      ? (typeof toolAction.args.command === 'string' ? toolAction.args.command : '')
      : buildNativeRepoToolRequestedCommand(normalizedToolName, toolAction.args);
    if (isCommandTool && !command.trim()) {
      this.invalidResponses += 1;
      const invalidCommandMessage = `Invalid action: ${normalizedToolName} requires args.command.`;
      state.batchOutcomes.push({
        action: { tool_name: normalizedToolName, args: toolAction.args },
        toolCallId: `invalid_call_${this.invalidResponses}`,
        toolContent: invalidCommandMessage,
      });
      this.options.logger?.write({
        kind: 'turn_action_invalid',
        taskId: this.task.id,
        turn,
        invalidResponses: this.invalidResponses,
        error: invalidCommandMessage,
        toolAction,
        toolResultText: invalidCommandMessage,
      });
      if (this.invalidResponses >= this.maxInvalidResponses) {
        this.reason = 'invalid_response_limit';
        return 'stop_batch';
      }
      return 'next';
    }
    const expectedCommandToken = isCommandTool ? getRepoSearchCommandTokenForToolName(normalizedToolName) : null;
    const actualCommandToken = isCommandTool ? getFirstCommandToken(command) : null;
    if (isCommandTool && (!expectedCommandToken || actualCommandToken !== expectedCommandToken)) {
      this.invalidResponses += 1;
      const invalidToolCommandMessage = `Invalid action: ${normalizedToolName} only allows commands starting with '${expectedCommandToken || '<unknown>'}'.`;
      state.batchOutcomes.push({
        action: { tool_name: normalizedToolName, args: toolAction.args },
        toolCallId: `invalid_call_${this.invalidResponses}`,
        toolContent: invalidToolCommandMessage,
      });
      this.options.logger?.write({
        kind: 'turn_action_invalid',
        taskId: this.task.id,
        turn,
        invalidResponses: this.invalidResponses,
        error: invalidToolCommandMessage,
        toolAction,
        toolResultText: invalidToolCommandMessage,
      });
      if (this.invalidResponses >= this.maxInvalidResponses) {
        this.reason = 'invalid_response_limit';
        return 'stop_batch';
      }
      return 'next';
    }
    return { normalizedToolName, isCommandTool, isNativeTool, command };
  }

  private screenWebAndDuplicates(
    turn: number,
    context: AcceptedToolContext,
    prospectiveToolType: string,
    state: TurnBatchState,
  ): ToolActionOutcome | null {
    const { toolAction, normalizedToolName, isNativeTool, command, normalized, fingerprint, normalizedKey } = context;
    const { isExactDuplicate, isSemanticDuplicate, duplicateFingerprint } = this.duplicates.classify({
      toolName: normalizedToolName,
      normalizedKey,
      fingerprint,
      rejected: Boolean(normalized.rejected),
    });
    const canAdvanceRepeatedRead = normalizedToolName === 'repo_read_file' || Boolean(!isNativeTool && parseGetContentReadWindowCommand(normalizedKey));
    if (this.chatWebGroundingEnabled && (normalizedToolName === 'web_search' || normalizedToolName === 'web_fetch')) {
      const duplicateDecision = this.chatWebGroundingPolicy.evaluateToolCall(normalizedToolName, toolAction.args);
      if (duplicateDecision.kind === 'reject') {
        this.commandFailures += 1;
        this.commands.push({
          command,
          turn,
          safe: false,
          reason: 'duplicate web tool',
          exitCode: null,
          output: duplicateDecision.message,
        });
        state.batchOutcomes.push({
          action: buildEffectiveTranscriptAction({
            toolName: normalizedToolName,
            rawArgs: toolAction.args,
            isNativeTool,
            commandToRun: command,
          }),
          toolCallId: `duplicate_web_call_${this.commands.length}`,
          toolContent: duplicateDecision.message,
        });
        return 'next';
      }
    }
    if (!canAdvanceRepeatedRead && (isExactDuplicate || isSemanticDuplicate)) {
      const registration = this.duplicates.registerDuplicate(duplicateFingerprint, this.transcript.length);
      const duplicateMessage = buildRepeatedToolCallSummary(normalizedToolName, registration.count);
      this.commandFailures += 1;
      const rejectionReason = isExactDuplicate ? 'duplicate command' : 'semantic duplicate command';
      this.commands.push({ command, turn, safe: false, reason: rejectionReason, exitCode: null, output: `Rejected: ${duplicateMessage}` });
      if (registration.activeReplayMessageIndex !== null) {
        this.transcript.replaceToolMessage(registration.activeReplayMessageIndex, duplicateMessage);
      } else {
        const duplicateToolCallId = `duplicate_call_${this.commands.length}`;
        state.batchOutcomes.push({
          action: buildEffectiveTranscriptAction({
            toolName: normalizedToolName,
            rawArgs: toolAction.args,
            isNativeTool,
            commandToRun: command,
          }),
          toolCallId: duplicateToolCallId,
          toolContent: duplicateMessage,
        });
        state.batchDuplicateAnchorIndex = state.batchOutcomes.length - 1;
      }
      if (isSemanticDuplicate) {
        this.toolStats.recordSemanticRepeatReject(prospectiveToolType);
        this.options.logger?.write({
          kind: 'turn_semantic_repeat_rejected',
          taskId: this.task.id,
          turn,
          command,
          fingerprint,
          repeats: registration.count,
        });
      }
      if (this.duplicates.shouldForceFinish() && !this.forcedFinish.isActive()) {
        state.pendingModeChangeUserMessages.push(this.forcedFinish.activateFromStagnation());
        this.toolStats.recordForcedFinishFromStagnation(prospectiveToolType);
        this.options.logger?.write({
          kind: 'turn_forced_finish_mode_started',
          taskId: this.task.id,
          turn,
          attemptsRemaining: FORCED_FINISH_MAX_ATTEMPTS,
          trigger: isSemanticDuplicate ? 'semantic_repetition' : 'consecutive_duplicates',
        });
      }
      return 'next';
    }
    return null;
  }

  private async runNativeExecution(normalizedToolName: string, toolAction: ToolAction, command: string): Promise<NativeRepoToolExecution> {
    if (normalizedToolName === 'repo_read_file') {
      const nativeReadPlan = planRepoReadFile(toolAction.args, this.options.repoRoot, this.ignorePolicy, this.readWindows.stateMap);
      return isFailedRepoReadFilePlan(nativeReadPlan)
        ? { ok: false, command: nativeReadPlan.command, reason: nativeReadPlan.reason, toolType: normalizedToolName }
        : buildRepoReadFileExecution(normalizedToolName, nativeReadPlan, null);
    }
    if (this.options.mockCommandResults && this.options.mockCommandResults[command]) {
      const mockResult = this.options.mockCommandResults[command];
      return {
        ok: true,
        requestedCommand: command,
        command,
        exitCode: Number(mockResult.exitCode),
        output: [mockResult.stdout, mockResult.stderr]
          .filter((part) => typeof part === 'string' && part.length > 0)
          .join('\n'),
        toolType: normalizedToolName,
      };
    }
    return executeNativeRepoTool(normalizedToolName, toolAction.args, this.options.repoRoot, this.ignorePolicy, this.webTools, this.readWindows.stateMap);
  }

  private screenRejection(turn: number, context: AcceptedToolContext, state: TurnBatchState): ToolActionOutcome | null {
    const { toolAction, normalizedToolName, isNativeTool, command, normalized, nativeExecution } = context;
    if (isNativeTool && nativeExecution && !nativeExecution.ok) {
      this.safetyRejects += 1;
      const rejection = `Rejected command: ${nativeExecution.reason}`;
      this.commands.push({ command, turn, safe: false, reason: nativeExecution.reason, exitCode: null, output: rejection });
      state.batchOutcomes.push({
        action: buildEffectiveTranscriptAction({
          toolName: normalizedToolName,
          rawArgs: toolAction.args,
          isNativeTool,
          commandToRun: nativeExecution.command,
        }),
        toolCallId: `rejected_call_${this.commands.length}`,
        toolContent: rejection,
      });
      return 'next';
    }
    if (!isNativeTool && normalized.rejected) {
      this.safetyRejects += 1;
      const rejection = `Rejected command: ${normalized.rejectedReason}`;
      this.commands.push({ command, turn, safe: false, reason: normalized.rejectedReason || null, exitCode: null, output: rejection });
      state.batchOutcomes.push({
        action: buildEffectiveTranscriptAction({
          toolName: normalizedToolName,
          rawArgs: toolAction.args,
          isNativeTool,
          commandToRun: command,
        }),
        toolCallId: `rejected_call_${this.commands.length}`,
        toolContent: rejection,
      });
      return 'next';
    }
    return null;
  }

  private async executeAcceptedTool(
    turn: number,
    context: AcceptedToolContext,
    state: TurnBatchState,
    promptTokenCount: number,
  ): Promise<ToolActionOutcome> {
    const { toolAction, normalizedToolName, isNativeTool, command, normalized, nativeExecution } = context;
    const requestedCommand = isNativeTool && nativeExecution?.ok
      ? nativeExecution.requestedCommand || command
      : command;
    const normalizedCommand = isNativeTool && nativeExecution?.ok ? nativeExecution.command : isNativeTool ? command : normalized.command;
    const preExecutionPerToolCapTokens = this.budget.perToolCapTokens(this.commands.length);
    const parsedReadWindow = isNativeTool ? null : parseGetContentReadWindowCommand(normalizedCommand);
    let commandToRun = normalizedCommand;
    let lineReadAdjustment: LineReadAdjustment | null = null;

    if (parsedReadWindow) {
      const planned = this.readWindows.planAdjustment({
        parsedReadWindow,
        perToolCapTokens: preExecutionPerToolCapTokens,
        currentGetContentStats: this.toolStats.get('get-content'),
        historicalGetContentStats: this.historicalToolStats['get-content'] || null,
      });
      if (planned) {
        commandToRun = planned.commandToRun;
        lineReadAdjustment = planned.adjustment;
      }
    }

    const safety = isNativeTool
      ? { safe: true, reason: null }
      : evaluateCommandSafety(commandToRun, this.options.repoRoot);
    this.options.logger?.write({ kind: 'turn_command_safety', taskId: this.task.id, turn, command: commandToRun, safe: safety.safe, reason: safety.reason });

    if (!safety.safe) {
      this.safetyRejects += 1;
      const rejection = `Rejected command: ${safety.reason}`;
      this.commands.push({ command: commandToRun, turn, safe: false, reason: safety.reason, exitCode: null, output: rejection });
      const rejectedModelVisibleCommand = isNativeTool || lineReadAdjustment || !normalized.rewritten
        ? commandToRun
        : requestedCommand;
      state.batchOutcomes.push({
        action: buildEffectiveTranscriptAction({
          toolName: normalizedToolName,
          rawArgs: toolAction.args,
          isNativeTool,
          commandToRun: rejectedModelVisibleCommand,
        }),
        toolCallId: `rejected_call_${this.commands.length}`,
        toolContent: rejection,
      });
      return 'next';
    }

    const progressToolCallId = `tc_${this.progressToolCallSeq}`;
    this.progressToolCallSeq += 1;
    this.progress.toolStart(progressToolCallId, turn, requestedCommand, promptTokenCount);

    const toolExecutionSpan = this.options.timingRecorder?.start('repo.tool.execute', {
      taskId: this.task.id,
      turn,
      toolName: normalizedToolName,
      commandChars: commandToRun.length,
      native: isNativeTool,
    });
    const executed = isNativeTool && nativeExecution && nativeExecution.ok
      ? { exitCode: nativeExecution.exitCode, output: nativeExecution.output }
      : await executeRepoCommand(commandToRun, this.options.repoRoot, this.options.mockCommandResults || null, this.options.abortSignal);
    toolExecutionSpan?.end({
      exitCode: executed.exitCode,
      outputChars: String(executed.output || '').length,
    });
    const baseOutput = String(executed.output || '').trim();
    if (normalizedToolName === 'web_search' || normalizedToolName === 'web_fetch') {
      this.chatWebGroundingPolicy.recordToolResult({
        toolName: normalizedToolName,
        command: commandToRun,
        exitCode: Number(executed.exitCode),
        output: baseOutput,
      });
    }
    const searchExit = classifySearchExit(commandToRun, Number(executed.exitCode), baseOutput);
    const promptedBaseOutput = searchExit.syntaxFailure && searchExit.message
      ? `${searchExit.message}\n${baseOutput}`.trim()
      : baseOutput;
    const executedReadWindow = isNativeTool ? null : parseGetContentReadWindowCommand(commandToRun);
    let readMetrics: ReadExecutionMetrics = { overlapLines: 0, newLinesCovered: 0, cumulativeUniqueLines: 0 };
    if (parsedReadWindow) {
      readMetrics = this.readWindows.recordExecution({
        parsedReadWindow,
        executedReadWindow,
        turn,
        adjusted: Boolean(lineReadAdjustment),
      });
    }

    const rewriteNotesForLogs: string[] = [];
    const rewriteNotesForPrompt: string[] = [];
    if (normalized.rewritten && normalized.note) {
      rewriteNotesForLogs.push(normalized.note);
    }
    if (lineReadAdjustment) {
      rewriteNotesForLogs.push(
        `note: repeated file read window adjusted; requested start=${lineReadAdjustment.requestedStart} end=${lineReadAdjustment.requestedEnd}; adjusted start=${lineReadAdjustment.adjustedStart} end=${lineReadAdjustment.adjustedEnd}; reason=${lineReadAdjustment.reason}; ran '${lineReadAdjustment.executedCommand}' instead`
      );
    }
    const outputWithRewriteNote = rewriteNotesForLogs.length > 0
      ? `${rewriteNotesForLogs.join('\n')}\n${promptedBaseOutput}`.trim()
      : promptedBaseOutput;
    const outputForPrompt = rewriteNotesForPrompt.length > 0
      ? `${rewriteNotesForPrompt.join('\n')}\n${promptedBaseOutput}`.trim()
      : promptedBaseOutput;

    if (Number(executed.exitCode) !== 0 && !searchExit.noMatch) {
      this.commandFailures += 1;
    }

    let zeroOutputWarningText = '';
    const zeroOutputObservation = this.forcedFinish.recordToolOutput(baseOutput.length);
    if (baseOutput.length === 0) {
      zeroOutputWarningText = zeroOutputObservation.warningText;
      this.options.logger?.write({
        kind: 'turn_zero_output_countdown', taskId: this.task.id, turn,
        zeroOutputStreak: zeroOutputObservation.zeroOutputStreak,
        remainingBeforeForce: zeroOutputObservation.remainingBeforeForce,
      });
      if (zeroOutputObservation.activated) {
        state.pendingModeChangeUserMessages.push(FORCED_FINISH_MODE_MESSAGE);
        this.options.logger?.write({
          kind: 'turn_forced_finish_mode_started', taskId: this.task.id, turn, attemptsRemaining: FORCED_FINISH_MAX_ATTEMPTS,
        });
      }
    }

    return this.recordToolOutcome(turn, {
      ...context,
      requestedCommand,
      commandToRun,
      lineReadAdjustment,
      parsedReadWindow,
      executedReadWindow,
      executed,
      baseOutput,
      searchExit,
      readMetrics,
      outputWithRewriteNote,
      outputForPrompt,
      zeroOutputWarningText,
      progressToolCallId,
    }, state, promptTokenCount);
  }

  private async recordToolOutcome(
    turn: number,
    context: ExecutedToolContext,
    state: TurnBatchState,
    promptTokenCount: number,
  ): Promise<ToolActionOutcome> {
    const {
      toolAction, normalizedToolName, isNativeTool, normalized, fingerprint, normalizedKey, nativeExecution,
      requestedCommand, lineReadAdjustment, parsedReadWindow, executedReadWindow,
      executed, baseOutput, searchExit, readMetrics, outputWithRewriteNote, outputForPrompt,
      zeroOutputWarningText, progressToolCallId,
    } = context;
    let { commandToRun } = context;

    // For search commands (rg/grep), exit_code=1 means "no match" — but when there IS output it
    // means the pipeline was terminated early (e.g. `| Select-Object -First N` closed the pipe
    // before rg finished, causing a broken-pipe exit). In that case the output is valid truncated
    // results, not an error, so don't prepend a misleading `exit_code=1` prefix.
    const suppressExitCode = searchExit.noMatch && outputForPrompt.length > 0;
    const rawResultText = suppressExitCode
      ? outputForPrompt
      : `exit_code=${executed.exitCode}\n${outputForPrompt}`.trim();
    const promptVisibleCommand = isNativeTool || lineReadAdjustment || !normalized.rewritten
      ? commandToRun
      : requestedCommand;
    let resultText = buildPromptToolResult({
      toolName: normalizedToolName,
      command: isNativeTool ? commandToRun : promptVisibleCommand,
      exitCode: executed.exitCode,
      rawOutput: rawResultText,
    });
    if (zeroOutputWarningText) {
      resultText = `${zeroOutputWarningText}\n\n${resultText}`.trim();
    }
    resultText = applyToolOutputRepetitionGuard(resultText);
    const perToolCapTokens = this.budget.perToolCapTokens(this.commands.length);
    const remainingTokenAllowance = this.budget.remainingToolAllowance(promptTokenCount, state.acceptedToolPromptTokensThisTurn);
    const fitted = await this.resultBudgeter.fit({
      taskId: this.task.id,
      turn,
      toolName: normalizedToolName,
      resultText,
      rawResultText,
      perToolCapTokens,
      remainingTokenAllowance,
      commandSucceededForFitting: Number(executed.exitCode) === 0 || searchExit.noMatch,
      outputUnit: nativeExecution && nativeExecution.ok && nativeExecution.outputUnit ? nativeExecution.outputUnit : 'lines',
    });
    resultText = fitted.resultText;
    const resultTokenCount = fitted.resultTokenCount;
    const resultTokenCountEstimated = fitted.resultTokenCountEstimated;
    const fittedReturnedSegmentCount = fitted.fittedReturnedSegmentCount;
    const rawResultTokenCount = fitted.rawResultTokenCount;
    let lineReadStats = isNativeTool && nativeExecution && nativeExecution.ok && nativeExecution.lineReadStats
      ? nativeExecution.lineReadStats
      : getRepoSearchLineReadStats(commandToRun, baseOutput, rawResultTokenCount);
    if (nativeExecution && nativeExecution.ok && nativeExecution.readFile && nativeExecution.lineReadStats && nativeExecution.lineReadStats.lineReadLinesTotal > 0) {
      const returnedLineCount = Math.min(
        nativeExecution.lineReadStats.lineReadLinesTotal,
        fittedReturnedSegmentCount ?? resultText.split(/\r?\n/u).filter((line) => /^\d+:/u.test(line)).length,
      );
      if (returnedLineCount > 0) {
        const returnedEndLineExclusive = nativeExecution.readFile.startLine + returnedLineCount;
        commandToRun = buildRepoReadFileCommand(
          nativeExecution.readFile.commandPath,
          nativeExecution.readFile.startLine,
          returnedEndLineExclusive - 1,
        );
        lineReadStats = {
          lineReadCalls: 1,
          lineReadLinesTotal: returnedLineCount,
          lineReadTokensTotal: Math.max(1, estimateTokenCount(this.options.config, resultText)),
        };
        this.readWindows.recordNativeReturnedRange(nativeExecution.readFile.pathKey, {
          start: nativeExecution.readFile.startLine,
          end: returnedEndLineExclusive,
        });
      }
    }
    if (!isNativeTool && parsedReadWindow && executedReadWindow) {
      this.readWindows.applyFitTruncation({ parsedReadWindow, executedReadWindow, fittedReturnedSegmentCount, metrics: readMetrics });
    }
    const toolType = isNativeTool
      ? normalizedToolName
      : normalizeToolTypeFromCommand(commandToRun);
    this.toolStats.recordToolCall({
      toolType,
      resultTextLength: resultText.length,
      resultTokenCount,
      resultTokenCountEstimated,
      rawResultTokenCount,
      lineReadStats: lineReadStats || null,
    });
    const novelty = baseOutput.length === 0
      ? { evidenceKeys: [], hasNewEvidence: true }
      : classifyToolResultNovelty({
        promptResultText: resultText,
        recentEvidenceKeys: this.recentEvidenceKeys,
      });
    this.toolStats.recordNovelty(toolType, novelty.hasNewEvidence);
    for (const evidenceKey of novelty.evidenceKeys) {
      this.recentEvidenceKeys.add(evidenceKey);
    }
    if (novelty.evidenceKeys.length > 0) {
      this.successfulToolCalls.push({ toolName: toolType, promptResultText: resultText });
    }

    const modelVisibleCommand = isNativeTool || lineReadAdjustment || !normalized.rewritten
      ? commandToRun
      : requestedCommand;
    if (this.progress.enabled) {
      const snippet = resultText.length > 200 ? `${resultText.slice(0, 200)}...` : resultText;
      this.progress.toolResult({
        toolCallId: progressToolCallId,
        turn,
        command: modelVisibleCommand,
        exitCode: executed.exitCode,
        outputSnippet: snippet,
        outputTokens: resultTokenCount,
        promptTokenCount,
      });
    }
    const commandOutputText = isNativeTool && nativeExecution?.ok ? resultText : outputWithRewriteNote;

    this.options.logger?.write({
      kind: 'turn_command_result', taskId: this.task.id, turn, command: commandToRun,
      requestedCommand,
      executedCommand: commandToRun,
      modelVisibleCommand,
      lineReadAdjusted: Boolean(lineReadAdjustment),
      lineReadRequestedStart: parsedReadWindow?.requestedStart,
      lineReadRequestedEnd: parsedReadWindow?.requestedEnd,
      lineReadAdjustedStart: lineReadAdjustment?.adjustedStart,
      lineReadAdjustedEnd: lineReadAdjustment?.adjustedEnd,
      lineReadMinLinesFromCap: lineReadAdjustment?.minLinesFromCap,
      lineReadPerToolCapTokens: lineReadAdjustment?.perToolCapTokens,
      lineReadExecutedStart: executedReadWindow?.requestedStart,
      lineReadExecutedEnd: executedReadWindow?.requestedEnd,
      lineReadOverlapLines: executedReadWindow ? readMetrics.overlapLines : undefined,
      lineReadNewLinesCovered: executedReadWindow ? readMetrics.newLinesCovered : undefined,
      lineReadCumulativeUniqueLines: executedReadWindow ? readMetrics.cumulativeUniqueLines : undefined,
      exitCode: executed.exitCode, output: commandOutputText,
      promptTokenCount, resultTokenCount, perToolCapTokens, remainingTokenAllowance,
      insertedResultText: resultText,
    });
    this.tokenUsage.addToolTokens(resultTokenCount);

    this.commands.push({
      command: commandToRun,
      turn,
      modelVisibleCommand,
      safe: true,
      reason: null,
      exitCode: executed.exitCode,
      output: commandOutputText,
      promptOutput: resultText,
      outputTokens: resultTokenCount,
    });
    const commandSucceeded = Number(executed.exitCode) === 0 || searchExit.noMatch;
    if (commandSucceeded) {
      this.duplicates.recordSuccess(normalizedKey, fingerprint || null);
    }
    const toolCallId = `call_${this.commands.length}`;
    state.batchOutcomes.push({
      action: buildEffectiveTranscriptAction({
        toolName: normalizedToolName,
        rawArgs: toolAction.args,
        isNativeTool,
        commandToRun: modelVisibleCommand,
      }),
      toolCallId,
      toolContent: resultText,
    });
    state.acceptedToolPromptTokensThisTurn += Math.max(0, Math.ceil(resultTokenCount));
    return 'next';
  }

  private async buildResult(): Promise<TaskResult> {
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
        reason: this.reason,
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
    const passed = signalCheck.passed && this.commandFailures === 0;

    this.options.logger?.write({
      kind: 'task_done', taskId: this.task.id, reason: this.reason, turnsUsed: this.turnsUsed, safetyRejects: this.safetyRejects,
      invalidResponses: this.invalidResponses, commandFailures: this.commandFailures, passed, missingSignals: signalCheck.missingSignals,
    });

    return {
      id: this.task.id, question: this.task.question, reason: this.reason, turnsUsed: this.turnsUsed, safetyRejects: this.safetyRejects,
      invalidResponses: this.invalidResponses, commandFailures: this.commandFailures, commands: this.commands, turnThinking: this.turnThinking, finalOutput: this.finalOutput, passed,
      ...(this.chatWebGroundingEnabled ? { groundingStatus: this.chatWebGroundingPolicy.getStatus() } : {}),
      missingSignals: signalCheck.missingSignals,
      ...this.tokenUsage.snapshot(),
      toolStats: this.toolStats.snapshot(),
      readOverlapSummary: this.readWindows.summary(),
    };
  }
}
