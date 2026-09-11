import test from 'node:test';
import assert from 'node:assert/strict';
import { ChatSessionRuntimeStore } from '../src/lib/chat-session-runtime-store';
import { createLiveMessage } from '../src/lib/chat-live-messages';
import { DEFAULT_APPROVAL_MODE, type ChatProjectionTerminalRecord, type DurableChatApproval } from '@siftkit/contracts';
import type { ChatSessionResponse } from '../src/types';
import { buildUsageFrame } from './usage-frame';
import { chatSnapshot } from './chat-snapshot-fixture.js';

const PROMPT_FRAME = { turn: 1, maxTurns: 20, promptTokens: 900, charsPerToken: 4 } as const;
const IMAGE_A = { dataUrl: 'data:image/png;base64,AA', note: null };
const IMAGE_B = { dataUrl: 'data:image/png;base64,BB', note: 'resized second image' };
const OPERATION_ID = '4f9c1f9a-0000-4000-8000-000000000000';

/** A committed view for the session, the only way streamed evidence reaches the store now. */
function snapshotFor(sessionId: string, overrides: Parameters<typeof chatSnapshot>[0] = {}) {
  return { kind: 'snapshot' as const, sessionId, snapshot: chatSnapshot({ sessionId, operationId: OPERATION_ID, operationKind: 'message', ...overrides }) };
}

function terminalFor(sessionId: string, operationId = OPERATION_ID, issue: ChatProjectionTerminalRecord['issue'] = null) {
  return { kind: 'terminal' as const, sessionId, terminal: { kind: 'terminal' as const, cursor: { operationId, sequence: 1, historyRevision: 0 }, terminalCause: 'completed' as const, issue } };
}

const APPROVAL: DurableChatApproval = {
  runId: '4f9c1f9a-0000-4000-8000-000000000000', approvalId: '4f9c1f9a-0000-4000-8000-000000000001', toolName: 'bash', command: 'npm test',
  reviewPayload: null, toolCallId: 'call', mode: 'interactive', requestedAtUtc: '2026-09-08T12:00:00.000Z', expiresAtUtc: '2026-09-08T12:10:00.000Z',
  outcome: null, decidedAtUtc: null, actionable: true,
};

test('operation token metadata survives disconnects and clears when an authoritative replacement arrives', () => {
  const store = new ChatSessionRuntimeStore().ensureSession('s1', '').ensureSession('s2', '')
    .apply(snapshotFor('s1', { tokenTurns: [{ turn: 1, prompt: PROMPT_FRAME, usage: buildUsageFrame({ turn: 1, record: { thinkingTokens: 20 } }) }] }));
  const tokenTurns = store.get('s1').tokenTurns;
  assert.equal(tokenTurns.size, 1);
  const queued = store.apply({ kind: 'queued-submit', sessionId: 's1', content: 'queued', images: [] })
    .apply({ kind: 'draft', sessionId: 's1', draft: 'next' });
  assert.equal(queued.get('s1').tokenTurns, tokenTurns);
  assert.equal(queued.get('s2').tokenTurns.size, 0);
  for (const kind of ['begin', 'attach'] as const) {
    assert.equal(queued.apply({ kind, sessionId: 's1', operationKind: 'message', operationId: OPERATION_ID }).get('s1').tokenTurns.size, 0);
  }
  assert.equal(queued.apply(terminalFor('s1')).get('s1').tokenTurns.size, 0);
  assert.equal(queued.apply({ kind: 'failure', sessionId: 's1', message: 'failed' }).get('s1').tokenTurns, tokenTurns);
  assert.equal(queued.apply({ kind: 'detach', sessionId: 's1' }).get('s1').tokenTurns, tokenTurns);
  assert.equal(store.get('s1').tokenTurns, tokenTurns);
});

