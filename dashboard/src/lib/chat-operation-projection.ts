import {
  ChatProjectionRecordSchema,
  ChatTextRowKindSchema,
  ChatTranscriptMessageSchema,
  advancesChatProjectionCursor,
  type ChatMessageQueueState,
  type ChatOperationSnapshot,
  type ChatProjectionCommitCounts,
  type ChatProjectionCursor,
  type ChatProjectionDelivery,
  type ChatProjectionFrame,
  type ChatProjectionRecord,
  type ChatRecoveredTool,
  type ChatSnapshotTokenTurn,
  type DurableChatApproval,
} from '@siftkit/contracts';
import { parseJsonValueText } from '../../../src/lib/json.js';

type BeginRecord = Extract<ChatProjectionRecord, { kind: 'begin' }>;

/** One incomplete logical record: its fragments are joined once, at its final chunk. */
type PendingRecord = { transferId: string; recordIndex: number; chunkIndex: number; parts: string[] };

/** An open transfer staged over the last committed view; nothing here is readable until commit. */
type Staged = {
  transferId: string;
  nextRecordIndex: number;
  begin: BeginRecord;
  messages: ChatTranscriptMessage[];
  tools: Map<string, ChatRecoveredTool>;
  tokenTurns: Map<number, ChatSnapshotTokenTurn>;
  warnings: string[];
  issues: ChatOperationSnapshot['issues'];
  approval: DurableChatApproval | null;
  queue: ChatMessageQueueState | null;
};

type ChatTranscriptMessage = ChatOperationSnapshot['messages'][number];

function fail(detail: string): never {
  throw new Error(`Chat projection stream is invalid (${detail}). Reconnect to recover the conversation.`);
}

/**
 * Assembles bounded projection frames into committed views. Holds at most one incomplete logical
 * record and one staged transfer besides the committed view; incomplete batches never replace
 * readable state.
 */
export class ChatOperationProjection {
  private pending: PendingRecord | null = null;
  private staged: Staged | null = null;
  private committed: { snapshot: ChatOperationSnapshot; cursor: ChatProjectionCursor } | null = null;
  private readonly finishedTransferIds = new Set<string>();

  constructor(private readonly sessionId: string) {}

  /** The last committed view, or null before the first commit. */
  get snapshot(): ChatOperationSnapshot | null {
    return this.committed?.snapshot ?? null;
  }

  /** Null while a logical record or transfer is still incomplete. */
  acceptFrame(frame: ChatProjectionFrame): ChatProjectionDelivery | null {
    const pending = this.pending;
    if (pending) {
      if (frame.transferId !== pending.transferId || frame.recordIndex !== pending.recordIndex) fail('fragment of another record');
      if (frame.chunkIndex !== pending.chunkIndex + 1) fail('fragment out of order');
      pending.chunkIndex = frame.chunkIndex;
      pending.parts.push(frame.data);
    } else {
      if (frame.chunkIndex !== 0) fail('record starts mid-fragment');
      if (this.finishedTransferIds.has(frame.transferId)) fail('finished transfer reused');
      if (this.staged && frame.transferId !== this.staged.transferId) this.staged = null; // the sender ended that transfer before its commit
      const expectedIndex = this.staged?.nextRecordIndex ?? 0;
      if (frame.recordIndex !== expectedIndex) fail('record out of order');
      this.pending = { transferId: frame.transferId, recordIndex: frame.recordIndex, chunkIndex: 0, parts: [frame.data] };
    }
    if (!frame.finalChunk) return null;
    const complete = this.pending;
    if (!complete) fail('no pending record');
    this.pending = null;
    let record: ChatProjectionRecord;
    try {
      record = ChatProjectionRecordSchema.parse(parseJsonValueText(complete.parts.join('')));
    } catch {
      fail('malformed record');
    }
    return this.applyRecord(record, complete.transferId);
  }

  private applyRecord(record: ChatProjectionRecord, transferId: string): ChatProjectionDelivery | null {
    const staged = this.staged;
    if (record.kind === 'error') {
      this.staged = null;
      this.finishedTransferIds.add(transferId);
      return { kind: 'failure', failure: record.failure };
    }
    if (record.kind === 'terminal') {
      if (staged) fail('terminal inside an open transfer');
      const committed = this.committed;
      if (!committed) fail('terminal before any committed view');
      if (!sameCursor(committed.cursor, record.cursor)) fail('terminal cursor mismatch');
      if (committed.snapshot.terminalCause !== null && committed.snapshot.terminalCause !== record.terminalCause) {
        fail('terminal cause mismatch');
      }
      this.finishedTransferIds.add(transferId);
      return { kind: 'terminal', terminal: record };
    }
    if (record.kind === 'begin') {
      if (staged) fail('begin inside an open transfer');
      this.staged = this.stage(record, transferId);
      return null;
    }
    if (!staged) fail(`${record.kind} outside a transfer`);
    staged.nextRecordIndex += 1;
    if (record.kind === 'commit') return this.commit(staged, record);
    this.stageRecord(staged, record);
    return null;
  }

