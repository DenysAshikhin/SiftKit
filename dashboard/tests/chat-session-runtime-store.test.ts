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

test('session B cannot clear session A streaming state or draft', () => {
  const initial = new ChatSessionRuntimeStore()
    .ensureSession('session-a')
    .ensureSession('session-b')
    .setDraft('session-a', 'draft-a')
    .begin('session-a', 'message')
    .applyAnswer('session-a', 'answer-a')
    .begin('session-b', 'plan');

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
    .begin('s1', 'message');
  const activity = store.get('s1').activity;
  assert.equal(activity.kind, 'active');
  if (activity.kind === 'active') {
    assert.equal(activity.operationKind, 'message');
  }
});

test('applyThinking appends a thinking live message', () => {
  const store = new ChatSessionRuntimeStore()
    .ensureSession('s1')
    .appendThinking('s1', 'thinking text');
  const runtime = store.get('s1');
  assert.equal(runtime.liveMessages.length, 1);
  assert.equal(runtime.liveMessages[0]?.content, 'thinking text');
});

test('applyToolEvent appends running tool message on tool_start', () => {
  const store = new ChatSessionRuntimeStore()
    .ensureSession('s1')
    .applyToolEvent('s1', {
      kind: 'tool_start',
      toolCallId: 'tc1',
      turn: 1,
      maxTurns: 4,
      command: 'rg foo',
    });
  const runtime = store.get('s1');
  assert.equal(runtime.liveMessages.length, 1);
  assert.equal(runtime.liveMessages[0]?.toolCallStatus, 'running');
});

test('applyToolEvent completes tool message on tool_result', () => {
  const store = new ChatSessionRuntimeStore()
    .ensureSession('s1')
    .applyToolEvent('s1', {
      kind: 'tool_start',
      toolCallId: 'tc1',
      turn: 1,
      maxTurns: 4,
      command: 'rg foo',
    })
    .applyToolEvent('s1', {
      kind: 'tool_result',
      toolCallId: 'tc1',
      turn: 1,
      maxTurns: 4,
      command: 'rg foo',
      exitCode: 0,
      outputSnippet: 'hit',
    });
  const runtime = store.get('s1');
  assert.equal(runtime.liveMessages.length, 1);
  assert.equal(runtime.liveMessages[0]?.toolCallStatus, 'done');
  assert.equal(runtime.liveMessages[0]?.toolCallExitCode, 0);
});

test('applyAnswer upserts an answer live message', () => {
  const store = new ChatSessionRuntimeStore()
    .ensureSession('s1')
    .applyAnswer('s1', 'hello world');
  const runtime = store.get('s1');
  assert.equal(runtime.liveMessages.length, 1);
  assert.equal(runtime.liveMessages[0]?.content, 'hello world');
});

test('applyAnswer handles empty answer text', () => {
  const store = new ChatSessionRuntimeStore()
    .ensureSession('s1')
    .applyAnswer('s1', '');
  const runtime = store.get('s1');
  assert.equal(runtime.liveMessages.length, 1);
  assert.equal(runtime.liveMessages[0]?.content, '');
  assert.equal(runtime.liveMessages[0]?.outputTokensEstimate, 1);
});

test('applyWarning appends a warning string', () => {
  const store = new ChatSessionRuntimeStore()
    .ensureSession('s1')
    .applyWarning('s1', 'missing file');
  assert.deepEqual(store.get('s1').warnings, ['missing file']);
});

test('applyDone sets idle activity and applies context usage', () => {
  const store = new ChatSessionRuntimeStore()
    .ensureSession('s1')
    .begin('s1', 'message')
    .applyDone('s1', SAMPLE_RESPONSE);
  const runtime = store.get('s1');
  assert.equal(runtime.activity.kind, 'idle');
  assert.equal(runtime.contextUsage?.totalUsedTokens, 0);
});

test('applyFailure sets error and idle activity', () => {
  const store = new ChatSessionRuntimeStore()
    .ensureSession('s1')
    .begin('s1', 'message')
    .applyFailure('s1', 'boom');
  const runtime = store.get('s1');
  assert.equal(runtime.error, 'boom');
  assert.equal(runtime.activity.kind, 'idle');
});

test('setDraft replaces the draft text', () => {
  const store = new ChatSessionRuntimeStore()
    .ensureSession('s1')
    .setDraft('s1', 'new draft');
  assert.equal(store.get('s1').draft, 'new draft');
});

test('setImages replaces pending images', () => {
  const store = new ChatSessionRuntimeStore()
    .ensureSession('s1')
    .setImages('s1', ['img1', 'img2']);
  assert.deepEqual(store.get('s1').pendingImages, ['img1', 'img2']);
});

test('setPlanInputs replaces plan input fields', () => {
  const store = new ChatSessionRuntimeStore()
    .ensureSession('s1')
    .setPlanInputs('s1', 'C:\\repo', '30');
  assert.equal(store.get('s1').planRepoRootInput, 'C:\\repo');
  assert.equal(store.get('s1').planMaxTurnsInput, '30');
});

test('unknown session throws on get', () => {
  const store = new ChatSessionRuntimeStore();
  assert.throws(() => store.get('unknown'), /unknown session/);
});

