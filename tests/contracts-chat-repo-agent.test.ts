import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ChatSessionOperationKindSchema,
  ChatSessionBusyResponseSchema,
  ChatStreamApprovalSchema,
  RepoAgentDecisionSchema,
  ChatRepoAgentStreamRequestSchema,
  ActiveChatRepoAgentResponseSchema,
  ChatOperationStatusResponseSchema,
  StopChatOperationRequestSchema,
  StopChatOperationResponseSchema,
  PersistedChatTranscriptMessageSchema,
  ApprovalModeSchema,
  ChatRepoAgentApprovalModeRequestSchema,
  ChatRepoAgentApprovalModeResponseSchema,
  ChatRepoAgentDecideResponseSchema,
  DEFAULT_APPROVAL_MODE,
  APPROVAL_MODE_ERROR,
} from '@siftkit/contracts';

const OPERATION_ID = '4f9c1f9a-0000-4000-8000-000000000000';

test('operation kind accepts repo-agent', () => {
  assert.equal(ChatSessionOperationKindSchema.parse('repo-agent'), 'repo-agent');
});

test('busy response parses with repo-agent kind', () => {
  const parsed = ChatSessionBusyResponseSchema.parse({
    error: 'Chat session already has an active operation.',
    sessionId: 's1',
    operationKind: 'repo-agent',
  });
  assert.equal(parsed.operationKind, 'repo-agent');
});

test('approval stream payload parses', () => {
  const parsed = ChatStreamApprovalSchema.parse({
    runId: '4f9c1f9a-0000-4000-8000-000000000000',
    approvalId: '4f9c1f9a-0000-4000-8000-000000000001',
    toolName: 'bash',
    command: 'node --test tests/x.test.ts',
    reviewPayload: null,
  });
  assert.equal(parsed.toolName, 'bash');
});

test('repo_agent_approval persisted message parses and old kinds still load', () => {
  const approval = PersistedChatTranscriptMessageSchema.parse({
    id: 'm1', role: 'user', kind: 'repo_agent_approval',
    content: 'approved bash: node --test tests/x.test.ts',
    inputTokensEstimate: 0, outputTokensEstimate: 0, thinkingTokens: 0,
    createdAtUtc: new Date().toISOString(),
    approvalDecision: 'approve', approvalToolName: 'bash',
    approvalCommand: 'node --test tests/x.test.ts', approvalReason: null,
  });
  assert.equal(approval.kind, 'repo_agent_approval');
  const legacy = PersistedChatTranscriptMessageSchema.parse({
    id: 'm2', role: 'user', kind: 'user_text', content: 'hi',
    inputTokensEstimate: 0, outputTokensEstimate: 0, thinkingTokens: 0,
    createdAtUtc: new Date().toISOString(),
  });
  assert.equal(legacy.kind, 'user_text');
});

test('repo-agent decisions share one strict public contract', () => {
  assert.deepEqual(RepoAgentDecisionSchema.parse({ decision: 'approve' }), { decision: 'approve' });
  assert.deepEqual(
    RepoAgentDecisionSchema.parse({ decision: 'deny', reason: 'unsafe command' }),
    { decision: 'deny', reason: 'unsafe command' },
  );
  assert.throws(() => RepoAgentDecisionSchema.parse({ decision: 'deny' }));
  assert.throws(() => RepoAgentDecisionSchema.parse({ decision: 'abort', reason: 'extra' }));
});

test('chat repo-agent stream requests require a client operation id', () => {
  const parsed = ChatRepoAgentStreamRequestSchema.parse({
    content: 'update the repository',
    repoRoot: 'C:\\repo',
    approval: 'interactive',
    operationId: OPERATION_ID,
  });
  assert.equal(parsed.operationId, OPERATION_ID);
  assert.throws(() => ChatRepoAgentStreamRequestSchema.parse({ content: 'missing ownership' }));
});

test('active repo-agent responses expose only actionable nonterminal states', () => {
  assert.deepEqual(ActiveChatRepoAgentResponseSchema.parse({
    runId: OPERATION_ID,
    status: 'running',
    approvalMode: 'auto',
  }), { runId: OPERATION_ID, status: 'running', approvalMode: 'auto' });
  assert.throws(() => ActiveChatRepoAgentResponseSchema.parse({
    runId: OPERATION_ID,
    status: 'approval_timeout',
  }));
});

