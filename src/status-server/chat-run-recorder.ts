import type {
  ChatRunEvidenceRecorder,
  ChatToolProposedEvidence,
  ChatToolResultEvidence,
  ChatToolResultFinalizedEvidence,
  ChatToolStartedEvidence,
  ChatApprovalRequestedEvidence,
  ChatApprovalResolvedEvidence,
} from '../repo-search/engine/chat-run-evidence.js';
import type { ChatContextInit, ChatContextSplice } from '../repo-search/planner-chat-message.js';
import {
  ChatAnswerCompletionSchema,
  type ChatAnswerCompletion,
  ChatRunEffectiveSettingsSchema,
  type ApprovalMode,
  type ChatRunEffectiveSettings,
  type ChatRunTerminalCause,
  type ChatSessionOperationKind,
  type ChatRecoveryStatus,
  type ChatStreamUsageEvent,
  type ChatTranscriptEvent,
} from '@siftkit/contracts';
import { z } from '../lib/zod.js';
import { getChatSessionPath, readChatSessionFromPath, type ChatSession, estimateTokenCount } from '../state/chat-sessions.js';
import type { SiftConfig } from '../config/types.js';
import { resolveChatSessionContextWindow } from './chat.js';
import { ChatJournalStore } from '../state/chat-journal.js';
import {
  ChatRunStartedEventSchema,
  type ChatJournalEvent,
} from '../state/chat-journal-schema.js';
import { getRuntimeDatabase } from '../state/runtime-db.js';
import { ChatMessageQueueStore, type ChatQueueClaimInput } from '../state/chat-message-queue.js';
import { dirname } from 'node:path';
import { reconcileChatRun } from './chat-run-projection.js';
import type { RepoSearchExecutionResult } from '../repo-search/types.js';
import { foldTurnTokenRecords } from '../repo-search/engine/turn-token-record.js';
import { getScorecardTotal } from './chat.js';
import type { ChatStreamProgressWriter } from './chat-stream-progress-writer.js';
import { buildRecoveredChatHistory } from './chat-context-replay.js';

/** The submission, minus the ordering the store assigns and the discriminator the recorder stamps. */
export const ChatRunRecorderStartSchema = ChatRunStartedEventSchema
  .omit({ kind: true, runOrder: true })
  .extend({
    operationId: z.string().uuid(),
    ownerEpoch: z.string().min(1),
    startedAtUtc: z.string().datetime(),
  });
export type ChatRunRecorderStart = z.infer<typeof ChatRunRecorderStartSchema>;

export const ChatRunEngineBindingSchema = z.strictObject({
  requestId: z.string().min(1),
  repoAgentSessionId: z.string().min(1).nullable(),
});
export type ChatRunEngineBinding = z.infer<typeof ChatRunEngineBindingSchema>;

/**
 * One Web operation's durable writer. Every method commits before returning, so a caller that got
 * back from the recorder may act, and a caller that got an exception must not.
 */
export class ChatRunRecorder implements ChatRunEvidenceRecorder {
  private latestSequence: number;
  private readonly storageAbort = new AbortController();
  private progressWriter: ChatStreamProgressWriter | null = null;

  get abortSignal(): AbortSignal { return this.storageAbort.signal; }
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

  static begin(databasePath: string, input: ChatRunRecorderStart): ChatRunRecorder {
    const start = ChatRunRecorderStartSchema.parse(input);
    const recorder = new ChatRunRecorder(databasePath, start.operationId, start.ownerEpoch, start.sessionId);
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
    const recorder = new ChatRunRecorder(databasePath, operationId, ownerEpoch, run.sessionId);
    recorder.latestSequence = run.latestSequence;
    return recorder;
  }

  /** Names the engine identities this run is found by. Repeating the same binding is a no-op. */
  bindEngine(input: ChatRunEngineBinding): void {
    const binding = ChatRunEngineBindingSchema.parse(input);
    const before = this.store.readRun(this.operationId);
    this.store.bindEngine({ ...binding, operationId: this.operationId, ownerEpoch: this.ownerEpoch });
    if (before?.requestId === binding.requestId) return;
    this.commit({ kind: 'engine_bound', ...binding });
  }

