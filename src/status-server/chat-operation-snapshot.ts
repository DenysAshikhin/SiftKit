import { buildChatRunMessageIdPrefix, buildChatMessageId, ChatOperationIdSchema, ChatSessionOperationKindSchema, DurableChatApprovalSchema, type ChatOperationSnapshot, type ChatProjectionCapture, type DurableChatApproval, type ChatSnapshotTokenTurn, type ChatTranscriptMessage, type ChatRecoveryStatus, type ChatRecoveryIssue } from '@siftkit/contracts';
import { z } from '../lib/zod.js';
import type { RuntimeDatabase } from '../state/database-handle.js';
import { ChatJournalStore, ChatRecoveryInvariantError } from '../state/chat-journal.js';
import { readChatRunMessages } from '../state/chat-sessions.js';
import { readChatHistoryRevisionCount } from '../state/chat-history-revisions.js';
import { ChatMessageQueueStore } from '../state/chat-message-queue.js';
import { ChatRunProjection, reconcileChatRun } from './chat-run-projection.js';
import type { ChatRun } from '../state/chat-journal-schema.js';

/** The pending gate's exact binding; its presence alone does not authorize an expired decision. */
const ChatLiveApprovalBindingSchema = z.strictObject({ runId: z.string().uuid(), approvalId: z.string().uuid() });
export const ChatLiveOperationBindingSchema = z.strictObject({
  approval: ChatLiveApprovalBindingSchema.nullable(), controlOperationId: z.string().uuid().nullable(),
  /** The registry's live lease, which the durable queue state reports alongside its rows. */
  activeOperation: z.strictObject({ operationId: ChatOperationIdSchema, operationKind: ChatSessionOperationKindSchema }).nullable(),
});
export type ChatLiveOperationBinding = z.infer<typeof ChatLiveOperationBindingSchema>;

/** One subscriber's view. Only new evidence is folded after its initial frozen capture. */
export class ChatOperationSnapshotReader {
  private snapshot: ChatOperationSnapshot | null = null;
  private historyHead = 0;
  private readonly calls = new Map<string, string>();
  private readonly tokenTurns = new Map<number, ChatSnapshotTokenTurn>();

  constructor(private readonly operationId: string) {}

  /** View, projection cursor and queue from one transaction, so a transfer never mixes two states. */
  capture(database: RuntimeDatabase, live: ChatLiveOperationBinding, nowMs = Date.now()): ChatProjectionCapture {
    return database.transaction((): ChatProjectionCapture => {
      const operationId = this.operationId;
      const binding = ChatLiveOperationBindingSchema.parse(live);
      const store = new ChatJournalStore(database);
      const run = store.readRun(operationId);
      if (!run || run.recordKind !== 'execution' || run.operationKind === null) throw new ChatRecoveryInvariantError('missing_run', operationId, 'Chat execution does not exist.');
      const historyHead = z.object({ head: z.number().int() }).parse(database.prepare(
        'SELECT COALESCE(MAX(run_order), 0) AS head FROM chat_runs WHERE session_id=?',
      ).get(run.sessionId)).head;
      let previous = this.snapshot;
      if (previous && (historyHead !== this.historyHead || previous.status === 'recovery_failed')) previous = null;
      // A compaction folded on top of a retained view restarts the fold from the run's first event.
      const { messages, status, issues, warnings, streamedCharsSinceBase, approval } = this.fold(database, store, run, previous) ?? this.fold(database, store, run, null);
      if (approval) approval.actionable = status !== 'recovery_failed' && run.terminalCause === null
        && approval.outcome === null && binding.approval?.runId === approval.runId && binding.approval.approvalId === approval.approvalId
        && nowMs < Date.parse(approval.expiresAtUtc);
      const tools = messages.flatMap(message => {
        if (message.kind !== 'assistant_tool_call') return [];
        const toolCallId = this.calls.get(message.id);
        if (!toolCallId) throw new ChatRecoveryInvariantError('context_gap', operationId, 'Projected tool has no native proposal identity.');
        return [{ toolCallId, messageId: message.id, executionState: message.toolCallExecutionState, toolCallStatus: message.toolCallStatus }];
      });
      const snapshot: ChatOperationSnapshot = {
        sessionId: run.sessionId, operationId, runOrder: run.runOrder, controlOperationId: binding.controlOperationId,
        operationKind: run.operationKind, recordKind: run.recordKind, startedAtUtc: run.createdAtUtc, terminalCause: run.terminalCause,
        status: tools.some(tool => tool.executionState === 'uncertain' || tool.executionState === 'not_started') && status === 'ok' ? 'recovery_needed' : status,
        cursor: { operationId, sequence: run.latestSequence }, messages, tools, approval,
        tokenTurns: [...this.tokenTurns.values()].sort((a, b) => a.turn - b.turn), streamedCharsSinceBase, warnings, issues,
      };
      this.snapshot = snapshot;
      this.historyHead = historyHead;
      const queue = { ...new ChatMessageQueueStore(database).state(run.sessionId),
        activeOperationId: binding.activeOperation?.operationId ?? null, activeOperationKind: binding.activeOperation?.operationKind ?? null };
      // Built rather than re-parsed so unchanged rows keep their identity across captures.
      const capture: ChatProjectionCapture = { snapshot, queue,
        cursor: { operationId, sequence: run.latestSequence, historyRevision: readChatHistoryRevisionCount(database, run.sessionId) } };
      return capture;
    })();
  }

