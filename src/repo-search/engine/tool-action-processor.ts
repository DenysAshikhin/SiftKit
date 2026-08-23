import { isReadExpansionEnabled, type SiftConfig } from '../../config/index.js';
import type { ImageMetadata, ImageTokenBudget } from '@siftkit/contracts';
import { getRepoSearchLineReadStats } from '../../line-read-guidance.js';
import type { TemporaryTimingRecorder } from '../../lib/temporary-timing-recorder.js';
import {
  evaluateCommandSafety,
  type IgnorePolicy,
} from '../command-safety.js';
import {
  isMutatingCommandToolName,
  isRepoSearchCommandToolName,
  isRepoSearchNativeToolName,
  isTreeMutatingToolName,
  normalizeRepoSearchCommandForToolName,
  type ToolAction,
} from '../planner-protocol.js';
import { buildApprovalReviewPayload } from '../approval-review-policy.js';
import { estimateTokenCount } from '../../lib/token-estimate.js';
import type { TaskCommand } from '../prompts.js';
import {
  buildRepeatedToolCallSummary,
  buildPromptToolResult,
  classifyToolOutputNovelty,
  fingerprintToolCall,
} from '../../tool-loop-governor.js';
import { ChatGroundingPolicy } from '../chat-grounding-policy.js';
import type { JsonLogger, RepoSearchMockCommandResult } from '../types.js';
import { type ToolBatchOutcome } from '../../tool-call-messages.js';
import { WebResearchTools } from '../../web-search/web-research-tools.js';
import { executeRepoCommand, normalizeToolTypeFromCommand } from './command-execution.js';
import {
  buildEffectiveTranscriptAction,
  buildRejectedTranscriptAction,
  buildReadCommand,
  buildRepoToolRequestedCommand,
  executeRepoTool,
  type RepoToolExecution,
} from './repo-tools.js';
import type { ApprovalRequester } from './approval-gate.js';
import { buildDuplicateFingerprint, DuplicateTracker } from './duplicate-tracker.js';
import { FORCED_FINISH_MAX_ATTEMPTS, FORCED_FINISH_MODE_MESSAGE, ForcedFinishController } from './forced-finish.js';
import { ActivitySummaryCollector } from './activity-summary-collector.js';
import { ImageRetentionPolicy } from '../../image-retention-policy.js';
import { ProgressReporter } from './progress-reporter.js';
import { buildReadPathKey } from './read-overlap.js';
import { ReadWindowGovernor } from './read-window-governor.js';
import {
  applyToolOutputRepetitionGuard,
  decayInvalidResponses,
  type LoopCounters,
  type TaskDefinition,
  type TurnOutcome,
} from './task-loop-support.js';
import { ToolResultBudgeter } from './tool-result-budgeter.js';
import { TokenUsageTracker } from './token-usage.js';
import { ToolStatsRecorder } from './tool-stats.js';
import { TranscriptManager } from './transcript-manager.js';
import { TurnBudget } from './turn-budget.js';
import {
  RepoNativeToolCallSchema,
  type RepoNativeToolCall,
} from '../repo-tool-arguments.js';
import type { TurnPromptTokens } from '../../agent-loop/types.js';
import type { RepoSearchRuntimeProfile } from './runtime-profile.js';

type RunOutputDecision = ReturnType<RepoSearchRuntimeProfile['beginRun']>;

type ToolActionOutcome = 'next' | 'stop_batch';

type TurnBatchState = {
  batchOutcomes: ToolBatchOutcome[];
  /** One entry per tool result that produced an image, in batch order. */
  pendingToolImages: Array<{ outcomeIndex: number; dataUrl: string; pathKey: string; metadata: ImageMetadata }>;
  pendingModeChangeUserMessages: string[];
  pendingForcedFinishCountdownText: string | null;
  batchDuplicateAnchorIndex: number | null;
  acceptedToolPromptTokensThisTurn: number;
  // Number of tool actions in this turn's batch. The turn's tool budget is split
  // across them, so every member is capped at its share up front.
  batchCommandCount: number;
  // Commands completed before this turn started. Snapshotted so the progress term
  // that grows the turn share cannot also grow *within* a batch, which would let
  // later members of the batch claim more than their share.
  completedCommandCountAtTurnStart: number;
};

type ValidatedToolAction = {
  normalizedToolName: string;
  isCommandTool: boolean;
  isNativeTool: boolean;
  nativeCall: RepoNativeToolCall | null;
  command: string;
};

