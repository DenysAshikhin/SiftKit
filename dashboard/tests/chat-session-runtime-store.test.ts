import test from 'node:test';
import assert from 'node:assert/strict';
import { ChatSessionRuntimeStore } from '../src/lib/chat-session-runtime-store';
import type { ChatSessionResponse } from '../src/types';

const IMAGE_A = { dataUrl: 'data:image/png;base64,AA', note: null };
const IMAGE_B = { dataUrl: 'data:image/png;base64,BB', note: 'resized second image' };

const SAMPLE_RESPONSE: ChatSessionResponse = {
  session: {
    id: 's1',
    title: 'Test',
    modelPresetId: 'test-model',
    model: null,
    contextWindowTokens: 100,
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
    imageUsedTokens: 0,
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
    .apply({ kind: 'images', sessionId: 's', images: [IMAGE_A] })
    .apply({ kind: 'plan-inputs', sessionId: 's', planRepoRootInput: 'C:/repo', planMaxTurnsInput: '12' });
  assert.deepEqual(next.get('s').pendingImages, [IMAGE_A]);
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
  assert.equal(runtime.awaitingResponse, false);
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

test('narration deltas assemble in one turn-scoped live message', () => {
  const store = new ChatSessionRuntimeStore()
    .apply({ kind: 'narration', sessionId: 's1', delta: { turn: 4, offset: 0, text: 'Reading' } })
    .apply({ kind: 'narration', sessionId: 's1', delta: { turn: 4, offset: 7, text: ' files' } });

  assert.deepEqual(store.get('s1').liveMessages.map((message) => ({
    id: message.id,
    kind: message.kind,
    content: message.content,
  })), [{
    id: 'assistant-narration-turn-4',
    kind: 'assistant_narration',
    content: 'Reading files',
  }]);
});

test('tool start demotes narration and answer promotes the same message identity', () => {
  const store = new ChatSessionRuntimeStore()
    .apply({ kind: 'narration', sessionId: 's1', delta: { turn: 2, offset: 0, text: 'Candidate draft' } })
    .apply({ kind: 'tool', sessionId: 's1', toolEvent: {
      kind: 'tool_start', toolCallId: 'tc1', turn: 2, maxTurns: 4, toolCallLimit: 4,
      activityKind: 'search', activitySubject: { kind: 'none' }, command: 'rg foo', promptTokenCount: 0,
    }});
  const demoted = store.get('s1').liveMessages.find((message) => message.id === 'assistant-narration-turn-2');
  assert.equal(demoted?.kind, 'assistant_progress');

  const promoted = store
    .apply({ kind: 'answer', sessionId: 's1', delta: { turn: 2, offset: 0, text: 'Authoritative answer' } })
    .get('s1').liveMessages.find((message) => message.id === 'assistant-narration-turn-2');
  assert.equal(promoted?.kind, 'assistant_answer');
  assert.equal(promoted?.content, 'Authoritative answer');
});

test('applyToolEvent appends running tool message on tool_start', () => {
  const store = new ChatSessionRuntimeStore()
    .ensureSession('s1')
    .apply({ kind: 'tool', sessionId: 's1', toolEvent: {
      kind: 'tool_start',
      toolCallId: 'tc1',
      turn: 1,
      maxTurns: 4,
      toolCallLimit: 4,
      activityKind: 'search',
      activitySubject: { kind: 'none' },
      command: 'rg foo',
      promptTokenCount: 0,
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
      toolCallLimit: 4,
      activityKind: 'search',
      activitySubject: { kind: 'none' },
      command: 'rg foo',
      promptTokenCount: 0,
    }})
    .apply({ kind: 'tool', sessionId: 's1', toolEvent: {
      kind: 'tool_result',
      toolCallId: 'tc1',
      turn: 1,
      maxTurns: 4,
      toolCallLimit: 4,
      activityKind: 'search',
      activitySubject: { kind: 'none' },
      command: 'rg foo',
      exitCode: 0,
      outputSnippet: 'hit',
      outputTokens: 0,
      outputTokensEstimated: false,
      promptTokenCount: 0,
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
    .apply({ kind: 'images', sessionId: 's1', images: [IMAGE_A, IMAGE_B] });
  assert.deepEqual(store.get('s1').pendingImages, [IMAGE_A, IMAGE_B]);
});

test('appendImages preserves complete attachment records in dispatch order', () => {
  const store = new ChatSessionRuntimeStore()
    .ensureSession('s1')
    .apply({ kind: 'append-images', sessionId: 's1', images: [IMAGE_A] })
    .apply({ kind: 'append-images', sessionId: 's1', images: [IMAGE_B] });

  assert.deepEqual(store.get('s1').pendingImages, [IMAGE_A, IMAGE_B]);
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
      toolCallLimit: 4,
      activityKind: 'search',
      activitySubject: { kind: 'none' },
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
      toolCallLimit: 4,
      activityKind: 'search',
      activitySubject: { kind: 'none' },
      command: 'rg foo',
      exitCode: 0,
      outputSnippet: '',
      outputTokens: 0,
      outputTokensEstimated: false,
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
    .apply({ kind: 'images', sessionId: 's1', images: [IMAGE_A] })
    .apply({ kind: 'answer', sessionId: 's1', delta: { turn: 1, offset: 0, text: 'answer' } })
    .apply({ kind: 'failure', sessionId: 's1', message: 'boom' });
  const runtime = store.get('s1');
  assert.deepEqual(runtime.liveMessages, []);
  assert.equal(runtime.draft, 'draft');
  assert.deepEqual(runtime.pendingImages, [IMAGE_A]);
});

test('setContextUsage updates only the targeted session', () => {
  const store = new ChatSessionRuntimeStore()
    .ensureSession('s1')
    .ensureSession('s2')
    .apply({ kind: 'context-usage', sessionId: 's1', contextUsage: SAMPLE_RESPONSE.contextUsage });
  assert.equal(store.get('s1').contextUsage, SAMPLE_RESPONSE.contextUsage);
  assert.equal(store.get('s2').contextUsage, null);
});

test('submit moves the draft and images into a live user bubble', () => {
  const next = new ChatSessionRuntimeStore()
    .apply({ kind: 'draft', sessionId: 's1', draft: 'look at this' })
    .apply({ kind: 'append-images', sessionId: 's1', images: [IMAGE_A] })
    .apply({ kind: 'submit', sessionId: 's1', content: 'look at this', images: [IMAGE_A] });

  const runtime = next.get('s1');
  assert.equal(runtime.draft, '');
  assert.deepEqual(runtime.pendingImages, []);
  assert.equal(runtime.liveMessages.length, 1);
  assert.equal(runtime.liveMessages[0]?.id, 'live-user');
  assert.equal(runtime.liveMessages[0]?.role, 'user');
  assert.equal(runtime.liveMessages[0]?.content, 'look at this');
  assert.deepEqual(runtime.liveMessages[0]?.images, [IMAGE_A.dataUrl]);
  assert.deepEqual(runtime.submittedInput, { content: 'look at this', images: [IMAGE_A] });
});

test('submit keeps the live user bubble first when the answer starts streaming', () => {
  const next = new ChatSessionRuntimeStore()
    .apply({ kind: 'submit', sessionId: 's1', content: 'hi', images: [] })
    .apply({ kind: 'answer', sessionId: 's1', delta: { turn: 1, offset: 0, text: 'hello' } });

  assert.deepEqual(
    next.get('s1').liveMessages.map((message) => message.id),
    ['live-user', 'live-answer'],
  );
});

test('failure restores the submitted draft and images and drops the live bubble', () => {
  const next = new ChatSessionRuntimeStore()
    .apply({ kind: 'submit', sessionId: 's1', content: 'look at this', images: [IMAGE_A, IMAGE_B] })
    .apply({ kind: 'failure', sessionId: 's1', message: 'engine unavailable' });

  const runtime = next.get('s1');
  assert.equal(runtime.draft, 'look at this');
  assert.deepEqual(runtime.pendingImages, [IMAGE_A, IMAGE_B]);
  assert.deepEqual(runtime.liveMessages, []);
  assert.equal(runtime.submittedInput, null);
  assert.equal(runtime.error, 'engine unavailable');
});

test('failure without a submitted input leaves the composer untouched', () => {
  const next = new ChatSessionRuntimeStore()
    .apply({ kind: 'draft', sessionId: 's1', draft: 'typed but never sent' })
    .apply({ kind: 'failure', sessionId: 's1', message: 'boom' });

  assert.equal(next.get('s1').draft, 'typed but never sent');
  assert.deepEqual(next.get('s1').pendingImages, []);
});

test('submit marks the session as awaiting the first streamed response', () => {
  const next = new ChatSessionRuntimeStore()
    .apply({ kind: 'submit', sessionId: 's1', content: 'hi', images: [] });

  assert.equal(next.get('s1').awaitingResponse, true);
});

test('a warning before the stream starts leaves the session still awaiting', () => {
  const next = new ChatSessionRuntimeStore()
    .apply({ kind: 'submit', sessionId: 's1', content: 'hi', images: [] })
    .apply({ kind: 'warning', sessionId: 's1', text: 'repo root is dirty' });

  assert.equal(next.get('s1').awaitingResponse, true);
});

test('any streamed evidence ends the awaiting state, whatever arrives first', () => {
  const submitted = new ChatSessionRuntimeStore()
    .apply({ kind: 'submit', sessionId: 's1', content: 'hi', images: [] });

  const afterTool = submitted.apply({ kind: 'tool', sessionId: 's1', toolEvent: {
    kind: 'tool_start',
    toolCallId: 'tc1',
    turn: 1,
    maxTurns: 4,
    toolCallLimit: 4,
    activityKind: 'search',
    activitySubject: { kind: 'none' },
    command: 'rg foo',
    promptTokenCount: 0,
  }});
  const afterThinking = submitted
    .apply({ kind: 'thinking', sessionId: 's1', delta: { turn: 1, offset: 0, text: 'hmm' } });
  const afterAnswer = submitted
    .apply({ kind: 'answer', sessionId: 's1', delta: { turn: 1, offset: 0, text: 'hello' } });

  assert.equal(afterTool.get('s1').awaitingResponse, false);
  assert.equal(afterThinking.get('s1').awaitingResponse, false);
  assert.equal(afterAnswer.get('s1').awaitingResponse, false);
});

test('done and failure both end the awaiting state', () => {
  const submitted = new ChatSessionRuntimeStore()
    .apply({ kind: 'submit', sessionId: 's1', content: 'hi', images: [] });

  assert.equal(submitted.apply({ kind: 'done', sessionId: 's1', response: SAMPLE_RESPONSE }).get('s1').awaitingResponse, false);
  assert.equal(submitted.apply({ kind: 'failure', sessionId: 's1', message: 'boom' }).get('s1').awaitingResponse, false);
});

test('done clears the submitted input along with the live messages', () => {
  const next = new ChatSessionRuntimeStore()
    .apply({ kind: 'submit', sessionId: 's1', content: 'hi', images: [IMAGE_A] })
    .apply({ kind: 'done', sessionId: 's1', response: SAMPLE_RESPONSE });

  assert.equal(next.get('s1').submittedInput, null);
  assert.deepEqual(next.get('s1').liveMessages, []);
  assert.deepEqual(next.get('s1').pendingImages, []);
});

test('progress transitions upsert a single live-progress message in place', () => {
  const store = new ChatSessionRuntimeStore()
    .ensureSession('s1')
    .apply({ kind: 'progress', sessionId: 's1', progress: { turn: 3, text: 'RED done', elapsedMs: 1_000 } })
    .apply({ kind: 'progress', sessionId: 's1', progress: { turn: 5, text: 'GREEN wiring', elapsedMs: 2_000 } });

  const progressMessages = store.get('s1').liveMessages.filter((message) => message.id === 'live-progress');
  assert.equal(progressMessages.length, 1);
  assert.equal(progressMessages[0]?.kind, 'assistant_progress');
  assert.equal(progressMessages[0]?.content, 'GREEN wiring');
});

test('approval state is set by approval and cleared by submit, done, and failure', () => {
  const approval = {
    runId: '4f9c1f9a-0000-4000-8000-000000000000',
    approvalId: '4f9c1f9a-0000-4000-8000-000000000001',
    toolName: 'bash',
    command: 'npm test',
    reviewPayload: null,
  };
  const pending = new ChatSessionRuntimeStore()
    .apply({ kind: 'approval', sessionId: 's1', approval });
  assert.deepEqual(pending.get('s1').pendingApproval, approval);
  assert.equal(
    pending.apply({ kind: 'submit', sessionId: 's1', content: 'again', images: [] }).get('s1').pendingApproval,
    null,
  );
  assert.equal(
    pending.apply({ kind: 'done', sessionId: 's1', response: SAMPLE_RESPONSE }).get('s1').pendingApproval,
    null,
  );
  assert.equal(
    pending.apply({ kind: 'failure', sessionId: 's1', message: 'boom' }).get('s1').pendingApproval,
    null,
  );
  assert.equal(
    pending.apply({ kind: 'approval-clear', sessionId: 's1' }).get('s1').pendingApproval,
    null,
  );
});
