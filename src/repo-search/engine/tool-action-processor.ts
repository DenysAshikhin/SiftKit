import type { SiftConfig } from '../../config/index.js';
import { getRepoSearchLineReadStats } from '../../line-read-guidance.js';
import type { TemporaryTimingRecorder } from '../../lib/temporary-timing-recorder.js';
import {
  evaluateCommandSafety,
  getFirstCommandToken,
  type IgnorePolicy,
} from '../command-safety.js';
import {
  getRepoSearchCommandTokenForToolName,
  isRepoSearchCommandToolName,
  isRepoSearchNativeToolName,
  type ToolAction,
} from '../planner-protocol.js';
import { estimateTokenCount } from '../prompt-budget.js';
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
  buildReadCommand,
  buildReadExecution,
  buildRepoToolRequestedCommand,
  executeRepoTool,
  isFailedReadPlan,
  planRead,
  type RepoToolExecution,
} from './repo-tools.js';
import type { ApprovalGate } from './approval-gate.js';
import { DuplicateTracker } from './duplicate-tracker.js';
import { FORCED_FINISH_MAX_ATTEMPTS, FORCED_FINISH_MODE_MESSAGE, ForcedFinishController } from './forced-finish.js';
import { ProgressReporter } from './progress-reporter.js';
import { ReadWindowGovernor } from './read-window-governor.js';
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
  fingerprint: string;
  normalizedKey: string;
  nativeExecution: RepoToolExecution | null;
};

type PreparedCommand = {
  requestedCommand: string;
  commandToRun: string;
};

