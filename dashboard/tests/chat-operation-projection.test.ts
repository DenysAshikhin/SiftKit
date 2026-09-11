import assert from 'node:assert/strict';
import test from 'node:test';
import { ChatTextRowMetadataSchema, ChatTranscriptMessageSchema, ChatSessionResponseSchema, ChatRecoveryReportSchema, type ChatProjectionRecord, type ChatProjectionFrame } from '@siftkit/contracts';
import { createChatSnapshotRecords, createChatUpdateRecords, encodeChatProjectionRecords } from '../../src/status-server/chat-projection-encoder.js';
import { ChatOperationProjection } from '../src/lib/chat-operation-projection';
import { ChatSessionRuntimeStore } from '../src/lib/chat-session-runtime-store';
import { toRuntimeTransitions } from '../src/lib/chat-stream-transitions';
import type { ChatStreamEvent } from '../src/lib/chat-stream-parser';
import { CHAT_SESSION_RESPONSE } from './fixtures.js';
import {
  chatProjectionCapture, chatQueueState, chatSnapshotFrames, errorRecord, fragmentedFrames, nextTransferId, singleRecordFrames, terminalRecord,
} from './chat-snapshot-fixture.js';

const operationId = '4f9c1f9a-0000-4000-8000-000000000002';
function message(id: string, content: string, kind: 'assistant_answer' | 'assistant_narration' = 'assistant_answer') {
  return ChatTranscriptMessageSchema.parse({ id, kind, role: 'assistant', content,
    createdAtUtc: '2026-09-10T12:00:00.000Z',
    inputTokensEstimate: 0, outputTokensEstimate: 0, thinkingTokens: 0,
    inputTokensEstimated: false, outputTokensEstimated: false, thinkingTokensEstimated: false });
}
function capture(sequence: number, messages = [message('answer', 'partial')], historyRevision = 0) {
  return chatProjectionCapture({ operationId, operationKind: 'message', controlOperationId: null, cursor: { operationId, sequence }, messages }, historyRevision);
}

/** Feeds frames, asserting nothing is delivered before the last one, and returns that delivery. */
function feed(projection: ChatOperationProjection, frames: readonly ChatProjectionFrame[]) {
  const readable = projection.snapshot;
  for (const frame of frames.slice(0, -1)) {
    assert.equal(projection.acceptFrame(frame), null);
    assert.equal(projection.snapshot, readable);
  }
  const last = frames[frames.length - 1];
  assert.ok(last);
  return projection.acceptFrame(last);
}

function updateFrames(before: ReturnType<typeof capture>, after: ReturnType<typeof capture>, transferId = nextTransferId()) {
  return [...encodeChatProjectionRecords(createChatUpdateRecords(before, after), transferId)];
}

test('a snapshot transfer becomes readable only at its commit, with its queue', () => {
  const projection = new ChatOperationProjection('s1');
  const source = capture(4);
  const delivery = feed(projection, chatSnapshotFrames(source));
  assert.equal(delivery?.kind, 'view');
  if (delivery?.kind !== 'view') return;
  assert.deepEqual(delivery.snapshot, source.snapshot);
  assert.deepEqual(delivery.queue, source.queue);
  assert.equal(projection.snapshot, delivery.snapshot);
});

test('a snapshot rejects conflicting duplicate message identities', () => {
  const source = chatProjectionCapture({ operationId, messages: [message('duplicate', 'first'), message('duplicate', 'second')] });
  const records = [...createChatSnapshotRecords(source)].map(record => record.kind === 'commit'
    ? { ...record, counts: { ...record.counts, messages: 1 } }
    : record.kind === 'message' ? { ...record, afterMessageId: null } : record);
  const projection = new ChatOperationProjection('s1');

  assert.throws(() => {
    for (const frame of encodeChatProjectionRecords(records, nextTransferId())) projection.acceptFrame(frame);
  }, /duplicate message id in snapshot/u);
  assert.equal(projection.snapshot, null);
});

