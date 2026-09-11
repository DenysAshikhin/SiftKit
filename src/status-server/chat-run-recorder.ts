import type {
  ChatRunEvidenceRecorder,
  ChatToolProposedEvidence,
  ChatToolResultEvidence,
  ChatToolResultFinalizedEvidence,
  ChatToolStartedEvidence,
  ChatApprovalRequestedEvidence,
  ChatApprovalResolvedEvidence,
  ChatApprovalReviewedEvidence,
} from '../repo-search/engine/chat-run-evidence.js';
import type { ChatContextInit, ChatContextSplice } from '../repo-search/planner-chat-message.js';
import { ChatAnswerCompletionSchema, buildChatRunMessageIdPrefix, buildChatMessageId, type ChatAnswerCompletion, ChatRunEffectiveSettingsSchema, type ApprovalMode, type ChatRunEffectiveSettings, type ChatRunTerminalCause, type ChatSessionOperationKind, type ChatRecoveryStatus, type ChatStreamUsageEvent, type ChatTranscriptEvent, type ChatRunPresentationEvent } from '@siftkit/contracts';
import { z } from '../lib/zod.js';
import { toError } from '../lib/errors.js';
import { getChatSessionPath, readChatSessionFromPath, type ChatSession, estimateTokenCount } from '../state/chat-sessions.js';
import type { ModelRuntimePreset, SiftConfig } from '../config/types.js';
import { resolveChatSessionContextWindow } from './chat.js';
import { ChatJournalStore } from '../state/chat-journal.js';
import {
  ChatEngineBindingSchema,
  ChatRunStartedEventSchema,
  type ChatJournalAppend,
  type ChatJournalEnvelope,
  type ChatJournalEvent,
} from '../state/chat-journal-schema.js';
import { getRuntimeDatabase } from '../state/runtime-db.js';
import { isStorageFailure } from '../state/database-handle.js';
import { ChatMessageQueueStore, type ChatQueueClaimInput } from '../state/chat-message-queue.js';
import { dirname } from 'node:path';
import { reconcileChatRun } from './chat-run-projection.js';
import type { RepoSearchExecutionResult } from '../repo-search/types.js';
import { foldTurnTokenRecords } from '../repo-search/engine/turn-token-record.js';
import { getScorecardTotal } from './chat.js';
import type { ChatStreamProgressWriter } from './chat-stream-progress-writer.js';
import { buildRecoveredChatHistory } from './chat-context-replay.js';
import { getGenerationTokensPerSecond, getPromptTokensPerSecond } from '../lib/telemetry-metrics.js';
import { getAbortError, throwIfAborted } from '../lib/abort.js';
import { admitChatImages } from '../llm-protocol/preset-image-admission.js';
import { readChatHistoryRevisions } from '../state/chat-history-revisions.js';

/** The submission, minus the ordering the store assigns and the discriminator the recorder stamps. */
export const ChatRunRecorderStartSchema = ChatRunStartedEventSchema
  .omit({ kind: true, runOrder: true })
  .extend({
    operationId: z.string().uuid(),
    ownerEpoch: z.string().min(1),
    startedAtUtc: z.string().datetime(),
  });
export type ChatRunRecorderStart = z.infer<typeof ChatRunRecorderStartSchema>;

/** The store's binding minus the identity the recorder already owns. */
export const ChatRunEngineBindingSchema = ChatEngineBindingSchema.omit({ operationId: true, ownerEpoch: true });
export type ChatRunEngineBinding = z.infer<typeof ChatRunEngineBindingSchema>;

/**
 * One Web operation's durable writer. Every method commits before returning, so a caller that got
 * back from the recorder may act, and a caller that got an exception must not.
 */
export class ChatRunRecorder implements ChatRunEvidenceRecorder {
  private latestSequence: number;
  private readonly storageAbort = new AbortController();
  private readonly userStop = new AbortController();
  private readonly executionSignal = AbortSignal.any([this.storageAbort.signal, this.userStop.signal]);
  private progressWriter: ChatStreamProgressWriter | null = null;
  private answerMessageId: string | undefined;
  private readonly narratedTurns = new Set<number>();
  private readonly toolMessageIds = new Map<string, string>();
  private historyRevisionValue = 0;
  private dispatched = false;

  get historyRevision(): number { return this.historyRevisionValue; }
  readHistoryRevisions() { return readChatHistoryRevisions(getRuntimeDatabase(this.databasePath), this.sessionId); }
  private deleted = false;

