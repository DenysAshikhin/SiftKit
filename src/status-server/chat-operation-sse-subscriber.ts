import type { ChatOperationFrame, ChatOperationSubscriber } from './chat-operation-broadcast.js';
import type { SseResponseWriter } from './sse-response-writer.js';
import { ChatStreamErrorSchema, isTerminalChatStreamEventName, type ChatOperationSnapshot } from '@siftkit/contracts';
import { getRuntimeDatabase } from '../state/runtime-db.js';
import { ChatOperationSnapshotReader, diffChatOperationSnapshots, pageChatOperationSnapshot, type ChatLiveOperationBinding } from './chat-operation-snapshot.js';
import type { ServerContext } from './server-types.js';
import { ChatRecoveryInvariantError } from '../state/chat-journal.js';
import { recoveryIssue } from './chat-run-recovery.js';
import { serverLogger } from './server-logger.js';

function readLiveBinding(ctx: ServerContext, sessionId: string, operationId: string): ChatLiveOperationBinding {
  const lease = ctx.chatSessionOperations.getActive(sessionId);
  if (!lease || lease.recorder?.operationId !== operationId) return { approval: null, controlOperationId: null };
  const binding = ctx.chatRepoAgentRuns.get(sessionId);
  const state = binding ? ctx.repoAgentSessions.get(binding.runId)?.getState() : null;
  return { controlOperationId: lease.operationId,
    approval: binding && state?.status === 'approval_required' ? { runId: binding.runId, approvalId: state.approval.approvalId } : null };
}

/** Publications wake journal catch-up; no frame history is retained while a slow reader drains. */
export class ChatOperationSseSubscriber implements ChatOperationSubscriber {
  private snapshot: ChatOperationSnapshot | null = null;
  private dirty = true;
  private closed = false;
  private started = false;
  private draining = false;
  private terminalFrame: ChatOperationFrame | null = null;
  private readonly reader: ChatOperationSnapshotReader;

  constructor(private readonly writer: SseResponseWriter, private readonly source: {
    ctx: ServerContext; sessionId: string; operationId: string; databasePath: string;
  }) { this.reader = new ChatOperationSnapshotReader(source.operationId); }

  start(): void {
    if (this.started) throw new Error('Chat subscription already started.');
    this.started = true;
    void this.pump();
  }

  onFrame(frame: ChatOperationFrame): void {
    if (isTerminalChatStreamEventName(frame.event)) this.terminalFrame = frame;
    this.dirty = true;
    if (this.started) void this.pump();
  }

  onHistoryRevised(): void {
    this.dirty = true;
    if (this.started) void this.pump();
  }

  onClosed(): void {
    this.closed = true;
    this.dirty = true;
    if (this.started) void this.pump();
  }

  private async pump(): Promise<void> {
    if (this.draining || this.writer.isClientDisconnected()) return;
    this.draining = true;
    try {
      while (this.dirty && !this.writer.isClientDisconnected()) {
        this.dirty = false;
        const { ctx, sessionId, operationId, databasePath } = this.source;
        const next = this.reader.capture(getRuntimeDatabase(databasePath), readLiveBinding(ctx, sessionId, operationId));
        if (next.sessionId !== sessionId) throw new ChatRecoveryInvariantError('conflicting_event', operationId, 'Chat subscription session mismatch.');
        if (!this.snapshot) {
          for (const page of pageChatOperationSnapshot(next)) {
            if (!await this.writer.writeSerializedEventAndDrain('snapshot', JSON.stringify(page))) return;
          }
        } else if (next.cursor.sequence !== this.snapshot.cursor.sequence
          || next.controlOperationId !== this.snapshot.controlOperationId
          || next.messages.length !== this.snapshot.messages.length
          || next.messages.some((message, index) => message !== this.snapshot?.messages[index])
          || JSON.stringify(next.approval) !== JSON.stringify(this.snapshot.approval)) {
          const update = diffChatOperationSnapshots(this.snapshot, next);
          if (!await this.writer.writeSerializedEventAndDrain('projection', JSON.stringify(update))) return;
        }
        this.snapshot = next;
        if (!await this.writer.writeSerializedEventAndDrain('queue', JSON.stringify(ctx.chatMessageQueue.state(sessionId)))) return;
      }
      if (this.closed && !this.writer.isClientDisconnected()) {
        const terminal = this.terminalFrame ?? { event: 'ended', data: '{}' };
        await this.writer.writeSerializedEventAndDrain(terminal.event, terminal.data);
        this.writer.end();
        this.snapshot = null;
      }
    } catch (error) {
      const issue = recoveryIssue(this.source.operationId, error instanceof Error ? error : new Error('Chat recovery failed.'));
      serverLogger.error({ scope: 'chat', id: this.source.operationId, event: 'snapshot_failed', fields: JSON.stringify(issue) });
      await this.writer.writeSerializedEventAndDrain('error', JSON.stringify(ChatStreamErrorSchema.parse({
        error: `Chat recovery failed (${issue.code}): ${issue.detail}`, issue,
      })));
      this.writer.end();
    } finally {
      this.draining = false;
    }
  }
}