test('an update stages suffixes, inserts, removals, moves and auxiliary changes over the committed view and keeps unchanged rows', () => {
  const projection = new ChatOperationProjection('s1');
  const before = capture(4, [message('a', 'alpha'), message('b', 'beta'), message('c', 'gamma', 'assistant_narration')]);
  feed(projection, chatSnapshotFrames(before));
  const committed = projection.snapshot;
  assert.ok(committed);
  const kept = committed.messages[1];
  const after = chatProjectionCapture({ operationId, operationKind: 'message', controlOperationId: null, cursor: { operationId, sequence: 9 },
    messages: [message('c', 'gamma delta', 'assistant_narration'), before.snapshot.messages[1] ?? message('b', 'beta'), message('d', 'new')],
    warnings: ['late warning'], tokenTurns: [{ turn: 1, prompt: null, usage: null }] }, 0, chatQueueState({ revision: 3 }));
  const records = [...createChatUpdateRecords(before, after)];
  assert.deepEqual(records.map(record => record.kind), ['begin', 'remove_message', 'append_text', 'move_message', 'message', 'token_turn', 'warning', 'queue', 'commit']);
  const delivery = feed(projection, [...encodeChatProjectionRecords(records, nextTransferId())]);
  assert.equal(delivery?.kind, 'view');
  if (delivery?.kind !== 'view') return;
  assert.deepEqual(delivery.snapshot.messages.map(row => [row.id, row.content]), [['c', 'gamma delta'], ['b', 'beta'], ['d', 'new']]);
  assert.equal(delivery.snapshot.messages[1], kept, 'an untouched row keeps its identity');
  assert.deepEqual(delivery.snapshot.warnings, ['late warning']);
  assert.equal(delivery.queue?.revision, 3);
  assert.equal(delivery.snapshot.cursor.sequence, 9);
});

test('an update without queue changes delivers a null queue', () => {
  const projection = new ChatOperationProjection('s1');
  const before = capture(4);
  feed(projection, chatSnapshotFrames(before));
  const delivery = feed(projection, updateFrames(before, capture(5, [message('answer', 'partial answer')])));
  assert.equal(delivery?.kind, 'view');
  if (delivery?.kind !== 'view') return;
  assert.equal(delivery.queue, null);
  assert.equal(delivery.snapshot.messages[0]?.content, 'partial answer');
});

test('every fragmentation of multibyte and escaped content reassembles exactly', () => {
  const text = 'quote " backslash \\ newline \n emoji 😀 flag 🇺🇦 combining é and 界';
  const source = capture(4, [message('m', text)]);
  const records = [...createChatSnapshotRecords(source)];
  const json = JSON.stringify(records.find(record => record.kind === 'message'));
  for (let chunkChars = 1; chunkChars <= Math.min(json.length, 40); chunkChars += 1) {
    const projection = new ChatOperationProjection('s1');
    const delivery = feed(projection, fragmentedFrames(records, nextTransferId(), chunkChars));
    assert.equal(delivery?.kind, 'view', `chunk size ${String(chunkChars)}`);
    if (delivery?.kind === 'view') assert.equal(delivery.snapshot.messages[0]?.content, text);
  }
});

test('a transfer the sender abandons is discarded and the next transfer starts cleanly', () => {
  const projection = new ChatOperationProjection('s1');
  const before = capture(4);
  feed(projection, chatSnapshotFrames(before));
  const stale = updateFrames(before, capture(5, [message('answer', 'partial stale')]));
  for (const frame of stale.slice(0, -1)) projection.acceptFrame(frame);
  assert.equal(projection.snapshot?.messages[0]?.content, 'partial');
  const fresh = feed(projection, chatSnapshotFrames(capture(6, [message('answer', 'partial fresh')])));
  assert.equal(fresh?.kind, 'view');
  assert.equal(projection.snapshot?.messages[0]?.content, 'partial fresh');
});

