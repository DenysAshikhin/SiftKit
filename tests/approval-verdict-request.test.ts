import test from 'node:test';
import assert from 'node:assert/strict';
import { requestApprovalVerdict } from '../src/repo-search/planner-protocol.js';
import { buildApprovalVerdictJsonSchema } from '../src/providers/structured-output-schema.js';
import { ApprovalModeSchema } from '../src/repo-search/engine/approval-gate.js';

test('ApprovalModeSchema accepts the three modes and rejects booleans', () => {
  assert.equal(ApprovalModeSchema.parse('interactive'), 'interactive');
  assert.equal(ApprovalModeSchema.parse('auto'), 'auto');
  assert.equal(ApprovalModeSchema.parse('off'), 'off');
  assert.equal(ApprovalModeSchema.safeParse(false).success, false);
  assert.equal(ApprovalModeSchema.safeParse(true).success, false);
});

test('buildApprovalVerdictJsonSchema constrains verdict to approve|deny|unsure', () => {
  assert.deepEqual(buildApprovalVerdictJsonSchema(), {
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
  const response = await requestApprovalVerdict({
    baseUrl: 'http://127.0.0.1:1',
    model: 'mock-model',
    messages: [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'question' },
    ],
    timeoutMs: 5000,
    mockResponses: ['{"verdict":"approve","reason":"ok"}'],
    mockResponseIndex: 0,
  });
  assert.equal(response.text, '{"verdict":"approve","reason":"ok"}');
  assert.equal(response.nextMockResponseIndex, 1);
});