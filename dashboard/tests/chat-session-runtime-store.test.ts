import test from 'node:test';
import assert from 'node:assert/strict';
import { ChatSessionRuntimeStore } from '../src/lib/chat-session-runtime-store';
import type { ChatSessionResponse } from '../src/types';

const SAMPLE_RESPONSE: ChatSessionResponse = {
  session: {
    id: 's1',
    title: 'Test',
    modelPresetId: 'test-model',
    model: null,
    contextWindowTokens: 100,
    condensedSummary: '',
    createdAtUtc: '2026-06-03T00:00:00.000Z',
    updatedAtUtc: '2026-06-03T00:00:00.000Z',
    messages: [],
  },
  contextUsage: {
    contextWindowTokens: 100,
    usedTokens: 0,
    chatUsedTokens: 0,
    thinkingUsedTokens: 0,
    toolUsedTokens: 0,
    totalUsedTokens: 0,
    remainingTokens: 100,
    warnThresholdTokens: 80,
    shouldCondense: false,
    estimatedTokenFallbackTokens: 0,
    providerOverheadTokens: 0,
  },
};

test('apply routes every transition through one copy-on-write path', () => {
  const store = new ChatSessionRuntimeStore()
    .ensureSession('session-a')
    .ensureSession('session-b');
  const next = store
    .apply({ kind: 'begin', sessionId: 'session-a', operationKind: 'message' })
    .apply({ kind: 'draft', sessionId: 'session-a', draft: 'hello' })
    .apply({ kind: 'answer', sessionId: 'session-a', delta: { turn: 1, offset: 0, text: 'hi there' } })
    .apply({ kind: 'warning', sessionId: 'session-a', text: 'careful' });

  assert.deepEqual(next.get('session-a').activity, { kind: 'active', operationKind: 'message' });
  assert.equal(next.get('session-a').draft, 'hello');
  assert.equal(next.get('session-a').liveMessages[0]?.content, 'hi there');
  assert.deepEqual(next.get('session-a').warnings, ['careful']);

  assert.deepEqual(store.get('session-a').activity, { kind: 'idle' });
  assert.equal(store.get('session-a').draft, '');
  assert.deepEqual(next.get('session-b'), store.get('session-b'));
});

test('apply creates a runtime for a session that has not been seeded', () => {
  const next = new ChatSessionRuntimeStore()
    .apply({ kind: 'draft', sessionId: 'fresh', draft: 'typed' });
  assert.equal(next.get('fresh').draft, 'typed');
  assert.deepEqual(next.get('fresh').activity, { kind: 'idle' });
});

test('get still throws for a session that was never touched', () => {
  assert.throws(
    () => new ChatSessionRuntimeStore().get('ghost'),
    /unknown session "ghost"/,
  );
});

test('plan input and image transitions replace only their own fields', () => {
  const next = new ChatSessionRuntimeStore()
    .apply({ kind: 'images', sessionId: 's', images: ['data:image/png;base64,AA'] })
    .apply({ kind: 'plan-inputs', sessionId: 's', planRepoRootInput: 'C:/repo', planMaxTurnsInput: '12' });
  assert.deepEqual(next.get('s').pendingImages, ['data:image/png;base64,AA']);
  assert.equal(next.get('s').planRepoRootInput, 'C:/repo');
  assert.equal(next.get('s').planMaxTurnsInput, '12');
  assert.equal(next.get('s').draft, '');
});

test('session B cannot clear session A streaming state or draft', () => {
  const initial = new ChatSessionRuntimeStore()
    .ensureSession('session-a')
    .ensureSession('session-b')
    .apply({ kind: 'draft', sessionId: 'session-a', draft: 'draft-a' })
    .apply({ kind: 'begin', sessionId: 'session-a', operationKind: 'message' })
    .apply({ kind: 'answer', sessionId: 'session-a', delta: { turn: 1, offset: 0, text: 'answer-a' } })
    .apply({ kind: 'begin', sessionId: 'session-b', operationKind: 'plan' });

  assert.equal(initial.get('session-a').draft, 'draft-a');
  assert.equal(initial.get('session-a').liveMessages[0]?.content, 'answer-a');
  assert.equal(initial.get('session-a').activity.kind, 'active');
  assert.equal(initial.get('session-b').activity.kind, 'active');
});