test('a same-cursor transfer and a same-sequence history revision both apply', () => {
  const projection = new ChatOperationProjection('s1');
  const before = capture(4);
  feed(projection, chatSnapshotFrames(before));
  const queueOnly = chatProjectionCapture({ operationId, operationKind: 'message', controlOperationId: null, cursor: { operationId, sequence: 4 },
    messages: before.snapshot.messages }, 0, chatQueueState({ paused: true }));
  const first = feed(projection, updateFrames(before, queueOnly));
  assert.equal(first?.kind === 'view' && first.queue?.paused, true);
  const revised = capture(4, [], 1);
  const second = feed(projection, updateFrames(queueOnly, revised));
  assert.equal(second?.kind, 'view');
  assert.deepEqual(projection.snapshot?.messages, []);
});

test('a terminal after a commit is delivered and one before any commit is rejected', () => {
  const projection = new ChatOperationProjection('s1');
  const source = capture(4);
  assert.throws(() => feed(projection, singleRecordFrames(terminalRecord(source.cursor))), /terminal before any committed view/u);
  const fresh = new ChatOperationProjection('s1');
  feed(fresh, chatSnapshotFrames(source));
  const delivery = feed(fresh, singleRecordFrames(terminalRecord(source.cursor, 'user_stop')));
  assert.equal(delivery?.kind === 'terminal' && delivery.terminal.terminalCause, 'user_stop');
});

test('a terminal must identify the exact committed final cursor', () => {
  const projection = new ChatOperationProjection('s1');
  const source = capture(4);
  feed(projection, chatSnapshotFrames(source));

  assert.throws(() => feed(projection, singleRecordFrames(terminalRecord({ operationId, sequence: 50, historyRevision: 0 }))), /terminal cursor mismatch/u);
});

test('an error record discards staging, keeps the readable view, and is delivered as a failure', () => {
  const projection = new ChatOperationProjection('s1');
  const before = capture(4);
  feed(projection, chatSnapshotFrames(before));
  const partial = updateFrames(before, capture(5, [message('answer', 'partial more')]));
  for (const frame of partial.slice(0, -1)) projection.acceptFrame(frame);
  const delivery = feed(projection, singleRecordFrames(errorRecord({ error: 'Source has a sequence gap.' })));
  assert.equal(delivery?.kind === 'failure' && delivery.failure.error, 'Source has a sequence gap.');
  assert.equal(projection.snapshot?.messages[0]?.content, 'partial');
  const early = new ChatOperationProjection('s1');
  assert.equal(feed(early, singleRecordFrames(errorRecord({ error: 'before begin' })))?.kind, 'failure');
});

test('repeated transfers, reordered fragments, cursor gaps and identity conflicts fail without touching readable state', () => {
  const before = capture(4);
  const transferId = nextTransferId();
  // A failed stream is abandoned and reattached, so each rejection gets a fresh assembler with the same committed view.
  const committed = () => {
    const projection = new ChatOperationProjection('s1');
    feed(projection, chatSnapshotFrames(before, transferId));
    return projection;
  };
  const reject = (pattern: RegExp, frames: readonly ChatProjectionFrame[]) => {
    const projection = committed();
    const readable = projection.snapshot;
    assert.throws(() => { for (const frame of frames) projection.acceptFrame(frame); }, pattern);
    assert.equal(projection.snapshot, readable);
  };
  reject(/finished transfer reused/u, chatSnapshotFrames(before, transferId).slice(0, 1));
  const frames = fragmentedFrames([...createChatUpdateRecords(before, capture(5, [message('answer', 'partial x')]))], nextTransferId(), 8);
  const [first, second] = frames;
  assert.ok(first && second);
  reject(/out of order/u, [first, { ...second, chunkIndex: second.chunkIndex + 1 }]);
  reject(/mid-fragment/u, [{ ...first, chunkIndex: 1 }]);
  reject(/cursor gap/u, updateFrames(capture(6), capture(7, [message('answer', 'partial y')])));
  reject(/session mismatch/u, chatSnapshotFrames(chatProjectionCapture({ sessionId: 'other', operationId, cursor: { operationId, sequence: 8 } })));
  reject(/cursor regressed/u, chatSnapshotFrames(capture(3)));
});