test('a committed view replaces the live transcript and completion preserves the next draft', () => {
  const store = new ChatSessionRuntimeStore().ensureSession('s1', '')
    .apply({ kind: 'submit', sessionId: 's1', content: 'original', images: [] })
    .apply({ kind: 'draft', sessionId: 's1', draft: 'still typing' })
    .apply(snapshotFor('s1', { messages: [
      createLiveMessage('u1', 'user_text', 'user', 'original'),
      createLiveMessage('q1', 'user_text', 'user', 'queued one'),
      createLiveMessage('q2', 'user_text', 'user', 'queued two'),
    ] }));
  assert.equal(store.get('s1').liveMessages.length, 3);
  const settled = store.apply(terminalFor('s1'));
  assert.equal(settled.get('s1').draft, 'still typing');
  assert.deepEqual(settled.get('s1').liveMessages, []);
});

const SAMPLE_RESPONSE: ChatSessionResponse = {
  session: {
    id: 's1',
    title: 'Test',
    modelPresetId: 'test-model',
    model: null,
    contextWindowTokens: 100,
    planRepoRoot: 'C:/repo',
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
    .ensureSession('session-a', '')
    .ensureSession('session-b', '');
  const next = store
    .apply({ kind: 'begin', sessionId: 'session-a', operationKind: 'message', operationId: OPERATION_ID })
    .apply({ kind: 'draft', sessionId: 'session-a', draft: 'hello' })
    .apply(snapshotFor('session-a', { controlOperationId: OPERATION_ID, messages: [createLiveMessage('a1', 'assistant_answer', 'assistant', 'hi there')], warnings: ['careful'] }));

  assert.deepEqual(next.get('session-a').activity, {
    kind: 'local', operationKind: 'message', operationId: OPERATION_ID,
  });
  assert.equal(next.get('session-a').draft, 'hello');
  assert.equal(next.get('session-a').liveMessages[0]?.content, 'hi there');
  assert.deepEqual(next.get('session-a').warnings, ['careful']);

  assert.deepEqual(store.get('session-a').activity, { kind: 'idle' });
  assert.equal(store.get('session-a').draft, '');
  assert.deepEqual(next.get('session-b'), store.get('session-b'));
});

test('get still throws for a session that was never touched', () => {
  assert.throws(
    () => new ChatSessionRuntimeStore().get('ghost'),
    /unknown session "ghost"/,
  );
});

test('plan input and image transitions replace only their own fields', () => {
  const next = new ChatSessionRuntimeStore()
    .ensureSession('s', '')
    .apply({ kind: 'images', sessionId: 's', images: [IMAGE_A] })
    .apply({ kind: 'plan-inputs', sessionId: 's', planRepoRootInput: 'C:/repo', planMaxTurnsInput: '12' });
  assert.deepEqual(next.get('s').pendingImages, [IMAGE_A]);
  assert.equal(next.get('s').planRepoRootInput, 'C:/repo');
  assert.equal(next.get('s').planMaxTurnsInput, '12');
  assert.equal(next.get('s').draft, '');
});

test('changing either plan input preserves the other session-local value', () => {
  const initial = new ChatSessionRuntimeStore()
    .ensureSession('s', 'C:/repo')
    .apply({ kind: 'plan-inputs', sessionId: 's', planRepoRootInput: 'C:/repo', planMaxTurnsInput: '1000' });
  const turnsChanged = initial.apply({
    kind: 'plan-inputs', sessionId: 's', planRepoRootInput: initial.get('s').planRepoRootInput, planMaxTurnsInput: '10000',
  });
  const rootChanged = turnsChanged.apply({
    kind: 'plan-inputs', sessionId: 's', planRepoRootInput: 'D:/repo', planMaxTurnsInput: turnsChanged.get('s').planMaxTurnsInput,
  });
  assert.equal(rootChanged.get('s').planRepoRootInput, 'D:/repo');
  assert.equal(rootChanged.get('s').planMaxTurnsInput, '10000');
});