type AcceptedToolContext = ValidatedToolAction & {
  toolAction: ToolAction;
  fingerprint: string;
  normalizedKey: string;
  runFullOutputDecision: RunOutputDecision | null;
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

/**
 * The kinds of repeat a tool call can be rejected as. The recorded reason, the forced-finish
 * trigger and whether the repeat counts as semantic are all restatements of the same fact, so they
 * are derived here rather than passed alongside each other.
 */
const REPEAT_KINDS = {
  exact: { reason: 'duplicate command', trigger: 'consecutive_duplicates', isSemantic: false },
  semantic: { reason: 'semantic duplicate command', trigger: 'semantic_repetition', isSemantic: true },
  exhausted_read: { reason: 'exhausted read', trigger: 'exhausted_read', isSemantic: false },
} as const;

type RepeatKind = keyof typeof REPEAT_KINDS;

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
  approvalGate: ApprovalRequester | null;
  runtimeProfile: RepoSearchRuntimeProfile;
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
  /** Repository-relative paths successfully written to, in the order they were first touched. */
  mutatedPaths: Set<string>;
  successfulToolCalls: Array<{ toolName: string; promptResultText: string }>;
  commands: TaskCommand[];
  counters: LoopCounters;
  visionEnabled: boolean;
  visionImageRetention: number;
  visionMaxImagePixels: number;
  imageTokenBudget: ImageTokenBudget;
  liveImagePathKeys: Set<string>;
};

export class ToolActionProcessor {
  private readonly collector = new ActivitySummaryCollector();
  private progressToolCallSeq = 0;
  private forcedFinishCountdownUserMessageIndex = -1;

  constructor(private readonly deps: ToolActionProcessorDeps) {}

  async executeBatch(
    turn: number,
    toolActions: ToolAction[],
    responseThinkingText: string,
    promptTokens: TurnPromptTokens,
    inForcedFinishMode: boolean,
  ): Promise<TurnOutcome> {
    const { transcript, duplicates, counters } = this.deps;
    const state: TurnBatchState = {
      batchOutcomes: [],
      pendingToolImages: [],
      pendingModeChangeUserMessages: [],
      pendingForcedFinishCountdownText: null,
      batchDuplicateAnchorIndex: null,
      acceptedToolPromptTokensThisTurn: 0,
      batchCommandCount: toolActions.length,
      completedCommandCountAtTurnStart: this.deps.commands.length,
    };

    const commandsAtBatchStart = this.deps.commands.length;
    for (const toolAction of toolActions) {
      const outcome = await this.processToolAction(turn, toolAction, state, promptTokens, inForcedFinishMode);
      if (outcome === 'stop_batch') {
        break;
      }
    }

    const batchCommands = this.deps.commands.slice(commandsAtBatchStart);
    this.collector.recordBatch(turn, toolActions, batchCommands);

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
      duplicates.setReplayToolMessageIndex(preAppendMessagesLength + 1 + state.batchDuplicateAnchorIndex, transcript.generation);
    }
    for (const pending of [...state.pendingToolImages].reverse()) {
      transcript.insertUserAfter(
        preAppendMessagesLength + 1 + pending.outcomeIndex,
        `image ${pending.pathKey} — ${pending.metadata.width}×${pending.metadata.height}`,
        [pending.dataUrl],
        pending.pathKey,
      );
      this.deps.liveImagePathKeys.add(pending.pathKey);
    }
    for (const droppedPathKey of new ImageRetentionPolicy(this.deps.visionImageRetention).prune(transcript.getMessages())) {
      this.deps.liveImagePathKeys.delete(droppedPathKey);
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
    const summary = this.collector.takeSummary(turn, this.deps.progress.getMaxTurns());
    if (summary !== null) {
      this.deps.progress.activitySummary(summary);
    }
    return counters.reason === 'forced_finish_attempt_limit' ? 'stop' : 'continue';
  }

