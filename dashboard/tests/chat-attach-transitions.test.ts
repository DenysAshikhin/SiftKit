import assert from 'node:assert/strict';
import test from 'node:test';

import { ChatOperationIdleError } from '../src/api';
import { toRuntimeTransitions } from '../src/lib/chat-stream-transitions';
import type { ChatStreamEvent } from '../src/lib/chat-stream-parser';
import type { ChatSessionRuntimeTransition } from '../src/lib/chat-session-runtime-store';
import {
  FIXTURE_OPERATION_ID, chatProjectionCapture, chatQueueState, chatSnapshotFrames, errorRecord, projectionEvents, singleRecordFrames, terminalRecord,
} from './chat-snapshot-fixture.js';

const CAPTURE = chatProjectionCapture({ operationId: FIXTURE_OPERATION_ID, terminalCause: 'completed' }, 0, chatQueueState({ revision: 2 }));
const ATTACHED: ChatStreamEvent[] = projectionEvents(chatSnapshotFrames(CAPTURE));

async function* streamOf(events: ChatStreamEvent[]): AsyncGenerator<ChatStreamEvent> {
  for (const event of events) {
    yield event;
  }
}

async function* failingStream(error: Error): AsyncGenerator<ChatStreamEvent> {
  await Promise.resolve();
  throw error;
}

async function collect(stream: AsyncGenerator<ChatStreamEvent>): Promise<ChatSessionRuntimeTransition[]> {
  const collected: ChatSessionRuntimeTransition[] = [];
  for await (const transition of toRuntimeTransitions('s1', { kind: 'attached' }, stream, true)) {
    collected.push(transition);
  }
  return collected;
}

test('an attached stream adopts its committed view and queue without a speculative begin', async () => {
  const transitions = await collect(streamOf([...ATTACHED, ...projectionEvents(singleRecordFrames(terminalRecord(CAPTURE.cursor)))]));
  assert.deepEqual(transitions.map((transition) => transition.kind), ['snapshot', 'queue', 'terminal']);
  assert.deepEqual(transitions[0], { kind: 'snapshot', sessionId: 's1', snapshot: CAPTURE.snapshot });
  assert.deepEqual(transitions[1], { kind: 'queue', sessionId: 's1', queue: CAPTURE.queue });
});

test('an incomplete transfer is never adopted, and a body that ends inside one is a failure', async () => {
  const transitions = await collect(streamOf(ATTACHED.slice(0, -1)));
  assert.deepEqual(transitions.map((transition) => transition.kind), ['failure']);
  assert.equal(transitions[0]?.kind === 'failure' && transitions[0].message, 'Chat stream ended before its terminal record');
});

test('thinking rows are filtered from adopted views when thinking is disabled', async () => {
  const capture = chatProjectionCapture({ operationId: FIXTURE_OPERATION_ID, messages: [
    { id: 'think', kind: 'assistant_thinking', role: 'assistant', content: 'private', createdAtUtc: '2026-09-08T12:00:00.000Z',
      inputTokensEstimate: 0, outputTokensEstimate: 0, thinkingTokens: 0, inputTokensEstimated: false, outputTokensEstimated: false, thinkingTokensEstimated: false },
    { id: 'answer', kind: 'assistant_answer', role: 'assistant', content: 'shown', createdAtUtc: '2026-09-08T12:00:00.000Z',
      inputTokensEstimate: 0, outputTokensEstimate: 0, thinkingTokens: 0, inputTokensEstimated: false, outputTokensEstimated: false, thinkingTokensEstimated: false },
  ] });
  const collected: ChatSessionRuntimeTransition[] = [];
  for await (const transition of toRuntimeTransitions('s1', { kind: 'attached' }, streamOf(projectionEvents(chatSnapshotFrames(capture))), false)) {
    collected.push(transition);
  }
  const snapshot = collected[0];
  assert.equal(snapshot?.kind === 'snapshot' && snapshot.snapshot.messages.map(message => message.id).join(','), 'answer');
});

test('an error record becomes a failure carrying its recovery issue and ends the stream', async () => {
  const issue = { code: 'sequence_gap' as const, operationId: FIXTURE_OPERATION_ID, eventId: null, sequence: 3, detail: 'Source has a sequence gap.' };
  const transitions = await collect(streamOf([...ATTACHED, ...projectionEvents(singleRecordFrames(errorRecord({ error: 'Source has a sequence gap.', issue })))]));
  assert.deepEqual(transitions.map((transition) => transition.kind), ['snapshot', 'queue', 'failure']);
  assert.deepEqual(transitions[2], { kind: 'failure', sessionId: 's1', message: 'Source has a sequence gap.', issue });
});

test('a view for another session fails the attaching session', async () => {
  const other = chatProjectionCapture({ sessionId: 'other', operationId: FIXTURE_OPERATION_ID });
  const transitions = await collect(streamOf(projectionEvents(chatSnapshotFrames(other))));
  assert.equal(transitions[0]?.kind === 'failure' && /session mismatch/u.test(transitions[0].message), true);
});

test('an idle session escapes as ChatOperationIdleError instead of a failure transition', async () => {
  await assert.rejects(
    collect(failingStream(new ChatOperationIdleError())),
    (error: Error) => error instanceof ChatOperationIdleError,
  );
});

test('an owned stream still emits begin up front', async () => {
  const collected: ChatSessionRuntimeTransition[] = [];
  for await (const transition of toRuntimeTransitions(
    's1',
    { kind: 'owned', operationKind: 'message', operationId: FIXTURE_OPERATION_ID },
    streamOf([...ATTACHED, ...projectionEvents(singleRecordFrames(terminalRecord(CAPTURE.cursor)))]),
    true,
  )) {
    collected.push(transition);
  }
  assert.deepEqual(collected.map((transition) => transition.kind), ['begin', 'snapshot', 'queue', 'terminal']);
});