test('session B cannot clear session A streaming state or draft', () => {
  const initial = new ChatSessionRuntimeStore()
    .ensureSession('session-a', '')
    .ensureSession('session-b', '')
    .apply({ kind: 'draft', sessionId: 'session-a', draft: 'draft-a' })
    .apply({ kind: 'begin', sessionId: 'session-a', operationKind: 'message', operationId: OPERATION_ID })
    .apply(snapshotFor('session-a', { controlOperationId: OPERATION_ID, messages: [createLiveMessage('a1', 'assistant_answer', 'assistant', 'answer-a')] }))
    .apply({ kind: 'begin', sessionId: 'session-b', operationKind: 'plan', operationId: OPERATION_ID });

  assert.equal(initial.get('session-a').draft, 'draft-a');
  assert.equal(initial.get('session-a').liveMessages[0]?.content, 'answer-a');
  assert.equal(initial.get('session-a').activity.kind, 'local');
  assert.equal(initial.get('session-b').activity.kind, 'local');
});

test('ensureSession creates a runtime with idle activity and empty defaults', () => {
  const store = new ChatSessionRuntimeStore().ensureSession('s1', '');
  const runtime = store.get('s1');
  assert.equal(runtime.sessionId, 's1');
  assert.equal(runtime.activity.kind, 'idle');
  assert.deepEqual(runtime.liveMessages, []);
  assert.equal(runtime.error, null);
  assert.deepEqual(runtime.warnings, []);
  assert.equal(runtime.contextUsage, null);
  assert.equal(runtime.liveTokenBase, null);
  assert.equal(runtime.streamedCharsSinceBase, 0);
  assert.equal(runtime.draft, '');
  assert.deepEqual(runtime.pendingImages, []);
  assert.equal(runtime.planRepoRootInput, '');
  assert.equal(runtime.planMaxTurnsInput, '');
  assert.equal(runtime.awaitingResponse, false);
});

test('begin sets local activity with operation kind and ownership id', () => {
  const store = new ChatSessionRuntimeStore()
    .ensureSession('s1', '')
    .apply({ kind: 'begin', sessionId: 's1', operationKind: 'message', operationId: OPERATION_ID });
  const activity = store.get('s1').activity;
  assert.equal(activity.kind, 'local');
  if (activity.kind === 'local') {
    assert.equal(activity.operationKind, 'message');
    assert.equal(activity.operationId, OPERATION_ID);
  }
});

test('a committed view carries the token base, streamed tail and turn metadata; begin drops the previous base', () => {
  const store = new ChatSessionRuntimeStore().ensureSession('s1', '')
    .apply(snapshotFor('s1', { streamedCharsSinceBase: 12, tokenTurns: [
      { turn: 1, prompt: PROMPT_FRAME, usage: buildUsageFrame({ turn: 1, record: { thinkingTokens: 20 } }) },
      { turn: 2, prompt: { ...PROMPT_FRAME, turn: 2, promptTokens: 950 }, usage: null },
    ] }));
  const runtime = store.get('s1');
  assert.equal(runtime.liveTokenBase?.promptTokens, 950);
  assert.equal(runtime.streamedCharsSinceBase, 12);
  assert.equal(runtime.tokenTurns.get(1)?.usage?.record.thinkingTokens, 20);
  // A new run measures its own prompt; the previous base would restart the bar behind itself.
  const restarted = store.apply({ kind: 'begin', sessionId: 's1', operationKind: 'message', operationId: OPERATION_ID }).get('s1');
  assert.equal(restarted.liveTokenBase, null);
  assert.equal(restarted.streamedCharsSinceBase, 0);
  assert.equal(restarted.tokenTurns.size, 0);
});

test('ensureSession seeds the composer repo root with the session default', () => {
  const runtime = new ChatSessionRuntimeStore()
    .ensureSession('s1', 'C:/srv/siftkit')
    .get('s1');
  assert.equal(runtime.planRepoRootInput, 'C:/srv/siftkit');
});