test('ensureSession creates a runtime with idle activity and empty defaults', () => {
  const store = new ChatSessionRuntimeStore().ensureSession('s1');
  const runtime = store.get('s1');
  assert.equal(runtime.sessionId, 's1');
  assert.equal(runtime.activity.kind, 'idle');
  assert.deepEqual(runtime.liveMessages, []);
  assert.equal(runtime.error, null);
  assert.deepEqual(runtime.warnings, []);
  assert.equal(runtime.contextUsage, null);
  assert.equal(runtime.liveToolPromptTokenCount, null);
  assert.equal(runtime.draft, '');
  assert.deepEqual(runtime.pendingImages, []);
  assert.equal(runtime.planRepoRootInput, '');
  assert.equal(runtime.planMaxTurnsInput, '');
});

test('begin sets active activity with operation kind', () => {
  const store = new ChatSessionRuntimeStore()
    .ensureSession('s1')
    .apply({ kind: 'begin', sessionId: 's1', operationKind: 'message' });
  const activity = store.get('s1').activity;
  assert.equal(activity.kind, 'active');
  if (activity.kind === 'active') {
    assert.equal(activity.operationKind, 'message');
  }
});

test('thinking deltas assemble per turn into separate live messages', () => {
  let store = new ChatSessionRuntimeStore();
  store = store.apply({ kind: 'thinking', sessionId: 's1', delta: { turn: 1, offset: 0, text: 'first ' } });
  store = store.apply({ kind: 'thinking', sessionId: 's1', delta: { turn: 1, offset: 6, text: 'turn' } });
  store = store.apply({ kind: 'thinking', sessionId: 's1', delta: { turn: 2, offset: 0, text: 'second turn' } });
  const messages = store.get('s1').liveMessages;
  assert.equal(messages.length, 2);
  assert.equal(messages[0]?.content, 'first turn');
  assert.equal(messages[0]?.id, 'live-thinking-1');
  assert.equal(messages[1]?.content, 'second turn');
  assert.equal(messages[1]?.id, 'live-thinking-2');
});

test('answer deltas assemble on the live answer message', () => {
  let store = new ChatSessionRuntimeStore();
  store = store.apply({ kind: 'answer', sessionId: 's1', delta: { turn: 4, offset: 0, text: 'Answer' } });
  store = store.apply({ kind: 'answer', sessionId: 's1', delta: { turn: 4, offset: 6, text: ' body' } });
  const answer = store.get('s1').liveMessages.find((message) => message.id === 'live-answer');
  assert.equal(answer?.content, 'Answer body');
});

test('applyToolEvent appends running tool message on tool_start', () => {
  const store = new ChatSessionRuntimeStore()
    .ensureSession('s1')
    .apply({ kind: 'tool', sessionId: 's1', toolEvent: {
      kind: 'tool_start',
      toolCallId: 'tc1',
      turn: 1,
      maxTurns: 4,
      command: 'rg foo',
    }});
  const runtime = store.get('s1');
  assert.equal(runtime.liveMessages.length, 1);
  assert.equal(runtime.liveMessages[0]?.toolCallStatus, 'running');
});

test('applyToolEvent completes tool message on tool_result', () => {
  const store = new ChatSessionRuntimeStore()
    .ensureSession('s1')
    .apply({ kind: 'tool', sessionId: 's1', toolEvent: {
      kind: 'tool_start',
      toolCallId: 'tc1',
      turn: 1,
      maxTurns: 4,
      command: 'rg foo',
    }})
    .apply({ kind: 'tool', sessionId: 's1', toolEvent: {
      kind: 'tool_result',
      toolCallId: 'tc1',
      turn: 1,
      maxTurns: 4,
      command: 'rg foo',
      exitCode: 0,
      outputSnippet: 'hit',
    }});
  const runtime = store.get('s1');
  assert.equal(runtime.liveMessages.length, 1);
  assert.equal(runtime.liveMessages[0]?.toolCallStatus, 'done');
  assert.equal(runtime.liveMessages[0]?.toolCallExitCode, 0);
});