test('commit counts, append offsets, anchors and record order are validated', () => {
  const before = capture(4);
  const begin: ChatProjectionRecord = { kind: 'begin', mode: 'update', sessionId: 's1', operationId, after: before.cursor,
    cursor: { operationId, sequence: 5, historyRevision: 0 }, state: stateOf(before) };
  const commit = (messages: number, tools = 0): ChatProjectionRecord => ({ kind: 'commit', cursor: { operationId, sequence: 5, historyRevision: 0 },
    counts: { messages, tools, tokenTurns: 0, warnings: 0, issues: 0 } });
  const attempt = (records: ChatProjectionRecord[]) => {
    const projection = new ChatOperationProjection('s1');
    feed(projection, chatSnapshotFrames(before));
    return () => feed(projection, [...encodeChatProjectionRecords(records, nextTransferId())]);
  };
  assert.throws(attempt([begin, commit(2)]), /counts mismatch/u);
  assert.throws(attempt([begin, { kind: 'append_text', messageId: 'answer', offset: 3, text: 'x', metadata: metadataOf() }, commit(1)]), /offset mismatch/u);
  assert.throws(attempt([begin, { kind: 'append_text', messageId: 'missing', offset: 0, text: 'x', metadata: metadataOf() }, commit(1)]), /unknown message/u);
  assert.throws(attempt([begin, { kind: 'message', message: message('n', 'new'), afterMessageId: 'ghost' }, commit(2)]), /anchor is not staged/u);
  assert.throws(attempt([begin, { kind: 'remove_message', messageId: 'ghost' }, commit(1)]), /unknown message/u);
  assert.throws(attempt([begin, { kind: 'warning', index: 3, warning: 'late' }, commit(1)]), /index gap/u);
  assert.throws(attempt([begin, { kind: 'tool', tool: { toolCallId: 'call', messageId: 'ghost', executionState: 'completed', toolCallStatus: 'done' } }, commit(1, 1)]), /tool without its message/u);
  assert.throws(attempt([{ kind: 'remove_message', messageId: 'answer' }]), /outside a transfer/u);
  assert.throws(attempt([begin, begin]), /begin inside an open transfer/u);
  assert.throws(attempt([begin, { kind: 'commit', cursor: { operationId, sequence: 6, historyRevision: 0 }, counts: { messages: 1, tools: 0, tokenTurns: 0, warnings: 0, issues: 0 } }]), /commit cursor mismatch/u);
  const malformed = new ChatOperationProjection('s1');
  assert.throws(() => malformed.acceptFrame({ version: 2, transferId: nextTransferId(), recordIndex: 0, chunkIndex: 0, finalChunk: true, data: '{"kind":"begin"' }), /malformed record/u);
});

test('two sessions assemble independently', () => {
  const a = new ChatOperationProjection('a');
  const b = new ChatOperationProjection('b');
  const sourceA = chatProjectionCapture({ sessionId: 'a', operationId, messages: [message('x', 'from a')] });
  const sourceB = chatProjectionCapture({ sessionId: 'b', operationId, messages: [message('y', 'from b')] });
  const framesA = chatSnapshotFrames(sourceA);
  const framesB = chatSnapshotFrames(sourceB);
  for (let index = 0; index < Math.max(framesA.length, framesB.length); index += 1) {
    const frameA = framesA[index];
    const frameB = framesB[index];
    if (frameA) a.acceptFrame(frameA);
    if (frameB) b.acceptFrame(frameB);
  }
  assert.equal(a.snapshot?.messages[0]?.content, 'from a');
  assert.equal(b.snapshot?.messages[0]?.content, 'from b');
});

