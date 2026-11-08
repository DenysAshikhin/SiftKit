import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  buildApprovalVerdictMessages,
  requestApprovalVerdict,
} from '../src/repo-search/planner-protocol.ts';
import { TaskLoop } from '../src/repo-search/engine/task-loop.ts';
import { ApprovalVerdictSchema } from '../src/repo-search/approval-verdict.ts';
import { APPROVER_SYSTEM_PROMPT, buildApprovalReviewRequest } from '../src/repo-search/approval-review-policy.ts';
import { buildPlannerJsonSchema } from '../src/planner-protocol/json-schema.ts';
import { ApprovalModeSchema } from '@siftkit/contracts';
import { RepoSearchApprovalRequestSchema } from '../src/repo-search/engine/approval-gate.ts';
import { createEmptyPresetSystemContext } from './helpers/empty-preset-system-context.ts';
import { mockOfflineSiftConfig } from './helpers/mock-config.ts';
import { createManagedTempDir } from './helpers/temp-dirs.ts';
import { DEAD_BASE_URL } from './helpers/dead-endpoints.ts';
import { RepoSearchRuntimeProfile } from '../src/repo-search/engine/runtime-profile.ts';
import { resolveRepoSearchPlannerToolDefinitions } from '../src/repo-search/planner-protocol.ts';
import { baseVerdictOptions } from './helpers/approval-verdict-fixture.ts';
import { TEST_THROUGHPUT_AUDIT_OPERATION } from './_test-helpers.ts';

// Mock-mode requests never reach a provider, but the request layer still derives its
// model, samplers and budgets from a real config, so every call supplies one.
const MOCK_CONFIG = mockOfflineSiftConfig();

const APPROVE_MOCK = '{"verdict":"approve","reason":"ok"}';

function verdictOptions() {
  return {
    config: MOCK_CONFIG,
    baseUrl: DEAD_BASE_URL,
    model: 'mock-model',
    throughputAudit: TEST_THROUGHPUT_AUDIT_OPERATION,
    ...baseVerdictOptions(),
    timeoutMs: 5000,
    mockResponses: [{ content: APPROVE_MOCK }],
    mockResponseIndex: 0,
  };
}

test('ApprovalModeSchema accepts the three modes and rejects booleans', () => {
  assert.equal(ApprovalModeSchema.parse('interactive'), 'interactive');
  assert.equal(ApprovalModeSchema.parse('auto'), 'auto');
  assert.equal(ApprovalModeSchema.parse('off'), 'off');
  assert.equal(ApprovalModeSchema.safeParse(false).success, false);
  assert.equal(ApprovalModeSchema.safeParse(true).success, false);
});

test('approval submissions discard reviewer payloads', () => {
  assert.deepEqual(
    RepoSearchApprovalRequestSchema.parse({
      requestId: 'request-1',
      approvalId: 'approval-1',
      decision: 'approve',
      reviewPayload: 'must-not-survive',
    }),
    {
      requestId: 'request-1',
      approvalId: 'approval-1',
      decision: 'approve',
    },
  );
});

test('the approval verdict JSON schema constrains verdict to approve|deny|unsure', () => {
  assert.deepEqual(buildPlannerJsonSchema(ApprovalVerdictSchema), {
    type: 'object',
    properties: {
      verdict: { type: 'string', enum: ['approve', 'deny', 'unsure'] },
      reason: { type: 'string' },
    },
    required: ['verdict', 'reason'],
    additionalProperties: false,
  });
});

test('requestApprovalVerdict consumes one mock response and advances the index', async () => {
  const response = await requestApprovalVerdict(verdictOptions());
  assert.equal(response.text, APPROVE_MOCK);
  assert.equal(response.nextMockResponseIndex, 1);
});

test('a verdict request is the approver system prompt and one user message holding the whole proposed call', () => {
  const request = buildApprovalReviewRequest({ toolName: 'edit', command: 'edit path="a.ts" edits=1 sha="0"', reviewPayload: '{"toolName":"edit"}' });
  assert.deepEqual(buildApprovalVerdictMessages(request), [
    { role: 'system', content: APPROVER_SYSTEM_PROMPT },
    { role: 'user', content: request },
  ]);
  assert.equal(request, '<APPROVAL_REVIEW_REQUEST>\ntool: edit\ncommand: edit path="a.ts" edits=1 sha="0"\npayload:\n{"toolName":"edit"}');
  assert.match(APPROVER_SYSTEM_PROMPT, /^You review one proposed tool call for a coding agent\. You are not that agent/u);
});

test('a run or git call reaches the approver with no payload section', () => {
  assert.equal(
    buildApprovalReviewRequest({ toolName: 'run', command: 'run command="npm test"', reviewPayload: null }),
    '<APPROVAL_REVIEW_REQUEST>\ntool: run\ncommand: run command="npm test"',
  );
});

test('a task loop refuses an approval verdict before any planner request', async () => {
  const tempRoot = createManagedTempDir('siftkit-verdict-no-planner-');
  try {
    const loop = new TaskLoop(
      { id: 'task-1', question: 'q' },
      {
        throughputAudit: TEST_THROUGHPUT_AUDIT_OPERATION,
        plannerToolDefinitions: resolveRepoSearchPlannerToolDefinitions(),
        repoRoot: tempRoot,
        systemContext: createEmptyPresetSystemContext(),
        config: MOCK_CONFIG,
        model: 'mock-model',
        baseUrl: DEAD_BASE_URL,
        runtimeProfile: new RepoSearchRuntimeProfile('repo-search'),
        maxTurns: 1,
        minToolCallsBeforeFinish: 0,
        mockResponses: [],
        mockCommandResults: {},
      },
    );
    await assert.rejects(
      loop.requestApprovalVerdict('approve?'),
      /before any planner request; there are no tool definitions to review against/u,
    );
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});
