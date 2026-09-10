import type {
  ChatRunEvidenceRecorder,
  ChatToolProposedEvidence,
  ChatToolResultEvidence,
  ChatToolResultFinalizedEvidence,
  ChatToolStartedEvidence,
} from '../repo-search/engine/chat-run-evidence.js';
import type { ChatContextInit, ChatContextSplice } from '../repo-search/planner-chat-message.js';
import {
  ChatRunEffectiveSettingsSchema,
  type ApprovalMode,
  type ChatRunEffectiveSettings,
  type ChatRunTerminalCause,
  type ChatSessionOperationKind,
  type ChatRecoveryStatus,
  type ChatStreamUsageEvent,
} from '@siftkit/contracts';
import { z } from '../lib/zod.js';
import type { ChatSession } from '../state/chat-sessions.js';
import type { SiftConfig } from '../config/types.js';
import { resolveChatSessionContextWindow } from './chat.js';
import { ChatJournalStore } from '../state/chat-journal.js';
import {
  ChatRunStartedEventSchema,
  type ChatJournalEvent,
} from '../state/chat-journal-schema.js';
import { getRuntimeDatabase } from '../state/runtime-db.js';

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

  private constructor(
    private readonly databasePath: string,
    readonly operationId: string,
    private readonly ownerEpoch: string,
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
    const recorder = new ChatRunRecorder(databasePath, start.operationId, start.ownerEpoch);
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
    const finishedAtUtc = new Date().toISOString();
    if (this.store.readRun(this.operationId)?.terminalCause === null) {
      this.commit({ kind: 'run_finished', ...outcome, finishedAtUtc }, finishedAtUtc);
    }
    this.store.finish({
      operationId: this.operationId,
      ownerEpoch: this.ownerEpoch,
      terminalCause: outcome.terminalCause,
      updatedAtUtc: finishedAtUtc,
    });
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