test('applyAnswer upserts an answer live message', () => {
  const store = new ChatSessionRuntimeStore()
    .ensureSession('s1')
    .apply({ kind: 'answer', sessionId: 's1', delta: { turn: 1, offset: 0, text: 'hello world' } });
  const runtime = store.get('s1');
  assert.equal(runtime.liveMessages.length, 1);
  assert.equal(runtime.liveMessages[0]?.content, 'hello world');
});

test('applyAnswer handles empty answer text', () => {
  const store = new ChatSessionRuntimeStore()
    .ensureSession('s1')
    .apply({ kind: 'answer', sessionId: 's1', delta: { turn: 1, offset: 0, text: '' } });
  const runtime = store.get('s1');
  assert.equal(runtime.liveMessages.length, 1);
  assert.equal(runtime.liveMessages[0]?.content, '');
  assert.equal(runtime.liveMessages[0]?.outputTokensEstimate, 1);
});

test('applyWarning appends a warning string', () => {
  const store = new ChatSessionRuntimeStore()
    .ensureSession('s1')
    .apply({ kind: 'warning', sessionId: 's1', text: 'missing file' });
  assert.deepEqual(store.get('s1').warnings, ['missing file']);
});

test('applyDone sets idle activity and applies context usage', () => {
  const store = new ChatSessionRuntimeStore()
    .ensureSession('s1')
    .apply({ kind: 'begin', sessionId: 's1', operationKind: 'message' })
    .apply({ kind: 'done', sessionId: 's1', response: SAMPLE_RESPONSE });
  const runtime = store.get('s1');
  assert.equal(runtime.activity.kind, 'idle');
  assert.equal(runtime.contextUsage?.totalUsedTokens, 0);
});

test('applyFailure sets error and idle activity', () => {
  const store = new ChatSessionRuntimeStore()
    .ensureSession('s1')
    .apply({ kind: 'begin', sessionId: 's1', operationKind: 'message' })
    .apply({ kind: 'failure', sessionId: 's1', message: 'boom' });
  const runtime = store.get('s1');
  assert.equal(runtime.error, 'boom');
  assert.equal(runtime.activity.kind, 'idle');
});

test('setDraft replaces the draft text', () => {
  const store = new ChatSessionRuntimeStore()
    .ensureSession('s1')
    .apply({ kind: 'draft', sessionId: 's1', draft: 'new draft' });
  assert.equal(store.get('s1').draft, 'new draft');
});

test('setImages replaces pending images', () => {
  const store = new ChatSessionRuntimeStore()
    .ensureSession('s1')
    .apply({ kind: 'images', sessionId: 's1', images: ['img1', 'img2'] });
  assert.deepEqual(store.get('s1').pendingImages, ['img1', 'img2']);
});

test('setPlanInputs replaces plan input fields', () => {
  const store = new ChatSessionRuntimeStore()
    .ensureSession('s1')
    .apply({ kind: 'plan-inputs', sessionId: 's1', planRepoRootInput: 'C:\\repo', planMaxTurnsInput: '30' });
  assert.equal(store.get('s1').planRepoRootInput, 'C:\\repo');
  assert.equal(store.get('s1').planMaxTurnsInput, '30');
});

test('unknown session throws on get', () => {
  const store = new ChatSessionRuntimeStore();
  assert.throws(() => store.get('unknown'), /unknown session/);
});

test('removeSession drops the session and rejects subsequent access', () => {
  const store = new ChatSessionRuntimeStore()
    .ensureSession('s1')
    .ensureSession('s2')
    .removeSession('s1');
  assert.equal(store.getAll().length, 1);
  assert.equal(store.getAll()[0]?.sessionId, 's2');
  assert.throws(() => store.get('s1'), /unknown session/);
});

test('getAll returns runtimes in insertion order', () => {
  const store = new ChatSessionRuntimeStore()
    .ensureSession('a')
    .ensureSession('b')
    .ensureSession('c');
  const all = store.getAll();
  assert.equal(all.length, 3);
  assert.equal(all[0]?.sessionId, 'a');
  assert.equal(all[1]?.sessionId, 'b');
  assert.equal(all[2]?.sessionId, 'c');
});

