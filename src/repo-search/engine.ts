import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  applyHostLlamaRuntimeSettings,
  getActiveManagedLlamaPreset,
  getConfiguredLlamaBaseUrl,
  getConfiguredLlamaNumCtx,
  getConfiguredLlamaSetting,
  getConfiguredModel,
  loadConfig,
  type SiftConfig,
} from '../config/index.js';
import {
  getRepoSearchLineReadStats,
  mergeToolTypeStats,
  readLatestIdleSummaryToolStats,
} from '../line-read-guidance.js';
import { getDynamicMaxOutputTokens } from '../lib/dynamic-output-cap.js';
import { ModelJson } from '../lib/model-json.js';
import type { TemporaryTimingRecorder } from '../lib/temporary-timing-recorder.js';
import { listLlamaCppModels } from '../providers/llama-cpp.js';
import type { ToolTypeStats } from '../status-server/metrics.js';
import {
  buildIgnorePolicy,
  classifySearchExit,
  evaluateCommandSafety,
  getFirstCommandToken,
  type IgnorePolicy,
  normalizePlannerCommand,
} from './command-safety.js';
import { getAbortError, throwIfAborted } from './engine/abort.js';
import { executeRepoCommand, findMockResult, normalizeToolTypeFromCommand } from './engine/command-execution.js';
import {
  buildEffectiveTranscriptAction,
  buildNativeRepoToolRequestedCommand,
  buildRepoReadFileCommand,
  buildRepoReadFileExecution,
  executeNativeRepoTool,
  isFailedRepoReadFilePlan,
  planRepoReadFile,
  type NativeRepoToolExecution,
} from './engine/native-tools.js';
import { DuplicateTracker } from './engine/duplicate-tracker.js';
import { FORCED_FINISH_MAX_ATTEMPTS, FORCED_FINISH_MODE_MESSAGE, ForcedFinishController } from './engine/forced-finish.js';
import { ProgressReporter } from './engine/progress-reporter.js';
import { ReadWindowGovernor } from './engine/read-window-governor.js';
import { ToolResultBudgeter } from './engine/tool-result-budgeter.js';
import { TranscriptManager } from './engine/transcript-manager.js';
import { TokenUsageTracker } from './engine/token-usage.js';
import { ToolStatsRecorder } from './engine/tool-stats.js';
import { TurnBudget } from './engine/turn-budget.js';
import {
  getRepoSearchCommandTokenForToolName,
  isRepoSearchCommandToolName,
  isRepoSearchNativeToolName,
  getRepoSearchToolNamesForParsing,
  resolveRepoSearchPlannerToolDefinitions,
  buildPlannerRequestPromptReserveText,
  requestPlannerAction,
  requestTerminalSynthesis,
  type ChatMessage,
  type PlannerActionResponse,
} from './planner-protocol.js';
import {
  compactPlannerMessagesOnce,
  countTokensWithFallback,
  estimateTokenCount,
  preflightPlannerPromptBudget,
} from './prompt-budget.js';
import {
  type LineReadAdjustment,
  mergeReadOverlapSummaries,
  parseGetContentReadWindowCommand,
  type ReadOverlapSummary,
} from './engine/read-overlap.js';
import {
  buildTaskInitialUserPrompt,
  buildTaskSystemPrompt,
  buildTerminalSynthesisPrompt,
  scanRepoFiles,
  type TaskCommand,
} from './prompts.js';
import {
  buildRepeatedToolCallSummary,
  buildPromptToolResult,
  classifyToolResultNovelty,
  evaluateFinishAttempt,
  fingerprintToolCall,
} from '../tool-loop-governor.js';
import {
  CHAT_GROUNDING_FINAL_ANSWER_INSTRUCTION,
  ChatGroundingPolicy,
  type ChatGroundingStatus,
} from './chat-grounding-policy.js';
import type {
  JsonLogger,
  RetainedWebToolCall,
  RepoSearchMockCommandResult,
  RepoSearchProgressEvent,
} from './types.js';
import {
  buildAssistantToolCallMessage as buildSharedAssistantToolCallMessage,
  type ToolBatchOutcome,
  type ToolTranscriptAction,
} from '../tool-call-messages.js';
import {
  detectRecentTokenRepetition,
  type TokenRepetitionDetection,
} from './repetition-guard.js';
import { WebResearchTools } from '../web-search/web-research-tools.js';
import type { WebFetchToolArgs, WebSearchConfig, WebSearchToolArgs } from '../web-search/types.js';

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

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_MAX_TURNS = 45;
const DEFAULT_MAX_INVALID_RESPONSES = 3;
const DEFAULT_TIMEOUT_MS = 120_000;
const MIN_TOOL_CALLS_BEFORE_FINISH = 5;

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
// Task definitions (built-in self-test pack)
// ---------------------------------------------------------------------------

export type TaskDefinition = {
  id: string;
  question: string;
  signals: string[];
};

export const TASK_PACK: TaskDefinition[] = [
  {
    id: 'symbol-location',
    question: 'Find where buildPlannerToolDefinitions is defined. Return file path and nearby signature text.',
    signals: ['src[\\\\/]summary\\.ts', 'buildPlannerToolDefinitions'],
  },
  {
    id: 'call-path',
    question: 'Find what function invokes invokePlannerMode in summary flow. Return caller function name.',
    signals: ['invokePlannerMode', 'invokeSummaryCore'],
  },
  {
    id: 'config-runtime-key',
    question: 'Find where getConfiguredLlamaNumCtx is defined and at least one usage site.',
    signals: ['src[\\\\/]config\\.ts', 'getConfiguredLlamaNumCtx'],
  },
  {
    id: 'planner-tools',
    question: 'Find planner tool names in SiftKit and list them.',
    signals: ['find_text', 'read_lines', 'json_filter'],
  },
  {
    id: 'debug-artifacts',
    question: 'Find where planner debug dumps are written and show filename pattern.',
    signals: ['planner_debug_', 'getRuntimeLogsPath'],
  },
];

// ---------------------------------------------------------------------------
// Signal evaluation
// ---------------------------------------------------------------------------