  get sessionDeleted(): boolean { return this.deleted; }
  markSessionDeleted(): void {
    this.deleted = true;
    this.storageAbort.abort(new Error('Chat session was deleted.'));
  }

  get abortSignal(): AbortSignal { return this.executionSignal; }
  get stopRequested(): boolean { return this.userStop.signal.aborted; }
  requestUserStop(): void {
    if (this.stopRequested || this.terminalCause !== null) return;
    this.commit({ kind: 'stop_requested', requestedAtUtc: new Date().toISOString() });
    this.userStop.abort(new Error('Stopped by user.'));
  }
  abortForStorageFailure(error: Error): void { this.storageAbort.abort(error); }

  attachProgress(writer: ChatStreamProgressWriter): void {
    if (this.progressWriter && this.progressWriter !== writer) throw new Error('Chat run already has a progress writer.');
    this.progressWriter = writer;
  }

  private constructor(
    private readonly databasePath: string,
    readonly operationId: string,
    private readonly ownerEpoch: string,
    readonly sessionId: string,
    /** The admitted settings; execution reads them here instead of re-deriving them from the request. */
    readonly settings: ChatRunEffectiveSettings,
  ) {
    this.latestSequence = 0;
  }

  /**
   * Resolved per write, never held: a second runtime root in the same process closes the cached
   * handle, and a run that lost its terminal write would block its session forever.
   */
  private get store(): ChatJournalStore {
    return new ChatJournalStore(getRuntimeDatabase(this.databasePath));
  }

  get userMessageId(): string {
    const first = this.store.readAfter(this.operationId, 0, 1)[0]?.event;
    if (first?.kind !== 'run_started') throw new Error('Chat execution is missing its accepted submission.');
    return first.userMessageId;
  }

  get messageIdPrefix(): string { return buildChatRunMessageIdPrefix(this.operationId); }

  resolveAssistantMessageId(turn: number): string {
    this.progressWriter?.flushPending();
    return buildChatMessageId(this.messageIdPrefix, { kind: this.narratedTurns.has(turn) ? 'narration' : 'answer', turn: turn });
  }

  resolveToolMessageId(toolCallId: string): string | null { return this.toolMessageIds.get(toolCallId) ?? null; }

  cancelUndispatchedSubmission(): void {
    const run = this.store.readRun(this.operationId);
    if (!run || run.requestId !== null || this.dispatched) {
      throw new Error('Only an undispatched submission can be cancelled.');
    }
    this.commit({ kind: 'submission_cancelled', userMessageId: this.userMessageId, reason: 'client_disconnected_before_dispatch' });
    this.finish({ terminalCause: 'user_stop', detail: 'Client disconnected before dispatch.', usage: null, recoveryStatus: 'ok' });
  }

  static begin(databasePath: string, input: ChatRunRecorderStart): ChatRunRecorder {
    const start = ChatRunRecorderStartSchema.parse(input);
    const recorder = new ChatRunRecorder(databasePath, start.operationId, start.ownerEpoch, start.sessionId, start.settings);
    return getRuntimeDatabase(databasePath).transaction(() => {
    const run = recorder.store.begin({
      operationId: start.operationId,
      sessionId: start.sessionId,
      recordKind: 'execution',
      operationKind: start.operationKind,
      ownerEpoch: start.ownerEpoch,
      settings: start.settings,
      provenance: null,
      createdAtUtc: start.startedAtUtc,
    });
    recorder.commit({
      kind: 'run_started',
      sessionId: start.sessionId,
      operationKind: start.operationKind,
      runOrder: run.runOrder,
      userMessageId: start.userMessageId,
      content: start.content,
      images: start.images,
      imageMeta: start.imageMeta,
      settings: start.settings,
      retainedHistoryRevision: start.retainedHistoryRevision,
    }, start.startedAtUtc);
    return recorder;
    })();
  }

  static resume(databasePath: string, operationId: string, ownerEpoch: string): ChatRunRecorder {
    const run = new ChatJournalStore(getRuntimeDatabase(databasePath)).readRun(operationId);
    if (!run || run.ownerEpoch !== ownerEpoch) throw new Error('Cannot resume a chat recorder owned by another epoch.');
    if (run.settings === null) throw new Error('Only an execution run with admitted settings can be resumed.');
    const recorder = new ChatRunRecorder(databasePath, operationId, ownerEpoch, run.sessionId, run.settings);
    for (const envelope of recorder.store.readAll(operationId)) recorder.observeCommitted(envelope.event);
    recorder.latestSequence = run.latestSequence;
    return recorder;
  }

