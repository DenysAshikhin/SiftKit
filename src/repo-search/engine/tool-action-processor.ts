import type { SiftConfig } from '../../config/index.js';
import { getRepoSearchLineReadStats } from '../../line-read-guidance.js';
import type { TemporaryTimingRecorder } from '../../lib/temporary-timing-recorder.js';
import type { ToolTypeStats } from '../../status-server/metrics.js';
import {
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
  type ToolAction,
} from '../planner-protocol.js';
import { estimateTokenCount } from '../prompt-budget.js';
import {
  type LineReadAdjustment,
  type ParsedGetContentReadWindow,
  parseGetContentReadWindowCommand,
} from './read-overlap.js';
import type { TaskCommand } from '../prompts.js';
import {
  buildRepeatedToolCallSummary,
  buildPromptToolResult,
  classifyToolResultNovelty,
  fingerprintToolCall,
} from '../../tool-loop-governor.js';
import { ChatGroundingPolicy } from '../chat-grounding-policy.js';
import type { JsonLogger, RepoSearchMockCommandResult } from '../types.js';
import { type ToolBatchOutcome } from '../../tool-call-messages.js';
import { WebResearchTools } from '../../web-search/web-research-tools.js';
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
import { ReadWindowGovernor, type ReadExecutionMetrics } from './read-window-governor.js';
import { applyToolOutputRepetitionGuard, type LoopCounters, type TaskDefinition, type TurnOutcome } from './task-loop-support.js';
import { ToolResultBudgeter } from './tool-result-budgeter.js';
import { TokenUsageTracker } from './token-usage.js';
import { ToolStatsRecorder } from './tool-stats.js';
import { TranscriptManager } from './transcript-manager.js';
import { TurnBudget } from './turn-budget.js';

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

type PreparedCommand = {
  requestedCommand: string;
  commandToRun: string;
  lineReadAdjustment: LineReadAdjustment | null;
  parsedReadWindow: ParsedGetContentReadWindow | null;
};

