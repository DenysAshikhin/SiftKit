import { buildChatRunMessageIdPrefix, buildChatMessageId, type ChatOperationUpdate, DurableChatApprovalSchema, type ChatOperationSnapshot, type DurableChatApproval, type ChatSnapshotTokenTurn, type ChatTranscriptMessage, type ChatRecoveryStatus, type ChatRecoveryIssue } from '@siftkit/contracts';
import { z } from '../lib/zod.js';
import type { RuntimeDatabase } from '../state/database-handle.js';
import { ChatJournalStore, ChatRecoveryInvariantError } from '../state/chat-journal.js';
import { readChatRunMessages } from '../state/chat-sessions.js';
import { projectChatRunEvents, reconcileChatRun } from './chat-run-projection.js';

const CHAT_SNAPSHOT_PAGE_SIZE = 100;
const CHAT_SNAPSHOT_MAX_PAGE_SIZE = 500;

/** The pending gate's exact binding; its presence alone does not authorize an expired decision. */
const ChatLiveApprovalBindingSchema = z.strictObject({ runId: z.string().uuid(), approvalId: z.string().uuid() });
export const ChatLiveOperationBindingSchema = z.strictObject({
  approval: ChatLiveApprovalBindingSchema.nullable(), controlOperationId: z.string().uuid().nullable(),
});
export type ChatLiveOperationBinding = z.infer<typeof ChatLiveOperationBindingSchema>;

/** One subscriber's view. Only new evidence is folded after its initial frozen capture. */
export class ChatOperationSnapshotReader {
  private snapshot: ChatOperationSnapshot | null = null;
  private historyHead = 0;
  private readonly calls = new Map<string, string>();
  private readonly tokenTurns = new Map<number, ChatSnapshotTokenTurn>();

  constructor(private readonly operationId: string) {}

  /** Resolve the database per capture; another runtime root may have closed an earlier handle. */
  capture(database: RuntimeDatabase, live: ChatLiveOperationBinding, nowMs = Date.now()): ChatOperationSnapshot {
    return database.transaction(() => {
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
      let events = [...store.readAll(operationId, previous?.cursor.sequence ?? 0)];
      if (previous && events.some(envelope => envelope.event.kind === 'context_spliced' && envelope.event.reason === 'compacted')) {
        previous = null;
        events = [...store.readAll(operationId)];
      }
      let messages: ChatTranscriptMessage[];
      let status: ChatRecoveryStatus;
      let issues: ChatRecoveryIssue[];
      if (previous) {
        const projected = projectChatRunEvents(events, { messageIdPrefix: buildChatRunMessageIdPrefix(operationId),
          sourceRunId: operationId, createdAtUtc: run.createdAtUtc }, previous.messages,
          events.some(envelope => envelope.event.kind === 'approval_resolved' && envelope.event.decision !== null) ? store.readApprovalRequests(operationId) : []);
        messages = projected.messages;
        status = projected.status;
        issues = previous.issues;
      } else {
        const report = reconcileChatRun(database, operationId);
        messages = readChatRunMessages(database, run.sessionId, operationId);
        status = report.status;
        issues = report.issues;
        this.calls.clear();
        this.tokenTurns.clear();
      }
      messages = messages.map(message => message.sourceRequestId === run.requestId ? message : { ...message, sourceRequestId: run.requestId });
      const warnings = [...(previous?.warnings ?? [])];
      let streamedCharsSinceBase = previous?.streamedCharsSinceBase ?? 0;
      let approval: DurableChatApproval | null = previous?.approval ? { ...previous.approval } : null;
      for (const envelope of events) {
        const event = envelope.event;
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
        cursor: { operationId, sequence: run.latestSequence }, messageOffset: 0, messages, tools, approval,
        tokenTurns: [...this.tokenTurns.values()].sort((a, b) => a.turn - b.turn), streamedCharsSinceBase, warnings, issues, complete: true,
      };
      this.snapshot = snapshot;
      this.historyHead = historyHead;
      return snapshot;
    })();
  }
}

/** A frozen capture is paged independently of subsequent writes, including writes between pages. */
export function* pageChatOperationSnapshot(snapshot: ChatOperationSnapshot, pageSize = CHAT_SNAPSHOT_PAGE_SIZE): Generator<ChatOperationSnapshot> {
  z.number().int().positive().max(CHAT_SNAPSHOT_MAX_PAGE_SIZE).parse(pageSize);
  for (let offset = 0; offset < Math.max(snapshot.messages.length, 1); offset += pageSize) {
    const messages = snapshot.messages.slice(offset, offset + pageSize);
    const ids = new Set(messages.map(message => message.id));
    yield { ...snapshot, messageOffset: offset, messages, tools: snapshot.tools.filter(tool => ids.has(tool.messageId)),
      complete: offset + pageSize >= snapshot.messages.length };
  }
}

export function diffChatOperationSnapshots(before: ChatOperationSnapshot, after: ChatOperationSnapshot): ChatOperationUpdate {
  const { messageOffset, complete, ...view } = after;
  if (!before.complete || !complete || messageOffset !== 0 || before.messageOffset !== 0) throw new Error('Chat updates require complete snapshots.');
  if (before.operationId !== after.operationId || before.sessionId !== after.sessionId) throw new Error('Chat update operation mismatch.');
  if (after.cursor.sequence < before.cursor.sequence) throw new Error('Chat update cursor moved backwards.');
  const previous = new Map(before.messages.map(message => [message.id, message]));
  return { ...view, afterSequence: before.cursor.sequence,
    messages: after.messages.filter(message => previous.get(message.id) !== message),
    messageOrder: after.messages.map(message => message.id) };
}
