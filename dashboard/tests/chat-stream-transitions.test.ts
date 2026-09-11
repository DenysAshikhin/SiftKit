import test from 'node:test';
import { buildChatRunMessageIdPrefix, buildChatMessageId } from '@siftkit/contracts';
import type { ChatRunTerminalCause } from '@siftkit/contracts';
import { createLiveMessage } from '../src/lib/chat-live-messages';
import assert from 'node:assert/strict';

import { toRuntimeTransitions } from '../src/lib/chat-stream-transitions';
import { ChatSessionRuntimeStore } from '../src/lib/chat-session-runtime-store';
import { ChatSessionBusyError } from '../src/api';
import type { ChatStreamEvent } from '../src/lib/chat-stream-parser';
import type { ChatSessionRuntimeTransition } from '../src/lib/chat-session-runtime-store';
import type { ChatSessionOperationKind } from '../src/types';
import { buildLiveTokenDisplays } from '../src/lib/chat-live-token-display';
import { buildUsageFrame } from './usage-frame';
import { chatProjectionCapture, chatSnapshotFrames, errorRecord, projectionEvents, singleRecordFrames, terminalRecord } from './chat-snapshot-fixture.js';

const OPERATION_ID = '4f9c1f9a-0000-4000-8000-000000000000';

for (const thinking of [true, false]) {
  test(`recovered token metadata stays session scoped, respects thinking=${thinking}, and survives failure until its successor`, async () => {
    const drain = new StoreDrain();
    const gate = new Gate();
    const firstId = buildChatMessageId(buildChatRunMessageIdPrefix(OPERATION_ID), { kind: 'thinking', turn: 1 });
    const secondId = buildChatMessageId(buildChatRunMessageIdPrefix(OPERATION_ID), { kind: 'thinking', turn: 2 });
    const capture = chatProjectionCapture({ sessionId: 'session-a', operationKind: 'message', operationId: OPERATION_ID,
      messages: [createLiveMessage(firstId, 'assistant_thinking', 'assistant', 'x'.repeat(400)),
        createLiveMessage('queued', 'user_text', 'user', 'queued'),
        createLiveMessage(secondId, 'assistant_thinking', 'assistant', 'y'.repeat(400))],
      tokenTurns: [{ turn: 1, prompt: null, usage: buildUsageFrame({ turn: 1, record: { thinkingTokens: 187 } }) },
        { turn: 2, prompt: { turn: 2, maxTurns: 20, promptTokens: 100, charsPerToken: 8 }, usage: null }],
    });
    async function* replay(): AsyncGenerator<ChatStreamEvent> {
      yield* projectionEvents(chatSnapshotFrames(capture));
      gate.markWaiting();
      await gate.promise;
      throw new Error('provider failure after text');
    }
    const completion = drain.drain(replay(), 'session-a', thinking);
    await Promise.race([gate.waiting, completion.then(() => { throw new Error('Replay ended before its gate'); })]);
    const runtime = drain.store.get('session-a');
    const displays = buildLiveTokenDisplays(runtime);
    assert.equal(displays.get(firstId)?.tokenCount, thinking ? 187 : undefined);
    assert.equal(displays.get(secondId)?.tokenCount, thinking ? 50 : undefined);
    assert.equal(runtime.liveMessages.filter((message) => message.kind === 'assistant_thinking').length, thinking ? 2 : 0);
    assert.equal(runtime.tokenTurns.size, 2);
    assert.equal(drain.store.get('session-b').tokenTurns.size, 0);
    gate.open();
    await completion;
    assert.equal(drain.store.get('session-a').tokenTurns.size, 2);
    assert.equal(drain.store.get('session-a').error, 'provider failure after text');
    const successorGate = new Gate();
    const successorId = '4f9c1f9a-0000-4000-8000-000000000003';
    const answerId = buildChatMessageId(buildChatRunMessageIdPrefix(successorId), { kind: 'answer', turn: 1 });
    const successorCapture = chatProjectionCapture({ sessionId: 'session-a', operationId: successorId, runOrder: 2,
      controlOperationId: OPERATION_ID, terminalCause: 'completed', messages: [createLiveMessage(answerId, 'assistant_answer', 'assistant', 'z'.repeat(400))],
      tokenTurns: [{ turn: 1, prompt: { turn: 1, maxTurns: 20, promptTokens: 10, charsPerToken: 8 }, usage: null }] });
    async function* successor(): AsyncGenerator<ChatStreamEvent> {
      yield* projectionEvents(chatSnapshotFrames(successorCapture));
      successorGate.markWaiting();
      await successorGate.promise;
      yield* projectionEvents(singleRecordFrames(terminalRecord(successorCapture.cursor)));
    }
    const successorDone = drain.drain(successor(), 'session-a', thinking);
    await successorGate.waiting;
    assert.equal(buildLiveTokenDisplays(drain.store.get('session-a')).get(answerId)?.tokenCount, 50);
    assert.equal(drain.store.get('session-a').tokenTurns.size, 1);
    successorGate.open();
    await successorDone;
    assert.equal(drain.store.get('session-a').tokenTurns.size, 0);
  });
}