test('terminal sets idle activity and retires the live view; REST supplies context usage separately', () => {
  const store = new ChatSessionRuntimeStore()
    .ensureSession('s1', '')
    .apply({ kind: 'begin', sessionId: 's1', operationKind: 'message', operationId: OPERATION_ID })
    .apply(snapshotFor('s1', { controlOperationId: OPERATION_ID, messages: [createLiveMessage('a1', 'assistant_answer', 'assistant', 'answer')] }))
    .apply({ kind: 'context-usage', sessionId: 's1', contextUsage: SAMPLE_RESPONSE.contextUsage })
    .apply(terminalFor('s1'));
  const runtime = store.get('s1');
  assert.equal(runtime.activity.kind, 'idle');
  assert.equal(runtime.journalSnapshot, null);
  assert.deepEqual(runtime.liveMessages, []);
  assert.equal(runtime.contextUsage?.totalUsedTokens, 0);
});

test('a terminal for another operation than the adopted one is ignored', () => {
  const store = new ChatSessionRuntimeStore()
    .ensureSession('s1', '')
    .apply(snapshotFor('s1', { messages: [createLiveMessage('a1', 'assistant_answer', 'assistant', 'answer')] }));
  const other = store.apply(terminalFor('s1', '4f9c1f9a-0000-4000-8000-000000000009')).get('s1');
  assert.equal(other.liveMessages.length, 1);
  assert.equal(other.journalSnapshot?.operationId, OPERATION_ID);
});

test('a terminal carrying a recovery issue blocks continuation', () => {
  const store = new ChatSessionRuntimeStore()
    .ensureSession('s1', '')
    .apply(snapshotFor('s1'))
    .apply(terminalFor('s1', OPERATION_ID, { code: 'context_gap', operationId: OPERATION_ID, eventId: null, sequence: 4, detail: 'Missing result evidence.' }));
  assert.equal(store.get('s1').recoveryStatus, 'recovery_failed');
});

test('applyFailure sets error and idle activity', () => {
  const store = new ChatSessionRuntimeStore()
    .ensureSession('s1', '')
    .apply({ kind: 'begin', sessionId: 's1', operationKind: 'message', operationId: OPERATION_ID })
    .apply({ kind: 'failure', sessionId: 's1', message: 'boom' });
  const runtime = store.get('s1');
  assert.equal(runtime.error, 'boom');
  assert.equal(runtime.activity.kind, 'idle');
});

test('setDraft replaces the draft text', () => {
  const store = new ChatSessionRuntimeStore()
    .ensureSession('s1', '')
    .apply({ kind: 'draft', sessionId: 's1', draft: 'new draft' });
  assert.equal(store.get('s1').draft, 'new draft');
});

test('setImages replaces pending images', () => {
  const store = new ChatSessionRuntimeStore()
    .ensureSession('s1', '')
    .apply({ kind: 'images', sessionId: 's1', images: [IMAGE_A, IMAGE_B] });
  assert.deepEqual(store.get('s1').pendingImages, [IMAGE_A, IMAGE_B]);
});

test('appendImages preserves complete attachment records in dispatch order', () => {
  const store = new ChatSessionRuntimeStore()
    .ensureSession('s1', '')
    .apply({ kind: 'append-images', sessionId: 's1', images: [IMAGE_A] })
    .apply({ kind: 'append-images', sessionId: 's1', images: [IMAGE_B] });

  assert.deepEqual(store.get('s1').pendingImages, [IMAGE_A, IMAGE_B]);
});

test('setPlanInputs replaces plan input fields', () => {
  const store = new ChatSessionRuntimeStore()
    .ensureSession('s1', '')
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
    .ensureSession('s1', '')
    .ensureSession('s2', '')
    .removeSession('s1');
  assert.equal(store.getAll().length, 1);
  assert.equal(store.getAll()[0]?.sessionId, 's2');
  assert.throws(() => store.get('s1'), /unknown session/);
});

test('getAll returns runtimes in insertion order', () => {
  const store = new ChatSessionRuntimeStore()
    .ensureSession('a', '')
    .ensureSession('b', '')
    .ensureSession('c', '');
  const all = store.getAll();
  assert.equal(all.length, 3);
  assert.equal(all[0]?.sessionId, 'a');
  assert.equal(all[1]?.sessionId, 'b');
  assert.equal(all[2]?.sessionId, 'c');
});

