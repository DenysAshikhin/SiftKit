import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CHAT_PROJECTION_MAX_FRAME_BYTES,
  CHAT_PROJECTION_PROTOCOL_VERSION,
  ChatProjectionCaptureSchema,
  ChatProjectionCursorSchema,
  ChatProjectionDeliverySchema,
  ChatProjectionFrameSchema,
  ChatProjectionRecordSchema,
  ChatTextRowMetadataSchema,
  ChatOperationSnapshotSchema,
  ChatMessageQueueStateSchema,
  advancesChatProjectionCursor,
  type ChatProjectionRecord,
} from '@siftkit/contracts';

const OPERATION_ID = '3e3b5cf7-39ce-438b-8d6c-1031056e471d';
const OTHER_OPERATION_ID = '706f2e52-01ec-4e62-9dc0-b7ced282e27e';
const TRANSFER_ID = 'e08682f5-9b0d-49ab-b4ef-cc0f027089ff';
const AT = '2026-09-10T12:09:36.905Z';

const cursor = { operationId: OPERATION_ID, sequence: 4, historyRevision: 1 };
const textMessage = {
  id: 'run-narration-1', role: 'assistant', kind: 'assistant_narration', content: 'hello', inputTokensEstimate: 0, outputTokensEstimate: 2,
  thinkingTokens: 0, createdAtUtc: AT, sourceRunId: OPERATION_ID,
};
const metadata = ChatTextRowMetadataSchema.parse({ kind: 'assistant_narration', inputTokensEstimate: 0, outputTokensEstimate: 3, thinkingTokens: 0 });
const state = { runOrder: 1, controlOperationId: null, operationKind: 'repo-agent', recordKind: 'execution', startedAtUtc: AT,
  terminalCause: null, status: 'ok', streamedCharsSinceBase: 0 };
const queue = ChatMessageQueueStateSchema.parse({ sessionId: 's1', revision: 0, messages: [], paused: false, force: null });
const tool = { toolCallId: 'call_a', messageId: 'run-tool-tc_0', executionState: 'completed', toolCallStatus: 'done' };
const tokenTurn = { turn: 1, prompt: null, usage: null };
const issue = { code: 'context_gap', operationId: OPERATION_ID, eventId: null, sequence: null, detail: 'gap' };

const VALID_RECORDS: ChatProjectionRecord[] = [
  { kind: 'begin', mode: 'snapshot', sessionId: 's1', operationId: OPERATION_ID, after: null, cursor, state: { ...state, operationKind: 'repo-agent', recordKind: 'execution', status: 'ok' } },
  { kind: 'begin', mode: 'update', sessionId: 's1', operationId: OPERATION_ID, after: { ...cursor, sequence: 3 }, cursor, state: { ...state, operationKind: 'repo-agent', recordKind: 'execution', status: 'ok' } },
  { kind: 'message', message: { ...textMessage, role: 'assistant', kind: 'assistant_narration' }, afterMessageId: null },
  { kind: 'message', message: { ...textMessage, role: 'assistant', kind: 'assistant_narration' }, afterMessageId: 'run-user' },
  { kind: 'append_text', messageId: 'run-narration-1', offset: 5, text: ' world', metadata },
  { kind: 'remove_message', messageId: 'run-narration-1' },
  { kind: 'move_message', messageId: 'run-narration-1', afterMessageId: null },
  { kind: 'tool', tool: { ...tool, executionState: 'completed', toolCallStatus: 'done' } },
  { kind: 'token_turn', tokenTurn },
  { kind: 'warning', index: 0, warning: 'slow provider' },
  { kind: 'issue', index: 0, issue: { ...issue, code: 'context_gap' } },
  { kind: 'approval', approval: null },
  { kind: 'queue', queue },
  { kind: 'commit', cursor, counts: { messages: 1, tools: 1, tokenTurns: 1, warnings: 1, issues: 1 } },
  { kind: 'terminal', cursor, terminalCause: 'completed', issue: null },
  { kind: 'terminal', cursor, terminalCause: 'execution_failure', issue: { ...issue, code: 'projection_failed' } },
  { kind: 'error', failure: { error: 'stream failed' } },
];

test('every projection record variant round-trips through its schema', () => {
  for (const record of VALID_RECORDS) assert.deepEqual(ChatProjectionRecordSchema.parse(record), record);
  assert.equal(ChatProjectionRecordSchema.options.length, 14);
});

