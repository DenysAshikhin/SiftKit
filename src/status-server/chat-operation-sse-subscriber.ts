import { randomUUID } from 'node:crypto';
import { CHAT_PROJECTION_MAX_FRAME_BYTES, ChatStreamErrorSchema, type ChatProjectionCapture, type ChatProjectionRecord, type ChatStreamError } from '@siftkit/contracts';
import type { ChatOperationClosure, ChatOperationSubscriber } from './chat-operation-broadcast.js';
import type { SseResponseWriter } from './sse-response-writer.js';
import type { RuntimeDatabase } from '../state/database-handle.js';
import { ChatOperationSnapshotReader, type ChatLiveOperationBinding } from './chat-operation-snapshot.js';
import { CHAT_PROJECTION_EVENT_NAME, createChatSnapshotRecords, createChatUpdateRecords, encodeChatProjectionRecord } from './chat-projection-encoder.js';
import type { ServerContext } from './server-types.js';
import { ChatRecoveryInvariantError } from '../state/chat-journal.js';
import { recoveryIssue } from './chat-run-recovery.js';
import { serverLogger } from './server-logger.js';

function readLiveBinding(ctx: ServerContext, sessionId: string, operationId: string): ChatLiveOperationBinding {
  const active = ctx.chatSessionOperations.getActiveOperation(sessionId);
  const activeOperation = active ? { operationId: active.operationId, operationKind: active.operationKind } : null;
  const lease = ctx.chatSessionOperations.getActive(sessionId);
  if (!lease || lease.recorder?.operationId !== operationId) return { approval: null, controlOperationId: null, activeOperation };
  const binding = ctx.chatRepoAgentRuns.get(sessionId);
  const state = binding ? ctx.repoAgentSessions.get(binding.runId)?.getState() : null;
  return { controlOperationId: lease.operationId, activeOperation,
    approval: binding && state?.status === 'approval_required' ? { runId: binding.runId, approvalId: state.approval.approvalId } : null };
}

/** One record as bounded frames, each submitted whole before its drain; false once the client is gone. */
async function writeRecord(writer: SseResponseWriter, record: ChatProjectionRecord, transferId: string, recordIndex: number): Promise<boolean> {
  for (const frame of encodeChatProjectionRecord(record, transferId, recordIndex)) {
    if (!await writer.writeBoundedSerializedEventAndDrain(CHAT_PROJECTION_EVENT_NAME, JSON.stringify(frame), CHAT_PROJECTION_MAX_FRAME_BYTES)) return false;
  }
  return true;
}

/** A failure is its own single-record transfer, so it never interleaves with an open record, then the stream ends. */
export async function writeChatProjectionFailure(writer: SseResponseWriter, failure: ChatStreamError): Promise<void> {
  await writeRecord(writer, { kind: 'error', failure: ChatStreamErrorSchema.parse(failure) }, randomUUID(), 0);
  writer.end();
}

type TransferOutcome = 'committed' | 'stale' | 'disconnected';

/**
 * Publications wake journal catch-up; no frame history is retained while a slow reader drains.
 * The reader holds its last committed view and at most one frozen capture in flight.
 */
export class ChatOperationSseSubscriber implements ChatOperationSubscriber {
  private committed: ChatProjectionCapture | null = null;
  private dirty = true;
  private revised = false;
  private closure: ChatOperationClosure | null = null;
  private started = false;
  private draining = false;
  private readonly reader: ChatOperationSnapshotReader;

  constructor(private readonly writer: SseResponseWriter, private readonly source: {
    ctx: ServerContext; sessionId: string; operationId: string; database: RuntimeDatabase;
  }) { this.reader = new ChatOperationSnapshotReader(source.operationId); }

  start(): void {
    if (this.started) throw new Error('Chat subscription already started.');
    this.started = true;
    void this.pump();
  }

  onPublished(): void {
    this.dirty = true;
    if (this.started) void this.pump();
  }

  onHistoryRevised(): void {
    this.revised = true;
    this.dirty = true;
    if (this.started) void this.pump();
  }

  onClosed(closure: ChatOperationClosure): void {
    this.closure = closure;
    this.dirty = true;
    if (this.started) void this.pump();
  }

  private async pump(): Promise<void> {
    if (this.draining || this.writer.isClientDisconnected()) return;
    this.draining = true;
    try {
      while (this.dirty && !this.writer.isClientDisconnected()) {
        this.dirty = false;
        this.revised = false;
        const { ctx, sessionId, operationId, database } = this.source;
        const next = this.reader.capture(database, readLiveBinding(ctx, sessionId, operationId));
        if (next.snapshot.sessionId !== sessionId) throw new ChatRecoveryInvariantError('conflicting_event', operationId, 'Chat subscription session mismatch.');
        const outcome = await this.transfer(next);
        if (outcome === 'disconnected') return;
        if (outcome === 'stale') this.dirty = true;
      }
      if (!this.closure || this.writer.isClientDisconnected()) return;
      if (this.closure.failure !== null) {
        await writeChatProjectionFailure(this.writer, { error: this.closure.failure });
        return;
      }
      const committed = this.committed;
      if (!committed || committed.snapshot.terminalCause === null) {
        throw new ChatRecoveryInvariantError('conflicting_event', this.source.operationId, 'Chat operation closed before its journal finished.');
      }
      await writeRecord(this.writer, { kind: 'terminal', cursor: committed.cursor, terminalCause: committed.snapshot.terminalCause,
        issue: committed.snapshot.issues[0] ?? null }, randomUUID(), 0);
      this.writer.end();
    } catch (error) {
      const issue = recoveryIssue(this.source.operationId, error instanceof Error ? error : new Error('Chat recovery failed.'));
      serverLogger.error({ scope: 'chat', id: this.source.operationId, event: 'snapshot_failed', fields: JSON.stringify(issue) });
      await writeChatProjectionFailure(this.writer, { error: `Chat recovery failed (${issue.code}): ${issue.detail}`, issue });
    } finally {
      this.draining = false;
    }
  }

  /** One transfer from the last committed view; a history revision during the drain ends it before its commit. */
  private async transfer(next: ChatProjectionCapture): Promise<TransferOutcome> {
    const transferId = randomUUID();
    const records = this.committed ? createChatUpdateRecords(this.committed, next) : createChatSnapshotRecords(next);
    let recordIndex = 0;
    for (const record of records) {
      // Checked immediately before the commit frame's synchronous write: that write is the publication boundary.
      if (record.kind === 'commit' && this.revised) {
        this.committed = null;
        return 'stale';
      }
      if (!await writeRecord(this.writer, record, transferId, recordIndex)) return 'disconnected';
      recordIndex += 1;
    }
    this.committed = next;
    return 'committed';
  }
}
