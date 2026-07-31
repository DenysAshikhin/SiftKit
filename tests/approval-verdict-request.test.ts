import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  captureExecutingPlannerRequest,
  requestApprovalVerdict,
  serializeProtocolMessages,
  type ChatMessage,
  type PlannerThinkingFlags,
} from '../src/repo-search/planner-protocol.js';
import { TaskLoop } from '../src/repo-search/engine/task-loop.js';
import { buildApprovalVerdictJsonSchema } from '../src/providers/structured-output-schema.js';
import {
  ApprovalModeSchema,
  RepoSearchApprovalRequestSchema,
} from '../src/repo-search/engine/approval-gate.js';
import { createEmptyPresetSystemContext } from './helpers/empty-preset-system-context.js';

const transcript: ChatMessage[] = [
  { role: 'system', content: 'sys' },
  { role: 'user', content: 'task' },
  { role: 'assistant', content: 'analysis', reasoning_content: 'thinking-1' },
];

function captureExecuting(messages: ChatMessage[], flags: PlannerThinkingFlags = {
  thinkingEnabled: true,
  reasoningContentEnabled: true,
  preserveThinking: true,
}) {
  return captureExecutingPlannerRequest(
    serializeProtocolMessages(messages, flags.reasoningContentEnabled),
    flags,
  );
}

const APPROVE_MOCK = '{"verdict":"approve","reason":"ok"}';

function verdictOptions(transcriptMessages: ChatMessage[], executing: ReturnType<typeof captureExecuting>) {
  return {
    baseUrl: 'http://127.0.0.1:1',
    model: 'mock-model',
    transcriptMessages,
    question: 'approve?',
    executing,
    timeoutMs: 5000,
    mockResponses: [APPROVE_MOCK],
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
  const response = await requestApprovalVerdict(verdictOptions(transcript, captureExecuting(transcript)));
  assert.equal(response.text, APPROVE_MOCK);
  assert.equal(response.nextMockResponseIndex, 1);
});

test('verdict accepts a transcript that extends the executing planner request', async () => {
  const grown: ChatMessage[] = [...transcript, { role: 'assistant', content: 'follow-up' }];
  const response = await requestApprovalVerdict(verdictOptions(grown, captureExecuting(transcript)));
  assert.equal(response.text, APPROVE_MOCK);
});

test('verdict fails loud when a transcript message diverges from the executing planner request', async () => {
  const rewritten = transcript.map((message, index) => (
    index === 1 ? { ...message, content: 'rewritten task' } : message
  ));
  await assert.rejects(
    requestApprovalVerdict(verdictOptions(rewritten, captureExecuting(transcript))),
    /diverged[\s\S]*message 1/u,
  );
});

test('verdict fails loud when the transcript is shorter than the executing planner request', async () => {
  await assert.rejects(
    requestApprovalVerdict(verdictOptions(transcript.slice(0, 2), captureExecuting(transcript))),
    /diverged/u,
  );
});

test('verdict serializes the transcript with the executing request flags', async () => {
  // Captured with reasoning content disabled: the prefix has reasoning_content
  // stripped, and the fresh verdict serialization must strip it identically.
  const executing = captureExecuting(transcript, {
    thinkingEnabled: false,
    reasoningContentEnabled: false,
    preserveThinking: false,
  });
  const response = await requestApprovalVerdict(verdictOptions(transcript, executing));
  assert.equal(response.text, APPROVE_MOCK);
});

test('a task loop refuses an approval verdict before any planner request', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'siftkit-verdict-no-planner-'));
  try {
    const loop = new TaskLoop(
      { id: 'task-1', question: 'q', signals: [] },
      {
        repoRoot: tempRoot,
        systemContext: createEmptyPresetSystemContext(),
        model: 'mock-model',
        baseUrl: 'http://127.0.0.1:1',
        maxTurns: 1,
        minToolCallsBeforeFinish: 0,
        mockResponses: [],
        mockCommandResults: {},
      },
    );
    await assert.rejects(
      loop.requestApprovalVerdict('approve?'),
      /before any planner request/u,
    );
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});
