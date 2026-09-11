import assert from 'node:assert/strict';
import {
  CHAT_PROJECTION_MAX_FRAME_BYTES, ChatOperationSnapshotSchema, ChatProjectionFrameSchema, ChatProjectionRecordSchema, ChatTranscriptMessageSchema,
  type ChatMessageQueueState, type ChatOperationSnapshot, type ChatProjectionCapture, type ChatProjectionFrame, type ChatProjectionRecord, type ChatTranscriptMessage,
} from '@siftkit/contracts';
import { serializeChatProjectionFrame } from '../../src/status-server/chat-projection-encoder.js';

/** Reassembles frames exactly as a receiver would: by record, in chunk order, one JSON parse per record. */
export function decodeChatProjectionFrames(frames: Iterable<ChatProjectionFrame>, transferId: string): ChatProjectionRecord[] {
  const records: ChatProjectionRecord[] = [];
  let pending: { recordIndex: number; chunkIndex: number; data: string } | null = null;
  for (const frame of frames) {
    ChatProjectionFrameSchema.parse(frame);
    assert.equal(frame.transferId, transferId);
    if (pending === null) {
      assert.equal(frame.recordIndex, records.length);
      assert.equal(frame.chunkIndex, 0);
      pending = { recordIndex: frame.recordIndex, chunkIndex: 0, data: frame.data };
    } else {
      assert.equal(frame.recordIndex, pending.recordIndex);
      assert.equal(frame.chunkIndex, pending.chunkIndex + 1);
      pending.chunkIndex = frame.chunkIndex;
      pending.data += frame.data;
    }
    if (frame.finalChunk) {
      records.push(ChatProjectionRecordSchema.parse(JSON.parse(pending.data)));
      pending = null;
    }
  }
  assert.equal(pending, null, 'a transfer must not end mid-record');
  return records;
}

/** A view as JSON delivers it: optional fields that were undefined are simply absent. */
export function asWireView(snapshot: ChatOperationSnapshot): ChatOperationSnapshot {
  return ChatOperationSnapshotSchema.parse(JSON.parse(JSON.stringify(snapshot)));
}

/** Total SSE bytes of the frames, asserting each one stays within the protocol bound. */
export function chatProjectionWireBytes(frames: Iterable<ChatProjectionFrame>): number {
  let total = 0;
  for (const frame of frames) {
    const bytes = Buffer.byteLength(serializeChatProjectionFrame(frame), 'utf8');
    assert.ok(bytes <= CHAT_PROJECTION_MAX_FRAME_BYTES, `frame of ${String(bytes)} bytes exceeds the bound`);
    total += bytes;
  }
  return total;
}

type StagedView = { snapshot: ChatOperationSnapshot; queue: ChatMessageQueueState | null };

function placeAfter(messages: ChatTranscriptMessage[], message: ChatTranscriptMessage, afterMessageId: string | null): ChatTranscriptMessage[] {
  const without = messages.filter(candidate => candidate.id !== message.id);
  if (afterMessageId === null) return [message, ...without];
  const anchor = without.findIndex(candidate => candidate.id === afterMessageId);
  assert.ok(anchor >= 0, `anchor ${afterMessageId} must already be staged`);
  return [...without.slice(0, anchor + 1), message, ...without.slice(anchor + 1)];
}

/** A reference receiver: stages one transfer over the previous view and returns the committed result. */
export function applyChatProjectionRecords(records: readonly ChatProjectionRecord[], previous: ChatProjectionCapture | null): StagedView {
  const [begin, ...rest] = records;
  assert.equal(begin?.kind, 'begin');
  if (begin?.kind !== 'begin') throw new Error('unreachable');
  if (begin.mode === 'update') assert.deepEqual(begin.after, previous?.cursor);
  const base = begin.mode === 'snapshot' || previous === null ? null : asWireView(previous.snapshot);
  let messages: ChatTranscriptMessage[] = base ? [...base.messages] : [];
  const tools = new Map((base?.tools ?? []).map(tool => [tool.messageId, tool]));
  const tokenTurns = new Map((base?.tokenTurns ?? []).map(tokenTurn => [tokenTurn.turn, tokenTurn]));
  const warnings = [...(base?.warnings ?? [])];
  const issues = [...(base?.issues ?? [])];
  let approval = base?.approval ?? null;
  let queue: ChatMessageQueueState | null = null;
  let committed = false;
  for (const record of rest) {
    assert.equal(committed, false, 'records after commit');
    if (record.kind === 'message') messages = placeAfter(messages, record.message, record.afterMessageId);
    else if (record.kind === 'append_text') {
      const index = messages.findIndex(message => message.id === record.messageId);
      const existing = messages[index];
      assert.ok(existing, `append target ${record.messageId} must be staged`);
      assert.equal(record.offset, existing.content.length);
      messages[index] = ChatTranscriptMessageSchema.parse({ ...existing, ...record.metadata, content: existing.content + record.text });
    } else if (record.kind === 'remove_message') {
      assert.ok(messages.some(message => message.id === record.messageId));
      messages = messages.filter(message => message.id !== record.messageId);
      tools.delete(record.messageId);
    } else if (record.kind === 'move_message') {
      const moved = messages.find(message => message.id === record.messageId);
      assert.ok(moved, `move target ${record.messageId} must be staged`);
      messages = placeAfter(messages, moved, record.afterMessageId);
    } else if (record.kind === 'tool') tools.set(record.tool.messageId, record.tool);
    else if (record.kind === 'token_turn') tokenTurns.set(record.tokenTurn.turn, record.tokenTurn);
    else if (record.kind === 'warning') { assert.ok(record.index <= warnings.length); warnings[record.index] = record.warning; }
    else if (record.kind === 'issue') { assert.ok(record.index <= issues.length); issues[record.index] = record.issue; }
    else if (record.kind === 'approval') approval = record.approval;
    else if (record.kind === 'queue') queue = record.queue;
    else if (record.kind === 'commit') {
      assert.deepEqual(record.counts, { messages: messages.length, tools: tools.size, tokenTurns: tokenTurns.size, warnings: warnings.length, issues: issues.length });
      assert.deepEqual(record.cursor, begin.cursor);
      committed = true;
    } else throw new Error(`unexpected ${record.kind} inside a transfer`);
  }
  assert.equal(committed, true, 'a transfer must commit');
  const snapshot = ChatOperationSnapshotSchema.parse({
    ...begin.state, sessionId: begin.sessionId, operationId: begin.operationId, cursor: { operationId: begin.cursor.operationId, sequence: begin.cursor.sequence },
    messages, tools: [...tools.values()], approval,
    tokenTurns: [...tokenTurns.values()].sort((a, b) => a.turn - b.turn), warnings, issues,
  });
  return { snapshot, queue };
}