test('immutable previous snapshots remain unchanged after mutation', () => {
  const store1 = new ChatSessionRuntimeStore().ensureSession('s1', '');
  const store2 = store1.apply({
    kind: 'begin', sessionId: 's1', operationKind: 'message', operationId: OPERATION_ID,
  });
  assert.equal(store1.get('s1').activity.kind, 'idle');
  assert.equal(store2.get('s1').activity.kind, 'local');
});

test('plan inputs initialize once on ensureSession but do not overwrite dirty draft', () => {
  const store = new ChatSessionRuntimeStore()
    .ensureSession('s1', '')
    .apply({ kind: 'draft', sessionId: 's1', draft: 'dirty' })
    .ensureSession('s1', '');
  assert.equal(store.get('s1').draft, 'dirty');
});

test('apply rejects a session that was never seeded by ensureSession', () => {
  const store = new ChatSessionRuntimeStore();
  assert.throws(
    () => store.apply({ kind: 'draft', sessionId: 'unknown', draft: 'text' }),
    /unknown session "unknown"/,
  );
});

test('applyFailure preserves generated messages, draft, and images', () => {
  const store = new ChatSessionRuntimeStore()
    .ensureSession('s1', '')
    .apply({ kind: 'draft', sessionId: 's1', draft: 'draft' })
    .apply({ kind: 'images', sessionId: 's1', images: [IMAGE_A] })
    .apply(snapshotFor('s1', { messages: [createLiveMessage('a1', 'assistant_answer', 'assistant', 'answer')] }))
    .apply({ kind: 'failure', sessionId: 's1', message: 'boom' });
  const runtime = store.get('s1');
  assert.deepEqual(runtime.liveMessages.map(message => message.content), ['answer']);
  assert.equal(runtime.draft, 'draft');
  assert.deepEqual(runtime.pendingImages, [IMAGE_A]);
});

test('setContextUsage updates only the targeted session', () => {
  const store = new ChatSessionRuntimeStore()
    .ensureSession('s1', '')
    .ensureSession('s2', '')
    .apply({ kind: 'context-usage', sessionId: 's1', contextUsage: SAMPLE_RESPONSE.contextUsage });
  assert.equal(store.get('s1').contextUsage, SAMPLE_RESPONSE.contextUsage);
  assert.equal(store.get('s2').contextUsage, null);
});

