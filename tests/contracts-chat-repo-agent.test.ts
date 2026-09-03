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
  }), { runId: OPERATION_ID, status: 'running' });
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