test('a structured recovery failure blocks continuation immediately and preserves the readable prefix', async () => {
  const drain = new StoreDrain();
  const capture = chatProjectionCapture({ sessionId: 'session-a', operationId: OPERATION_ID,
    messages: [createLiveMessage('saved-prefix', 'assistant_narration', 'assistant', 'readable prefix')] });
  async function* stream(): AsyncGenerator<ChatStreamEvent> {
    yield* projectionEvents(chatSnapshotFrames(capture));
    yield* projectionEvents(singleRecordFrames(errorRecord({ error: 'Source has a sequence gap.',
      issue: { code: 'sequence_gap', operationId: OPERATION_ID, eventId: null, sequence: 3, detail: 'Source has a sequence gap.' } })));
  }
  await drain.drain(stream(), 'session-a', true);
  const runtime = drain.store.get('session-a');
  assert.equal(runtime.recoveryStatus, 'recovery_failed');
  assert.equal(runtime.liveMessages[0]?.content, 'readable prefix');
  assert.equal(runtime.error, 'Source has a sequence gap.');
});

class Gate {
  private releaseGate: (() => void) | null = null;
  private announceWaiting: (() => void) | null = null;
  readonly promise = new Promise<void>((resolve) => { this.releaseGate = resolve; });
  readonly waiting = new Promise<void>((resolve) => { this.announceWaiting = resolve; });

  markWaiting(): void {
    const announceWaiting = this.announceWaiting;
    if (!announceWaiting) {
      throw new Error('Gate already marked waiting');
    }
    this.announceWaiting = null;
    announceWaiting();
  }

  open(): void {
    const releaseGate = this.releaseGate;
    if (!releaseGate) {
      throw new Error('Gate already opened');
    }
    this.releaseGate = null;
    releaseGate();
  }
}

/** Mirrors how useChatSessions drains the generator into the store. */
class StoreDrain {
  store = new ChatSessionRuntimeStore().ensureSession('session-a', '').ensureSession('session-b', '');
  readonly completions: string[] = [];

  async drain(stream: AsyncGenerator<ChatStreamEvent>, sessionId: string, thinking: boolean): Promise<void> {
    for await (const transition of toRuntimeTransitions(sessionId, { kind: 'owned', operationKind: 'message', operationId: OPERATION_ID }, stream, thinking)) {
      this.store = this.store.apply(transition);
      if (transition.kind === 'terminal') {
        this.completions.push(transition.sessionId);
      }
    }
  }
}

function answerCapture(sessionId: string, terminalCause: ChatRunTerminalCause | null = null) {
  const answerId = buildChatMessageId(buildChatRunMessageIdPrefix(OPERATION_ID), { kind: 'answer', turn: 1 });
  return chatProjectionCapture({ sessionId, operationKind: 'message', operationId: OPERATION_ID, terminalCause,
    messages: [createLiveMessage(answerId, 'assistant_answer', 'assistant', `answer-${sessionId}`)] });
}

async function* controlledStream(sessionId: string, gate: Gate): AsyncGenerator<ChatStreamEvent> {
  const capture = answerCapture(sessionId);
  const terminalCapture = answerCapture(sessionId, 'completed');
  yield* projectionEvents(chatSnapshotFrames(capture));
  gate.markWaiting();
  await gate.promise;
  yield* projectionEvents(chatSnapshotFrames(terminalCapture));
  yield* projectionEvents(singleRecordFrames(terminalRecord(terminalCapture.cursor)));
}