  /** Names the engine identities this run is found by. Repeating the same binding is a no-op. */
  bindEngine(input: ChatRunEngineBinding): void {
    const binding = ChatRunEngineBindingSchema.parse(input);
    const sequence = this.latestSequence;
    try {
      getRuntimeDatabase(this.databasePath).transaction(() => {
        const before = this.store.readRun(this.operationId);
        this.store.bindEngine({ ...binding, operationId: this.operationId, ownerEpoch: this.ownerEpoch });
        if (before?.requestId === binding.requestId) return;
        this.commit({ kind: 'engine_bound', ...binding });
      })();
    } catch (error) {
      this.latestSequence = sequence;
      throw error;
    }
  }

  recordContextInitialized(init: ChatContextInit): void {
    this.commit({ kind: 'context_initialized', ...init });
  }

  recordDisplay(event: ChatTranscriptEvent): void {
    this.commit({ kind: 'display', event });
  }

  recordPresentation(event: ChatRunPresentationEvent): void { this.commit({ kind: 'presentation', event }); }

  get terminalCause(): ChatRunTerminalCause | null {
    const run = this.store.readRun(this.operationId);
    if (!run) throw new Error(`Chat run ${this.operationId} is missing.`);
    return run.terminalCause;
  }

  readSession(): ChatSession {
    const database = getRuntimeDatabase(this.databasePath);
    const report = reconcileChatRun(database, this.operationId);
    if (report.status === 'recovery_failed') throw new Error(`Chat projection failed: ${report.issues.map(issue => issue.detail).join('; ')}`);
    const session = readChatSessionFromPath(getChatSessionPath(dirname(this.databasePath), this.sessionId));
    if (!session) throw new Error(`Chat session ${this.sessionId} is missing.`);
    const requestId = this.store.readRun(this.operationId)?.requestId;
    if (requestId) new ChatMessageQueueStore(database).deleteIncorporated(this.sessionId, requestId);
    return session;
  }

  readHistory() {
    const history = buildRecoveredChatHistory(getRuntimeDatabase(this.databasePath), this.sessionId, this.operationId);
    if (history.status === 'recovery_failed') throw new Error('Chat context recovery failed; repair the journal before continuing.');
    this.historyRevisionValue = this.readHistoryRevisions().length;
    return [...history.messages, ...history.interruptionNotices.map(content => ({ role: 'user' as const, content }))];
  }

  completeAnswer(answer: ChatAnswerCompletion, terminalCause: ChatRunTerminalCause = 'completed', detail: string | null = null): ChatSession {
    this.progressWriter?.flushPending();
    this.recordDisplay({ kind: 'answer_completed', answer: ChatAnswerCompletionSchema.parse(answer), messageId: this.answerMessageId });
    this.finish({ terminalCause, detail, usage: null, recoveryStatus: terminalCause === 'completed' ? 'ok' : 'recovery_needed' });
    return this.readSession();
  }

  stop(terminalCause: ChatRunTerminalCause, detail: string | null): ChatSession {
    this.progressWriter?.flushPending();
    this.finish({ terminalCause, detail, usage: null, recoveryStatus: 'recovery_needed' });
    return this.readSession();
  }

  /** `modelPreset` is the run's admitted model preset: a queued image is admitted exactly as the submission was. */
  claimQueuedMessages(sessionId: string, input: ChatQueueClaimInput, modelPreset: ModelRuntimePreset, forceId?: string) {
    const before = this.latestSequence;
    try {
      return getRuntimeDatabase(this.databasePath).transaction(() => {
        const run = this.store.readRun(this.operationId);
        if (!run || run.sessionId !== sessionId) throw new Error('Queue delivery does not belong to this chat run.');
        if (run.requestId !== null && run.requestId !== input.requestId) throw new Error('Queue delivery has a different engine identity.');
        const queue = new ChatMessageQueueStore(getRuntimeDatabase(this.databasePath));
        const force = forceId ? queue.state(sessionId).force : null;
        if (forceId && (!force || force.id !== forceId || force.phase === 'failed')) throw new Error('Queued continuation was cancelled.');
        const now = new Date().toISOString();
        // Admission runs inside the claim: a refused image leaves the message pending, not half-delivered.
        const messages = queue.claim(sessionId, input, now).map(message => ({ ...message, ...admitChatImages(modelPreset, message.images) }));
        for (const message of messages) {
          this.commit({ kind: 'queue_delivered', requestId: input.requestId, deliveredAtUtc: now,
            message: { id: message.id, content: message.content, images: message.images, imageMeta: message.imageMeta, turn: input.turn,
              boundary: input.turn === 0 ? 'successor_start' : 'post_tool_batch' },
          }, now);
        }
        if (forceId) {
          queue.setPaused(sessionId, false);
          queue.clearForce(sessionId, forceId);
        }
        return messages;
      })();
    } catch (error) {
      this.latestSequence = before;
      throw error;
    }
  }

