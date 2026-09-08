import assert from 'node:assert/strict';
import test from 'node:test';

import { ChatOperationIdleError } from '../src/api';
import { toRuntimeTransitions } from '../src/lib/chat-stream-transitions';
import type { ChatStreamEvent } from '../src/lib/chat-stream-parser';
import type { ChatSessionRuntimeTransition } from '../src/lib/chat-session-runtime-store';
import { CHAT_SESSION_RESPONSE } from './fixtures.js';

const OPERATION_ID = '4f9c1f9a-0000-4000-8000-000000000000';
const RUN_ID = '4f9c1f9a-0000-4000-8000-000000000001';
const APPROVAL_ID = '4f9c1f9a-0000-4000-8000-000000000002';

const APPROVAL = {
  runId: RUN_ID,
  approvalId: APPROVAL_ID,
  toolName: 'bash',
  command: 'git status',
  reviewPayload: null,
} as const;

const ATTACHED: ChatStreamEvent = {
  kind: 'attached', operationKind: 'repo-agent', operationId: OPERATION_ID, replayTruncated: false,
};

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

test('an attached stream emits no begin before the attached frame arrives', async () => {
  const transitions = await collect(streamOf([ATTACHED, { kind: 'done', payload: CHAT_SESSION_RESPONSE }]));
  assert.deepEqual(transitions.map((transition) => transition.kind), ['attach', 'done']);
  assert.deepEqual(transitions[0], {
    kind: 'attach',
    sessionId: 's1',
    operationKind: 'repo-agent',
    operationId: OPERATION_ID,
  });
});

test('a truncated replay warns the user that earlier output is gone', async () => {
  const transitions = await collect(streamOf([
    { ...ATTACHED, replayTruncated: true },
    { kind: 'done', payload: CHAT_SESSION_RESPONSE },
  ]));
  assert.deepEqual(transitions.map((transition) => transition.kind), ['attach', 'warning', 'done']);
});

test('a submitted frame becomes a user-turn transition', async () => {
  const transitions = await collect(streamOf([
    ATTACHED,
    { kind: 'submitted', content: 'fix it', images: [] },
    { kind: 'done', payload: CHAT_SESSION_RESPONSE },
  ]));
  assert.deepEqual(transitions[1], { kind: 'user-turn', sessionId: 's1', content: 'fix it', images: [] });
});

test('approval state maps to a pending approval or an explicit clear', async () => {
  const pending = await collect(streamOf([
    ATTACHED,
    { kind: 'approval-state', approval: APPROVAL },
    { kind: 'done', payload: CHAT_SESSION_RESPONSE },
  ]));
  assert.deepEqual(pending[1], { kind: 'approval', sessionId: 's1', approval: APPROVAL });
  const cleared = await collect(streamOf([
    ATTACHED,
    { kind: 'approval-state', approval: null },
    { kind: 'done', payload: CHAT_SESSION_RESPONSE },
  ]));
  assert.deepEqual(cleared[1], { kind: 'approval-clear', sessionId: 's1' });
});

test('a resolved approval becomes an approval decision transition', async () => {
  const resolution = {
    approval: APPROVAL,
    decision: { decision: 'approve' },
    decidedAtUtc: '2026-09-08T12:00:05.000Z',
  } as const;
  const transitions = await collect(streamOf([
    ATTACHED,
    { kind: 'approval-resolved', resolution },
    { kind: 'done', payload: CHAT_SESSION_RESPONSE },
  ]));
  assert.deepEqual(transitions[1], { kind: 'approval-decision', sessionId: 's1', resolution });
});

test('an ended frame becomes a detach and counts as completion', async () => {
  const transitions = await collect(streamOf([ATTACHED, { kind: 'ended' }]));
  assert.deepEqual(transitions.map((transition) => transition.kind), ['attach', 'detach']);
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
    { kind: 'owned', operationKind: 'message', operationId: OPERATION_ID },
    streamOf([{ kind: 'done', payload: CHAT_SESSION_RESPONSE }]),
    true,
  )) {
    collected.push(transition);
  }
  assert.deepEqual(collected.map((transition) => transition.kind), ['begin', 'done']);
});