type ExecutedToolContext = AcceptedToolContext & PreparedCommand & {
  executed: { exitCode: number; output: string };
  baseOutput: string;
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
  approvalGate: ApprovalGate | null;
  chatWebGroundingEnabled: boolean;
  chatWebGroundingPolicy: ChatGroundingPolicy;
  ignorePolicy: IgnorePolicy;
  webTools: WebResearchTools;
  budget: TurnBudget;
  tokenUsage: TokenUsageTracker;
  toolStats: ToolStatsRecorder;
  duplicates: DuplicateTracker;
  forcedFinish: ForcedFinishController;
  resultBudgeter: ToolResultBudgeter;
  readWindows: ReadWindowGovernor;
  maintainPerStepThinking: boolean;
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
    transcript.pruneThinking(this.deps.maintainPerStepThinking);
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
    const { counters, forcedFinish } = this.deps;
    const validated = this.validateToolAction(turn, toolAction, state);
    if (validated === 'next' || validated === 'stop_batch') {
      return validated;
    }
    const { normalizedToolName, isNativeTool, command } = validated;

    if (inForcedFinishMode) {
      const attempt = forcedFinish.consumeAttempt();
      counters.commandFailures += 1;
      this.recordRejectedToolCall(turn, state, {
        toolName: normalizedToolName,
        rawArgs: toolAction.args,
        isNativeTool,
        recordedCommand: command,
        transcriptCommand: command,
        reason: attempt.rejectionReason,
        output: `Rejected command: ${attempt.rejectionReason}`,
        callIdPrefix: 'forced_finish_call',
      });
      state.pendingForcedFinishCountdownText = attempt.countdownText;
      if (attempt.exhausted) {
        counters.reason = 'forced_finish_attempt_limit';
        return 'stop_batch';
      }
      return 'next';
    }

    const fingerprint = fingerprintToolCall({ toolName: normalizedToolName, command });
    const prospectiveToolType = isNativeTool ? normalizedToolName : normalizeToolTypeFromCommand(command);
    const screened = this.screenWebAndDuplicates(turn, {
      ...validated,
      toolAction,
      fingerprint,
      normalizedKey: command,
      nativeExecution: null,
    }, prospectiveToolType, state);
    if (screened !== null) {
      return screened;
    }

    if (this.deps.approvalGate) {
      const decision = await this.deps.approvalGate.request({
        turn,
        toolName: normalizedToolName,
        command,
      });
      if (decision.kind === 'abort') {
        throw new Error('Aborted by user.');
      }
      if (decision.kind === 'deny') {
        counters.safetyRejects += 1;
        const reason = decision.reason ? `user denied — ${decision.reason}` : 'user denied this command';
        this.recordRejectedToolCall(turn, state, {
          toolName: normalizedToolName,
          rawArgs: toolAction.args,
          isNativeTool,
          recordedCommand: command,
          transcriptCommand: command,
          reason,
          output: `Rejected command: ${reason}`,
          callIdPrefix: 'denied_call',
        });
        return 'next';
      }
    }

    const nativeExecution = isNativeTool
      ? await this.runNativeExecution(normalizedToolName, toolAction, command)
      : null;
    const context: AcceptedToolContext = {
      ...validated,
      toolAction,
      fingerprint,
      normalizedKey: command,
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
    if (!this.deps.allowedPlannerToolNames.includes(normalizedToolName)) {
      counters.invalidResponses += 1;
      const disallowedToolMessage = `Invalid action: tool "${normalizedToolName}" is not enabled for this run. Use one of: ${this.deps.allowedPlannerToolNames.join(', ')}.`;
      state.batchOutcomes.push({
        action: { tool_name: normalizedToolName, args: toolAction.args },
        toolCallId: `invalid_call_${counters.invalidResponses}`,
        toolContent: disallowedToolMessage,
      });
      return this.logInvalidAction(turn, toolAction, disallowedToolMessage);
    }
    const command = isCommandTool
      ? (typeof toolAction.args.command === 'string' ? toolAction.args.command : '')
      : buildRepoToolRequestedCommand(normalizedToolName, toolAction.args);
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

  /** Records a rejected tool call: a safe:false command entry plus its transcript outcome. */
  private recordRejectedToolCall(
    turn: number,
    state: TurnBatchState,
    rejection: {
      toolName: string;
      rawArgs: ToolAction['args'];
      isNativeTool: boolean;
      recordedCommand: string;
      transcriptCommand: string;
      reason: string | null;
      output: string;
      callIdPrefix: string;
    },
  ): void {
    const { commands } = this.deps;
    commands.push({
      command: rejection.recordedCommand,
      turn,
      safe: false,
      reason: rejection.reason,
      exitCode: null,
      output: rejection.output,
    });
    state.batchOutcomes.push({
      action: buildEffectiveTranscriptAction({
        toolName: rejection.toolName,
        rawArgs: rejection.rawArgs,
        isNativeTool: rejection.isNativeTool,
        commandToRun: rejection.transcriptCommand,
      }),
      toolCallId: `${rejection.callIdPrefix}_${commands.length}`,
      toolContent: rejection.output,
    });
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
    const { toolAction, normalizedToolName, isNativeTool, command, fingerprint, normalizedKey } = context;
    const { commands, counters, duplicates, forcedFinish, toolStats, transcript } = this.deps;
    const { isExactDuplicate, isSemanticDuplicate, duplicateFingerprint } = duplicates.classify({
      toolName: normalizedToolName,
      normalizedKey,
      fingerprint,
      rejected: false,
    });
    // A repeated `read` is legitimate: planRead advances past already-returned lines each time.
    const canAdvanceRepeatedRead = normalizedToolName === 'read';
    if (this.deps.chatWebGroundingEnabled && (normalizedToolName === 'web_search' || normalizedToolName === 'web_fetch')) {
      const duplicateDecision = this.deps.chatWebGroundingPolicy.evaluateToolCall(normalizedToolName, toolAction.args);
      if (duplicateDecision.kind === 'reject') {
        counters.commandFailures += 1;
        this.recordRejectedToolCall(turn, state, {
          toolName: normalizedToolName,
          rawArgs: toolAction.args,
          isNativeTool,
          recordedCommand: command,
          transcriptCommand: command,
          reason: 'duplicate web tool',
          output: duplicateDecision.message,
          callIdPrefix: 'duplicate_web_call',
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

  private async runNativeExecution(normalizedToolName: string, toolAction: ToolAction, command: string): Promise<RepoToolExecution> {
    if (normalizedToolName === 'read') {
      const readPlan = planRead(toolAction.args, this.deps.repoRoot, this.deps.ignorePolicy, this.deps.readWindows.stateMap);
      return isFailedReadPlan(readPlan)
        ? { ok: false, command: readPlan.command, reason: readPlan.reason, toolType: normalizedToolName }
        : buildReadExecution(normalizedToolName, readPlan);
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
    return executeRepoTool(normalizedToolName, toolAction.args, {
      repoRoot: this.deps.repoRoot,
      ignorePolicy: this.deps.ignorePolicy,
      webTools: this.deps.webTools,
      fileReadStateByPath: this.deps.readWindows.stateMap,
      abortSignal: this.deps.abortSignal,
    });
  }

  private screenRejection(turn: number, context: AcceptedToolContext, state: TurnBatchState): ToolActionOutcome | null {
    const { toolAction, normalizedToolName, isNativeTool, command, nativeExecution } = context;
    const { counters } = this.deps;
    if (!nativeExecution || nativeExecution.ok) {
      return null;
    }
    counters.safetyRejects += 1;
    this.recordRejectedToolCall(turn, state, {
      toolName: normalizedToolName,
      rawArgs: toolAction.args,
      isNativeTool,
      recordedCommand: command,
      transcriptCommand: nativeExecution.command,
      reason: nativeExecution.reason,
      output: `Rejected command: ${nativeExecution.reason}`,
      callIdPrefix: 'rejected_call',
    });
    return 'next';
  }

  private prepareCommandToRun(turn: number, context: AcceptedToolContext, state: TurnBatchState): PreparedCommand | 'next' {
    const { toolAction, normalizedToolName, isNativeTool, command, nativeExecution } = context;
    const { counters } = this.deps;
    const requestedCommand = nativeExecution?.ok ? nativeExecution.requestedCommand || command : command;
    const commandToRun = nativeExecution?.ok ? nativeExecution.command : command;

    // Native tools validate their own typed args; only `git` carries a raw command string.
    const safety = isNativeTool
      ? { safe: true, reason: null }
      : evaluateCommandSafety(commandToRun, this.deps.repoRoot);
    this.deps.logger?.write({ kind: 'turn_command_safety', taskId: this.deps.task.id, turn, command: commandToRun, safe: safety.safe, reason: safety.reason });

    if (!safety.safe) {
      counters.safetyRejects += 1;
      this.recordRejectedToolCall(turn, state, {
        toolName: normalizedToolName,
        rawArgs: toolAction.args,
        isNativeTool,
        recordedCommand: commandToRun,
        transcriptCommand: commandToRun,
        reason: safety.reason,
        output: `Rejected command: ${safety.reason}`,
        callIdPrefix: 'rejected_call',
      });
      return 'next';
    }
    return { requestedCommand, commandToRun };
  }

  private async executeAcceptedTool(
    turn: number,
    context: AcceptedToolContext,
    state: TurnBatchState,
    promptTokenCount: number,
  ): Promise<ToolActionOutcome> {
    const { normalizedToolName, isNativeTool, nativeExecution } = context;
    const { counters, forcedFinish } = this.deps;
    const preparedCommand = this.prepareCommandToRun(turn, context, state);
    if (preparedCommand === 'next') {
      return 'next';
    }
    const { requestedCommand, commandToRun } = preparedCommand;

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
    const executed = nativeExecution && nativeExecution.ok
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
    if (Number(executed.exitCode) !== 0) {
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
      executed,
      baseOutput,
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
      normalizedToolName, nativeExecution,
      executed, baseOutput, zeroOutputWarningText,
    } = context;
    let { commandToRun } = context;

    const rawResultText = `exit_code=${executed.exitCode}\n${baseOutput}`.trim();
    let resultText = buildPromptToolResult({
      toolName: normalizedToolName,
      command: commandToRun,
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
      commandSucceededForFitting: Number(executed.exitCode) === 0,
      outputUnit: nativeExecution && nativeExecution.ok && nativeExecution.outputUnit ? nativeExecution.outputUnit : 'lines',
    });
    resultText = fitted.resultText;
    const fittedReturnedSegmentCount = fitted.fittedReturnedSegmentCount;
    const rawResultTokenCount = fitted.rawResultTokenCount;
    let lineReadStats = nativeExecution && nativeExecution.ok && nativeExecution.lineReadStats
      ? nativeExecution.lineReadStats
      : getRepoSearchLineReadStats(commandToRun, baseOutput, rawResultTokenCount);
    if (nativeExecution && nativeExecution.ok && nativeExecution.readFile && nativeExecution.lineReadStats && nativeExecution.lineReadStats.lineReadLinesTotal > 0) {
      // Output fitting may have truncated the window; record only what the model actually saw.
      const returnedLineCount = Math.min(
        nativeExecution.lineReadStats.lineReadLinesTotal,
        fittedReturnedSegmentCount ?? resultText.split(/\r?\n/u).filter((line) => /^\d+:/u.test(line)).length,
      );
      if (returnedLineCount > 0) {
        const { readFile } = nativeExecution;
        commandToRun = buildReadCommand(readFile.commandPath, readFile.startLine, returnedLineCount);
        lineReadStats = {
          lineReadCalls: 1,
          lineReadLinesTotal: returnedLineCount,
          lineReadTokensTotal: Math.max(1, estimateTokenCount(this.deps.config, resultText)),
        };
        this.deps.readWindows.recordNativeRead({
          pathKey: readFile.pathKey,
          returnedStart: readFile.startLine,
          returnedEndExclusive: readFile.startLine + returnedLineCount,
        });
      }
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
      toolAction, normalizedToolName, isNativeTool, fingerprint, normalizedKey,
      requestedCommand, executed, baseOutput, progressToolCallId,
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

    if (progress.enabled) {
      const snippet = resultText.length > 200 ? `${resultText.slice(0, 200)}...` : resultText;
      progress.toolResult({
        toolCallId: progressToolCallId,
        turn,
        command: commandToRun,
        exitCode: executed.exitCode,
        outputSnippet: snippet,
        outputTokens: resultTokenCount,
        outputTokensEstimated: resultTokenCountEstimated,
        promptTokenCount,
      });
    }
    const commandOutputText = isNativeTool ? resultText : baseOutput;

    this.deps.logger?.write({
      kind: 'turn_command_result', taskId: this.deps.task.id, turn, command: commandToRun,
      requestedCommand,
      executedCommand: commandToRun,
      exitCode: executed.exitCode, output: commandOutputText,
      promptTokenCount, resultTokenCount, perToolCapTokens, remainingTokenAllowance,
      insertedResultText: resultText,
    });
    tokenUsage.addToolTokens(resultTokenCount);

    commands.push({
      command: commandToRun,
      turn,
      modelVisibleCommand: commandToRun,
      safe: true,
      reason: null,
      exitCode: executed.exitCode,
      output: commandOutputText,
      promptOutput: resultText,
      outputTokens: resultTokenCount,
      outputTokensEstimated: resultTokenCountEstimated,
    });
    const commandSucceeded = Number(executed.exitCode) === 0;
    if (commandSucceeded) {
      duplicates.recordSuccess(normalizedKey, fingerprint || null);
    }
    const toolCallId = `call_${commands.length}`;
    state.batchOutcomes.push({
      action: buildEffectiveTranscriptAction({
        toolName: normalizedToolName,
        rawArgs: toolAction.args,
        isNativeTool,
        commandToRun,
      }),
      toolCallId,
      toolContent: resultText,
    });
    state.acceptedToolPromptTokensThisTurn += Math.max(0, Math.ceil(resultTokenCount));
    return 'next';
  }
}