  recordContextInitialized(init: ChatContextInit): void {
    this.commit({ kind: 'context_initialized', ...init });
  }

  recordDisplay(event: ChatTranscriptEvent): void {
    this.commit({ kind: 'display', event });
  }

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
    return [...history.messages, ...history.interruptionNotices.map(content => ({ role: 'user' as const, content }))];
  }

  completeAnswer(answer: ChatAnswerCompletion, terminalCause: ChatRunTerminalCause = 'completed', detail: string | null = null): ChatSession {
    this.progressWriter?.flushPending();
    this.recordDisplay({ kind: 'answer_completed', answer: ChatAnswerCompletionSchema.parse(answer) });
    this.finish({ terminalCause, detail, usage: null, recoveryStatus: terminalCause === 'completed' ? 'ok' : 'recovery_needed' });
    return this.readSession();
  }

  stop(terminalCause: ChatRunTerminalCause, marker: string): ChatSession {
    this.progressWriter?.flushPending();
    const previous = [...(this.readSession().messages ?? [])].reverse()
      .find(message => message.sourceRunId === this.operationId && message.kind === 'assistant_answer');
    return this.completeAnswer({ content: previous?.content ? `${previous.content}\n\n${marker}` : marker }, terminalCause,
      terminalCause === 'user_stop' ? null : marker);
  }

  claimQueuedMessages(sessionId: string, input: ChatQueueClaimInput, forceId?: string) {
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
        const messages = queue.claim(sessionId, input, now);
        for (const message of messages) {
          this.commit({ kind: 'queue_delivered', requestId: input.requestId, deliveredAtUtc: now,
            message: { id: message.id, content: message.content, images: message.images, turn: input.turn,
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
    this.commit({ kind: 'context_spliced', ...splice });
    this.store.advanceContextRevision({
      operationId: this.operationId,
      contextRevision: splice.contextRevision,
    });
  }

  recordToolProposed(evidence: ChatToolProposedEvidence): void {
    this.commit({ kind: 'tool_proposed', ...evidence });
  }

  recordApprovalRequested(evidence: ChatApprovalRequestedEvidence): void {
    this.commit({ kind: 'approval_requested', ...evidence });
  }

  recordApprovalResolved(evidence: ChatApprovalResolvedEvidence): void {
    this.commit({ kind: 'approval_resolved', ...evidence });
  }

  recordToolStarted(evidence: ChatToolStartedEvidence): void {
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
    this.progressWriter?.flushPending();
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

  private commit(event: ChatJournalEvent, occurredAtUtc = new Date().toISOString()): void {
    const envelope = this.store.append({
      operationId: this.operationId,
      ownerEpoch: this.ownerEpoch,
      expectedSequence: this.latestSequence,
      eventId: `${this.operationId}:${String(this.latestSequence + 1)}`,
      occurredAtUtc,
      event,
    });
    this.latestSequence = envelope.sequence;
  }
}

/** What a run executed under, captured once at admission for audit rather than re-derived later. */
export function buildChatRunSettings(input: {
  session: ChatSession;
  config: SiftConfig;
  operationKind: ChatSessionOperationKind;
  repoRoot: string;
  approval: ApprovalMode | null;
  maxTurns: number | null;
}): ChatRunEffectiveSettings {
  return ChatRunEffectiveSettingsSchema.parse({
    operationKind: input.operationKind,
    mode: input.session.mode ?? 'chat',
    modelPresetId: input.session.modelPresetId,
    model: input.session.modelPreset.Model ?? null,
    repoRoot: input.repoRoot,
    approval: input.approval,
    maxTurns: input.maxTurns,
    thinkingEnabled: input.session.thinkingEnabled !== false,
    webSearchEnabled: input.session.webSearchEnabled === true,
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
    speculativeAcceptedTokens: getScorecardTotal(result.scorecard, 'speculativeAcceptedTokens'),
    speculativeGeneratedTokens: getScorecardTotal(result.scorecard, 'speculativeGeneratedTokens'),
  });
}