  private stage(begin: BeginRecord, transferId: string): Staged {
    if (begin.sessionId !== this.sessionId) fail('session mismatch');
    const committed = this.committed;
    const base = begin.mode === 'update' ? committed : null;
    if (begin.mode === 'update') {
      if (!base) fail('update before a committed view');
      if (begin.operationId !== base.snapshot.operationId) fail('update for another operation');
      if (begin.after === null || !sameCursor(begin.after, base.cursor)) fail('update cursor gap');
    } else if (committed && committed.snapshot.operationId === begin.operationId && !advancesChatProjectionCursor(committed.cursor, begin.cursor)) {
      fail('snapshot cursor regressed');
    }
    return {
      transferId, nextRecordIndex: 1, begin,
      messages: base ? [...base.snapshot.messages] : [],
      tools: new Map((base?.snapshot.tools ?? []).map(tool => [tool.messageId, tool])),
      tokenTurns: new Map((base?.snapshot.tokenTurns ?? []).map(tokenTurn => [tokenTurn.turn, tokenTurn])),
      warnings: [...(base?.snapshot.warnings ?? [])],
      issues: [...(base?.snapshot.issues ?? [])],
      approval: base?.snapshot.approval ?? null,
      queue: null,
    };
  }

  private stageRecord(staged: Staged, record: Exclude<ChatProjectionRecord, { kind: 'begin' | 'commit' | 'terminal' | 'error' }>): void {
    switch (record.kind) {
      case 'message': {
        if (staged.begin.mode === 'snapshot' && staged.messages.some(message => message.id === record.message.id)) {
          fail('duplicate message id in snapshot');
        }
        removeMessage(staged, record.message.id);
        insertAfter(staged, record.message, record.afterMessageId);
        return;
      }
      case 'append_text': {
        const index = staged.messages.findIndex(message => message.id === record.messageId);
        const existing = staged.messages[index];
        if (!existing) fail('append to an unknown message');
        if (!ChatTextRowKindSchema.safeParse(existing.kind).success) fail('append to a non-text row');
        if (record.offset !== existing.content.length) fail('append offset mismatch');
        staged.messages[index] = ChatTranscriptMessageSchema.parse({ ...existing, ...record.metadata, content: existing.content + record.text });
        return;
      }
      case 'remove_message': {
        if (!removeMessage(staged, record.messageId)) fail('removal of an unknown message');
        staged.tools.delete(record.messageId);
        return;
      }
      case 'move_message': {
        const moved = staged.messages.find(message => message.id === record.messageId);
        if (!moved) fail('move of an unknown message');
        removeMessage(staged, record.messageId);
        insertAfter(staged, moved, record.afterMessageId);
        return;
      }
      case 'tool':
        staged.tools.set(record.tool.messageId, record.tool);
        return;
      case 'token_turn':
        staged.tokenTurns.set(record.tokenTurn.turn, record.tokenTurn);
        return;
      case 'warning':
        if (record.index !== staged.warnings.length) fail('warning index gap');
        staged.warnings.push(record.warning);
        return;
      case 'issue':
        if (record.index !== staged.issues.length) fail('issue index gap');
        staged.issues.push(record.issue);
        return;
      case 'approval':
        staged.approval = record.approval;
        return;
      case 'queue':
        if (record.queue.sessionId !== this.sessionId) fail('queue session mismatch');
        staged.queue = record.queue;
        return;
    }
  }

  private commit(staged: Staged, record: Extract<ChatProjectionRecord, { kind: 'commit' }>): ChatProjectionDelivery {
    const { begin } = staged;
    if (!sameCursor(record.cursor, begin.cursor)) fail('commit cursor mismatch');
    const counts: ChatProjectionCommitCounts = { messages: staged.messages.length, tools: staged.tools.size, tokenTurns: staged.tokenTurns.size,
      warnings: staged.warnings.length, issues: staged.issues.length };
    if (COUNT_KEYS.some(key => record.counts[key] !== counts[key])) fail('commit counts mismatch');
    const ids = new Set(staged.messages.map(message => message.id));
    for (const messageId of staged.tools.keys()) if (!ids.has(messageId)) fail('tool without its message');
    const tools = staged.messages.flatMap(message => { const tool = staged.tools.get(message.id); return tool ? [tool] : []; });
    // Assembled from already-validated records, not re-parsed: unchanged rows keep their identity across views.
    const snapshot: ChatOperationSnapshot = {
      ...begin.state, sessionId: begin.sessionId, operationId: begin.operationId,
      cursor: { operationId: begin.cursor.operationId, sequence: begin.cursor.sequence },
      messages: staged.messages, tools, approval: staged.approval,
      tokenTurns: [...staged.tokenTurns.values()].sort((a, b) => a.turn - b.turn), warnings: staged.warnings, issues: staged.issues,
    };
    this.committed = { snapshot, cursor: begin.cursor };
    this.staged = null;
    this.finishedTransferIds.add(staged.transferId);
    return { kind: 'view', snapshot, queue: staged.queue };
  }
}

const COUNT_KEYS = ['messages', 'tools', 'tokenTurns', 'warnings', 'issues'] as const satisfies readonly (keyof ChatProjectionCommitCounts)[];

function sameCursor(a: ChatProjectionCursor, b: ChatProjectionCursor): boolean {
  return a.operationId === b.operationId && a.sequence === b.sequence && a.historyRevision === b.historyRevision;
}

function removeMessage(staged: Staged, messageId: string): boolean {
  const index = staged.messages.findIndex(message => message.id === messageId);
  if (index < 0) return false;
  staged.messages.splice(index, 1);
  return true;
}

/** Null anchor places first; a named anchor must already be staged. Appending after the last row is O(1). */
function insertAfter(staged: Staged, message: ChatTranscriptMessage, afterMessageId: string | null): void {
  if (afterMessageId === null) { staged.messages.unshift(message); return; }
  const last = staged.messages[staged.messages.length - 1];
  if (last && last.id === afterMessageId) { staged.messages.push(message); return; }
  const anchor = staged.messages.findIndex(candidate => candidate.id === afterMessageId);
  if (anchor < 0) fail('anchor is not staged');
  staged.messages.splice(anchor + 1, 0, message);
}
