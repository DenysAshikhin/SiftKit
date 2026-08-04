import test from 'node:test';
import assert from 'node:assert/strict';

import {
  consumeChatStream,
  parsePlanMaxTurnsOverride,
  requireSelectedSession,
  resolveRepoRoot,
  type RuntimeActions,
} from '../../src/hooks/useChatComposer';
import { ChatSessionRuntimeStore } from '../../src/lib/chat-session-runtime-store';
import type { ChatStreamEvent, ChatStreamToolEvent } from '../../src/lib/chat-stream-parser';
import type { ChatSession, ChatSessionOperationKind, ChatSessionResponse } from '../../src/types';

const SESSION: ChatSession = {
  id: 's1',
  title: 'Session',
  model: null,
  contextWindowTokens: 100,
  condensedSummary: '',
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
  readonly promise = new Promise<void>((resolve) => {
    this.releaseGate = resolve;
  });
  readonly waiting = new Promise<void>((resolve) => {
    this.announceWaiting = resolve;
  });

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

class RuntimeRecorder implements RuntimeActions {
  store = new ChatSessionRuntimeStore().ensureSession('session-a').ensureSession('session-b');
  readonly completions: string[] = [];

  beginSessionOperation(sessionId: string, operationKind: ChatSessionOperationKind): void {
    this.store = this.store.begin(sessionId, operationKind);
  }

  appendSessionThinking(sessionId: string, text: string): void {
    this.store = this.store.appendThinking(sessionId, text);
  }

  applySessionToolEvent(sessionId: string, toolEvent: ChatStreamToolEvent): void {
    this.store = this.store.applyToolEvent(sessionId, toolEvent);
  }

  applySessionAnswer(sessionId: string, text: string): void {
    this.store = this.store.applyAnswer(sessionId, text);
  }

  applySessionWarning(sessionId: string, text: string): void {
    this.store = this.store.applyWarning(sessionId, text);
  }

  completeSessionOperation(sessionId: string, value: ChatSessionResponse): void {
    this.completions.push(sessionId);
    this.store = this.store.applyDone(value.session.id, value);
  }

  failSessionOperation(sessionId: string, message: string): void {
    this.store = this.store.applyFailure(sessionId, message);
  }
}

async function* controlledStream(
  sessionId: string,
  gate: Gate,
): AsyncGenerator<ChatStreamEvent> {
  yield { kind: 'answer', text: `answer-${sessionId}` };
  gate.markWaiting();
  await gate.promise;
  yield { kind: 'done', payload: response(sessionId) };
}

async function* prematureStream(): AsyncGenerator<ChatStreamEvent> {
  yield { kind: 'answer', text: 'partial' };
}

test('parsePlanMaxTurnsOverride returns maxTurns when input is a positive number', () => {
  assert.deepEqual(parsePlanMaxTurnsOverride('45'), { maxTurns: 45 });
});

test('parsePlanMaxTurnsOverride returns empty object for invalid values', () => {
  assert.deepEqual(parsePlanMaxTurnsOverride('0'), {});
  assert.deepEqual(parsePlanMaxTurnsOverride('-5'), {});
  assert.deepEqual(parsePlanMaxTurnsOverride('abc'), {});
  assert.deepEqual(parsePlanMaxTurnsOverride(''), {});
});

test('resolveRepoRoot trims input and falls back for blanks', () => {
  assert.equal(resolveRepoRoot('  C:\\repo  ', 'fallback'), 'C:\\repo');
  assert.equal(resolveRepoRoot('   ', 'fallback'), 'fallback');
  assert.equal(resolveRepoRoot('', ''), '');
});

test('requireSelectedSession rejects null and returns a session', () => {
  assert.throws(() => requireSelectedSession(null), /selectedSession is required/);
  assert.equal(requireSelectedSession(SESSION), SESSION);
});

test('two streams complete out of order without crossing session state', async () => {
  const runtimes = new RuntimeRecorder();
  const gateA = new Gate();
  const gateB = new Gate();
  const runA = consumeChatStream('session-a', 'message', controlledStream('session-a', gateA), true, runtimes);
  const runB = consumeChatStream('session-b', 'message', controlledStream('session-b', gateB), true, runtimes);

  await Promise.all([gateA.waiting, gateB.waiting]);
  assert.equal(runtimes.store.get('session-a').activity.kind, 'active');
  assert.equal(runtimes.store.get('session-b').activity.kind, 'active');
  assert.equal(runtimes.store.get('session-a').liveMessages[0]?.content, 'answer-session-a');
  assert.equal(runtimes.store.get('session-b').liveMessages[0]?.content, 'answer-session-b');

  gateB.open();
  await runB;
  assert.deepEqual(runtimes.completions, ['session-b']);
  assert.equal(runtimes.store.get('session-a').activity.kind, 'active');
  assert.equal(runtimes.store.get('session-b').activity.kind, 'idle');

  gateA.open();
  await runA;
  assert.deepEqual(runtimes.completions, ['session-b', 'session-a']);
  assert.equal(runtimes.store.get('session-a').activity.kind, 'idle');
});

test('premature stream close fails only the initiating session and preserves its draft', async () => {
  const runtimes = new RuntimeRecorder();
  runtimes.store = runtimes.store.setDraft('session-a', 'retry me');
  await consumeChatStream('session-a', 'message', prematureStream(), true, runtimes);
  assert.equal(runtimes.store.get('session-a').error, 'Chat stream ended before the done event');
  assert.equal(runtimes.store.get('session-a').draft, 'retry me');
  assert.equal(runtimes.store.get('session-b').error, null);
});
