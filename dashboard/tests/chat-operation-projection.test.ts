import assert from 'node:assert/strict';
import test from 'node:test';
import { ChatOperationSnapshotSchema, ChatOperationUpdateSchema, ChatTranscriptMessageSchema, ChatSessionResponseSchema, ChatRecoveryReportSchema } from '@siftkit/contracts';
import { ChatOperationProjection } from '../src/lib/chat-operation-projection';
import { ChatSessionRuntimeStore } from '../src/lib/chat-session-runtime-store';
import { toRuntimeTransitions } from '../src/lib/chat-stream-transitions';
import type { ChatStreamEvent } from '../src/lib/chat-stream-parser';
import { CHAT_SESSION_RESPONSE } from './fixtures.js';

const operationId = '4f9c1f9a-0000-4000-8000-000000000002';
function message(id: string, content: string) {
  return ChatTranscriptMessageSchema.parse({ id, kind: 'assistant_answer', role: 'assistant', content,
    createdAtUtc: '2026-09-10T12:00:00.000Z',
    inputTokensEstimate: 0, outputTokensEstimate: 0, thinkingTokens: 0,
    inputTokensEstimated: false, outputTokensEstimated: false, thinkingTokensEstimated: false });
}
function snapshot() {
  return ChatOperationSnapshotSchema.parse({ sessionId: 's1', operationId, operationKind: 'message', recordKind: 'execution',
    runOrder: 1, controlOperationId: null,
    startedAtUtc: '2026-09-10T12:00:00.000Z', terminalCause: null, status: 'ok', cursor: { operationId, sequence: 4 },
    messageOffset: 0, messages: [message('answer', 'partial')], tools: [], approval: null, tokenTurns: [], streamedCharsSinceBase: 0, warnings: [], issues: [], complete: true });
}

test('snapshot pages replace the visible state atomically after the final page', () => {
  const projection = new ChatOperationProjection('s1');
  const first = snapshot();
  assert.equal(projection.acceptSnapshotPage({ ...first, complete: false }), null);
  assert.equal(projection.snapshot, null);
  const completed = projection.acceptSnapshotPage({ ...first, messageOffset: 1, messages: [message('tail', 'last')], complete: true });
  assert.deepEqual(completed?.messages.map(row => row.id), ['answer', 'tail']);
  assert.equal(projection.snapshot, completed);
});

test('missing and conflicting snapshot pages fail without replacing a readable prefix', () => {
  const projection = new ChatOperationProjection('s1');
  const first = snapshot();
  projection.acceptSnapshotPage(first);
  const committed = projection.snapshot;
  assert.throws(() => projection.acceptSnapshotPage({ ...first, messageOffset: 2 }), /offset/i);
  assert.equal(projection.snapshot, committed);
  assert.throws(() => projection.acceptSnapshotPage({ ...first, sessionId: 'different' }), /session/i);
  projection.acceptSnapshotPage({ ...first, cursor: { operationId, sequence: 5 }, complete: false });
  assert.throws(() => projection.acceptSnapshotPage({ ...first, messageOffset: 1, cursor: { operationId, sequence: 6 } }), /cursor/i);
  assert.equal(projection.snapshot, committed);
});

test('committed replacement patches apply once, preserve row identity, and reject gaps', () => {
  const projection = new ChatOperationProjection('s1');
  const first = snapshot();
  projection.acceptSnapshotPage(first);
  const { messageOffset, complete, ...view } = first;
  assert.equal(messageOffset, 0);
  assert.equal(complete, true);
  const update = ChatOperationUpdateSchema.parse({ ...view, afterSequence: 4, cursor: { operationId, sequence: 8 },
    messages: [message('answer', 'partial answer'), message('tail', 'last')], messageOrder: ['answer', 'tail'] });
  assert.equal(projection.acceptUpdate(update)?.messages[0]?.content, 'partial answer');
  assert.equal(projection.acceptUpdate(update), null);
  assert.equal(projection.snapshot?.messages.length, 2);
  assert.throws(() => projection.acceptUpdate({ ...update, afterSequence: 9, cursor: { operationId, sequence: 10 } }), /gap/i);
  assert.equal(projection.snapshot?.cursor.sequence, 8);
  const removed = projection.acceptUpdate({ ...update, afterSequence: 8, cursor: { operationId, sequence: 9 }, messages: [], messageOrder: ['tail'] });
  assert.deepEqual(removed?.messages.map(row => row.id), ['tail']);
});

test('updates reject duplicate IDs, missing rows, and an unrelated operation', () => {
  const projection = new ChatOperationProjection('s1');
  const first = snapshot();
  projection.acceptSnapshotPage(first);
  const { messageOffset, complete, ...view } = first;
  assert.equal(messageOffset, 0);
  assert.equal(complete, true);
  const update = ChatOperationUpdateSchema.parse({ ...view,
    afterSequence: 4, cursor: { operationId, sequence: 5 }, messageOrder: ['answer'] });
  assert.throws(() => projection.acceptUpdate({ ...update, messageOrder: ['answer', 'answer'] }), /duplicate/i);
  assert.throws(() => projection.acceptUpdate({ ...update, messageOrder: ['missing'], messages: [] }), /missing/i);
  assert.throws(() => projection.acceptUpdate({ ...update, operationId: '4f9c1f9a-0000-4000-8000-000000000003' }), /operation/i);
  assert.equal(projection.snapshot?.cursor.sequence, 4);
});

test('streamed snapshots preserve partial text on transport failure and use the separate Stop key', async () => {
  const controlOperationId = '4f9c1f9a-0000-4000-8000-000000000010';
  async function* stream(): AsyncGenerator<ChatStreamEvent> {
    yield { kind: 'snapshot', snapshot: { ...snapshot(), controlOperationId } };
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
  const newer = { ...snapshot(), runOrder: 2, messages: [message('new', 'newer run')] };
  const store = new ChatSessionRuntimeStore().ensureSession('s1', '')
    .apply({ kind: 'snapshot', sessionId: 's1', snapshot: newer });
  const stale = { ...snapshot(), operationId: '4f9c1f9a-0000-4000-8000-000000000004' };
  const after = store.apply({ kind: 'snapshot', sessionId: 's1', snapshot: { ...stale, cursor: { operationId: stale.operationId, sequence: 50 } } });
  assert.equal(after.get('s1').liveMessages[0]?.id, 'new');
});

test('GET recovery reports survive parsing and block continuation without clearing readable text', () => {
  const report = ChatRecoveryReportSchema.parse({ sessionId: 's1', operationId, status: 'recovery_failed', terminalCause: 'provider_failure',
    appliedSequence: 3, eventCount: 4, messageCount: 1, toolCount: 0, changed: false,
    issues: [{ code: 'context_gap', operationId, eventId: null, sequence: 4, detail: 'Missing result evidence.' }] });
  const response = ChatSessionResponseSchema.parse({ ...CHAT_SESSION_RESPONSE, recovery: [report] });
  assert.deepEqual(response.recovery, [report]);
  const store = new ChatSessionRuntimeStore().ensureSession('s1', '').apply({ kind: 'snapshot', sessionId: 's1', snapshot: snapshot() })
    .apply({ kind: 'recovery', sessionId: 's1', reports: response.recovery ?? [] });
  assert.equal(store.get('s1').recoveryStatus, 'recovery_failed');
  assert.equal(store.get('s1').liveMessages[0]?.content, 'partial');
  assert.equal(store.apply({ kind: 'recovery', sessionId: 's1', reports: [] }).get('s1').recoveryStatus, 'ok');
});
