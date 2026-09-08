import assert from 'node:assert/strict';
import test from 'node:test';

import { ChatSessionOperationRegistry } from '../src/status-server/chat-session-operation-registry.js';
import { buildChatOperationAttachFrames } from '../src/status-server/routes/chat-operation-attach.js';

const OPERATION_ID = '4f9c1f9a-0000-4000-8000-000000000000';
const RUN_ID = '4f9c1f9a-0000-4000-8000-000000000001';
const APPROVAL_ID = '4f9c1f9a-0000-4000-8000-000000000002';
const STARTED_AT_MS = Date.parse('2026-09-08T12:00:00.000Z');

const PENDING_APPROVAL = {
  runId: RUN_ID,
  approvalId: APPROVAL_ID,
  toolName: 'bash',
  command: 'git status',
  reviewPayload: null,
} as const;

function silentSubscriber(): { onFrame: () => void; onClosed: () => void } {
  return { onFrame: () => {}, onClosed: () => {} };
}

test('the attach preamble identifies the run, replays non-approval frames, then states approval', () => {
  const registry = new ChatSessionOperationRegistry();
  registry.acquire('session-a', 'repo-agent', OPERATION_ID, STARTED_AT_MS);
  const broadcast = registry.getBroadcast('session-a');
  const lease = registry.getActive('session-a');
  assert.ok(broadcast);
  assert.ok(lease);
  broadcast.writeEvent('submitted', { content: 'do it', images: [] });
  broadcast.writeEvent('thinking', { turn: 0, offset: 0, text: 'planning' });
  broadcast.writeEvent('approval', PENDING_APPROVAL);
  broadcast.writeEvent('progress', { turn: 1, text: 'running', elapsedMs: 12 });
  const frames = buildChatOperationAttachFrames(
    lease,
    broadcast.attach(silentSubscriber()),
    PENDING_APPROVAL,
  );
  assert.deepEqual(frames.map((frame) => frame.event), [
    'attached',
    'submitted',
    'thinking',
    'progress',
    'approval_state',
  ]);
  assert.equal(
    frames[0]?.data,
    `{"operationKind":"repo-agent","operationId":"${OPERATION_ID}",`
      + '"startedAtUtc":"2026-09-08T12:00:00.000Z","replayTruncated":false}',
  );
  assert.ok(frames[4]?.data.includes(APPROVAL_ID));
});

test('with no pending approval the state frame is an explicit null', () => {
  const registry = new ChatSessionOperationRegistry();
  registry.acquire('session-a', 'message', OPERATION_ID, STARTED_AT_MS);
  const broadcast = registry.getBroadcast('session-a');
  const lease = registry.getActive('session-a');
  assert.ok(broadcast);
  assert.ok(lease);
  broadcast.writeEvent('answer', { turn: 0, offset: 0, text: 'hi' });
  const frames = buildChatOperationAttachFrames(lease, broadcast.attach(silentSubscriber()), null);
  assert.deepEqual(frames.map((frame) => frame.event), ['attached', 'answer', 'approval_state']);
  assert.equal(frames[2]?.data, '{"approval":null}');
});

test('a truncated replay is flagged in the attached frame', () => {
  const registry = new ChatSessionOperationRegistry();
  registry.acquire('session-a', 'plan', OPERATION_ID, STARTED_AT_MS);
  const lease = registry.getActive('session-a');
  assert.ok(lease);
  const frames = buildChatOperationAttachFrames(lease, { frames: [], truncated: true }, null);
  assert.ok(frames[0]?.data.includes('"replayTruncated":true'));
});

test('a resolved approval frame is suppressed from the replay', () => {
  const registry = new ChatSessionOperationRegistry();
  registry.acquire('session-a', 'repo-agent', OPERATION_ID, STARTED_AT_MS);
  const broadcast = registry.getBroadcast('session-a');
  const lease = registry.getActive('session-a');
  assert.ok(broadcast);
  assert.ok(lease);
  broadcast.writeEvent('approval', PENDING_APPROVAL);
  broadcast.writeEvent('approval_resolved', {
    approval: PENDING_APPROVAL,
    decision: { decision: 'approve' },
    decidedAtUtc: '2026-09-08T12:00:05.000Z',
  });
  const frames = buildChatOperationAttachFrames(lease, broadcast.attach(silentSubscriber()), null);
  assert.deepEqual(frames.map((frame) => frame.event), ['attached', 'approval_state']);
  assert.equal(frames[1]?.data, '{"approval":null}');
});