function evaluateTaskSignals(task: TaskDefinition, evidenceText: string): {
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
// Console helper
// ---------------------------------------------------------------------------


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
// Main task loop
// ---------------------------------------------------------------------------

type RunTaskLoopOptions = {
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

function buildAssistantToolCallMessage(
  toolName: string,
  args: Record<string, unknown>,
  toolCallId: string,
  thinkingText: string
): ChatMessage {
  return buildSharedAssistantToolCallMessage({ tool_name: toolName, args }, toolCallId, thinkingText) as ChatMessage;
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

export async function runTaskLoop(task: TaskDefinition, options: RunTaskLoopOptions): Promise<TaskResult> {
  const taskStartedAt = Date.now();
  const maxTurns = Math.max(1, Number(options.maxTurns || DEFAULT_MAX_TURNS));
  const maxInvalidResponses = Math.max(1, Number(options.maxInvalidResponses || DEFAULT_MAX_INVALID_RESPONSES));
  const webTools = buildWebToolsForTaskLoop(options.config);
  const commands: TaskCommand[] = [];
  const turnThinking: Record<number, string> = {};
  let finalOutput = '';
  let invalidResponses = 0;
  let commandFailures = 0;
  let safetyRejects = 0;
  let reason = 'max_turns';
  let turnsUsed = 0;
  let mockResponseIndex = 0;
  let progressToolCallSeq = 0;
  const tokenUsage = new TokenUsageTracker(options.config);
  const toolStats = new ToolStatsRecorder();
  const minToolCallsBeforeFinish = Math.max(0, Number(options.minToolCallsBeforeFinish ?? MIN_TOOL_CALLS_BEFORE_FINISH));
  const budget = new TurnBudget({
    totalContextTokens: Math.max(1, Number(options.totalContextTokens || (options.config ? getConfiguredLlamaNumCtx(options.config) : 32000))),
    maxTurns,
  });
  const useEstimatedTokensOnly = Array.isArray(options.mockResponses);
  const plannerThinkingEnabled = typeof options.thinkingEnabledOverride === 'boolean'
    ? options.thinkingEnabledOverride
    : isPlannerReasoningEnabled(options.config);
  const plannerReasoningContentEnabled = plannerThinkingEnabled && isPlannerReasoningContentEnabled(options.config);
  const plannerPreserveThinkingEnabled = plannerReasoningContentEnabled && isPlannerPreserveThinkingEnabled(options.config);
  const loopKind = options.loopKind === 'chat' ? 'chat' : 'repo-search';
  const streamFinishAsAnswer = options.streamFinishAsAnswer === true;
  const plannerToolDefinitions = Array.isArray(options.plannerToolDefinitions)
    ? options.plannerToolDefinitions
    : resolveRepoSearchPlannerToolDefinitions();
  const activePlannerToolNames = plannerToolDefinitions.map((toolDefinition) => toolDefinition.function.name);
  const allowedPlannerToolNames = loopKind === 'chat'
    ? activePlannerToolNames
    : Array.from(new Set<string>([
      ...activePlannerToolNames,
      ...getRepoSearchToolNamesForParsing(),
    ]));
  const chatWebGroundingEnabled = loopKind === 'chat'
    && allowedPlannerToolNames.includes('web_search')
    && allowedPlannerToolNames.includes('web_fetch');
  const chatWebGroundingPolicy = new ChatGroundingPolicy({
    enabled: chatWebGroundingEnabled,
    retainedWebToolCalls: options.retainedWebToolCalls,
  });
  const slotId = options.config ? allocateLlamaCppSlotId(options.config) : 0;
  const ignorePolicy = buildIgnorePolicy(options.repoRoot);
  const bootstrapFileListSpan = options.timingRecorder?.start('repo.bootstrap.file_listing', {
    taskId: task.id,
    enabled: options.includeRepoFileListing !== false,
  });
  const bootstrapFileList = options.includeRepoFileListing === false
    ? undefined
    : (scanRepoFiles(options.repoRoot, ignorePolicy) || undefined);
  bootstrapFileListSpan?.end({
    fileCount: Array.isArray(bootstrapFileList) ? bootstrapFileList.length : 0,
  });
  const historicalToolStats = readLatestIdleSummaryToolStats();
  const recentEvidenceKeys = new Set<string>();
  const successfulToolCalls: Array<{ toolName: string; promptResultText: string }> = [];
  const duplicates = new DuplicateTracker();
  const forcedFinish = new ForcedFinishController();
  const resultBudgeter = new ToolResultBudgeter({
    config: options.config,
    useEstimatedTokensOnly,
    timingRecorder: options.timingRecorder || null,
  });
  const readWindows = new ReadWindowGovernor();
  let forcedFinishCountdownUserMessageIndex = -1;

  const baseSystemPrompt = typeof options.systemPromptOverride === 'string' && options.systemPromptOverride.trim()
    ? options.systemPromptOverride.trim()
    : buildTaskSystemPrompt(options.repoRoot, {
      includeAgentsMd: options.includeAgentsMd,
      includeRepoFileListing: options.includeRepoFileListing,
    });
  const systemPromptContent = chatWebGroundingEnabled
    ? `${baseSystemPrompt}\n\n${CHAT_GROUNDING_FINAL_ANSWER_INSTRUCTION}`
    : baseSystemPrompt;
  const progress = new ProgressReporter({
    onProgress: options.onProgress || null,
    taskId: task.id,
    maxTurns,
    taskStartedAt,
  });
  const transcript = new TranscriptManager({
    systemPromptContent,
    historyMessages: options.historyMessages || [],
    initialUserContent: loopKind === 'chat'
      ? task.question
      : buildTaskInitialUserPrompt(task.question, bootstrapFileList, {
        includeRepoFileListing: options.includeRepoFileListing,
      }),
  });

  for (let turn = 1; turn <= maxTurns; turn += 1) {
    throwIfAborted(options.abortSignal);
    turnsUsed = turn;
    const inForcedFinishMode = forcedFinish.isActive();

    const promptRenderSpan = options.timingRecorder?.start('repo.prompt.render', {
      taskId: task.id,
      turn,
      messageCount: transcript.length,
    });
    let providerPromptReserveText = buildPlannerRequestPromptReserveText({
      stage: 'planner_action',
      model: String(options.model || ''),
      messageRoles: transcript.messageRoles(),
      toolDefinitions: plannerToolDefinitions,
      maxTokens: budget.totalContextTokens,
      thinkingEnabled: plannerThinkingEnabled,
      reasoningContentEnabled: plannerReasoningContentEnabled,
      preserveThinking: plannerPreserveThinkingEnabled,
      stream: progress.enabled,
    });
    let prompt = transcript.render();
    promptRenderSpan?.end({ promptChars: prompt.length, providerPromptReserveChars: providerPromptReserveText.length });
    const preflightSpan = options.timingRecorder?.start('repo.prompt.preflight', {
      taskId: task.id,
      turn,
    });
    progress.preflightStart(turn, prompt.length);
    const preflightConfig = useEstimatedTokensOnly ? undefined : options.config;
    if (preflightConfig) {
      progress.tokenizeStart(turn, prompt.length);
    }
    let preflight = await preflightPlannerPromptBudget({
      config: preflightConfig,
      prompt,
      providerPromptReserveText,
      totalContextTokens: budget.totalContextTokens,
      thinkingBufferTokens: budget.thinkingBufferTokens,
    });
    preflightSpan?.end({
      promptTokenCount: preflight.promptTokenCount,
      overflowTokens: preflight.overflowTokens,
      ok: preflight.ok,
    });
    progress.preflightDone(turn, prompt.length, preflight.promptTokenCount);
    if (preflight.tokenizationAttempted) {
      progress.tokenizeDone(turn, prompt.length, preflight);
    }
    let maxOutputTokens = getDynamicMaxOutputTokens({
      totalContextTokens: budget.totalContextTokens,
      promptTokenCount: preflight.promptTokenCount,
    });

    options.logger?.write({
      kind: 'turn_preflight_budget', taskId: task.id, turn,
      promptTokenCount: preflight.promptTokenCount,
      transcriptPromptTokenCount: preflight.transcriptPromptTokenCount,
      providerPromptReserveTokenCount: preflight.providerPromptReserveTokenCount,
      maxPromptBudget: preflight.maxPromptBudget,
      overflowTokens: preflight.overflowTokens, ok: preflight.ok, compacted: false, maxOutputTokens,
    });

    if (!preflight.ok) {
      const compactionSpan = options.timingRecorder?.start('repo.prompt.compact', {
        taskId: task.id,
        turn,
        beforePromptTokenCount: preflight.promptTokenCount,
      });
      const compacted = await compactPlannerMessagesOnce({
        messages: transcript.getMessages(),
        config: useEstimatedTokensOnly ? undefined : options.config,
        maxPromptBudget: preflight.maxPromptBudget,
        providerPromptReserveText,
      });
      transcript.replaceWith(compacted.messages);
      const beforeProviderPromptReserveTokenCount = preflight.providerPromptReserveTokenCount;
      providerPromptReserveText = buildPlannerRequestPromptReserveText({
        stage: 'planner_action',
        model: String(options.model || ''),
        messageRoles: transcript.messageRoles(),
        toolDefinitions: plannerToolDefinitions,
        maxTokens: budget.totalContextTokens,
        thinkingEnabled: plannerThinkingEnabled,
        reasoningContentEnabled: plannerReasoningContentEnabled,
        preserveThinking: plannerPreserveThinkingEnabled,
        stream: progress.enabled,
      });
      prompt = transcript.render();
      if (preflightConfig) {
        progress.tokenizeStart(turn, prompt.length);
      }
      const afterCompaction = await preflightPlannerPromptBudget({
        config: preflightConfig, prompt, providerPromptReserveText,
        totalContextTokens: budget.totalContextTokens, thinkingBufferTokens: budget.thinkingBufferTokens,
      });
      if (afterCompaction.tokenizationAttempted) {
        progress.tokenizeDone(turn, prompt.length, afterCompaction);
      }
      compactionSpan?.end({
        afterPromptTokenCount: afterCompaction.promptTokenCount,
        droppedMessageCount: compacted.droppedMessageCount,
      });
      maxOutputTokens = getDynamicMaxOutputTokens({
        totalContextTokens: budget.totalContextTokens,
        promptTokenCount: afterCompaction.promptTokenCount,
      });
      options.logger?.write({
        kind: 'turn_preflight_compaction_applied', taskId: task.id, turn,
        beforePromptTokenCount: preflight.promptTokenCount,
        afterPromptTokenCount: afterCompaction.promptTokenCount,
        transcriptPromptTokenCount: afterCompaction.transcriptPromptTokenCount,
        beforeProviderPromptReserveTokenCount,
        providerPromptReserveTokenCount: afterCompaction.providerPromptReserveTokenCount,
        maxPromptBudget: afterCompaction.maxPromptBudget,
        droppedMessageCount: compacted.droppedMessageCount,
        summaryInserted: compacted.summaryInserted,
        maxOutputTokens,
      });
      preflight = afterCompaction;
    }

    if (!preflight.ok) {
      const overflowError = new Error(
        `planner_preflight_overflow prompt_tokens=${preflight.promptTokenCount} `
        + `max_prompt_tokens=${preflight.maxPromptBudget} overflow_tokens=${preflight.overflowTokens} `
        + `max_output_tokens=${maxOutputTokens} total_context_tokens=${budget.totalContextTokens} `
        + `thinking_buffer_tokens=${budget.thinkingBufferTokens}`,
      );
      options.logger?.write({
        kind: 'turn_preflight_overflow_fail', taskId: task.id, turn,
        promptTokenCount: preflight.promptTokenCount,
        transcriptPromptTokenCount: preflight.transcriptPromptTokenCount,
        providerPromptReserveTokenCount: preflight.providerPromptReserveTokenCount,
        maxPromptBudget: preflight.maxPromptBudget,
        overflowTokens: preflight.overflowTokens, maxOutputTokens,
        totalContextTokens: budget.totalContextTokens, thinkingBufferTokens: budget.thinkingBufferTokens,
        error: overflowError.message,
      });
      throw overflowError;
    }

    options.logger?.write({ kind: 'turn_model_request', taskId: task.id, turn, thinkingEnabled: plannerThinkingEnabled });
    progress.llmStart(turn, preflight.promptTokenCount);
    const newMessages = transcript.takeNewMessagesForLogging();
    options.logger?.write({ kind: 'turn_new_messages', taskId: task.id, turn, messages: newMessages, promptTokenCount: preflight.promptTokenCount });

    const providerSpan = options.timingRecorder?.start('repo.llama.request', {
      taskId: task.id,
      turn,
      promptTokenCount: preflight.promptTokenCount,
      maxOutputTokens,
      mock: Array.isArray(options.mockResponses),
    });
    let response: PlannerActionResponse;
    try {
      response = await requestPlannerAction({
        baseUrl: options.baseUrl,
        model: options.model,
        messages: transcript.getMessages(),
        slotId,
        timeoutMs: options.timeoutMs || DEFAULT_TIMEOUT_MS,
        maxTokens: maxOutputTokens,
        thinkingEnabled: plannerThinkingEnabled,
        reasoningContentEnabled: plannerReasoningContentEnabled,
        preserveThinking: plannerPreserveThinkingEnabled,
        stream: progress.enabled,
        onThinkingDelta: progress.enabled
          ? (accThinking) => { progress.thinking(turn, accThinking); }
          : undefined,
        onContentDelta: progress.enabled
          ? (accContent) => {
              if (streamFinishAsAnswer) {
                const finishOutput = ModelJson.extractStreamingFinishOutput(accContent);
                if (finishOutput !== null) {
                  progress.answer(turn, finishOutput);
                }
              } else {
                const finishOutput = ModelJson.extractStreamingFinishOutput(accContent) ?? accContent;
                progress.thinking(turn, finishOutput);
              }
            }
          : undefined,
        mockResponses: options.mockResponses,
        mockResponseIndex,
        abortSignal: options.abortSignal,
        logger: options.logger || null,
        toolDefinitions: plannerToolDefinitions,
      });
    } finally {
      providerSpan?.end();
    }

    progress.llmEnd(turn, preflight.promptTokenCount);
    if (typeof response.nextMockResponseIndex === 'number') {
      mockResponseIndex = response.nextMockResponseIndex;
    }

    options.logger?.write({
      kind: 'turn_model_response', taskId: task.id, turn,
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
      turnThinking[turn] = turnThinkingText;
    }

    const resolvedCompletionTokens = tokenUsage.recordModelResponse(response).completionTokens;

    if (response.mockExhausted) { reason = 'mock_responses_exhausted'; break; }

    let action;
    const parseSpan = options.timingRecorder?.start('repo.response.parse', {
      taskId: task.id,
      turn,
      responseChars: String(response.text || '').length,
    });
    try {
      action = ModelJson.parseRepoSearchPlannerAction(response.text, { allowedToolNames: allowedPlannerToolNames });
      parseSpan?.end({ ok: true });
      options.logger?.write({ kind: 'turn_action_parsed', taskId: task.id, turn, action });
    } catch (error) {
      parseSpan?.end({ ok: false });
      tokenUsage.addOutputTokens(resolvedCompletionTokens);
      invalidResponses += 1;
      const invalidActionMessage = `Invalid action: ${error instanceof Error ? error.message : String(error)}. Return a valid JSON finish action or tool action payload.`;
      const invalidToolAction = buildInvalidToolCallActionFromResponseText(String(response.text || ''), allowedPlannerToolNames);
      transcript.appendToolExchange(
        invalidToolAction,
        `invalid_call_${invalidResponses}`,
        invalidActionMessage,
        String(response.thinkingText || '').trim(),
      );
      options.logger?.write({
        kind: 'turn_action_invalid',
        taskId: task.id,
        turn,
        invalidResponses,
        error: error instanceof Error ? error.message : String(error),
        toolAction: invalidToolAction,
        toolResultText: invalidActionMessage,
      });
      if (invalidResponses >= maxInvalidResponses) { reason = 'invalid_response_limit'; break; }
      continue;
    }

    // Emit native thinking text (from reasoning_content) to UI
    if (response.thinkingText) {
      progress.thinking(turn, response.thinkingText);
    }

    if (action.action === 'finish') {
      tokenUsage.addOutputTokens(resolvedCompletionTokens);
      const finishEvaluation = evaluateFinishAttempt({
        loopKind,
        finalOutput: action.output,
        successfulToolCalls,
      });
      if (!finishEvaluation.allowed) {
        const warning = finishEvaluation.warning || 'Need stronger repository evidence before finishing.';
        toolStats.recordFinishRejection();
        transcript.pushAssistant(buildAssistantReplayMessage(response.text, String(response.thinkingText || '').trim()));
        transcript.pushUser(warning);
        options.logger?.write({ kind: 'turn_finish_rejected', taskId: task.id, turn, toolCallTurns: commands.length, minToolCallsBeforeFinish, warning });
        continue;
      }
      const groundingDecision = chatWebGroundingPolicy.evaluateFinish();
      if (groundingDecision.kind === 'reject') {
        toolStats.recordFinishRejection();
        transcript.pushAssistant(buildAssistantReplayMessage(response.text, String(response.thinkingText || '').trim()));
        transcript.pushUser(groundingDecision.message);
        options.logger?.write({
          kind: 'chat_grounding_finish_rejected',
          taskId: task.id,
          turn,
          status: chatWebGroundingPolicy.getStatus(),
        });
        continue;
      }
      finalOutput = action.output;
      if (streamFinishAsAnswer) {
        progress.answer(turn, finalOutput);
      }
      reason = 'finish';
      break;
    }

    // Tool action
    const toolActions = action.action === 'tool_batch'
      ? action.tool_calls.map((toolCall) => ({
        action: 'tool' as const,
        tool_name: toolCall.tool_name,
        args: toolCall.args,
      }))
      : [action];
    const batchOutcomes: ToolBatchOutcome[] = [];
    const pendingModeChangeUserMessages: string[] = [];
    let pendingForcedFinishCountdownText: string | null = null;
    let batchDuplicateAnchorIndex: number | null = null;
    let acceptedToolPromptTokensThisTurn = 0;

    for (const toolAction of toolActions) {
      const normalizedToolName = String(toolAction.tool_name || '').trim().toLowerCase();
      const isCommandTool = isRepoSearchCommandToolName(normalizedToolName);
      const isNativeTool = isRepoSearchNativeToolName(normalizedToolName);
      if (!isCommandTool && !isNativeTool) {
        invalidResponses += 1;
        const unsupportedToolMessage = `Invalid action: unsupported planner tool "${toolAction.tool_name}" for repo-search. Use one of: ${allowedPlannerToolNames.join(', ')}.`;
        batchOutcomes.push({
          action: { tool_name: String(toolAction.tool_name || '').trim() || 'invalid_tool_call', args: toolAction.args },
          toolCallId: `invalid_call_${invalidResponses}`,
          toolContent: unsupportedToolMessage,
        });
        options.logger?.write({
          kind: 'turn_action_invalid',
          taskId: task.id,
          turn,
          invalidResponses,
          error: unsupportedToolMessage,
          toolAction,
          toolResultText: unsupportedToolMessage,
        });
        if (invalidResponses >= maxInvalidResponses) { reason = 'invalid_response_limit'; break; }
        continue;
      }
      let nativeExecution: NativeRepoToolExecution | null = null;
      const command = isCommandTool
        ? (typeof toolAction.args.command === 'string' ? toolAction.args.command : '')
        : buildNativeRepoToolRequestedCommand(normalizedToolName, toolAction.args);
      if (isCommandTool && !command.trim()) {
        invalidResponses += 1;
        const invalidCommandMessage = `Invalid action: ${normalizedToolName} requires args.command.`;
        batchOutcomes.push({
          action: { tool_name: normalizedToolName, args: toolAction.args },
          toolCallId: `invalid_call_${invalidResponses}`,
          toolContent: invalidCommandMessage,
        });
        options.logger?.write({
          kind: 'turn_action_invalid',
          taskId: task.id,
          turn,
          invalidResponses,
          error: invalidCommandMessage,
          toolAction,
          toolResultText: invalidCommandMessage,
        });
        if (invalidResponses >= maxInvalidResponses) { reason = 'invalid_response_limit'; break; }
        continue;
      }
      const expectedCommandToken = isCommandTool ? getRepoSearchCommandTokenForToolName(normalizedToolName) : null;
      const actualCommandToken = isCommandTool ? getFirstCommandToken(command) : null;
      if (isCommandTool && (!expectedCommandToken || actualCommandToken !== expectedCommandToken)) {
        invalidResponses += 1;
        const invalidToolCommandMessage = `Invalid action: ${normalizedToolName} only allows commands starting with '${expectedCommandToken || '<unknown>'}'.`;
        batchOutcomes.push({
          action: { tool_name: normalizedToolName, args: toolAction.args },
          toolCallId: `invalid_call_${invalidResponses}`,
          toolContent: invalidToolCommandMessage,
        });
        options.logger?.write({
          kind: 'turn_action_invalid',
          taskId: task.id,
          turn,
          invalidResponses,
          error: invalidToolCommandMessage,
          toolAction,
          toolResultText: invalidToolCommandMessage,
        });
        if (invalidResponses >= maxInvalidResponses) { reason = 'invalid_response_limit'; break; }
        continue;
      }
      if (inForcedFinishMode) {
        const attempt = forcedFinish.consumeAttempt();
        commandFailures += 1;
        commands.push({ command, turn, safe: false, reason: attempt.rejectionReason, exitCode: null, output: `Rejected command: ${attempt.rejectionReason}` });
        batchOutcomes.push({
          action: buildEffectiveTranscriptAction({
            toolName: normalizedToolName,
            rawArgs: toolAction.args,
            isNativeTool,
            commandToRun: command,
          }),
          toolCallId: `forced_finish_call_${commands.length}`,
          toolContent: `Rejected command: ${attempt.rejectionReason}`,
        });
        pendingForcedFinishCountdownText = attempt.countdownText;
        if (attempt.exhausted) { reason = 'forced_finish_attempt_limit'; break; }
        continue;
      }

      const normalized = isNativeTool
        ? { command, rewritten: false, note: '', rejected: false }
        : normalizePlannerCommand(command, { repoRoot: options.repoRoot, ignorePolicy });
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
    const { isExactDuplicate, isSemanticDuplicate, duplicateFingerprint } = duplicates.classify({
      toolName: normalizedToolName,
      normalizedKey,
      fingerprint,
      rejected: Boolean(normalized.rejected),
    });
    const canAdvanceRepeatedRead = normalizedToolName === 'repo_read_file' || Boolean(!isNativeTool && parseGetContentReadWindowCommand(normalizedKey));
    if (chatWebGroundingEnabled && (normalizedToolName === 'web_search' || normalizedToolName === 'web_fetch')) {
      const duplicateDecision = chatWebGroundingPolicy.evaluateToolCall(normalizedToolName, toolAction.args);
      if (duplicateDecision.kind === 'reject') {
        commandFailures += 1;
        commands.push({
          command,
          turn,
          safe: false,
          reason: 'duplicate web tool',
          exitCode: null,
          output: duplicateDecision.message,
        });
        batchOutcomes.push({
          action: buildEffectiveTranscriptAction({
            toolName: normalizedToolName,
            rawArgs: toolAction.args,
            isNativeTool,
            commandToRun: command,
          }),
          toolCallId: `duplicate_web_call_${commands.length}`,
          toolContent: duplicateDecision.message,
        });
        continue;
      }
    }
    if (!canAdvanceRepeatedRead && (isExactDuplicate || isSemanticDuplicate)) {
      const registration = duplicates.registerDuplicate(duplicateFingerprint, transcript.length);
      const duplicateMessage = buildRepeatedToolCallSummary(normalizedToolName, registration.count);
      commandFailures += 1;
      const rejectionReason = isExactDuplicate ? 'duplicate command' : 'semantic duplicate command';
      commands.push({ command, turn, safe: false, reason: rejectionReason, exitCode: null, output: `Rejected: ${duplicateMessage}` });
      if (registration.activeReplayMessageIndex !== null) {
        transcript.replaceToolMessage(registration.activeReplayMessageIndex, duplicateMessage);
      } else {
        const duplicateToolCallId = `duplicate_call_${commands.length}`;
        batchOutcomes.push({
          action: buildEffectiveTranscriptAction({
            toolName: normalizedToolName,
            rawArgs: toolAction.args,
            isNativeTool,
            commandToRun: command,
          }),
          toolCallId: duplicateToolCallId,
          toolContent: duplicateMessage,
        });
        batchDuplicateAnchorIndex = batchOutcomes.length - 1;
      }
      if (isSemanticDuplicate) {
        toolStats.recordSemanticRepeatReject(prospectiveToolType);
        options.logger?.write({
          kind: 'turn_semantic_repeat_rejected',
          taskId: task.id,
          turn,
          command,
          fingerprint,
          repeats: registration.count,
        });
      }
      if (duplicates.shouldForceFinish() && !forcedFinish.isActive()) {
        pendingModeChangeUserMessages.push(forcedFinish.activateFromStagnation());
        toolStats.recordForcedFinishFromStagnation(prospectiveToolType);
        options.logger?.write({
          kind: 'turn_forced_finish_mode_started',
          taskId: task.id,
          turn,
          attemptsRemaining: FORCED_FINISH_MAX_ATTEMPTS,
          trigger: isSemanticDuplicate ? 'semantic_repetition' : 'consecutive_duplicates',
        });
      }
      continue;
    }
    if (isNativeTool) {
      if (normalizedToolName === 'repo_read_file') {
        const nativeReadPlan = planRepoReadFile(toolAction.args, options.repoRoot, ignorePolicy, readWindows.stateMap);
        nativeExecution = isFailedRepoReadFilePlan(nativeReadPlan)
          ? { ok: false, command: nativeReadPlan.command, reason: nativeReadPlan.reason, toolType: normalizedToolName }
          : buildRepoReadFileExecution(normalizedToolName, nativeReadPlan, null);
      } else if (options.mockCommandResults && options.mockCommandResults[command]) {
        const mockResult = options.mockCommandResults[command];
        nativeExecution = {
          ok: true,
          requestedCommand: command,
          command,
          exitCode: Number(mockResult.exitCode),
          output: [mockResult.stdout, mockResult.stderr]
            .filter((part) => typeof part === 'string' && part.length > 0)
            .join('\n'),
          toolType: normalizedToolName,
        };
      } else {
        nativeExecution = await executeNativeRepoTool(normalizedToolName, toolAction.args, options.repoRoot, ignorePolicy, webTools, readWindows.stateMap);
      }
    }
    if (isNativeTool && nativeExecution && !nativeExecution.ok) {
      safetyRejects += 1;
      const rejection = `Rejected command: ${nativeExecution.reason}`;
      commands.push({ command, turn, safe: false, reason: nativeExecution.reason, exitCode: null, output: rejection });
      batchOutcomes.push({
        action: buildEffectiveTranscriptAction({
          toolName: normalizedToolName,
          rawArgs: toolAction.args,
          isNativeTool,
          commandToRun: nativeExecution.command,
        }),
        toolCallId: `rejected_call_${commands.length}`,
        toolContent: rejection,
      });
      continue;
    }
    if (!isNativeTool && normalized.rejected) {
      safetyRejects += 1;
      const rejection = `Rejected command: ${normalized.rejectedReason}`;
      commands.push({ command, turn, safe: false, reason: normalized.rejectedReason || null, exitCode: null, output: rejection });
      batchOutcomes.push({
        action: buildEffectiveTranscriptAction({
          toolName: normalizedToolName,
          rawArgs: toolAction.args,
          isNativeTool,
          commandToRun: command,
        }),
        toolCallId: `rejected_call_${commands.length}`,
        toolContent: rejection,
      });
      continue;
    }

    const requestedCommand = isNativeTool && nativeExecution?.ok
      ? nativeExecution.requestedCommand || command
      : command;
    const normalizedCommand = isNativeTool && nativeExecution?.ok ? nativeExecution.command : isNativeTool ? command : normalized.command;
    const preExecutionPerToolCapTokens = budget.perToolCapTokens(commands.length);
    const parsedReadWindow = isNativeTool ? null : parseGetContentReadWindowCommand(normalizedCommand);
    let commandToRun = normalizedCommand;
    let lineReadAdjustment: LineReadAdjustment | null = null;

    if (parsedReadWindow) {
      const planned = readWindows.planAdjustment({
        parsedReadWindow,
        perToolCapTokens: preExecutionPerToolCapTokens,
        currentGetContentStats: toolStats.get('get-content'),
        historicalGetContentStats: historicalToolStats['get-content'] || null,
      });
      if (planned) {
        commandToRun = planned.commandToRun;
        lineReadAdjustment = planned.adjustment;
      }
    }

    const safety = isNativeTool
      ? { safe: true, reason: null }
      : evaluateCommandSafety(commandToRun, options.repoRoot);
    options.logger?.write({ kind: 'turn_command_safety', taskId: task.id, turn, command: commandToRun, safe: safety.safe, reason: safety.reason });

    if (!safety.safe) {
      safetyRejects += 1;
      const rejection = `Rejected command: ${safety.reason}`;
      commands.push({ command: commandToRun, turn, safe: false, reason: safety.reason, exitCode: null, output: rejection });
      const rejectedModelVisibleCommand = isNativeTool || lineReadAdjustment || !normalized.rewritten
        ? commandToRun
        : requestedCommand;
      batchOutcomes.push({
        action: buildEffectiveTranscriptAction({
          toolName: normalizedToolName,
          rawArgs: toolAction.args,
          isNativeTool,
          commandToRun: rejectedModelVisibleCommand,
        }),
        toolCallId: `rejected_call_${commands.length}`,
        toolContent: rejection,
      });
      continue;
    }

    const promptTokenCount = preflight.promptTokenCount;
    const progressToolCallId = `tc_${progressToolCallSeq}`;
    progressToolCallSeq += 1;
    progress.toolStart(progressToolCallId, turn, requestedCommand, promptTokenCount);

    const toolExecutionSpan = options.timingRecorder?.start('repo.tool.execute', {
      taskId: task.id,
      turn,
      toolName: normalizedToolName,
      commandChars: commandToRun.length,
      native: isNativeTool,
    });
    const executed = isNativeTool && nativeExecution && nativeExecution.ok
      ? { exitCode: nativeExecution.exitCode, output: nativeExecution.output }
      : await executeRepoCommand(commandToRun, options.repoRoot, options.mockCommandResults || null, options.abortSignal);
    toolExecutionSpan?.end({
      exitCode: executed.exitCode,
      outputChars: String(executed.output || '').length,
    });
    const baseOutput = String(executed.output || '').trim();
    if (normalizedToolName === 'web_search' || normalizedToolName === 'web_fetch') {
      chatWebGroundingPolicy.recordToolResult({
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
    let readMetrics = { overlapLines: 0, newLinesCovered: 0, cumulativeUniqueLines: 0 };
    if (parsedReadWindow) {
      readMetrics = readWindows.recordExecution({
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
      commandFailures += 1;
    }

    let zeroOutputWarningText = '';
    const zeroOutputObservation = forcedFinish.recordToolOutput(baseOutput.length);
    if (baseOutput.length === 0) {
      zeroOutputWarningText = zeroOutputObservation.warningText;
      options.logger?.write({
        kind: 'turn_zero_output_countdown', taskId: task.id, turn,
        zeroOutputStreak: zeroOutputObservation.zeroOutputStreak,
        remainingBeforeForce: zeroOutputObservation.remainingBeforeForce,
      });
      if (zeroOutputObservation.activated) {
        pendingModeChangeUserMessages.push(FORCED_FINISH_MODE_MESSAGE);
        options.logger?.write({
          kind: 'turn_forced_finish_mode_started', taskId: task.id, turn, attemptsRemaining: FORCED_FINISH_MAX_ATTEMPTS,
        });
      }
    }

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
    const perToolCapTokens = budget.perToolCapTokens(commands.length);
    const remainingTokenAllowance = budget.remainingToolAllowance(promptTokenCount, acceptedToolPromptTokensThisTurn);
    const fitted = await resultBudgeter.fit({
      taskId: task.id,
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
          lineReadTokensTotal: Math.max(1, estimateTokenCount(options.config, resultText)),
        };
        readWindows.recordNativeReturnedRange(nativeExecution.readFile.pathKey, {
          start: nativeExecution.readFile.startLine,
          end: returnedEndLineExclusive,
        });
      }
    }
    if (!isNativeTool && parsedReadWindow && executedReadWindow) {
      readWindows.applyFitTruncation({ parsedReadWindow, executedReadWindow, fittedReturnedSegmentCount, metrics: readMetrics });
    }
    const toolType = isNativeTool
      ? normalizedToolName
      : normalizeToolTypeFromCommand(commandToRun);
    toolStats.recordToolCall({
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
        recentEvidenceKeys,
      });
    toolStats.recordNovelty(toolType, novelty.hasNewEvidence);
    for (const evidenceKey of novelty.evidenceKeys) {
      recentEvidenceKeys.add(evidenceKey);
    }
    if (novelty.evidenceKeys.length > 0) {
      successfulToolCalls.push({ toolName: toolType, promptResultText: resultText });
    }

    const modelVisibleCommand = isNativeTool || lineReadAdjustment || !normalized.rewritten
      ? commandToRun
      : requestedCommand;
    if (progress.enabled) {
      const snippet = resultText.length > 200 ? `${resultText.slice(0, 200)}...` : resultText;
      progress.toolResult({
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

    options.logger?.write({
      kind: 'turn_command_result', taskId: task.id, turn, command: commandToRun,
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
    tokenUsage.addToolTokens(resultTokenCount);

    commands.push({
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
      duplicates.recordSuccess(normalizedKey, fingerprint || null);
    }
    const toolCallId = `call_${commands.length}`;
    batchOutcomes.push({
      action: buildEffectiveTranscriptAction({
        toolName: normalizedToolName,
        rawArgs: toolAction.args,
        isNativeTool,
        commandToRun: modelVisibleCommand,
      }),
      toolCallId,
      toolContent: resultText,
    });
    acceptedToolPromptTokensThisTurn += Math.max(0, Math.ceil(resultTokenCount));
    }

    const appendSpan = options.timingRecorder?.start('repo.tool.append', {
      taskId: task.id,
      turn,
      outcomeCount: batchOutcomes.length,
      beforeMessageCount: transcript.length,
    });
    const preAppendMessagesLength = transcript.appendBatchExchange(
      batchOutcomes,
      String(response.thinkingText || '').trim(),
    );
    appendSpan?.end({ afterMessageCount: transcript.length });
    if (batchDuplicateAnchorIndex !== null && batchOutcomes.length > 0) {
      duplicates.setReplayToolMessageIndex(preAppendMessagesLength + 1 + batchDuplicateAnchorIndex);
    }
    for (const userMessage of pendingModeChangeUserMessages) {
      transcript.pushUser(userMessage);
    }
    if (pendingForcedFinishCountdownText !== null) {
      forcedFinishCountdownUserMessageIndex = transcript.upsertTrailingUser(
        forcedFinishCountdownUserMessageIndex,
        pendingForcedFinishCountdownText,
      );
    }
    if (reason === 'forced_finish_attempt_limit') {
      break;
    }
  }

  // Terminal synthesis if no final output — retry up to 3 times then hard-fail.
  if (!String(finalOutput || '').trim()) {
    const synthesisPrompt = buildTerminalSynthesisPrompt({
      question: task.question,
      reason,
      transcript: transcript.renderTail(2),
    });
    const synthesisPromptTokenCount = await countTokensWithFallback(
      useEstimatedTokensOnly ? undefined : options.config,
      synthesisPrompt,
    );
    const synthesisMaxTokens = getDynamicMaxOutputTokens({
      totalContextTokens: budget.totalContextTokens,
      promptTokenCount: synthesisPromptTokenCount,
    });
    options.logger?.write({
      kind: 'task_terminal_synthesis_requested',
      taskId: task.id,
      reason,
      promptTokenCount: synthesisPromptTokenCount,
      maxOutputTokens: synthesisMaxTokens,
    });
    const maxSynthesisAttempts = 3;
    let lastErrorMessage = '';
    let successAttempt = 0;
    for (let attempt = 1; attempt <= maxSynthesisAttempts; attempt += 1) {
      try {
        const synthesisResponse = await requestTerminalSynthesis({
          baseUrl: options.baseUrl,
          model: options.model,
          prompt: synthesisPrompt,
          timeoutMs: options.timeoutMs || DEFAULT_TIMEOUT_MS,
          mockResponses: options.mockResponses,
          mockResponseIndex,
          maxTokens: synthesisMaxTokens,
          thinkingEnabled: plannerThinkingEnabled,
          reasoningContentEnabled: plannerReasoningContentEnabled,
          preserveThinking: plannerPreserveThinkingEnabled,
          logger: options.logger || null,
          stream: streamFinishAsAnswer && Boolean(options.onProgress),
          onContentDelta: streamFinishAsAnswer && options.onProgress
            ? (answerText: string) => {
                options.onProgress!({ kind: 'answer', turn: turnsUsed, maxTurns, answerText });
              }
            : undefined,
        });
        if (typeof synthesisResponse.nextMockResponseIndex === 'number') {
          mockResponseIndex = synthesisResponse.nextMockResponseIndex;
        }
        const resolved = tokenUsage.recordModelResponse(synthesisResponse);
        tokenUsage.addOutputTokens(resolved.completionTokens);

        const text = String(synthesisResponse.text || '').trim();
        if (!synthesisResponse.mockExhausted && text) {
          finalOutput = text;
          if (streamFinishAsAnswer && options.onProgress) {
            options.onProgress({ kind: 'answer', turn: turnsUsed, maxTurns, answerText: finalOutput });
          }
          successAttempt = attempt;
          break;
        }
        lastErrorMessage = synthesisResponse.mockExhausted ? 'mock_exhausted' : 'empty_output';
        options.logger?.write({ kind: 'task_terminal_synthesis_retry', taskId: task.id, attempt, error: lastErrorMessage });
      } catch (error) {
        lastErrorMessage = error instanceof Error ? error.message : String(error);
        options.logger?.write({ kind: 'task_terminal_synthesis_retry', taskId: task.id, attempt, error: lastErrorMessage });
      }
    }
    if (!String(finalOutput || '').trim()) {
      options.logger?.write({ kind: 'task_terminal_synthesis_failed', taskId: task.id, reason, lastError: lastErrorMessage });
      throw new Error(`Terminal synthesis produced no usable output after ${maxSynthesisAttempts} attempts (reason=${reason}, last=${lastErrorMessage || 'unknown'}).`);
    }
    options.logger?.write({ kind: 'task_terminal_synthesis_result', taskId: task.id, attempt: successAttempt, finalOutput });
  }

  const evidenceParts = [finalOutput, ...commands.map((item) => item.output)];
  const signalCheck = evaluateTaskSignals(task, evidenceParts.join('\n'));
  const passed = signalCheck.passed && commandFailures === 0;

  options.logger?.write({
    kind: 'task_done', taskId: task.id, reason, turnsUsed, safetyRejects,
    invalidResponses, commandFailures, passed, missingSignals: signalCheck.missingSignals,
  });

  return {
    id: task.id, question: task.question, reason, turnsUsed, safetyRejects,
    invalidResponses, commandFailures, commands, turnThinking, finalOutput, passed,
    ...(chatWebGroundingEnabled ? { groundingStatus: chatWebGroundingPolicy.getStatus() } : {}),
    missingSignals: signalCheck.missingSignals,
    ...tokenUsage.snapshot(),
    toolStats: toolStats.snapshot(),
    readOverlapSummary: readWindows.summary(),
  };
}

// ---------------------------------------------------------------------------
// Scorecard
// ---------------------------------------------------------------------------

export type Scorecard = {
  runId: string;
  model: string;
  tasks: TaskResult[];
  totals: Record<string, number>;
  toolStats: Record<string, ToolTypeStats>;
  readOverlapSummary: ReadOverlapSummary;
  verdict: 'pass' | 'fail';
  failureReasons: string[];
};

export function buildScorecard(options: { runId: string; model: string; tasks: TaskResult[] }): Scorecard {
  const totals = {
    tasks: options.tasks.length,
    passed: options.tasks.filter((t) => t.passed).length,
    failed: options.tasks.filter((t) => !t.passed).length,
    commandsExecuted: options.tasks.reduce((s, t) => s + t.commands.length, 0),
    safetyRejects: options.tasks.reduce((s, t) => s + t.safetyRejects, 0),
    invalidResponses: options.tasks.reduce((s, t) => s + t.invalidResponses, 0),
    commandFailures: options.tasks.reduce((s, t) => s + Number(t.commandFailures || 0), 0),
    promptTokens: options.tasks.reduce((s, t) => s + Number(t.promptTokens || 0), 0),
    outputTokens: options.tasks.reduce((s, t) => s + Number(t.outputTokens || 0), 0),
    toolTokens: options.tasks.reduce((s, t) => s + Number(t.toolTokens || 0), 0),
    thinkingTokens: options.tasks.reduce((s, t) => s + Number(t.thinkingTokens || 0), 0),
    promptCacheTokens: options.tasks.reduce((s, t) => s + Number(t.promptCacheTokens || 0), 0),
    promptEvalTokens: options.tasks.reduce((s, t) => s + Number(t.promptEvalTokens || 0), 0),
    promptEvalDurationMs: options.tasks.reduce((s, t) => s + Number(t.promptEvalDurationMs || 0), 0),
    generationDurationMs: options.tasks.reduce((s, t) => s + Number(t.generationDurationMs || 0), 0),
  };
  const toolStats: Record<string, ToolTypeStats> = {};
  for (const task of options.tasks) {
    Object.assign(toolStats, mergeToolTypeStats(toolStats, task.toolStats || {}));
  }
  const readOverlapSummary = mergeReadOverlapSummaries(options.tasks.map((task) => task.readOverlapSummary));

  const failureReasons: string[] = [];
  for (const task of options.tasks) {
    if (task.passed) continue;
    if (task.missingSignals.length > 0) failureReasons.push(`${task.id}: missing signals [${task.missingSignals.join(', ')}]`);
    if (Number(task.commandFailures || 0) > 0) failureReasons.push(`${task.id}: command failures ${Number(task.commandFailures || 0)}`);
    if (task.missingSignals.length === 0 && Number(task.commandFailures || 0) === 0) failureReasons.push(`${task.id}: task failed`);
  }

  return {
    runId: options.runId,
    model: options.model,
    tasks: options.tasks,
    totals,
    toolStats,
    readOverlapSummary,
    verdict: totals.failed === 0 ? 'pass' : 'fail',
    failureReasons,
  };
}

// ---------------------------------------------------------------------------
// Model assertion
// ---------------------------------------------------------------------------

export function assertConfiguredModelPresent(model: string, availableModels: string[]): void {
  if (!Array.isArray(availableModels) || !availableModels.includes(model)) {
    throw new Error(`Configured model not found: ${model}. Available models: ${Array.isArray(availableModels) ? availableModels.join(', ') : 'none'}`);
  }
}

// ---------------------------------------------------------------------------
// Top-level entry point
// ---------------------------------------------------------------------------

export async function runRepoSearch(options: {
  repoRoot?: string;
  config?: SiftConfig | Record<string, unknown>;
  model?: string;
  baseUrl?: string;
  allowedTools?: string[];
  includeAgentsMd?: boolean;
  includeRepoFileListing?: boolean;
  maxTurns?: number;
  timeoutMs?: number;
  maxInvalidResponses?: number;
  minToolCallsBeforeFinish?: number;
  loopKind?: 'repo-search' | 'chat';
  allowEmptyTools?: boolean;
  streamFinishAsAnswer?: boolean;
  systemPromptOverride?: string;
  historyMessages?: ChatMessage[];
  thinkingEnabledOverride?: boolean;
  taskPrompt?: string;
  availableModels?: string[];
  mockResponses?: string[];
  mockCommandResults?: Record<string, RepoSearchMockCommandResult>;
  retainedWebToolCalls?: RetainedWebToolCall[];
  abortSignal?: AbortSignal;
  logger?: JsonLogger | null;
  onProgress?: ((event: RepoSearchProgressEvent) => void) | null;
  timingRecorder?: TemporaryTimingRecorder | null;
} = {}): Promise<Scorecard> {
  throwIfAborted(options.abortSignal);
  const plannerToolDefinitions = resolveRepoSearchPlannerToolDefinitions(options.allowedTools);
  if (plannerToolDefinitions.length === 0 && !options.allowEmptyTools) {
    throw new Error('No repo-search planner tools are enabled for the active preset.');
  }
  const path = await import('node:path');
  const repoRoot = path.resolve(options.repoRoot || process.cwd());
  const configSpan = options.timingRecorder?.start('repo.config.load', {
    provided: Boolean(options.config),
  });
  // In pass-through mode the prompt-budget math must use the host SiftKit's
  // real context window, not this client's (possibly stale) local NumCtx.
  const config = await applyHostLlamaRuntimeSettings(
    (options.config || await loadConfig({ ensure: true })) as SiftConfig,
  );
  configSpan?.end();
  const model = options.model || getConfiguredModel(config);
  const baseUrl = options.baseUrl || getConfiguredLlamaBaseUrl(config);

  options.logger?.write({ kind: 'run_start', repoRoot, requestedModel: options.model || null, configuredModel: model, baseUrl });

  const inventorySpan = options.timingRecorder?.start('repo.model_inventory', {
    mock: Array.isArray(options.mockResponses),
  });
  options.onProgress?.({ kind: 'model_inventory_start', elapsedMs: 0 });
  const availableModels = options.availableModels
    || (Array.isArray(options.mockResponses) ? [model] : await listLlamaCppModels(config));
  inventorySpan?.end({ modelCount: availableModels.length });
  options.onProgress?.({ kind: 'model_inventory_done', modelCount: availableModels.length, elapsedMs: 0 });
  options.logger?.write({ kind: 'model_inventory', configuredModel: model, availableModels });

  const tasksToRun: TaskDefinition[] = options.taskPrompt
    ? [{ id: 'repo-search', question: String(options.taskPrompt), signals: [] }]
    : TASK_PACK;

  const tasks: TaskResult[] = [];

  for (const task of tasksToRun) {
    throwIfAborted(options.abortSignal);
    const result = await runTaskLoop(task, {
      repoRoot,
      model,
      baseUrl,
      config,
      totalContextTokens: getConfiguredLlamaNumCtx(config),
      timeoutMs: options.timeoutMs || DEFAULT_TIMEOUT_MS,
      maxTurns: options.maxTurns || DEFAULT_MAX_TURNS,
      maxInvalidResponses: options.maxInvalidResponses || DEFAULT_MAX_INVALID_RESPONSES,
      minToolCallsBeforeFinish: options.minToolCallsBeforeFinish,
      loopKind: options.loopKind,
      streamFinishAsAnswer: options.streamFinishAsAnswer,
      systemPromptOverride: options.systemPromptOverride,
      historyMessages: options.historyMessages,
      thinkingEnabledOverride: options.thinkingEnabledOverride,
      plannerToolDefinitions,
      includeAgentsMd: options.includeAgentsMd,
      includeRepoFileListing: options.includeRepoFileListing,
      mockResponses: options.mockResponses,
      mockCommandResults: options.mockCommandResults,
      retainedWebToolCalls: options.retainedWebToolCalls,
      abortSignal: options.abortSignal,
      logger: options.logger || null,
      onProgress: options.onProgress || null,
      timingRecorder: options.timingRecorder || null,
    });
    tasks.push(result);
  }

  const scorecard = buildScorecard({ runId: randomUUID(), model, tasks });
  options.logger?.write({ kind: 'run_done', scorecard });
  return scorecard;
}
