import test from 'node:test';
import assert from 'node:assert/strict';

import { toRuntimeTransitions } from '../src/lib/chat-stream-transitions';
import { ChatSessionRuntimeStore } from '../src/lib/chat-session-runtime-store';
import type { ChatStreamEvent } from '../src/lib/chat-stream-parser';
import type { ChatSession, ChatSessionResponse } from '../src/types';

const SESSION: ChatSession = {
  id: 's1',
  title: 'Session',
  model: null,
  contextWindowTokens: 100,
  createdAtUtc: '2026-06-03T12:00:00.000Z',
  updatedAtUtc: '2026-06-03T12:00:00.000Z',
  messages: [],
};

function response(sessionId: string): ChatSessionResponse {
  return {
    session: { ...SESSION, id: sessionId },
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
}

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
  store = new ChatSessionRuntimeStore().ensureSession('session-a').ensureSession('session-b');
  readonly completions: string[] = [];

  async drain(stream: AsyncGenerator<ChatStreamEvent>, sessionId: string, thinking: boolean): Promise<void> {
    for await (const transition of toRuntimeTransitions(sessionId, 'message', stream, thinking)) {
      this.store = this.store.apply(transition);
      if (transition.kind === 'done') {
        this.completions.push(transition.sessionId);
      }
    }
  }
}

async function* controlledStream(sessionId: string, gate: Gate): AsyncGenerator<ChatStreamEvent> {
  yield { kind: 'answer', delta: { turn: 1, offset: 0, text: `answer-${sessionId}` } };
  gate.markWaiting();
  await gate.promise;
  yield { kind: 'done', payload: response(sessionId) };
}

async function* prematureStream(): AsyncGenerator<ChatStreamEvent> {
  yield { kind: 'answer', delta: { turn: 1, offset: 0, text: 'partial' } };
}

async function* mismatchedStream(): AsyncGenerator<ChatStreamEvent> {
  yield { kind: 'done', payload: response('session-b') };
}

async function collect(stream: AsyncGenerator<ChatStreamEvent>, thinking: boolean): Promise<string[]> {
  const kinds: string[] = [];
  for await (const transition of toRuntimeTransitions('session-a', 'plan', stream, thinking)) {
    kinds.push(transition.kind);
  }
  return kinds;
}

test('the first transition begins the operation for the requested session', async () => {
  async function* empty(): AsyncGenerator<ChatStreamEvent> {
    yield { kind: 'done', payload: response('session-a') };
  }
  assert.deepEqual(await collect(empty(), true), ['begin', 'done']);
});

test('thinking events are dropped when thinking is disabled', async () => {
  async function* thinkingStream(): AsyncGenerator<ChatStreamEvent> {
    yield { kind: 'thinking', delta: { turn: 1, offset: 0, text: 'pondering' } };
    yield { kind: 'done', payload: response('session-a') };
  }
  assert.deepEqual(await collect(thinkingStream(), false), ['begin', 'done']);
  assert.deepEqual(await collect(thinkingStream(), true), ['begin', 'thinking', 'done']);
});

test('narration events always become narration transitions', async () => {
  async function* narrationStream(): AsyncGenerator<ChatStreamEvent> {
    yield { kind: 'narration', delta: { turn: 1, offset: 0, text: 'Reading files' } };
    yield { kind: 'done', payload: response('session-a') };
  }
  assert.deepEqual(await collect(narrationStream(), false), ['begin', 'narration', 'done']);
});

test('two streams complete out of order without crossing session state', async () => {
  const drain = new StoreDrain();
  const gateA = new Gate();
  const gateB = new Gate();
  const runA = drain.drain(controlledStream('session-a', gateA), 'session-a', true);
  const runB = drain.drain(controlledStream('session-b', gateB), 'session-b', true);

  await Promise.all([gateA.waiting, gateB.waiting]);
  assert.equal(drain.store.get('session-a').activity.kind, 'active');
  assert.equal(drain.store.get('session-b').activity.kind, 'active');
  assert.equal(drain.store.get('session-a').liveMessages[0]?.content, 'answer-session-a');
  assert.equal(drain.store.get('session-b').liveMessages[0]?.content, 'answer-session-b');

  gateB.open();
  await runB;
  assert.deepEqual(drain.completions, ['session-b']);
  assert.equal(drain.store.get('session-a').activity.kind, 'active');
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
  assert.equal(drain.store.get('session-a').error, 'Chat stream ended before the done event');
  assert.equal(drain.store.get('session-a').draft, 'retry me');
  assert.equal(drain.store.get('session-b').error, null);
});

test('a done payload for another session fails the initiating session', async () => {
  const drain = new StoreDrain();
  await drain.drain(mismatchedStream(), 'session-a', true);
  assert.match(drain.store.get('session-a').error ?? '', /session mismatch/);
  assert.equal(drain.store.get('session-b').activity.kind, 'idle');
  assert.deepEqual(drain.completions, []);
});
