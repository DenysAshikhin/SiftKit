import test from 'node:test';
import assert from 'node:assert/strict';

import { toRuntimeTransitions } from '../src/lib/chat-stream-transitions';
import { ChatSessionRuntimeStore } from '../src/lib/chat-session-runtime-store';
import { ChatSessionBusyError } from '../src/api';
import type { ChatStreamEvent } from '../src/lib/chat-stream-parser';
import type { ChatSessionRuntimeTransition } from '../src/lib/chat-session-runtime-store';
import type { ChatSession, ChatSessionOperationKind, ChatSessionResponse } from '../src/types';
import { parseChatStreamPacket } from '../src/lib/chat-stream-parser';
import { buildLiveTokenDisplays } from '../src/lib/chat-live-token-display';
import { buildUsageFrame } from './usage-frame';

for (const thinking of [true, false]) {
  test(`replayed token metadata stays session scoped, respects thinking=${thinking}, and clears on failure and successor`, async () => {
    const drain = new StoreDrain();
    const gate = new Gate();
    const frames = [
      ['attached', { operationKind: 'message', operationId: OPERATION_ID, startedAtUtc: '2026-09-10T00:00:00.000Z', replayTruncated: true }],
      ['thinking', { turn: 1, offset: 0, text: 'x'.repeat(400) }],
      ['usage', buildUsageFrame({ turn: 1, record: { thinkingTokens: 187 } })],
      ['queued_user_message', { id: OPERATION_ID, turn: 1, boundary: 'post_tool_batch', content: 'queued', images: [] }],
      ['prompt', { turn: 2, maxTurns: 20, promptTokens: 100, charsPerToken: 8 }],
      ['thinking', { turn: 2, offset: 0, text: 'y'.repeat(400) }],
    ] as const;
    async function* replay(): AsyncGenerator<ChatStreamEvent> {
      for (const [event, data] of frames) {
        const parsed = parseChatStreamPacket(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
        assert.ok(parsed);
        yield parsed;
      }
      gate.markWaiting();
      await gate.promise;
      throw new Error('provider failure after text');
    }
    const completion = drain.drain(replay(), 'session-a', thinking);
    await Promise.race([gate.waiting, completion.then(() => { throw new Error('Replay ended before its gate'); })]);
    const runtime = drain.store.get('session-a');
    const displays = buildLiveTokenDisplays(runtime);
    assert.equal(displays.get('live-thinking-1')?.tokenCount, thinking ? 187 : undefined);
    assert.equal(displays.get('live-thinking-2')?.tokenCount, thinking ? 50 : undefined);
    assert.equal(runtime.liveMessages.filter((message) => message.kind === 'assistant_thinking').length, thinking ? 2 : 0);
    assert.equal(runtime.tokenTurns.size, 2);
    assert.equal(drain.store.get('session-b').tokenTurns.size, 0);
    gate.open();
    await completion;
    assert.equal(drain.store.get('session-a').tokenTurns.size, 0);
    assert.equal(drain.store.get('session-a').error, 'provider failure after text');
    const successorGate = new Gate();
    async function* successor(): AsyncGenerator<ChatStreamEvent> {
      yield { kind: 'prompt', prompt: { turn: 1, maxTurns: 20, promptTokens: 10, charsPerToken: 8 } };
      yield { kind: 'answer', delta: { turn: 1, offset: 0, text: 'z'.repeat(400) } };
      successorGate.markWaiting();
      await successorGate.promise;
      yield { kind: 'done', payload: response('session-a') };
    }
    const successorDone = drain.drain(successor(), 'session-a', thinking);
    await successorGate.waiting;
    assert.equal(buildLiveTokenDisplays(drain.store.get('session-a')).get('live-answer-1')?.tokenCount, 50);
    assert.equal(drain.store.get('session-a').tokenTurns.size, 1);
    successorGate.open();
    await successorDone;
    assert.equal(drain.store.get('session-a').tokenTurns.size, 0);
  });
}

const OPERATION_ID = '4f9c1f9a-0000-4000-8000-000000000000';

const SESSION: ChatSession = {
  id: 's1',
  title: 'Session',
  modelPresetId: 'test-model',
  model: null,
  contextWindowTokens: 100,
  planRepoRoot: 'C:/repo',
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
  store = new ChatSessionRuntimeStore().ensureSession('session-a', '').ensureSession('session-b', '');
  readonly completions: string[] = [];

  async drain(stream: AsyncGenerator<ChatStreamEvent>, sessionId: string, thinking: boolean): Promise<void> {
    for await (const transition of toRuntimeTransitions(sessionId, { kind: 'owned', operationKind: 'message', operationId: OPERATION_ID }, stream, thinking)) {
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

async function collect(
  stream: AsyncGenerator<ChatStreamEvent>,
  operationKind: ChatSessionOperationKind,
  thinking: boolean,
): Promise<ChatSessionRuntimeTransition[]> {
  const transitions: ChatSessionRuntimeTransition[] = [];
  for await (const transition of toRuntimeTransitions('session-a', { kind: 'owned', operationKind, operationId: OPERATION_ID }, stream, thinking)) {
    transitions.push(transition);
  }
  return transitions;
}

async function collectKinds(
  stream: AsyncGenerator<ChatStreamEvent>,
  operationKind: ChatSessionOperationKind,
  thinking: boolean,
): Promise<string[]> {
  return (await collect(stream, operationKind, thinking)).map((transition) => transition.kind);
}

test('the first transition begins the operation for the requested session', async () => {
  async function* empty(): AsyncGenerator<ChatStreamEvent> {
    yield { kind: 'done', payload: response('session-a') };
  }
  assert.deepEqual(await collectKinds(empty(), 'plan', true), ['begin', 'done']);
});

test('thinking events are dropped when thinking is disabled', async () => {
  async function* thinkingStream(): AsyncGenerator<ChatStreamEvent> {
    yield { kind: 'thinking', delta: { turn: 1, offset: 0, text: 'pondering' } };
    yield { kind: 'done', payload: response('session-a') };
  }
  assert.deepEqual(await collectKinds(thinkingStream(), 'plan', false), ['begin', 'done']);
  assert.deepEqual(await collectKinds(thinkingStream(), 'plan', true), ['begin', 'thinking', 'done']);
});

test('repo-agent streams yield thinking transitions', async () => {
  async function* repoAgentThinkingStream(): AsyncGenerator<ChatStreamEvent> {
    yield { kind: 'thinking', delta: { turn: 1, offset: 0, text: 'inspecting the cipher' } };
    yield { kind: 'done', payload: response('session-a') };
  }
  const transitions = await collect(repoAgentThinkingStream(), 'repo-agent', true);
  assert.deepEqual(transitions.map((entry) => entry.kind), ['begin', 'thinking', 'done']);
  assert.deepEqual(transitions[1], {
    kind: 'thinking',
    sessionId: 'session-a',
    delta: { turn: 1, offset: 0, text: 'inspecting the cipher' },
  });
  assert.deepEqual(await collectKinds(repoAgentThinkingStream(), 'repo-agent', false), ['begin', 'done']);
});

test('narration events always become narration transitions', async () => {
  async function* narrationStream(): AsyncGenerator<ChatStreamEvent> {
    yield { kind: 'narration', delta: { turn: 1, offset: 0, text: 'Reading files' } };
    yield { kind: 'done', payload: response('session-a') };
  }
  assert.deepEqual(await collectKinds(narrationStream(), 'plan', false), ['begin', 'narration', 'done']);
});

test('usage events become session-scoped usage transitions', async () => {
  const usage = {
    turn: 1, maxTurns: 20,
    record: {
      turn: 1, promptTokens: 900, thinkingTokens: 70, outputTokens: 10, toolTokens: 40,
      generatedChars: 320, thinkingTokensEstimated: false, outputTokensEstimated: false,
    },
    totals: {
      promptTokens: 900, thinkingTokens: 70, outputTokens: 10, toolTokens: 40,
      thinkingTokensEstimatedCount: 0, outputTokensEstimatedCount: 0,
    },
    charsPerToken: 4,
  };
  async function* usageStream(): AsyncGenerator<ChatStreamEvent> {
    yield { kind: 'usage', usage };
    yield { kind: 'done', payload: response('session-a') };
  }
  const transitions = await collect(usageStream(), 'repo-search', true);
  assert.deepEqual(transitions.map((entry) => entry.kind), ['begin', 'usage', 'done']);
  assert.deepEqual(transitions[1], { kind: 'usage', sessionId: 'session-a', usage });
});

test('approval events become session-scoped approval transitions', async () => {
  async function* approvalStream(): AsyncGenerator<ChatStreamEvent> {
    yield {
      kind: 'approval',
      approval: {
        runId: '4f9c1f9a-0000-4000-8000-000000000000',
        approvalId: '4f9c1f9a-0000-4000-8000-000000000001',
        toolName: 'bash',
        command: 'npm test',
        reviewPayload: null,
      },
    };
    yield { kind: 'done', payload: response('session-a') };
  }
  assert.deepEqual(await collectKinds(approvalStream(), 'plan', true), ['begin', 'approval', 'done']);
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