test('immutable previous snapshots remain unchanged after mutation', () => {
  const store1 = new ChatSessionRuntimeStore().ensureSession('s1');
  const store2 = store1.apply({ kind: 'begin', sessionId: 's1', operationKind: 'message' });
  assert.equal(store1.get('s1').activity.kind, 'idle');
  assert.equal(store2.get('s1').activity.kind, 'active');
});

test('plan inputs initialize once on ensureSession but do not overwrite dirty draft', () => {
  const store = new ChatSessionRuntimeStore()
    .ensureSession('s1')
    .apply({ kind: 'draft', sessionId: 's1', draft: 'dirty' })
    .ensureSession('s1');
  assert.equal(store.get('s1').draft, 'dirty');
});

test('applyToolEvent sets liveToolPromptTokenCount from tool_start promptTokenCount', () => {
  const store = new ChatSessionRuntimeStore()
    .ensureSession('s1')
    .apply({ kind: 'tool', sessionId: 's1', toolEvent: {
      kind: 'tool_start',
      toolCallId: 'tc1',
      turn: 1,
      maxTurns: 4,
      command: 'rg foo',
      promptTokenCount: 42,
    }});
  assert.equal(store.get('s1').liveToolPromptTokenCount, 42);
});

test('applyToolEvent sets liveToolPromptTokenCount from tool_result promptTokenCount', () => {
  const store = new ChatSessionRuntimeStore()
    .ensureSession('s1')
    .apply({ kind: 'tool', sessionId: 's1', toolEvent: {
      kind: 'tool_result',
      toolCallId: 'tc1',
      turn: 1,
      maxTurns: 4,
      command: 'rg foo',
      exitCode: 0,
      promptTokenCount: 55,
    }});
  assert.equal(store.get('s1').liveToolPromptTokenCount, 55);
});

test('applyAnswer creates runtime for unknown session via apply', () => {
  const store = new ChatSessionRuntimeStore();
  const next = store.apply({ kind: 'answer', sessionId: 'unknown', delta: { turn: 1, offset: 0, text: 'text' } });
  assert.equal(next.get('unknown').liveMessages[0]?.content, 'text');
});

test('applyDone clears live messages and draft for the session', () => {
  const store = new ChatSessionRuntimeStore()
    .ensureSession('s1')
    .apply({ kind: 'draft', sessionId: 's1', draft: 'draft' })
    .apply({ kind: 'answer', sessionId: 's1', delta: { turn: 1, offset: 0, text: 'answer' } })
    .apply({ kind: 'done', sessionId: 's1', response: SAMPLE_RESPONSE });
  const runtime = store.get('s1');
  assert.deepEqual(runtime.liveMessages, []);
  assert.equal(runtime.draft, '');
  assert.deepEqual(runtime.pendingImages, []);
});

test('applyFailure clears live messages but preserves draft and images for retry', () => {
  const store = new ChatSessionRuntimeStore()
    .ensureSession('s1')
    .apply({ kind: 'draft', sessionId: 's1', draft: 'draft' })
    .apply({ kind: 'images', sessionId: 's1', images: ['image'] })
    .apply({ kind: 'answer', sessionId: 's1', delta: { turn: 1, offset: 0, text: 'answer' } })
    .apply({ kind: 'failure', sessionId: 's1', message: 'boom' });
  const runtime = store.get('s1');
  assert.deepEqual(runtime.liveMessages, []);
  assert.equal(runtime.draft, 'draft');
  assert.deepEqual(runtime.pendingImages, ['image']);
});

test('setContextUsage updates only the targeted session', () => {
  const store = new ChatSessionRuntimeStore()
    .ensureSession('s1')
    .ensureSession('s2')
    .apply({ kind: 'context-usage', sessionId: 's1', contextUsage: SAMPLE_RESPONSE.contextUsage });
  assert.equal(store.get('s1').contextUsage, SAMPLE_RESPONSE.contextUsage);
  assert.equal(store.get('s2').contextUsage, null);
});