function stateOf(source: ReturnType<typeof capture>) {
  const { sessionId, operationId: _operationId, cursor, messages, tools, approval, tokenTurns, warnings, issues, ...state } = source.snapshot;
  void [sessionId, cursor, messages, tools, approval, tokenTurns, warnings, issues];
  return state;
}

function metadataOf() {
  return ChatTextRowMetadataSchema.strip().parse(message('answer', 'partial'));
}

test('streamed snapshots preserve partial text on transport failure and use the separate Stop key', async () => {
  const controlOperationId = '4f9c1f9a-0000-4000-8000-000000000010';
  async function* stream(): AsyncGenerator<ChatStreamEvent> {
    for (const frame of chatSnapshotFrames(chatProjectionCapture({ operationId, operationKind: 'message', controlOperationId, cursor: { operationId, sequence: 4 },
      messages: [message('answer', 'partial')] }))) yield { kind: 'projection', frame };
    throw new Error('connection lost');
  }
  let store = new ChatSessionRuntimeStore().ensureSession('s1', '')
    .apply({ kind: 'draft', sessionId: 's1', draft: 'unsent draft' });
  let adopted = false;
  for await (const transition of toRuntimeTransitions('s1', { kind: 'attached' }, stream(), true)) {
    store = store.apply(transition);
    if (transition.kind === 'snapshot') {
      adopted = true;
      assert.deepEqual(store.get('s1').activity, { kind: 'local', operationKind: 'message', operationId: controlOperationId });
    }
  }
  assert.equal(adopted, true);
  assert.equal(store.get('s1').liveMessages[0]?.content, 'partial');
  assert.equal(store.get('s1').error, 'connection lost');
  assert.equal(store.get('s1').draft, 'unsent draft');
});

test('an older run cannot overwrite an authoritative newer snapshot', () => {
  const newer = { ...capture(4).snapshot, runOrder: 2, messages: [message('new', 'newer run')] };
  const store = new ChatSessionRuntimeStore().ensureSession('s1', '')
    .apply({ kind: 'snapshot', sessionId: 's1', snapshot: newer });
  const stale = { ...capture(4).snapshot, operationId: '4f9c1f9a-0000-4000-8000-000000000004' };
  const after = store.apply({ kind: 'snapshot', sessionId: 's1', snapshot: { ...stale, cursor: { operationId: stale.operationId, sequence: 50 } } });
  assert.equal(after.get('s1').liveMessages[0]?.id, 'new');
});

test('GET recovery reports survive parsing and block continuation without clearing readable text', () => {
  const report = ChatRecoveryReportSchema.parse({ sessionId: 's1', operationId, status: 'recovery_failed', terminalCause: 'provider_failure',
    appliedSequence: 3, eventCount: 4, messageCount: 1, toolCount: 0, changed: false,
    issues: [{ code: 'context_gap', operationId, eventId: null, sequence: 4, detail: 'Missing result evidence.' }] });
  const response = ChatSessionResponseSchema.parse({ ...CHAT_SESSION_RESPONSE, recovery: [report] });
  assert.deepEqual(response.recovery, [report]);
  const store = new ChatSessionRuntimeStore().ensureSession('s1', '').apply({ kind: 'snapshot', sessionId: 's1', snapshot: capture(4).snapshot })
    .apply({ kind: 'recovery', sessionId: 's1', reports: response.recovery ?? [] });
  assert.equal(store.get('s1').recoveryStatus, 'recovery_failed');
  assert.equal(store.get('s1').liveMessages[0]?.content, 'partial');
  assert.equal(store.apply({ kind: 'recovery', sessionId: 's1', reports: [] }).get('s1').recoveryStatus, 'ok');
});