  private async processToolAction(
    turn: number,
    toolAction: ToolAction,
    state: TurnBatchState,
    promptTokens: TurnPromptTokens,
    inForcedFinishMode: boolean,
  ): Promise<ToolActionOutcome> {
    const { counters, forcedFinish } = this.deps;
    const validated = this.validateToolAction(turn, toolAction, state);
    if (validated === 'next' || validated === 'stop_batch') {
      return validated;
    }
    const { normalizedToolName, isNativeTool, nativeCall, command } = validated;
    const runFullOutputDecision = this.beginRun(nativeCall);

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
      runFullOutputDecision,
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
        reviewPayload: buildApprovalReviewPayload({
          toolName: normalizedToolName,
          args: toolAction.args,
        }),
      });
      if (decision.kind === 'abort') {
        throw new Error(decision.reason);
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

    const nativeExecution = nativeCall === null
      ? null
      : await this.runNativeExecution(nativeCall, command, runFullOutputDecision);
    const context: AcceptedToolContext = {
      ...validated,
      toolAction,
      fingerprint,
      normalizedKey: command,
      runFullOutputDecision,
      nativeExecution,
    };
    const rejection = this.screenRejection(turn, context, state);
    if (rejection !== null) {
      return rejection;
    }
    const exhausted = this.screenExhaustedRead(turn, context, prospectiveToolType, state);
    if (exhausted !== null) {
      return exhausted;
    }

    return this.executeAcceptedTool(turn, context, state, promptTokens);
  }

  private validateToolAction(turn: number, toolAction: ToolAction, state: TurnBatchState): ValidatedToolAction | ToolActionOutcome {
    const normalizedToolName = String(toolAction.tool_name || '').trim().toLowerCase();
    const isCommandTool = isRepoSearchCommandToolName(normalizedToolName);
    const isNativeTool = isRepoSearchNativeToolName(normalizedToolName);
    if (!isCommandTool && !isNativeTool) {
      const unsupportedToolMessage = `Invalid action: unsupported planner tool "${toolAction.tool_name}" for repo-search. Use one of: ${this.deps.allowedPlannerToolNames.join(', ')}.`;
      return this.recordInvalidToolCall(turn, toolAction, state, String(toolAction.tool_name || '').trim() || 'invalid_tool_call', unsupportedToolMessage);
    }
    if (!this.deps.allowedPlannerToolNames.includes(normalizedToolName)) {
      const disallowedToolMessage = `Invalid action: tool "${normalizedToolName}" is not enabled for this run. Use one of: ${this.deps.allowedPlannerToolNames.join(', ')}.`;
      return this.recordInvalidToolCall(turn, toolAction, state, normalizedToolName, disallowedToolMessage);
    }
    const nativeCallResult = isNativeTool
      ? RepoNativeToolCallSchema.safeParse({
          toolName: normalizedToolName,
          args: toolAction.args,
        })
      : null;
    if (nativeCallResult !== null && !nativeCallResult.success) {
      return this.recordInvalidToolCall(
        turn,
        toolAction,
        state,
        normalizedToolName,
        `Invalid action: invalid ${normalizedToolName} arguments: ${nativeCallResult.error.message}`,
      );
    }
    const nativeCall = nativeCallResult?.data ?? null;
    const command = isCommandTool
      ? normalizeRepoSearchCommandForToolName(
          normalizedToolName,
          typeof toolAction.args.command === 'string' ? toolAction.args.command : '',
        )
      : nativeCall === null
        ? ''
        : buildRepoToolRequestedCommand(nativeCall.toolName, nativeCall.args);
    if (isCommandTool && !command) {
      return this.recordInvalidToolCall(
        turn,
        toolAction,
        state,
        normalizedToolName,
        `Invalid action: ${normalizedToolName} requires args.command.`,
      );
    }
    return { normalizedToolName, isCommandTool, isNativeTool, nativeCall, command };
  }

  private beginRun(nativeCall: RepoNativeToolCall | null): RunOutputDecision | null {
    if (nativeCall?.toolName !== 'run') {
      return null;
    }
    return this.deps.runtimeProfile.beginRun(nativeCall.args);
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
      action: buildRejectedTranscriptAction({
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

  /**
   * An invalid action must still append exactly one entry to `commands`: the task loop pairs
   * command results back to tool actions by index, so a skipped entry shifts every later result
   * onto the wrong action.
   */
  private recordInvalidToolCall(
    turn: number,
    toolAction: ToolAction,
    state: TurnBatchState,
    displayToolName: string,
    message: string,
  ): ToolActionOutcome {
    const { counters, commands } = this.deps;
    counters.invalidResponses += 1;
    commands.push({
      command: displayToolName,
      turn,
      safe: false,
      reason: 'invalid action',
      exitCode: null,
      output: message,
    });
    state.batchOutcomes.push({
      action: { tool_name: displayToolName, args: toolAction.args },
      toolCallId: `invalid_call_${counters.invalidResponses}`,
      toolContent: message,
    });
    return this.logInvalidAction(turn, toolAction, message);
  }

  private screenWebAndDuplicates(
    turn: number,
    context: AcceptedToolContext,
    prospectiveToolType: string,
    state: TurnBatchState,
  ): ToolActionOutcome | null {
    const {
      toolAction, normalizedToolName, isNativeTool, command, fingerprint, normalizedKey,
      runFullOutputDecision,
    } = context;
    const { counters, duplicates } = this.deps;
    const { isExactDuplicate, isSemanticDuplicate, duplicateFingerprint } = duplicates.classify({
      toolName: normalizedToolName,
      normalizedKey,
      fingerprint,
      rejected: false,
    });
    // A repeated `read` is legitimate: planRead advances past already-returned lines each time.
    const canAdvanceRepeatedRead = normalizedToolName === 'read';
    // A repeated `run` is legitimate exactly once: when it is the granted back-to-back "full"
    // retry of a command whose first "full" request was served as "auto".
    const canAdvanceRepeatedRun = runFullOutputDecision?.kind === 'retry';
    const completedRepeatedRun = runFullOutputDecision?.kind === 'duplicate';
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
    if (
      !canAdvanceRepeatedRead
      && !canAdvanceRepeatedRun
      && (completedRepeatedRun || isExactDuplicate || isSemanticDuplicate)
    ) {
      this.rejectAsDuplicate(turn, context, state, {
        duplicateFingerprint,
        kind: completedRepeatedRun || isExactDuplicate ? 'exact' : 'semantic',
        prospectiveToolType,
        bodyText: null,
      });
      return 'next';
    }
    return null;
  }

  /**
   * Records a repeat rejection: a safe:false command entry, a transcript message that collapses
   * onto the previous replay when one is active, and the stagnation pressure that eventually
   * forces a finish. Shared by string-level duplicates and reads with nothing left to return.
   */
  private rejectAsDuplicate(
    turn: number,
    context: AcceptedToolContext,
    state: TurnBatchState,
    options: {
      duplicateFingerprint: string;
      kind: RepeatKind;
      prospectiveToolType: string;
      bodyText: string | null;
    },
  ): void {
    const { toolAction, normalizedToolName, isNativeTool, command, fingerprint } = context;
    const { commands, counters, duplicates, forcedFinish, toolStats, transcript } = this.deps;
    const { reason, trigger, isSemantic } = REPEAT_KINDS[options.kind];
    const registration = duplicates.registerDuplicate(options.duplicateFingerprint, transcript.length, transcript.generation);
    const repeatSummary = buildRepeatedToolCallSummary(normalizedToolName, registration.count);
    const duplicateMessage = options.bodyText ? `${options.bodyText}\n${repeatSummary}` : repeatSummary;
    counters.commandFailures += 1;
    commands.push({
      command, turn, safe: false, reason, exitCode: null,
      output: `Rejected: ${duplicateMessage}`,
    });
    if (registration.activeReplayMessageIndex !== null) {
      transcript.replaceToolMessage(registration.activeReplayMessageIndex, duplicateMessage);
    } else {
      state.batchOutcomes.push({
        action: buildRejectedTranscriptAction({
          toolName: normalizedToolName,
          rawArgs: toolAction.args,
          isNativeTool,
          commandToRun: command,
        }),
        toolCallId: `duplicate_call_${commands.length}`,
        toolContent: duplicateMessage,
      });
      state.batchDuplicateAnchorIndex = state.batchOutcomes.length - 1;
    }
    if (isSemantic) {
      toolStats.recordSemanticRepeatReject(options.prospectiveToolType);
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
      toolStats.recordForcedFinishFromStagnation(options.prospectiveToolType);
      this.deps.logger?.write({
        kind: 'turn_forced_finish_mode_started',
        taskId: this.deps.task.id,
        turn,
        attemptsRemaining: FORCED_FINISH_MAX_ATTEMPTS,
        trigger,
      });
    }
  }

  private async runNativeExecution(
    nativeCall: RepoNativeToolCall,
    command: string,
    runFullOutputDecision: RunOutputDecision | null,
  ): Promise<RepoToolExecution> {
    const mockResult = this.deps.mockCommandResults?.[command];
    const execution: RepoToolExecution = mockResult
      ? {
          ok: true,
          requestedCommand: command,
          command,
          exitCode: Number(mockResult.exitCode),
          output: [mockResult.stdout, mockResult.stderr]
            .filter((part) => typeof part === 'string' && part.length > 0)
            .join('\n'),
          toolType: nativeCall.toolName,
        }
      : await executeRepoTool(nativeCall, {
          repoRoot: this.deps.repoRoot,
          ignorePolicy: this.deps.ignorePolicy,
          webTools: this.deps.webTools,
          fileReadStateByPath: this.deps.readWindows.stateMap,
          abortSignal: this.deps.abortSignal,
          expandReads: isReadExpansionEnabled(this.deps.config),
          agentRunId: this.deps.task.id,
          visionEnabled: this.deps.visionEnabled,
          visionImageRetention: this.deps.visionImageRetention,
          visionMaxImagePixels: this.deps.visionMaxImagePixels,
          imageTokenBudget: this.deps.imageTokenBudget,
          liveImagePathKeys: this.deps.liveImagePathKeys,
        });
    if (!execution.ok || nativeCall.toolName !== 'run') {
      return execution;
    }
    if (runFullOutputDecision === null || runFullOutputDecision.kind === 'duplicate') {
      return {
        ok: false,
        command,
        reason: 'run requires a precomputed executable output decision',
        toolType: nativeCall.toolName,
      };
    }
    const output = this.deps.runtimeProfile.applyRunOutput({
      call: nativeCall.args,
      output: execution.output,
      decision: runFullOutputDecision,
    });
    return {
      ...execution,
      output,
    };
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

  /**
   * A read whose whole requested window was already returned has nothing to add. Route it through
   * the same repeat machinery as a duplicate command so it costs a rejection, not a full result.
   */
  private screenExhaustedRead(
    turn: number,
    context: AcceptedToolContext,
    prospectiveToolType: string,
    state: TurnBatchState,
  ): ToolActionOutcome | null {
    const { nativeExecution, normalizedToolName, normalizedKey, fingerprint } = context;
    if (!nativeExecution || !nativeExecution.ok || !nativeExecution.readFile || nativeExecution.readFile.hasUnread) {
      return null;
    }
    this.rejectAsDuplicate(turn, context, state, {
      duplicateFingerprint: buildDuplicateFingerprint(normalizedToolName, normalizedKey, fingerprint),
      kind: 'exhausted_read',
      prospectiveToolType,
      bodyText: nativeExecution.output,
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
    promptTokens: TurnPromptTokens,
  ): Promise<ToolActionOutcome> {
    const { normalizedToolName, isNativeTool, nativeExecution } = context;
    const { counters, forcedFinish } = this.deps;
    const preparedCommand = this.prepareCommandToRun(turn, context, state);
    if (preparedCommand === 'next') {
      return 'next';
    }
    const { requestedCommand, commandToRun } = preparedCommand;
    // The action has cleared every screen and is about to run, which is the only point that counts
    // as progress. A rejected action parses fine but produces no work, so it must not buy back a
    // strike — otherwise alternating malformed and rejected actions never reaches the limit.
    decayInvalidResponses(counters);

    const progressToolCallId = `tc_${this.progressToolCallSeq}`;
    this.progressToolCallSeq += 1;
    this.deps.progress.toolStart(progressToolCallId, turn, requestedCommand, promptTokens.reported);
    this.deps.logger?.write({
      kind: 'turn_command_start',
      taskId: this.deps.task.id,
      turn,
      toolName: normalizedToolName,
      requestedCommand,
      commandToRun,
      native: isNativeTool,
    });

    const toolExecutionSpan = this.deps.timingRecorder?.start('repo.tool.execute', {
      taskId: this.deps.task.id,
      turn,
      toolName: normalizedToolName,
      commandChars: commandToRun.length,
      native: isNativeTool,
    });
    const executed = nativeExecution && nativeExecution.ok
      ? { exitCode: nativeExecution.exitCode, output: nativeExecution.output }
      : await executeRepoCommand(
        commandToRun,
        this.deps.repoRoot,
        this.deps.mockCommandResults || null,
        this.deps.task.id,
        this.deps.abortSignal,
      );
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
    }, state, promptTokens);
  }

  private async fitToolResult(
    turn: number,
    context: ExecutedToolContext,
    state: TurnBatchState,
    promptTokens: TurnPromptTokens,
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
      output: baseOutput,
    });
    if (zeroOutputWarningText) {
      resultText = `${zeroOutputWarningText}\n\n${resultText}`.trim();
    }
    resultText = applyToolOutputRepetitionGuard(resultText);
    const perToolCapTokens = this.deps.budget.perToolCapTokens(state.completedCommandCountAtTurnStart, state.batchCommandCount);
    // The reserve occupies request space, so what still fits is measured against the budgeted size.
    const remainingTokenAllowance = this.deps.budget.remainingToolAllowance(promptTokens.budgeted, state.acceptedToolPromptTokensThisTurn);
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
      keep: nativeExecution && nativeExecution.ok && nativeExecution.outputKeep ? nativeExecution.outputKeep : 'head',
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
    promptTokens: TurnPromptTokens,
  ): Promise<ToolActionOutcome> {
    const {
      toolAction, normalizedToolName, isNativeTool, fingerprint, normalizedKey,
      requestedCommand, executed, baseOutput, progressToolCallId, nativeExecution,
    } = context;
    const { commands, duplicates, progress, recentEvidenceKeys, successfulToolCalls, tokenUsage, toolStats } = this.deps;

    const fittedOutcome = await this.fitToolResult(turn, context, state, promptTokens);
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
    const novelty = classifyToolOutputNovelty({
      baseOutput,
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
        promptTokenCount: promptTokens.reported,
      });
    }
    const commandOutputText = isNativeTool ? resultText : baseOutput;

    this.deps.logger?.write({
      kind: 'turn_command_result', taskId: this.deps.task.id, turn, command: commandToRun,
      requestedCommand,
      executedCommand: commandToRun,
      exitCode: executed.exitCode, output: commandOutputText,
      promptTokenCount: promptTokens.reported, resultTokenCount, perToolCapTokens, remainingTokenAllowance,
      insertedResultText: resultText,
    });
    tokenUsage.addToolTokens(resultTokenCount);

    const imageDataUrls = nativeExecution && nativeExecution.ok && nativeExecution.imageDataUrl
      ? [nativeExecution.imageDataUrl]
      : undefined;
    const imageMeta = nativeExecution && nativeExecution.ok && nativeExecution.imageMetadata
      ? [nativeExecution.imageMetadata]
      : undefined;
    commands.push({
      command: commandToRun,
      turn,
      modelVisibleCommand: commandToRun,
      safe: true,
      reason: null,
      exitCode: executed.exitCode,
      output: commandOutputText,
      promptOutput: resultText,
      ...(imageDataUrls ? { imageDataUrls } : {}),
      ...(imageMeta ? { imageMeta } : {}),
      outputTokens: resultTokenCount,
      outputTokensEstimated: resultTokenCountEstimated,
      promptTokenCount: promptTokens.reported,
    });
    const commandSucceeded = Number(executed.exitCode) === 0;
    this.invalidateAfterMutation(context, commandSucceeded);
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
    if (commandSucceeded && nativeExecution && nativeExecution.ok
      && nativeExecution.imageDataUrl && nativeExecution.imagePathKey && nativeExecution.imageMetadata) {
      state.pendingToolImages.push({
        outcomeIndex: state.batchOutcomes.length - 1,
        dataUrl: nativeExecution.imageDataUrl,
        pathKey: nativeExecution.imagePathKey,
        metadata: nativeExecution.imageMetadata,
      });
    }
    state.acceptedToolPromptTokensThisTurn += Math.max(0, Math.ceil(resultTokenCount));
    return 'next';
  }

  /**
   * A mutation makes prior read windows stale — the same line numbers now hold different content.
   * Clearing them restores the model's ability to re-read what changed. This touches bookkeeping
   * only; the transcript keeps every earlier read result.
   *
   * Command-shaped tools do not report which paths they touched and can rewrite the tree, so any
   * completion clears everything — a non-zero exit can still have mutated.
   *
   * A tool that can actually change the tree also clears the duplicate memory, so a re-query after
   * a write is not rejected as a repeat of the pre-write answer.
   *
   * A reported path is also the run's record of which files it changed, so the caller can state
   * that independently of the model's own account of the run.
   */
  private invalidateAfterMutation(context: ExecutedToolContext, commandSucceeded: boolean): void {
    const { normalizedToolName, nativeExecution } = context;
    if (isTreeMutatingToolName(normalizedToolName)) {
      this.deps.duplicates.forgetSuccesses();
    }
    if (isMutatingCommandToolName(normalizedToolName)) {
      this.deps.readWindows.invalidateAll();
      return;
    }
    if (commandSucceeded && nativeExecution && nativeExecution.ok && nativeExecution.mutatedPath) {
      this.deps.readWindows.invalidatePath(buildReadPathKey(nativeExecution.mutatedPath));
      this.deps.mutatedPaths.add(nativeExecution.mutatedPath);
    }
  }
}
