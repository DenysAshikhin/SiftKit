import {
  CHAT_PROJECTION_PROTOCOL_VERSION, ChatMessageQueueStateSchema, ChatOperationSnapshotSchema, ChatProjectionCaptureSchema,
  type ChatMessageQueueState, type ChatOperationSnapshot, type ChatProjectionCapture, type ChatProjectionCursor,
  type ChatProjectionFrame, type ChatProjectionRecord, type ChatRunTerminalCause, type ChatStreamError,
} from '@siftkit/contracts';
import { createChatSnapshotRecords, encodeChatProjectionRecords, serializeChatProjectionFrame } from '../../src/status-server/chat-projection-encoder.js';
import type { ChatStreamEvent } from '../src/lib/chat-stream-parser';

export const FIXTURE_OPERATION_ID = '4f9c1f9a-0000-4000-8000-000000000000';
let transferCounter = 0;
/** Deterministic, unique per call, so a test that reuses one on purpose has to hold it. */
export function nextTransferId(): string {
  transferCounter += 1;
  return `4f9c1f9a-1111-4000-8000-${String(transferCounter).padStart(12, '0')}`;
}

export function chatSnapshot(overrides: Partial<ChatOperationSnapshot> = {}): ChatOperationSnapshot {
  const operationId = overrides.operationId ?? FIXTURE_OPERATION_ID;
  return ChatOperationSnapshotSchema.parse({ sessionId: 's1', operationId, runOrder: 1, controlOperationId: operationId,
    operationKind: 'repo-agent', recordKind: 'execution', startedAtUtc: '2026-09-08T12:00:00.000Z', terminalCause: null,
    status: 'ok', cursor: { operationId, sequence: 1 }, messages: [], tools: [], approval: null,
    tokenTurns: [], streamedCharsSinceBase: 0, warnings: [], issues: [], ...overrides });
}

export function chatQueueState(overrides: Partial<ChatMessageQueueState> = {}): ChatMessageQueueState {
  return ChatMessageQueueStateSchema.parse({ sessionId: 's1', revision: 0, messages: [], paused: false, force: null, ...overrides });
}

/** A capture whose projection cursor is derived from the snapshot it binds. */
export function chatProjectionCapture(
  snapshotOverrides: Partial<ChatOperationSnapshot> = {}, historyRevision = 0, queue?: ChatMessageQueueState,
): ChatProjectionCapture {
  const snapshot = chatSnapshot(snapshotOverrides);
  const cursor: ChatProjectionCursor = { ...snapshot.cursor, historyRevision };
  return ChatProjectionCaptureSchema.parse({ snapshot, cursor, queue: queue ?? chatQueueState({ sessionId: snapshot.sessionId }) });
}

/** The real encoder's frames for a complete snapshot transfer of the capture. */
export function chatSnapshotFrames(capture: ChatProjectionCapture, transferId = nextTransferId()): ChatProjectionFrame[] {
  return [...encodeChatProjectionRecords(createChatSnapshotRecords(capture), transferId)];
}

/** Records fragmented every `chunkChars` UTF-16 units, so surrogate pairs and escapes land on boundaries. */
export function fragmentedFrames(records: readonly ChatProjectionRecord[], transferId: string, chunkChars: number): ChatProjectionFrame[] {
  const frames: ChatProjectionFrame[] = [];
  records.forEach((record, recordIndex) => {
    const json = JSON.stringify(record);
    const chunks = Math.max(1, Math.ceil(json.length / chunkChars));
    for (let chunkIndex = 0; chunkIndex < chunks; chunkIndex += 1) {
      frames.push({ version: CHAT_PROJECTION_PROTOCOL_VERSION, transferId, recordIndex, chunkIndex, finalChunk: chunkIndex === chunks - 1,
        data: json.slice(chunkIndex * chunkChars, (chunkIndex + 1) * chunkChars) });
    }
  });
  return frames;
}

export function terminalRecord(cursor: ChatProjectionCursor, terminalCause: ChatRunTerminalCause = 'completed'): ChatProjectionRecord {
  return { kind: 'terminal', cursor, terminalCause, issue: null };
}

export function errorRecord(failure: ChatStreamError): ChatProjectionRecord {
  return { kind: 'error', failure };
}

export function singleRecordFrames(record: ChatProjectionRecord, transferId = nextTransferId()): ChatProjectionFrame[] {
  return [...encodeChatProjectionRecords([record], transferId)];
}

export function projectionEvents(frames: readonly ChatProjectionFrame[]): ChatStreamEvent[] {
  return frames.map(frame => ({ kind: 'projection', frame }));
}

/** The SSE body text those frames occupy on the wire. */
export function projectionPackets(frames: readonly ChatProjectionFrame[]): string {
  return frames.map(serializeChatProjectionFrame).join('');
}