async function* prematureStream(): AsyncGenerator<ChatStreamEvent> {
  yield* projectionEvents(chatSnapshotFrames(answerCapture('session-a')));
}

async function* mismatchedStream(): AsyncGenerator<ChatStreamEvent> {
  yield* projectionEvents(chatSnapshotFrames(answerCapture('session-b')));
}

async function collectKinds(
  stream: AsyncGenerator<ChatStreamEvent>,
  operationKind: ChatSessionOperationKind,
  thinking: boolean,
): Promise<string[]> {
  const transitions: ChatSessionRuntimeTransition[] = [];
  for await (const transition of toRuntimeTransitions('session-a', { kind: 'owned', operationKind, operationId: OPERATION_ID }, stream, thinking)) {
    transitions.push(transition);
  }
  return transitions.map((transition) => transition.kind);
}

test('the first transition begins the operation for the requested session and the terminal settles it', async () => {
  async function* settled(): AsyncGenerator<ChatStreamEvent> {
    const capture = answerCapture('session-a', 'completed');
    yield* projectionEvents(chatSnapshotFrames(capture));
    yield* projectionEvents(singleRecordFrames(terminalRecord(capture.cursor)));
  }
  assert.deepEqual(await collectKinds(settled(), 'plan', true), ['begin', 'snapshot', 'queue', 'terminal']);
});

test('two streams complete out of order without crossing session state', async () => {
  const drain = new StoreDrain();
  const gateA = new Gate();
  const gateB = new Gate();
  const runA = drain.drain(controlledStream('session-a', gateA), 'session-a', true);
  const runB = drain.drain(controlledStream('session-b', gateB), 'session-b', true);

  await Promise.all([gateA.waiting, gateB.waiting]);
  assert.equal(drain.store.get('session-a').activity.kind, 'local');
  assert.equal(drain.store.get('session-b').activity.kind, 'local');
  assert.equal(drain.store.get('session-a').liveMessages[0]?.content, 'answer-session-a');
  assert.equal(drain.store.get('session-b').liveMessages[0]?.content, 'answer-session-b');

  gateB.open();
  await runB;
  assert.deepEqual(drain.completions, ['session-b']);
  assert.equal(drain.store.get('session-a').activity.kind, 'local');
  assert.equal(drain.store.get('session-b').activity.kind, 'idle');

  gateA.open();
  await runA;
  assert.deepEqual(drain.completions, ['session-b', 'session-a']);
  assert.equal(drain.store.get('session-a').activity.kind, 'idle');
});

test('premature stream close fails only the initiating session and preserves its draft', async () => {
  const drain = new StoreDrain();
  drain.store = drain.store.apply({ kind: 'draft', sessionId: 'session-a', draft: 'retry me' });
  await drain.drain(prematureStream(), 'session-a', true);
  assert.equal(drain.store.get('session-a').error, 'Chat stream ended before its terminal record');
  assert.equal(drain.store.get('session-a').draft, 'retry me');
  assert.equal(drain.store.get('session-b').error, null);
});

test('a view for another session fails the initiating session', async () => {
  const drain = new StoreDrain();
  await drain.drain(mismatchedStream(), 'session-a', true);
  assert.match(drain.store.get('session-a').error ?? '', /session mismatch/);
  assert.equal(drain.store.get('session-b').activity.kind, 'idle');
  assert.deepEqual(drain.completions, []);
});

test('a 409 replaces local ownership with authoritative remote activity', async () => {
  async function* busyStream(): AsyncGenerator<ChatStreamEvent> {
    throw new ChatSessionBusyError({
      error: 'Chat session already has an active operation.',
      sessionId: 'session-a',
      operationKind: 'repo-search',
    });
  }

  const drain = new StoreDrain();
  await drain.drain(busyStream(), 'session-a', true);
  assert.deepEqual(drain.store.get('session-a').activity, {
    kind: 'remote',
    operationKind: 'repo-search',
  });
  assert.equal(drain.store.get('session-a').error, 'Chat session already has an active operation.');
});
