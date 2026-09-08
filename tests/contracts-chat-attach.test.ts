import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ActiveChatOperationsResponseSchema,
  ChatOperationAttachedEventSchema,
  ChatStreamApprovalResolvedSchema,
  ChatStreamApprovalStateSchema,
  ChatStreamSubmittedSchema,
} from '@siftkit/contracts';

const RUN_ID = '4f9c1f9a-0000-4000-8000-000000000000';
const APPROVAL_ID = '4f9c1f9a-0000-4000-8000-000000000001';
const OPERATION_ID = '4f9c1f9a-0000-4000-8000-000000000002';

test('the attached frame carries the operation identity and the replay fidelity flag', () => {
  const parsed = ChatOperationAttachedEventSchema.parse({
    operationKind: 'repo-agent',
    operationId: OPERATION_ID,
    startedAtUtc: '2026-09-08T12:00:00.000Z',
    replayTruncated: false,
  });
  assert.equal(parsed.operationKind, 'repo-agent');
  assert.equal(parsed.replayTruncated, false);
});

test('the attached frame rejects a non-uuid operation id', () => {
  assert.equal(ChatOperationAttachedEventSchema.safeParse({
    operationKind: 'repo-agent',
    operationId: 'not-a-uuid',
    startedAtUtc: '2026-09-08T12:00:00.000Z',
    replayTruncated: false,
  }).success, false);
});

test('the submitted frame carries the prompt and its image data urls', () => {
  const parsed = ChatStreamSubmittedSchema.parse({
    content: 'fix the bug',
    images: ['data:image/png;base64,AAAA'],
  });
  assert.equal(parsed.content, 'fix the bug');
  assert.equal(parsed.images.length, 1);
  assert.equal(ChatStreamSubmittedSchema.safeParse({ content: 'x', images: ['not-a-data-url'] }).success, false);
});

test('approval state carries either an approval or an explicit null', () => {
  assert.equal(ChatStreamApprovalStateSchema.parse({ approval: null }).approval, null);
  const pending = ChatStreamApprovalStateSchema.parse({
    approval: {
      runId: RUN_ID,
      approvalId: APPROVAL_ID,
      toolName: 'bash',
      command: 'git status',
      reviewPayload: null,
    },
  });
  assert.equal(pending.approval?.approvalId, APPROVAL_ID);
});

test('a resolved approval carries the decision and when it was made', () => {
  const parsed = ChatStreamApprovalResolvedSchema.parse({
    approval: {
      runId: RUN_ID,
      approvalId: APPROVAL_ID,
      toolName: 'bash',
      command: 'rm -rf build',
      reviewPayload: null,
    },
    decision: { decision: 'deny', reason: 'too broad' },
    decidedAtUtc: '2026-09-08T12:00:05.000Z',
  });
  assert.equal(parsed.decision.decision, 'deny');
  assert.equal(parsed.decidedAtUtc, '2026-09-08T12:00:05.000Z');
});

test('a deny decision without a reason is rejected', () => {
  assert.equal(ChatStreamApprovalResolvedSchema.safeParse({
    approval: {
      runId: RUN_ID,
      approvalId: APPROVAL_ID,
      toolName: 'bash',
      command: 'rm -rf build',
      reviewPayload: null,
    },
    decision: { decision: 'deny' },
    decidedAtUtc: '2026-09-08T12:00:05.000Z',
  }).success, false);
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