const INVALID_RECORDS: [string, object][] = [
  ['an unknown kind', { kind: 'page', messages: [] }],
  ['a begin with an unknown mode', { ...VALID_RECORDS[0], mode: 'delta' }],
  ['a begin whose after cursor names another operation', { ...VALID_RECORDS[1], after: { ...cursor, operationId: OTHER_OPERATION_ID } }],
  ['a begin whose after cursor is beyond its cursor', { ...VALID_RECORDS[1], after: { ...cursor, sequence: 5 } }],
  ['a begin whose after revision is beyond its cursor', { ...VALID_RECORDS[1], after: { ...cursor, historyRevision: 2 } }],
  ['a snapshot begin with an after cursor', { ...VALID_RECORDS[0], after: { ...cursor, sequence: 3 } }],
  ['an update begin without an after cursor', { ...VALID_RECORDS[1], after: null }],
  ['a begin carrying collections', { ...VALID_RECORDS[0], state: { ...state, messages: [] } }],
  ['a message anchored on itself', { kind: 'message', message: textMessage, afterMessageId: 'run-narration-1' }],
  ['a message with an empty anchor', { kind: 'message', message: textMessage, afterMessageId: '' }],
  ['a malformed message', { kind: 'message', message: { ...textMessage, kind: 'assistant_tool_call' }, afterMessageId: null }],
  ['an append with a negative offset', { kind: 'append_text', messageId: 'm', offset: -1, text: 'x', metadata }],
  ['an append with a fractional offset', { kind: 'append_text', messageId: 'm', offset: 1.5, text: 'x', metadata }],
  ['an append with empty text', { kind: 'append_text', messageId: 'm', offset: 1, text: '', metadata }],
  ['an append carrying a content body', { kind: 'append_text', messageId: 'm', offset: 1, text: 'x', metadata: { ...metadata, content: 'body' } }],
  ['an append on a non-text kind', { kind: 'append_text', messageId: 'm', offset: 1, text: 'x', metadata: { ...metadata, kind: 'user_text' } }],
  ['a move anchored on itself', { kind: 'move_message', messageId: 'm', afterMessageId: 'm' }],
  ['a remove without an identity', { kind: 'remove_message', messageId: '' }],
  ['a tool without a message identity', { kind: 'tool', tool: { ...tool, messageId: '' } }],
  ['a token turn with a negative turn', { kind: 'token_turn', tokenTurn: { ...tokenTurn, turn: -1 } }],
  ['a warning with a negative index', { kind: 'warning', index: -1, warning: 'w' }],
  ['an issue with a fractional index', { kind: 'issue', index: 0.5, issue }],
  ['a commit with a negative count', { kind: 'commit', cursor, counts: { messages: -1, tools: 0, tokenTurns: 0, warnings: 0, issues: 0 } }],
  ['a commit missing a count', { kind: 'commit', cursor, counts: { messages: 0, tools: 0, tokenTurns: 0, warnings: 0 } }],
  ['a cursor with a negative sequence', { kind: 'commit', cursor: { ...cursor, sequence: -1 }, counts: { messages: 0, tools: 0, tokenTurns: 0, warnings: 0, issues: 0 } }],
  ['a cursor with a fractional revision', { kind: 'commit', cursor: { ...cursor, historyRevision: 0.5 }, counts: { messages: 0, tools: 0, tokenTurns: 0, warnings: 0, issues: 0 } }],
  ['a cursor without an operation identity', { kind: 'commit', cursor: { sequence: 1, historyRevision: 0 }, counts: { messages: 0, tools: 0, tokenTurns: 0, warnings: 0, issues: 0 } }],
  ['a terminal with an unknown cause', { kind: 'terminal', cursor, terminalCause: 'vanished', issue: null }],
  ['a terminal without an issue slot', { kind: 'terminal', cursor, terminalCause: 'completed' }],
  ['an error without a message', { kind: 'error', failure: { issue } }],
];

for (const [name, record] of INVALID_RECORDS) test(`projection records reject ${name}`, () => {
  assert.equal(ChatProjectionRecordSchema.safeParse(record).success, false);
});

test('frames carry exactly the protocol version and bounded data', () => {
  assert.equal(CHAT_PROJECTION_PROTOCOL_VERSION, 2);
  assert.equal(CHAT_PROJECTION_MAX_FRAME_BYTES, 64 * 1024);
  const frame = { version: 2, transferId: TRANSFER_ID, recordIndex: 0, chunkIndex: 0, finalChunk: true, data: '{"kind":"commit"}' };
  assert.equal(ChatProjectionFrameSchema.safeParse(frame).success, true);
  assert.equal(ChatProjectionFrameSchema.safeParse({ ...frame, version: 1, data: '{}' }).success, false);
  assert.equal(ChatProjectionFrameSchema.safeParse({ ...frame, version: 3 }).success, false);
  assert.equal(ChatProjectionFrameSchema.safeParse({ ...frame, transferId: 'transfer' }).success, false);
  assert.equal(ChatProjectionFrameSchema.safeParse({ ...frame, recordIndex: -1 }).success, false);
  assert.equal(ChatProjectionFrameSchema.safeParse({ ...frame, chunkIndex: 1.5 }).success, false);
  assert.equal(ChatProjectionFrameSchema.safeParse({ ...frame, data: 'x'.repeat(CHAT_PROJECTION_MAX_FRAME_BYTES + 1) }).success, false);
  assert.equal(ChatProjectionFrameSchema.safeParse({ ...frame, extra: true }).success, false);
});