  recordContextSpliced(splice: ChatContextSplice): void {
    this.progressWriter?.flushPending();
    this.commit({ kind: 'context_spliced', ...splice });
    this.store.advanceContextRevision({
      operationId: this.operationId,
      contextRevision: splice.contextRevision,
    });
  }

  recordToolProposed(evidence: ChatToolProposedEvidence): void {
    this.progressWriter?.flushPending();
    this.commit({ kind: 'tool_proposed', ...evidence });
  }

  recordApprovalReviewed(evidence: ChatApprovalReviewedEvidence): void {
    this.commit({ kind: 'approval_reviewed', ...evidence }, evidence.reviewedAtUtc);
  }

  recordApprovalRequested(evidence: ChatApprovalRequestedEvidence): void {
    this.commit({ kind: 'approval_requested', ...evidence }, evidence.requestedAtUtc, `approval_requested:${evidence.approvalId}`);
  }

  recordApprovalResolved(evidence: ChatApprovalResolvedEvidence): void {
    this.commit({ kind: 'approval_resolved', ...evidence }, evidence.decidedAtUtc, `approval_resolved:${evidence.approvalId}`);
  }

  recordToolStarted(evidence: ChatToolStartedEvidence): void {
    throwIfAborted(this.abortSignal);
    this.commit({ kind: 'tool_started', ...evidence });
  }

  recordToolResult(evidence: ChatToolResultEvidence): void {
    this.commit({ kind: 'tool_result', ...evidence });
  }

  recordToolResultFinalized(evidence: ChatToolResultFinalizedEvidence): void {
    this.commit({ kind: 'tool_result_finalized', ...evidence });
  }

  /**
   * Ends the run: the outcome is committed, then the row is closed so the session can admit a
   * successor. Repeating the same terminal cause is a no-op; claiming a different one fails.
   */
  finish(outcome: {
    terminalCause: ChatRunTerminalCause;
    detail: string | null;
    usage: ChatStreamUsageEvent | null;
    recoveryStatus: ChatRecoveryStatus;
  }): void {
    if (this.deleted) throw new Error('Chat session deletion owns this operation; no terminal write is permitted.');
    if (this.storageAbort.signal.aborted) {
      outcome = { ...outcome, terminalCause: 'storage_failure', detail: getAbortError(this.storageAbort.signal).message, recoveryStatus: 'recovery_needed' };
    } else {
      this.progressWriter?.flushPending();
    }
    const finishedAtUtc = new Date().toISOString();
    const before = this.latestSequence;
    try {
      getRuntimeDatabase(this.databasePath).transaction(() => {
        if (this.store.readRun(this.operationId)?.terminalCause === null) {
          this.commit({ kind: 'run_finished', ...outcome, finishedAtUtc }, finishedAtUtc);
        }
        this.store.finish({
          operationId: this.operationId,
          ownerEpoch: this.ownerEpoch,
          terminalCause: outcome.terminalCause,
          updatedAtUtc: finishedAtUtc,
        });
      })();
    } catch (error) {
      this.latestSequence = before;
      throw error;
    }
  }

  private observeCommitted(event: ChatJournalEvent): void {
    if (event.kind === 'run_started') this.historyRevisionValue = event.retainedHistoryRevision;
    if (event.kind === 'context_initialized') {
      this.dispatched = true;
      this.answerMessageId = event.messages.slice(event.turnBoundary).reverse()
        .find(message => message.role === 'assistant' && !message.tool_calls)?.chatMessageId;
    }
    if (event.kind === 'context_spliced') {
      const assistant = [...event.inserted].reverse().find(message => message.role === 'assistant' && !message.tool_calls);
      if (assistant) this.answerMessageId = assistant.chatMessageId;
    }
    if (event.kind === 'display' && event.event.kind === 'narration') this.narratedTurns.add(event.event.delta.turn);
    if (event.kind === 'tool_proposed') this.toolMessageIds.set(event.call.toolCallId,
      buildChatMessageId(this.messageIdPrefix, { kind: 'tool', toolCallId: event.call.displayToolCallId }));
    if (event.kind === 'stop_requested') this.userStop.abort(new Error('Stopped by user.'));
  }