test('operation status and Stop contracts validate ownership without exposing it in status', () => {
  assert.deepEqual(StopChatOperationRequestSchema.parse({ operationId: OPERATION_ID }), {
    operationId: OPERATION_ID,
  });
  assert.deepEqual(StopChatOperationResponseSchema.parse({ ok: true, operationKind: 'repo-search' }), {
    ok: true,
    operationKind: 'repo-search',
  });
  const status = ChatOperationStatusResponseSchema.parse({
    operationKind: 'repo-agent',
    startedAtUtc: '2026-08-31T12:00:00.000Z',
  });
  assert.equal('operationId' in status, false);
});

test('approval mode is one shared enum', () => {
  assert.deepEqual(ApprovalModeSchema.options, ['interactive', 'auto', 'off']);
  assert.throws(() => ApprovalModeSchema.parse('manual'));
});

test('chat repo-agent stream requests require an approval mode', () => {
  assert.throws(() => ChatRepoAgentStreamRequestSchema.parse({
    content: 'update the repository',
    repoRoot: 'C:\repo',
    operationId: OPERATION_ID,
  }));
  assert.equal(
    ChatRepoAgentStreamRequestSchema.parse({ content: 'x', approval: 'off', operationId: OPERATION_ID }).approval,
    'off',
  );
});

test('active repo-agent responses report the live approval mode', () => {
  const running = ActiveChatRepoAgentResponseSchema.parse({
    runId: OPERATION_ID, status: 'running', approvalMode: 'auto',
  });
  assert.equal(running.approvalMode, 'auto');
  assert.throws(() => ActiveChatRepoAgentResponseSchema.parse({ runId: OPERATION_ID, status: 'running' }));
  const parked = ActiveChatRepoAgentResponseSchema.parse({
    runId: OPERATION_ID, status: 'approval_required', approvalMode: 'interactive',
    approval: { approvalId: '4f9c1f9a-0000-4000-8000-000000000001', toolName: 'write', command: 'write x', reviewPayload: null },
  });
  assert.equal(parked.approvalMode, 'interactive');
});

test('decision and approval-mode responses carry the server timestamp', () => {
  const decided = ChatRepoAgentDecideResponseSchema.parse({
    ok: true, runId: OPERATION_ID, decidedAtUtc: '2026-09-04T00:00:00.000Z',
  });
  assert.equal(decided.decidedAtUtc, '2026-09-04T00:00:00.000Z');
  assert.throws(() => ChatRepoAgentDecideResponseSchema.parse({ ok: true, runId: OPERATION_ID }));

  assert.deepEqual(ChatRepoAgentApprovalModeRequestSchema.parse({ approval: 'off' }), { approval: 'off' });
  assert.throws(() => ChatRepoAgentApprovalModeRequestSchema.parse({ approval: 'off', extra: 1 }));
  const idle = ChatRepoAgentApprovalModeResponseSchema.parse({
    ok: true, runId: OPERATION_ID, approval: 'off', released: null,
  });
  assert.equal(idle.released, null);
  const released = ChatRepoAgentApprovalModeResponseSchema.parse({
    ok: true, runId: OPERATION_ID, approval: 'off',
    released: { approvalId: '4f9c1f9a-0000-4000-8000-000000000001', decidedAtUtc: '2026-09-04T00:00:00.000Z' },
  });
  assert.equal(released.released?.approvalId, '4f9c1f9a-0000-4000-8000-000000000001');
  assert.throws(() => ChatRepoAgentApprovalModeResponseSchema.parse({ ok: true, runId: OPERATION_ID, approval: 'off' }));
});

test('the approval mode default and error text derive from the shared enum', () => {
  assert.equal(DEFAULT_APPROVAL_MODE, 'auto');
  assert.equal(ApprovalModeSchema.safeParse(DEFAULT_APPROVAL_MODE).success, true);
  assert.equal(APPROVAL_MODE_ERROR, 'approval must be one of: interactive, auto, off.');
});