test('a projection cursor advances only when both components hold or grow on the same operation', () => {
  assert.equal(advancesChatProjectionCursor(cursor, cursor), true);
  assert.equal(advancesChatProjectionCursor(cursor, { ...cursor, sequence: 5 }), true);
  assert.equal(advancesChatProjectionCursor(cursor, { ...cursor, historyRevision: 2 }), true);
  assert.equal(advancesChatProjectionCursor(cursor, { ...cursor, sequence: 3 }), false);
  assert.equal(advancesChatProjectionCursor(cursor, { ...cursor, historyRevision: 0 }), false);
  assert.equal(advancesChatProjectionCursor(cursor, { ...cursor, operationId: OTHER_OPERATION_ID }), false);
  assert.equal(ChatProjectionCursorSchema.safeParse({ operationId: OPERATION_ID, sequence: 0 }).success, false);
});

test('a capture binds its snapshot, projection cursor and queue to one operation and sequence', () => {
  const snapshot = ChatOperationSnapshotSchema.parse({ sessionId: 's1', operationId: OPERATION_ID, runOrder: 1, controlOperationId: null,
    operationKind: 'repo-agent', recordKind: 'execution', startedAtUtc: AT, terminalCause: null, status: 'ok',
    cursor: { operationId: OPERATION_ID, sequence: 4 }, messages: [], tools: [], approval: null,
    tokenTurns: [], streamedCharsSinceBase: 0, warnings: [], issues: [] });
  assert.equal(ChatProjectionCaptureSchema.safeParse({ snapshot, cursor, queue }).success, true);
  assert.equal(ChatProjectionCaptureSchema.safeParse({ snapshot, cursor: { ...cursor, sequence: 5 }, queue }).success, false);
  assert.equal(ChatProjectionCaptureSchema.safeParse({ snapshot, cursor: { ...cursor, operationId: OTHER_OPERATION_ID }, queue }).success, false);
  assert.equal(ChatProjectionCaptureSchema.safeParse({ snapshot, cursor }).success, false);
});

test('deliveries are exactly a view, a terminal or a failure', () => {
  const snapshot = ChatOperationSnapshotSchema.parse({ sessionId: 's1', operationId: OPERATION_ID, runOrder: 1, controlOperationId: null,
    operationKind: 'repo-agent', recordKind: 'execution', startedAtUtc: AT, terminalCause: null, status: 'ok',
    cursor: { operationId: OPERATION_ID, sequence: 4 }, messages: [], tools: [], approval: null,
    tokenTurns: [], streamedCharsSinceBase: 0, warnings: [], issues: [] });
  assert.equal(ChatProjectionDeliverySchema.safeParse({ kind: 'view', snapshot, queue: null }).success, true);
  assert.equal(ChatProjectionDeliverySchema.safeParse({ kind: 'view', snapshot, queue }).success, true);
  assert.equal(ChatProjectionDeliverySchema.safeParse({ kind: 'terminal', terminal: VALID_RECORDS[14] }).success, true);
  assert.equal(ChatProjectionDeliverySchema.safeParse({ kind: 'failure', failure: { error: 'x' } }).success, true);
  assert.equal(ChatProjectionDeliverySchema.safeParse({ kind: 'view', snapshot }).success, false);
  assert.equal(ChatProjectionDeliverySchema.safeParse({ kind: 'page', snapshot }).success, false);
});

test('text row metadata carries projection-changed fields and never a body', () => {
  const parsed = ChatTextRowMetadataSchema.parse({ kind: 'assistant_answer', inputTokensEstimate: 1, outputTokensEstimate: 2, thinkingTokens: 3,
    outputTokensEstimated: true, answerStartedAtUtc: AT, generationTokensPerSecond: 12.5, groundingStatus: 'fetched' });
  assert.equal(parsed.kind, 'assistant_answer');
  assert.equal(ChatTextRowMetadataSchema.safeParse({ ...metadata, id: 'x' }).success, false);
  assert.equal(ChatTextRowMetadataSchema.safeParse({ ...metadata, images: [] }).success, false);
  assert.equal(ChatTextRowMetadataSchema.safeParse({ ...metadata, toolCallOutput: 'x' }).success, false);
  assert.equal(ChatTextRowMetadataSchema.safeParse({ ...metadata, kind: 'assistant_tool_call' }).success, false);
});