  /**
   * Evidence the database could not commit ends the run as a storage failure: the engine that gets
   * the throw must not act, and the terminal write must say why it stopped.
   */
  private commit(event: ChatJournalEvent, occurredAtUtc = new Date().toISOString(), eventId = `${this.operationId}:${String(this.latestSequence + 1)}`): void {
    if (this.deleted) throw new Error('Chat session was deleted; its execution cannot write further evidence.');
    if (event.kind !== 'run_finished') throwIfAborted(this.storageAbort.signal);
    const envelope = this.append({
      operationId: this.operationId,
      ownerEpoch: this.ownerEpoch,
      expectedSequence: this.latestSequence,
      eventId,
      occurredAtUtc,
      event,
    });
    this.latestSequence = Math.max(this.latestSequence, envelope.sequence);
    this.observeCommitted(envelope.event);
  }

  /** A write the database could not take fences the run; a write the journal refused is reported as it is. */
  private append(input: ChatJournalAppend): ChatJournalEnvelope {
    try {
      return this.store.append(input);
    } catch (error) {
      const failure = toError(error);
      if (isStorageFailure(failure)) this.abortForStorageFailure(failure);
      throw error;
    }
  }
}

/**
 * What a run executes under, captured once at admission. `session` is the preset-selected session,
 * so the recorded mode and preset are the ones the engine is handed, not the ones the client sent.
 */
export function buildChatRunSettings(input: {
  session: ChatSession;
  config: SiftConfig;
  operationKind: ChatSessionOperationKind;
  presetId: string;
  repoRoot: string;
  approval: ApprovalMode | null;
  maxTurns: number | null;
  webSearchEnabled: boolean;
}): ChatRunEffectiveSettings {
  return ChatRunEffectiveSettingsSchema.parse({
    operationKind: input.operationKind,
    mode: input.session.mode ?? 'chat',
    presetId: input.presetId,
    modelPresetId: input.session.modelPresetId,
    model: input.session.modelPreset.Model ?? null,
    repoRoot: input.repoRoot,
    approval: input.approval,
    maxTurns: input.maxTurns,
    thinkingEnabled: input.session.thinkingEnabled !== false,
    webSearchEnabled: input.webSearchEnabled,
    contextWindowTokens: resolveChatSessionContextWindow(input.config, input.session),
  });
}

export function buildChatAnswerCompletion(result: RepoSearchExecutionResult, content: string): ChatAnswerCompletion {
  const totals = result.turnRecords.length > 0 ? foldTurnTokenRecords(result.turnRecords) : null;
  return ChatAnswerCompletionSchema.parse({
    content,
    outputTokensEstimate: totals?.outputTokens ?? estimateTokenCount(content),
    outputTokensEstimated: totals === null || totals.outputTokensEstimatedCount > 0,
    thinkingTokens: 0, thinkingTokensEstimated: false,
    promptCacheTokens: getScorecardTotal(result.scorecard, 'promptCacheTokens'),
    promptEvalTokens: getScorecardTotal(result.scorecard, 'promptEvalTokens'),
    promptEvalDurationMs: getScorecardTotal(result.scorecard, 'promptEvalDurationMs'),
    generationDurationMs: getScorecardTotal(result.scorecard, 'generationDurationMs'),
    promptTokensPerSecond: getPromptTokensPerSecond(getScorecardTotal(result.scorecard, 'promptEvalTokens'), getScorecardTotal(result.scorecard, 'promptEvalDurationMs')),
    generationTokensPerSecond: getGenerationTokensPerSecond(totals?.outputTokens ?? 0, totals?.thinkingTokens ?? 0, getScorecardTotal(result.scorecard, 'generationDurationMs')),
    speculativeAcceptedTokens: getScorecardTotal(result.scorecard, 'speculativeAcceptedTokens'),
    speculativeGeneratedTokens: getScorecardTotal(result.scorecard, 'speculativeGeneratedTokens'),
  });
}
