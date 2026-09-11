import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ActiveChatOperationsResponseSchema,
  ChatOperationSnapshotSchema,
  RepoAgentDecisionSchema,
} from '@siftkit/contracts';

const OPERATION_ID = '4f9c1f9a-0000-4000-8000-000000000002';

const AttachIdentitySchema = ChatOperationSnapshotSchema.pick({ operationKind: true, operationId: true, startedAtUtc: true, cursor: true });

test('the snapshot carries the operation identity and committed cursor', () => {
  const parsed = AttachIdentitySchema.parse({
    operationKind: 'repo-agent',
    operationId: OPERATION_ID,
    startedAtUtc: '2026-09-08T12:00:00.000Z',
    cursor: { operationId: OPERATION_ID, sequence: 12 },
  });
  assert.equal(parsed.operationKind, 'repo-agent');
  assert.equal(parsed.cursor.sequence, 12);
});

test('the snapshot rejects a non-uuid operation id', () => {
  assert.equal(AttachIdentitySchema.safeParse({
    operationKind: 'repo-agent',
    operationId: 'not-a-uuid',
    startedAtUtc: '2026-09-08T12:00:00.000Z',
    cursor: { operationId: OPERATION_ID, sequence: 12 },
  }).success, false);
});

test('a deny decision without a reason is rejected', () => {
  assert.equal(RepoAgentDecisionSchema.safeParse({ decision: 'deny' }).success, false);
  assert.equal(RepoAgentDecisionSchema.safeParse({ decision: 'deny', reason: 'too broad' }).success, true);
});

test('the active operations listing keys each entry by session', () => {
  const parsed = ActiveChatOperationsResponseSchema.parse({
    operations: [{
      sessionId: 's1',
      operationKind: 'plan',
      operationId: OPERATION_ID,
      startedAtUtc: '2026-09-08T12:00:00.000Z',
    }],
  });
  assert.equal(parsed.operations[0]?.sessionId, 's1');
});
