import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  AutoApprovalReplayPayloadSchema,
  AutoApprovalVerdictProbe,
  type ApprovalVerdictModelClient,
} from '../src/repo-search/approval-verdict-probe.js';
import { APPROVAL_REVIEW_REQUEST_MARKER } from '../src/repo-search/approval-review-policy.js';
import { buildApprovalVerdictQuestion } from '../src/repo-search/engine/llm-approval-gate.js';
import type { ChatMessage, PlannerActionResponse } from '../src/repo-search/planner-protocol.js';

const messages: ChatMessage[] = [
  { role: 'system', content: 'Work only inside C:\\repo.' },
  { role: 'user', content: 'Add one parser regression test.' },
  { role: 'assistant', content: 'I inspected the parser tests.' },
  { role: 'user', content: 'Continue without touching files outside the repository.' },
];

const action = {
  turn: 2,
  toolName: 'shell_command',
  command: 'Remove-Item -Recurse -Force C:\\Users\\denys\\Documents',
};

class RecordingVerdictModelClient implements ApprovalVerdictModelClient {
  readonly requests: ChatMessage[][] = [];

  constructor(private readonly responseText: string) {}

  request(requestMessages: ChatMessage[]): Promise<PlannerActionResponse> {
    this.requests.push(requestMessages);
    return Promise.resolve({
      text: this.responseText,
      thinkingText: '',
      mockExhausted: false,
    });
  }
}

test('validates a complete pre-action replay payload', () => {
  const fullHistory = [
    ...messages,
    {
      role: 'assistant',
      tool_calls: [{
        id: 'call_read',
        type: 'function',
        function: { name: 'read', arguments: '{"path":"tests/parser.test.ts"}' },
      }],
    },
    { role: 'tool', tool_call_id: 'call_read', content: 'file contents' },
  ];

  assert.deepEqual(
    AutoApprovalReplayPayloadSchema.parse({ messages: fullHistory, action }),
    { messages: fullHistory, action },
  );
  assert.throws(() => AutoApprovalReplayPayloadSchema.parse({ messages: [], action }));
  assert.throws(() => AutoApprovalReplayPayloadSchema.parse({
    messages,
    action: { ...action, command: '' },
  }));
});

test('builds a data-only approval review request', () => {
  assert.equal(
    buildApprovalVerdictQuestion({
      toolName: 'shell_command',
      command: 'git status --short',
    }),
    [
      APPROVAL_REVIEW_REQUEST_MARKER,
      'tool: shell_command',
      'command: git status --short',
    ].join('\n'),
  );
});

test('submits existing history followed by one transient approval question', async () => {
  const client = new RecordingVerdictModelClient(
    '{"verdict":"deny","reason":"Targets files outside the repository."}',
  );

  const result = await new AutoApprovalVerdictProbe(client).run({ messages, action });

  assert.deepEqual(result.submittedMessages.slice(0, -1), messages);
  assert.deepEqual(messages, [
    { role: 'system', content: 'Work only inside C:\\repo.' },
    { role: 'user', content: 'Add one parser regression test.' },
    { role: 'assistant', content: 'I inspected the parser tests.' },
    { role: 'user', content: 'Continue without touching files outside the repository.' },
  ]);
  const lastMessage = result.submittedMessages.at(-1);
  assert.equal(lastMessage?.role, 'user');
  assert.equal(
    lastMessage?.content,
    [
      APPROVAL_REVIEW_REQUEST_MARKER,
      'tool: shell_command',
      'command: Remove-Item -Recurse -Force C:\\Users\\denys\\Documents',
    ].join('\n'),
  );
  assert.doesNotMatch(lastMessage?.content ?? '', /independent command reviewer/u);
  assert.doesNotMatch(lastMessage?.content ?? '', /Decide whether this action should run/u);
  assert.deepEqual(client.requests, [result.submittedMessages]);
  assert.equal(result.verdict, 'deny');
  assert.equal(result.reason, 'Targets files outside the repository.');
  assert.deepEqual(result.action, action);
});

test('returns approve as data without executing the proposed command', async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'siftkit-approval-probe-'));
  const markerPath = join(tempRoot, 'executed.txt');
  const client = new RecordingVerdictModelClient(
    '{"verdict":"approve","reason":"The command appears scoped."}',
  );

  try {
    const result = await new AutoApprovalVerdictProbe(client).run({
      messages,
      action: {
        turn: 2,
        toolName: 'shell_command',
        command: `Set-Content -LiteralPath "${markerPath}" -Value executed`,
      },
    });

    assert.equal(result.verdict, 'approve');
    assert.equal(result.reason, 'The command appears scoped.');
    assert.equal(existsSync(markerPath), false);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('returns unsure without waiting for a human gate', async () => {
  const client = new RecordingVerdictModelClient(
    '{"verdict":"unsure","reason":"The write scope is ambiguous."}',
  );

  const result = await new AutoApprovalVerdictProbe(client).run({ messages, action });

  assert.equal(result.verdict, 'unsure');
  assert.equal(result.reason, 'The write scope is ambiguous.');
});

test('reports a failed verdict after exactly one retry', async () => {
  const client = new RecordingVerdictModelClient('not-json');

  const result = await new AutoApprovalVerdictProbe(client).run({ messages, action });

  assert.equal(client.requests.length, 2);
  assert.equal(result.verdict, 'unsure');
  assert.equal(result.reason, 'verdict call failed');
});

test('preserves the production read-only fast path without a model call', async () => {
  const client = new RecordingVerdictModelClient('not-json');

  const result = await new AutoApprovalVerdictProbe(client).run({
    messages,
    action: { turn: 2, toolName: 'read', command: 'read tests/parser.test.ts' },
  });

  assert.equal(client.requests.length, 0);
  assert.equal(result.verdict, 'approve');
  assert.equal(result.reason, 'read-only tool');
  assert.deepEqual(result.submittedMessages, []);
});