test('unknown session throws on mutators', () => {
  const store = new ChatSessionRuntimeStore();
  assert.throws(() => store.begin('unknown', 'message'), /unknown session/);
  assert.throws(() => store.setDraft('unknown', 'x'), /unknown session/);
  assert.throws(() => store.setImages('unknown', []), /unknown session/);
  assert.throws(() => store.setPlanInputs('unknown', '', ''), /unknown session/);
  assert.throws(() => store.applyFailure('unknown', 'err'), /unknown session/);
  assert.throws(() => store.applyWarning('unknown', 'w'), /unknown session/);
  assert.throws(() => store.appendThinking('unknown', 't'), /unknown session/);
  assert.throws(() => store.applyToolEvent('unknown', { kind: 'tool_start', toolCallId: 't', turn: 1, maxTurns: 1, command: 'x' }), /unknown session/);
  assert.throws(() => store.applyDone('unknown', SAMPLE_RESPONSE), /unknown session/);
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
  const store2 = store1.begin('s1', 'message');
  assert.equal(store1.get('s1').activity.kind, 'idle');
  assert.equal(store2.get('s1').activity.kind, 'active');
});

test('plan inputs initialize once on ensureSession but do not overwrite dirty draft', () => {
  const store = new ChatSessionRuntimeStore()
    .ensureSession('s1')
    .setDraft('s1', 'dirty')
    .ensureSession('s1');
  assert.equal(store.get('s1').draft, 'dirty');
});

test('applyToolEvent sets liveToolPromptTokenCount from tool_start promptTokenCount', () => {
  const store = new ChatSessionRuntimeStore()
    .ensureSession('s1')
    .applyToolEvent('s1', {
      kind: 'tool_start',
      toolCallId: 'tc1',
      turn: 1,
      maxTurns: 4,
      command: 'rg foo',
      promptTokenCount: 42,
    });
  assert.equal(store.get('s1').liveToolPromptTokenCount, 42);
});

test('applyToolEvent sets liveToolPromptTokenCount from tool_result promptTokenCount', () => {
  const store = new ChatSessionRuntimeStore()
    .ensureSession('s1')
    .applyToolEvent('s1', {
      kind: 'tool_result',
      toolCallId: 'tc1',
      turn: 1,
      maxTurns: 4,
      command: 'rg foo',
      exitCode: 0,
      promptTokenCount: 55,
    });
  assert.equal(store.get('s1').liveToolPromptTokenCount, 55);
});

test('applyAnswer throws on unknown session', () => {
  const store = new ChatSessionRuntimeStore();
  assert.throws(() => store.applyAnswer('unknown', 'text'), /unknown session/);
});

test('applyDone clears live messages and draft for the session', () => {
  const store = new ChatSessionRuntimeStore()
    .ensureSession('s1')
    .setDraft('s1', 'draft')
    .applyAnswer('s1', 'answer')
    .applyDone('s1', SAMPLE_RESPONSE);
  const runtime = store.get('s1');
  assert.deepEqual(runtime.liveMessages, []);
  assert.equal(runtime.draft, '');
  assert.deepEqual(runtime.pendingImages, []);
});

test('applyFailure clears live messages but preserves draft and images for retry', () => {
  const store = new ChatSessionRuntimeStore()
    .ensureSession('s1')
    .setDraft('s1', 'draft')
    .setImages('s1', ['image'])
    .applyAnswer('s1', 'answer')
    .applyFailure('s1', 'boom');
  const runtime = store.get('s1');
  assert.deepEqual(runtime.liveMessages, []);
  assert.equal(runtime.draft, 'draft');
  assert.deepEqual(runtime.pendingImages, ['image']);
});

test('setContextUsage updates only the targeted session', () => {
  const store = new ChatSessionRuntimeStore()
    .ensureSession('s1')
    .ensureSession('s2')
    .setContextUsage('s1', SAMPLE_RESPONSE.contextUsage);
  assert.equal(store.get('s1').contextUsage, SAMPLE_RESPONSE.contextUsage);
  assert.equal(store.get('s2').contextUsage, null);
  assert.throws(
    () => store.setContextUsage('unknown', SAMPLE_RESPONSE.contextUsage),
    /unknown session/,
  );
});

test('ensureSession is idempotent and does not reset existing state', () => {
  const store = new ChatSessionRuntimeStore()
    .ensureSession('s1')
    .setDraft('s1', 'existing')
    .ensureSession('s1');
  assert.equal(store.get('s1').draft, 'existing');
});

test('multiple sessions maintain independent state after concurrent operations', () => {
  const store = new ChatSessionRuntimeStore()
    .ensureSession('a')
    .ensureSession('b')
    .begin('a', 'message')
    .begin('b', 'plan')
    .applyAnswer('a', 'a-answer')
    .applyWarning('b', 'b-warning')
    .applyFailure('a', 'a-error')
    .applyDone('b', SAMPLE_RESPONSE);
  const runtimeA = store.get('a');
  const runtimeB = store.get('b');
  assert.equal(runtimeA.error, 'a-error');
  assert.equal(runtimeA.activity.kind, 'idle');
  assert.equal(runtimeB.activity.kind, 'idle');
  assert.deepEqual(runtimeB.warnings, ['b-warning']);
});