type ExecutedToolContext = AcceptedToolContext & PreparedCommand & {
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

type FittedToolOutcome = {
  commandToRun: string;
  resultText: string;
  resultTokenCount: number;
  resultTokenCountEstimated: boolean;
  rawResultTokenCount: number;
  lineReadStats: { lineReadCalls?: number; lineReadLinesTotal?: number; lineReadTokensTotal?: number } | null;
  perToolCapTokens: number;
  remainingTokenAllowance: number;
};

export type ToolActionProcessorDeps = {
  task: TaskDefinition;
  repoRoot: string;
  config: SiftConfig | undefined;
  mockCommandResults?: Record<string, RepoSearchMockCommandResult>;
  abortSignal?: AbortSignal;
  logger: JsonLogger | null;
  timingRecorder: TemporaryTimingRecorder | null;
  maxInvalidResponses: number;
  allowedPlannerToolNames: string[];
  chatWebGroundingEnabled: boolean;
  chatWebGroundingPolicy: ChatGroundingPolicy;
  ignorePolicy: IgnorePolicy;
  webTools: WebResearchTools;
  historicalToolStats: Record<string, ToolTypeStats>;
  budget: TurnBudget;
  tokenUsage: TokenUsageTracker;
  toolStats: ToolStatsRecorder;
  duplicates: DuplicateTracker;
  forcedFinish: ForcedFinishController;
  resultBudgeter: ToolResultBudgeter;
  readWindows: ReadWindowGovernor;
  progress: ProgressReporter;
  transcript: TranscriptManager;
  recentEvidenceKeys: Set<string>;
  successfulToolCalls: Array<{ toolName: string; promptResultText: string }>;
  commands: TaskCommand[];
  counters: LoopCounters;
};

export class ToolActionProcessor {
  private progressToolCallSeq = 0;
  private forcedFinishCountdownUserMessageIndex = -1;

  constructor(private readonly deps: ToolActionProcessorDeps) {}

  async executeBatch(
    turn: number,
    toolActions: ToolAction[],
    responseThinkingText: string,
    promptTokenCount: number,
    inForcedFinishMode: boolean,
  ): Promise<TurnOutcome> {
    const { transcript, duplicates, counters } = this.deps;
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

    const appendSpan = this.deps.timingRecorder?.start('repo.tool.append', {
      taskId: this.deps.task.id,
      turn,
      outcomeCount: state.batchOutcomes.length,
      beforeMessageCount: transcript.length,
    });
    const preAppendMessagesLength = transcript.appendBatchExchange(
      state.batchOutcomes,
      responseThinkingText,
    );
    appendSpan?.end({ afterMessageCount: transcript.length });
    if (state.batchDuplicateAnchorIndex !== null && state.batchOutcomes.length > 0) {
      duplicates.setReplayToolMessageIndex(preAppendMessagesLength + 1 + state.batchDuplicateAnchorIndex);
    }
    for (const userMessage of state.pendingModeChangeUserMessages) {
      transcript.pushUser(userMessage);
    }
    if (state.pendingForcedFinishCountdownText !== null) {
      this.forcedFinishCountdownUserMessageIndex = transcript.upsertTrailingUser(
        this.forcedFinishCountdownUserMessageIndex,
        state.pendingForcedFinishCountdownText,
      );
    }
    return counters.reason === 'forced_finish_attempt_limit' ? 'stop' : 'continue';
  }

  private async processToolAction(
    turn: number,
    toolAction: ToolAction,
    state: TurnBatchState,
    promptTokenCount: number,
    inForcedFinishMode: boolean,
  ): Promise<ToolActionOutcome> {
    const { commands, counters, forcedFinish } = this.deps;
    const validated = this.validateToolAction(turn, toolAction, state);
    if (validated === 'next' || validated === 'stop_batch') {
      return validated;
    }
    const { normalizedToolName, isNativeTool, command } = validated;

    if (inForcedFinishMode) {
      const attempt = forcedFinish.consumeAttempt();
      counters.commandFailures += 1;
      commands.push({ command, turn, safe: false, reason: attempt.rejectionReason, exitCode: null, output: `Rejected command: ${attempt.rejectionReason}` });
      state.batchOutcomes.push({
        action: buildEffectiveTranscriptAction({
          toolName: normalizedToolName,
          rawArgs: toolAction.args,
          isNativeTool,
          commandToRun: command,
        }),
        toolCallId: `forced_finish_call_${commands.length}`,
        toolContent: `Rejected command: ${attempt.rejectionReason}`,
      });
      state.pendingForcedFinishCountdownText = attempt.countdownText;
      if (attempt.exhausted) {
        counters.reason = 'forced_finish_attempt_limit';
        return 'stop_batch';
      }
      return 'next';
    }

    const normalized: NormalizedCommand = isNativeTool
      ? { command, rewritten: false, note: '', rejected: false }
      : normalizePlannerCommand(command, { repoRoot: this.deps.repoRoot, ignorePolicy: this.deps.ignorePolicy });
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
    const { counters } = this.deps;
    const normalizedToolName = String(toolAction.tool_name || '').trim().toLowerCase();
    const isCommandTool = isRepoSearchCommandToolName(normalizedToolName);
    const isNativeTool = isRepoSearchNativeToolName(normalizedToolName);
    if (!isCommandTool && !isNativeTool) {
      counters.invalidResponses += 1;
      const unsupportedToolMessage = `Invalid action: unsupported planner tool "${toolAction.tool_name}" for repo-search. Use one of: ${this.deps.allowedPlannerToolNames.join(', ')}.`;
      state.batchOutcomes.push({
        action: { tool_name: String(toolAction.tool_name || '').trim() || 'invalid_tool_call', args: toolAction.args },
        toolCallId: `invalid_call_${counters.invalidResponses}`,
        toolContent: unsupportedToolMessage,
      });
      return this.logInvalidAction(turn, toolAction, unsupportedToolMessage);
    }
    const command = isCommandTool
      ? (typeof toolAction.args.command === 'string' ? toolAction.args.command : '')
      : buildNativeRepoToolRequestedCommand(normalizedToolName, toolAction.args);
    if (isCommandTool && !command.trim()) {
      counters.invalidResponses += 1;
      const invalidCommandMessage = `Invalid action: ${normalizedToolName} requires args.command.`;
      state.batchOutcomes.push({
        action: { tool_name: normalizedToolName, args: toolAction.args },
        toolCallId: `invalid_call_${counters.invalidResponses}`,
        toolContent: invalidCommandMessage,
      });
      return this.logInvalidAction(turn, toolAction, invalidCommandMessage);
    }
    const expectedCommandToken = isCommandTool ? getRepoSearchCommandTokenForToolName(normalizedToolName) : null;
    const actualCommandToken = isCommandTool ? getFirstCommandToken(command) : null;
    if (isCommandTool && (!expectedCommandToken || actualCommandToken !== expectedCommandToken)) {
      counters.invalidResponses += 1;
      const invalidToolCommandMessage = `Invalid action: ${normalizedToolName} only allows commands starting with '${expectedCommandToken || '<unknown>'}'.`;
      state.batchOutcomes.push({
        action: { tool_name: normalizedToolName, args: toolAction.args },
        toolCallId: `invalid_call_${counters.invalidResponses}`,
        toolContent: invalidToolCommandMessage,
      });
      return this.logInvalidAction(turn, toolAction, invalidToolCommandMessage);
    }
    return { normalizedToolName, isCommandTool, isNativeTool, command };
  }

  private logInvalidAction(turn: number, toolAction: ToolAction, message: string): ToolActionOutcome {
    const { counters } = this.deps;
    this.deps.logger?.write({
      kind: 'turn_action_invalid',
      taskId: this.deps.task.id,
      turn,
      invalidResponses: counters.invalidResponses,
      error: message,
      toolAction,
      toolResultText: message,
    });
    if (counters.invalidResponses >= this.deps.maxInvalidResponses) {
      counters.reason = 'invalid_response_limit';
      return 'stop_batch';
    }
    return 'next';
  }

  private screenWebAndDuplicates(
    turn: number,
    context: AcceptedToolContext,
    prospectiveToolType: string,
    state: TurnBatchState,
  ): ToolActionOutcome | null {
    const { toolAction, normalizedToolName, isNativeTool, command, normalized, fingerprint, normalizedKey } = context;
    const { commands, counters, duplicates, forcedFinish, toolStats, transcript } = this.deps;
    const { isExactDuplicate, isSemanticDuplicate, duplicateFingerprint } = duplicates.classify({
      toolName: normalizedToolName,
      normalizedKey,
      fingerprint,
      rejected: Boolean(normalized.rejected),
    });
    const canAdvanceRepeatedRead = normalizedToolName === 'repo_read_file' || Boolean(!isNativeTool && parseGetContentReadWindowCommand(normalizedKey));
    if (this.deps.chatWebGroundingEnabled && (normalizedToolName === 'web_search' || normalizedToolName === 'web_fetch')) {
      const duplicateDecision = this.deps.chatWebGroundingPolicy.evaluateToolCall(normalizedToolName, toolAction.args);
      if (duplicateDecision.kind === 'reject') {
        counters.commandFailures += 1;
        commands.push({
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
          toolCallId: `duplicate_web_call_${commands.length}`,
          toolContent: duplicateDecision.message,
        });
        return 'next';
      }
    }
    if (!canAdvanceRepeatedRead && (isExactDuplicate || isSemanticDuplicate)) {
      const registration = duplicates.registerDuplicate(duplicateFingerprint, transcript.length);
      const duplicateMessage = buildRepeatedToolCallSummary(normalizedToolName, registration.count);
      counters.commandFailures += 1;
      const rejectionReason = isExactDuplicate ? 'duplicate command' : 'semantic duplicate command';
      commands.push({ command, turn, safe: false, reason: rejectionReason, exitCode: null, output: `Rejected: ${duplicateMessage}` });
      if (registration.activeReplayMessageIndex !== null) {
        transcript.replaceToolMessage(registration.activeReplayMessageIndex, duplicateMessage);
      } else {
        const duplicateToolCallId = `duplicate_call_${commands.length}`;
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
        toolStats.recordSemanticRepeatReject(prospectiveToolType);
        this.deps.logger?.write({
          kind: 'turn_semantic_repeat_rejected',
          taskId: this.deps.task.id,
          turn,
          command,
          fingerprint,
          repeats: registration.count,
        });
      }
      if (duplicates.shouldForceFinish() && !forcedFinish.isActive()) {
        state.pendingModeChangeUserMessages.push(forcedFinish.activateFromStagnation());
        toolStats.recordForcedFinishFromStagnation(prospectiveToolType);
        this.deps.logger?.write({
          kind: 'turn_forced_finish_mode_started',
          taskId: this.deps.task.id,
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
      const nativeReadPlan = planRepoReadFile(toolAction.args, this.deps.repoRoot, this.deps.ignorePolicy, this.deps.readWindows.stateMap);
      return isFailedRepoReadFilePlan(nativeReadPlan)
        ? { ok: false, command: nativeReadPlan.command, reason: nativeReadPlan.reason, toolType: normalizedToolName }
        : buildRepoReadFileExecution(normalizedToolName, nativeReadPlan, null);
    }
    if (this.deps.mockCommandResults && this.deps.mockCommandResults[command]) {
      const mockResult = this.deps.mockCommandResults[command];
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
    return executeNativeRepoTool(normalizedToolName, toolAction.args, this.deps.repoRoot, this.deps.ignorePolicy, this.deps.webTools, this.deps.readWindows.stateMap);
  }

  private screenRejection(turn: number, context: AcceptedToolContext, state: TurnBatchState): ToolActionOutcome | null {
    const { toolAction, normalizedToolName, isNativeTool, command, normalized, nativeExecution } = context;
    const { commands, counters } = this.deps;
    if (isNativeTool && nativeExecution && !nativeExecution.ok) {
      counters.safetyRejects += 1;
      const rejection = `Rejected command: ${nativeExecution.reason}`;
      commands.push({ command, turn, safe: false, reason: nativeExecution.reason, exitCode: null, output: rejection });
      state.batchOutcomes.push({
        action: buildEffectiveTranscriptAction({
          toolName: normalizedToolName,
          rawArgs: toolAction.args,
          isNativeTool,
          commandToRun: nativeExecution.command,
        }),
        toolCallId: `rejected_call_${commands.length}`,
        toolContent: rejection,
      });
      return 'next';
    }
    if (!isNativeTool && normalized.rejected) {
      counters.safetyRejects += 1;
      const rejection = `Rejected command: ${normalized.rejectedReason}`;
      commands.push({ command, turn, safe: false, reason: normalized.rejectedReason || null, exitCode: null, output: rejection });
      state.batchOutcomes.push({
        action: buildEffectiveTranscriptAction({
          toolName: normalizedToolName,
          rawArgs: toolAction.args,
          isNativeTool,
          commandToRun: command,
        }),
        toolCallId: `rejected_call_${commands.length}`,
        toolContent: rejection,
      });
      return 'next';
    }
    return null;
  }

  private prepareCommandToRun(turn: number, context: AcceptedToolContext, state: TurnBatchState): PreparedCommand | 'next' {
    const { toolAction, normalizedToolName, isNativeTool, command, normalized, nativeExecution } = context;
    const { commands, counters } = this.deps;
    const requestedCommand = isNativeTool && nativeExecution?.ok
      ? nativeExecution.requestedCommand || command
      : command;
    const normalizedCommand = isNativeTool && nativeExecution?.ok ? nativeExecution.command : isNativeTool ? command : normalized.command;
    const preExecutionPerToolCapTokens = this.deps.budget.perToolCapTokens(commands.length);
    const parsedReadWindow = isNativeTool ? null : parseGetContentReadWindowCommand(normalizedCommand);
    let commandToRun = normalizedCommand;
    let lineReadAdjustment: LineReadAdjustment | null = null;

    if (parsedReadWindow) {
      const planned = this.deps.readWindows.planAdjustment({
        parsedReadWindow,
        perToolCapTokens: preExecutionPerToolCapTokens,
        currentGetContentStats: this.deps.toolStats.get('get-content'),
        historicalGetContentStats: this.deps.historicalToolStats['get-content'] || null,
      });
      if (planned) {
        commandToRun = planned.commandToRun;
        lineReadAdjustment = planned.adjustment;
      }
    }

    const safety = isNativeTool
      ? { safe: true, reason: null }
      : evaluateCommandSafety(commandToRun, this.deps.repoRoot);
    this.deps.logger?.write({ kind: 'turn_command_safety', taskId: this.deps.task.id, turn, command: commandToRun, safe: safety.safe, reason: safety.reason });

    if (!safety.safe) {
      counters.safetyRejects += 1;
      const rejection = `Rejected command: ${safety.reason}`;
      commands.push({ command: commandToRun, turn, safe: false, reason: safety.reason, exitCode: null, output: rejection });
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
        toolCallId: `rejected_call_${commands.length}`,
        toolContent: rejection,
      });
      return 'next';
    }
    return { requestedCommand, commandToRun, lineReadAdjustment, parsedReadWindow };
  }

  private async executeAcceptedTool(
    turn: number,
    context: AcceptedToolContext,
    state: TurnBatchState,
    promptTokenCount: number,
  ): Promise<ToolActionOutcome> {
    const { normalizedToolName, isNativeTool, normalized, nativeExecution } = context;
    const { counters, forcedFinish } = this.deps;
    const preparedCommand = this.prepareCommandToRun(turn, context, state);
    if (preparedCommand === 'next') {
      return 'next';
    }
    const { requestedCommand, commandToRun, lineReadAdjustment, parsedReadWindow } = preparedCommand;

    const progressToolCallId = `tc_${this.progressToolCallSeq}`;
    this.progressToolCallSeq += 1;
    this.deps.progress.toolStart(progressToolCallId, turn, requestedCommand, promptTokenCount);

    const toolExecutionSpan = this.deps.timingRecorder?.start('repo.tool.execute', {
      taskId: this.deps.task.id,
      turn,
      toolName: normalizedToolName,
      commandChars: commandToRun.length,
      native: isNativeTool,
    });
    const executed = isNativeTool && nativeExecution && nativeExecution.ok
      ? { exitCode: nativeExecution.exitCode, output: nativeExecution.output }
      : await executeRepoCommand(commandToRun, this.deps.repoRoot, this.deps.mockCommandResults || null, this.deps.abortSignal);
    toolExecutionSpan?.end({
      exitCode: executed.exitCode,
      outputChars: String(executed.output || '').length,
    });
    const baseOutput = String(executed.output || '').trim();
    if (normalizedToolName === 'web_search' || normalizedToolName === 'web_fetch') {
      this.deps.chatWebGroundingPolicy.recordToolResult({
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
      readMetrics = this.deps.readWindows.recordExecution({
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
      counters.commandFailures += 1;
    }

    let zeroOutputWarningText = '';
    const zeroOutputObservation = forcedFinish.recordToolOutput(baseOutput.length);
    if (baseOutput.length === 0) {
      zeroOutputWarningText = zeroOutputObservation.warningText;
      this.deps.logger?.write({
        kind: 'turn_zero_output_countdown', taskId: this.deps.task.id, turn,
        zeroOutputStreak: zeroOutputObservation.zeroOutputStreak,
        remainingBeforeForce: zeroOutputObservation.remainingBeforeForce,
      });
      if (zeroOutputObservation.activated) {
        state.pendingModeChangeUserMessages.push(FORCED_FINISH_MODE_MESSAGE);
        this.deps.logger?.write({
          kind: 'turn_forced_finish_mode_started', taskId: this.deps.task.id, turn, attemptsRemaining: FORCED_FINISH_MAX_ATTEMPTS,
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

  private async fitToolResult(
    turn: number,
    context: ExecutedToolContext,
    state: TurnBatchState,
    promptTokenCount: number,
  ): Promise<FittedToolOutcome> {
    const {
      normalizedToolName, isNativeTool, normalized, nativeExecution,
      requestedCommand, lineReadAdjustment, parsedReadWindow, executedReadWindow,
      executed, baseOutput, searchExit, readMetrics, outputForPrompt, zeroOutputWarningText,
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
    const perToolCapTokens = this.deps.budget.perToolCapTokens(this.deps.commands.length);
    const remainingTokenAllowance = this.deps.budget.remainingToolAllowance(promptTokenCount, state.acceptedToolPromptTokensThisTurn);
    const fitted = await this.deps.resultBudgeter.fit({
      taskId: this.deps.task.id,
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
          lineReadTokensTotal: Math.max(1, estimateTokenCount(this.deps.config, resultText)),
        };
        this.deps.readWindows.recordNativeReturnedRange(nativeExecution.readFile.pathKey, {
          start: nativeExecution.readFile.startLine,
          end: returnedEndLineExclusive,
        });
      }
    }
    if (!isNativeTool && parsedReadWindow && executedReadWindow) {
      this.deps.readWindows.applyFitTruncation({ parsedReadWindow, executedReadWindow, fittedReturnedSegmentCount, metrics: readMetrics });
    }
    return {
      commandToRun,
      resultText,
      resultTokenCount: fitted.resultTokenCount,
      resultTokenCountEstimated: fitted.resultTokenCountEstimated,
      rawResultTokenCount,
      lineReadStats: lineReadStats || null,
      perToolCapTokens,
      remainingTokenAllowance,
    };
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
      executed, baseOutput, searchExit, readMetrics, outputWithRewriteNote, progressToolCallId,
    } = context;
    const { commands, duplicates, progress, recentEvidenceKeys, successfulToolCalls, tokenUsage, toolStats } = this.deps;

    const fittedOutcome = await this.fitToolResult(turn, context, state, promptTokenCount);
    const {
      commandToRun, resultText, resultTokenCount, resultTokenCountEstimated,
      rawResultTokenCount, lineReadStats, perToolCapTokens, remainingTokenAllowance,
    } = fittedOutcome;

    const toolType = isNativeTool
      ? normalizedToolName
      : normalizeToolTypeFromCommand(commandToRun);
    toolStats.recordToolCall({
      toolType,
      resultTextLength: resultText.length,
      resultTokenCount,
      resultTokenCountEstimated,
      rawResultTokenCount,
      lineReadStats,
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

    this.deps.logger?.write({
      kind: 'turn_command_result', taskId: this.deps.task.id, turn, command: commandToRun,
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
}
