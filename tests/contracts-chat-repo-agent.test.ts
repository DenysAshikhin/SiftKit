import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ChatSessionOperationKindSchema,
  ChatSessionBusyResponseSchema,
  ChatStreamApprovalSchema,
  PersistedChatMessageSchema,
} from '@siftkit/contracts';

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
  const approval = PersistedChatMessageSchema.parse({
    id: 'm1', role: 'user', kind: 'repo_agent_approval',
    content: 'approved bash: node --test tests/x.test.ts',
    inputTokensEstimate: 0, outputTokensEstimate: 0, thinkingTokens: 0,
    createdAtUtc: new Date().toISOString(),
    approvalDecision: 'approve', approvalToolName: 'bash',
    approvalCommand: 'node --test tests/x.test.ts', approvalReason: null,
  });
  assert.equal(approval.kind, 'repo_agent_approval');
  const legacy = PersistedChatMessageSchema.parse({
    id: 'm2', role: 'user', kind: 'user_text', content: 'hi',
    inputTokensEstimate: 0, outputTokensEstimate: 0, thinkingTokens: 0,
    createdAtUtc: new Date().toISOString(),
  });
  assert.equal(legacy.kind, 'user_text');
});