  /** One pass over the new evidence; null when a compaction invalidates the retained view. */
  private fold(database: RuntimeDatabase, store: ChatJournalStore, run: ChatRun, previous: null): FoldedSnapshot;
  private fold(database: RuntimeDatabase, store: ChatJournalStore, run: ChatRun, previous: ChatOperationSnapshot | null): FoldedSnapshot | null;
  private fold(database: RuntimeDatabase, store: ChatJournalStore, run: ChatRun, previous: ChatOperationSnapshot | null): FoldedSnapshot | null {
    const operationId = this.operationId;
    const projection = previous ? new ChatRunProjection({ messageIdPrefix: buildChatRunMessageIdPrefix(operationId),
      sourceRunId: operationId, createdAtUtc: run.createdAtUtc }, previous.messages, store.readApprovalRequests(operationId)) : null;
    if (!previous) {
      this.calls.clear();
      this.tokenTurns.clear();
    }
    const warnings = [...(previous?.warnings ?? [])];
    let streamedCharsSinceBase = previous?.streamedCharsSinceBase ?? 0;
    let approval: DurableChatApproval | null = previous?.approval ? { ...previous.approval } : null;
    for (const envelope of store.readAll(operationId, previous?.cursor.sequence ?? 0)) {
      const event = envelope.event;
      if (projection && event.kind === 'context_spliced' && event.reason === 'compacted') return null;
      projection?.apply(envelope);
      if (event.kind === 'presentation') {
        if (event.event.kind === 'warning') warnings.push(event.event.warning);
        else {
          const prompt = event.event.prompt;
          streamedCharsSinceBase = 0;
          this.tokenTurns.set(prompt.turn, { turn: prompt.turn, prompt, usage: this.tokenTurns.get(prompt.turn)?.usage ?? null });
        }
      } else if (event.kind === 'display' && event.event.kind === 'usage') {
        const usage = event.event.usage;
        this.tokenTurns.set(usage.turn, { turn: usage.turn, prompt: this.tokenTurns.get(usage.turn)?.prompt ?? null, usage });
      } else if (event.kind === 'display' && (event.event.kind === 'thinking' || event.event.kind === 'narration' || event.event.kind === 'answer')) {
        streamedCharsSinceBase += event.event.delta.text.length;
      }
      if (event.kind === 'tool_proposed') {
        this.calls.set(buildChatMessageId(buildChatRunMessageIdPrefix(operationId), { kind: 'tool', toolCallId: event.call.displayToolCallId }), event.call.toolCallId);
      } else if (event.kind === 'approval_requested') {
        if (run.repoAgentSessionId === null) throw new ChatRecoveryInvariantError('conflicting_event', operationId, 'Approval evidence has no bound execution.');
        approval = DurableChatApprovalSchema.parse({
          runId: run.repoAgentSessionId, approvalId: event.approvalId, toolCallId: event.call.toolCallId,
          toolName: event.toolName, command: event.command, reviewPayload: event.reviewPayload, mode: event.mode,
          requestedAtUtc: event.requestedAtUtc, expiresAtUtc: event.expiresAtUtc,
          outcome: null, decidedAtUtc: null, actionable: false,
        });
      } else if (event.kind === 'approval_resolved' && approval?.approvalId === event.approvalId) {
        approval.outcome = event.outcome;
        approval.decidedAtUtc = event.decidedAtUtc;
      }
    }
    if (projection && previous) {
      const projected = projection.finish();
      return { messages: projected.messages, status: projected.status, issues: previous.issues, warnings, streamedCharsSinceBase, approval };
    }
    const report = reconcileChatRun(database, operationId);
    return { messages: readChatRunMessages(database, run.sessionId, operationId), status: report.status, issues: report.issues, warnings, streamedCharsSinceBase, approval };
  }
}

type FoldedSnapshot = {
  messages: ChatTranscriptMessage[]; status: ChatRecoveryStatus; issues: ChatRecoveryIssue[];
  warnings: ChatOperationSnapshot['warnings']; streamedCharsSinceBase: number; approval: DurableChatApproval | null;
};
