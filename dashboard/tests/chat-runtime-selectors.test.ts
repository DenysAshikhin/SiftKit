import test from 'node:test';
import assert from 'node:assert/strict';
import { ChatSessionRuntimeStore } from '../src/lib/chat-session-runtime-store';
import { createLiveMessage } from '../src/lib/chat-live-messages';
import { chatSnapshot } from './chat-snapshot-fixture.js';
import {
  NO_MESSAGES, selectActionableApproval, selectActionableQuestion, selectAwaitingResponse, selectCompactedEarlierHistory,
  selectLive, selectLiveOperationId, selectQuestionId, selectRuntime, selectStreamedCharsSinceBase,
} from '../src/lib/chat-runtime-selectors';

const OPERATION_ID = '4f9c1f9a-0000-4000-8000-0000000000d1';

function frame(text: string, sequence: number) {
  return chatSnapshot({ sessionId: 's1', operationId: OPERATION_ID, cursor: { operationId: OPERATION_ID, sequence },
    messages: [createLiveMessage('a', 'assistant_answer', 'assistant', text)] });
}

function streamed(text: string, sequence: number): ChatSessionRuntimeStore {
  return new ChatSessionRuntimeStore().ensureSession('s1', '').apply({ kind: 'snapshot', sessionId: 's1', snapshot: frame(text, sequence) });
}

test('a token frame keeps the runtime slice and replaces the live slice', () => {
  const first = streamed('he', 1);
  const second = first.apply({ kind: 'snapshot', sessionId: 's1', snapshot: frame('hello', 2) });
  assert.equal(selectRuntime(second, 's1'), selectRuntime(first, 's1'));
  assert.notEqual(selectLive(second, 's1'), selectLive(first, 's1'));
});

test('a composer edit replaces the runtime slice and keeps the live slice', () => {
  const first = streamed('he', 1);
  const drafted = first.apply({ kind: 'draft', sessionId: 's1', draft: 'x' });
  assert.notEqual(selectRuntime(drafted, 's1'), selectRuntime(first, 's1'));
  assert.equal(selectLive(drafted, 's1'), selectLive(first, 's1'));
});

test('selectors read an unknown session as empty values', () => {
  const store = new ChatSessionRuntimeStore();
  assert.equal(selectRuntime(store, 'ghost'), null);
  assert.equal(selectLive(store, 'ghost'), null);
  assert.equal(selectLiveOperationId(store, 'ghost'), null);
  assert.equal(selectCompactedEarlierHistory(store, 'ghost'), false);
  assert.equal(selectStreamedCharsSinceBase(store, 'ghost'), 0);
  assert.equal(selectAwaitingResponse(store, 'ghost'), false);
  assert.equal(selectActionableApproval(store, 'ghost'), null);
  assert.equal(selectActionableQuestion(store, 'ghost'), null);
  assert.equal(selectQuestionId(store, 'ghost'), null);
  assert.deepEqual(NO_MESSAGES, []);
});