test('submit moves the draft and images into a live user bubble', () => {
  const next = new ChatSessionRuntimeStore()
    .ensureSession('s1', '')
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

test('failure restores the submitted draft and images and drops the live bubble', () => {
  const next = new ChatSessionRuntimeStore()
    .ensureSession('s1', '')
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
    .ensureSession('s1', '')
    .apply({ kind: 'draft', sessionId: 's1', draft: 'typed but never sent' })
    .apply({ kind: 'failure', sessionId: 's1', message: 'boom' });

  assert.equal(next.get('s1').draft, 'typed but never sent');
  assert.deepEqual(next.get('s1').pendingImages, []);
});

test('submit marks the session as awaiting the first streamed response', () => {
  const next = new ChatSessionRuntimeStore()
    .ensureSession('s1', '')
    .apply({ kind: 'submit', sessionId: 's1', content: 'hi', images: [] });

  assert.equal(next.get('s1').awaitingResponse, true);
});

test('a committed view, a terminal and a failure all end the awaiting state', () => {
  const submitted = new ChatSessionRuntimeStore()
    .ensureSession('s1', '')
    .apply({ kind: 'submit', sessionId: 's1', content: 'hi', images: [] });

  assert.equal(submitted.apply(snapshotFor('s1')).get('s1').awaitingResponse, false);
  assert.equal(submitted.apply(terminalFor('s1')).get('s1').awaitingResponse, false);
  assert.equal(submitted.apply({ kind: 'failure', sessionId: 's1', message: 'boom' }).get('s1').awaitingResponse, false);
});

test('terminal clears the submitted input along with the live messages', () => {
  const next = new ChatSessionRuntimeStore()
    .ensureSession('s1', '')
    .apply({ kind: 'submit', sessionId: 's1', content: 'hi', images: [IMAGE_A] })
    .apply(terminalFor('s1'));

  assert.equal(next.get('s1').submittedInput, null);
  assert.deepEqual(next.get('s1').liveMessages, []);
  assert.deepEqual(next.get('s1').pendingImages, []);
});

test('approval state comes from the actionable committed approval and is cleared by submit, terminal, failure and an explicit clear', () => {
  const pending = new ChatSessionRuntimeStore()
    .ensureSession('s1', '')
    .apply(snapshotFor('s1', { approval: APPROVAL }));
  assert.deepEqual(pending.get('s1').pendingApproval, APPROVAL);
  assert.equal(pending.apply(snapshotFor('s1', { approval: { ...APPROVAL, actionable: false } })).get('s1').pendingApproval, null);
  assert.equal(pending.apply({ kind: 'submit', sessionId: 's1', content: 'again', images: [] }).get('s1').pendingApproval, null);
  assert.equal(pending.apply(terminalFor('s1')).get('s1').pendingApproval, null);
  assert.equal(pending.apply({ kind: 'failure', sessionId: 's1', message: 'boom' }).get('s1').pendingApproval, null);
  assert.equal(pending.apply({ kind: 'approval-clear', sessionId: 's1' }).get('s1').pendingApproval, null);
});

test('local activity retains the client operation id used by Stop', () => {
  const activity = new ChatSessionRuntimeStore()
    .ensureSession('s1', '')
    .apply({
      kind: 'begin',
      sessionId: 's1',
      operationKind: 'repo-agent',
      operationId: OPERATION_ID,
    })
    .get('s1').activity;
  assert.deepEqual(activity, {
    kind: 'local',
    operationKind: 'repo-agent',
    operationId: OPERATION_ID,
  });
});

test('remote activity clears only when authoritative status reports no lease', () => {
  const remote = new ChatSessionRuntimeStore()
    .ensureSession('s1', '')
    .apply({ kind: 'remote-begin', sessionId: 's1', operationKind: 'plan' })
    .apply({ kind: 'control-error', sessionId: 's1', message: 'Session is busy' });
  assert.deepEqual(remote.get('s1').activity, { kind: 'remote', operationKind: 'plan' });
  const cleared = remote.apply({ kind: 'remote-clear', sessionId: 's1' }).get('s1');
  assert.deepEqual(cleared.activity, { kind: 'idle' });
  assert.equal(cleared.error, null);
});

test('a Stop control error preserves the live local operation and pending approval', () => {
  const runtime = new ChatSessionRuntimeStore()
    .ensureSession('s1', '')
    .apply({ kind: 'begin', sessionId: 's1', operationKind: 'repo-agent', operationId: OPERATION_ID })
    .apply(snapshotFor('s1', { operationKind: 'repo-agent', controlOperationId: OPERATION_ID, approval: APPROVAL,
      messages: [createLiveMessage('a1', 'assistant_answer', 'assistant', 'partial')] }))
    .apply({ kind: 'control-error', sessionId: 's1', message: 'Stop request failed' })
    .get('s1');

  assert.deepEqual(runtime.activity, {
    kind: 'local', operationKind: 'repo-agent', operationId: OPERATION_ID,
  });
  assert.equal(runtime.liveMessages.find((message) => message.id === 'a1')?.content, 'partial');
  assert.deepEqual(runtime.pendingApproval, APPROVAL);
  assert.equal(runtime.error, 'Stop request failed');
});

test('a fresh runtime uses the shared default repo-agent approval mode', () => {
  const store = new ChatSessionRuntimeStore().ensureSession('session-a', '');
  assert.equal(store.get('session-a').repoAgentApprovalMode, DEFAULT_APPROVAL_MODE);
});

test('repo-agent-approval-mode replaces only that field for its own session and survives a run', () => {
  const store = new ChatSessionRuntimeStore()
    .ensureSession('session-a', '')
    .ensureSession('session-b', '')
    .apply({ kind: 'draft', sessionId: 'session-a', draft: 'keep me' })
    .apply({ kind: 'repo-agent-approval-mode', sessionId: 'session-a', approval: 'off' });
  assert.equal(store.get('session-a').repoAgentApprovalMode, 'off');
  assert.equal(store.get('session-a').draft, 'keep me');
  assert.equal(store.get('session-b').repoAgentApprovalMode, 'auto');
  const afterRun = store
    .apply({ kind: 'begin', sessionId: 'session-a', operationKind: 'repo-agent', operationId: OPERATION_ID })
    .apply(terminalFor('session-a'));
  assert.equal(afterRun.get('session-a').repoAgentApprovalMode, 'off');
});

test('live thinking bubbles carry no self-derived token estimate', () => {
  const message = createLiveMessage('live-1', 'assistant_thinking', 'assistant', 'x'.repeat(400));
  assert.equal(message.thinkingTokens, 0);
});

test('attach adopts a running operation and clears the stale live transcript', () => {
  const store = new ChatSessionRuntimeStore()
    .ensureSession('s1', 'C:/repo')
    .apply({ kind: 'submit', sessionId: 's1', content: 'old', images: [] })
    .apply(snapshotFor('s1', { warnings: ['stale warning'] }))
    .apply({ kind: 'control-error', sessionId: 's1', message: 'stale failure' })
    .apply({
      kind: 'attach',
      sessionId: 's1',
      operationKind: 'repo-agent',
      operationId: '4f9c1f9a-0000-4000-8000-000000000000',
    });
  const runtime = store.get('s1');
  assert.deepEqual(runtime.activity, {
    kind: 'local',
    operationKind: 'repo-agent',
    operationId: '4f9c1f9a-0000-4000-8000-000000000000',
  });
  assert.equal(runtime.liveMessages.length, 0);
  assert.equal(runtime.warnings.length, 0);
  assert.equal(runtime.error, null);
  assert.equal(runtime.awaitingResponse, false);
  assert.equal(runtime.submittedInput, null);
  assert.equal(runtime.liveTokenBase, null);
  assert.equal(runtime.streamedCharsSinceBase, 0);
  assert.equal(runtime.pendingApproval, null);
});

test('attach preserves the composer draft so a reload does not eat typed text', () => {
  const store = new ChatSessionRuntimeStore()
    .ensureSession('s1', 'C:/repo')
    .apply({ kind: 'draft', sessionId: 's1', draft: 'queued follow-up' })
    .apply({
      kind: 'attach',
      sessionId: 's1',
      operationKind: 'plan',
      operationId: '4f9c1f9a-0000-4000-8000-000000000000',
    });
  assert.equal(store.get('s1').draft, 'queued follow-up');
});

test('detach idles an attached session without a payload, drops the live user bubble and keeps the draft', () => {
  const store = new ChatSessionRuntimeStore()
    .ensureSession('s1', 'C:/repo')
    .apply({
      kind: 'attach',
      sessionId: 's1',
      operationKind: 'condense',
      operationId: '4f9c1f9a-0000-4000-8000-000000000000',
    })
    .apply({ kind: 'submit', sessionId: 's1', content: 'x', images: [] })
    .apply({ kind: 'draft', sessionId: 's1', draft: 'typed' })
    .apply({ kind: 'detach', sessionId: 's1' });
  const runtime = store.get('s1');
  assert.deepEqual(runtime.activity, { kind: 'idle' });
  assert.equal(runtime.liveMessages.length, 0);
  assert.equal(runtime.awaitingResponse, false);
  assert.equal(runtime.error, null);
  assert.equal(runtime.draft, 'typed');
});
