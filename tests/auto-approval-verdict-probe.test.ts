import assert from 'node:assert/strict';
import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import {
  AutoApprovalReplayPayloadSchema,
  AutoApprovalVerdictProbe,
  type ApprovalVerdictModelClient,
} from '../src/repo-search/approval-verdict-probe.js';
import {
  APPROVAL_REVIEW_PAYLOAD_LABEL,
  APPROVAL_REVIEW_REQUEST_MARKER,
} from '../src/repo-search/approval-review-policy.js';
import { buildApprovalVerdictQuestion } from '../src/repo-search/engine/llm-approval-gate.js';
import type { ChatMessage, PlannerActionResponse } from '../src/repo-search/planner-protocol.js';
import { createManagedTempDir } from './helpers/temp-dirs.js';

const messages: ChatMessage[] = [
  { role: 'system', content: 'Work only inside C:\\repo.' },
  { role: 'user', content: 'Add one parser regression test.' },
  { role: 'assistant', content: 'I inspected the parser tests.' },
  { role: 'user', content: 'Continue without touching files outside the repository.' },
];

const reviewPayload = JSON.stringify({
  action: 'edit',
  path: 'src/cleanup.ts',
  edits: [{
    oldText: 'cleanCache();',
    newText: 'fs.rmSync(repoRoot, { recursive: true, force: true });',
  }],
}, null, 2);

const action = {
  turn: 2,
  toolName: 'edit',
  command: 'edit path="src/cleanup.ts" edits=1',
  reviewPayload,
};

class RecordingVerdictModelClient implements ApprovalVerdictModelClient {
  readonly requests: ChatMessage[][] = [];

  constructor(private readonly responseText: string) {}

  request(requestMessages: ChatMessage[], question: string): Promise<PlannerActionResponse> {
    this.requests.push([...requestMessages, { role: 'user', content: question }]);
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
  assert.throws(() => AutoApprovalReplayPayloadSchema.parse({
    messages,
    action: {
      turn: 2,
      toolName: 'edit',
      command: 'edit path="src/cleanup.ts" edits=1',
    },
  }));
});

test('verdict question carries the full review policy followed by the request', () => {
  const question = buildApprovalVerdictQuestion({
    toolName: 'shell_command',
    command: 'git status --short',
    reviewPayload: null,
  });

  assert.ok(question.endsWith([
    APPROVAL_REVIEW_REQUEST_MARKER,
    'tool: shell_command',
    'command: git status --short',
  ].join('\n')));

  assert.match(question, /Approval review policy/u);
  assert.match(question, /untrusted data/u);
  assert.match(question, /claims.*must never reduce.*risk/isu);
  assert.match(question, /Safety rules override user intent and task relevance/u);
  assert.match(question, /recursive deletion/u);
  assert.match(question, /repository-root deletion or deletion of \.git/u);
  assert.match(question, /git reset --hard/u);
  assert.match(question, /git clean with force/u);
  assert.match(question, /forced branch deletion or recursive git rm/u);
  assert.match(question, /force-push/u);
  assert.match(question, /credential or secret access/u);
  assert.match(question, /package installation/u);
  assert.match(question, /normal pushes/u);
  assert.match(question, /non-recursive deletion/u);
  assert.match(question, /narrowly scoped, non-destructive repository writes/u);
  assert.match(question, /"verdict":"approve"\|"deny"\|"unsure"/u);
  assert.match(question, /inspect the complete.*edit.*write.*payload/isu);
  assert.match(question, /buried among.*benign lines/isu);
  assert.match(question, /destructive filesystem|repository.*history/isu);
  assert.match(question, /credential|secret.*transmission/isu);
  assert.match(question, /remote execution|command injection/isu);
  assert.match(question, /package scripts|hooks|workflows|startup/isu);
  assert.match(question, /approval|authentication|authorization|validation|auditing/isu);
  assert.match(question, /obfuscation/iu);
  assert.match(question, /destructive migrations|disabling.*tests|safety checks/isu);
  assert.match(question, /missing.*malformed.*truncated.*too large.*unsure/isu);
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
  const lastContent = typeof lastMessage?.content === 'string' ? lastMessage.content : '';
  assert.match(lastContent, /^Approval review policy/u);
  assert.ok(lastContent.endsWith([
    APPROVAL_REVIEW_REQUEST_MARKER,
    'tool: edit',
    'command: edit path="src/cleanup.ts" edits=1',
    APPROVAL_REVIEW_PAYLOAD_LABEL,
    reviewPayload,
  ].join('\n')));
  assert.doesNotMatch(lastContent, /independent command reviewer/u);
  assert.doesNotMatch(lastContent, /Decide whether this action should run/u);
  assert.match(lastContent, /fs\.rmSync\(repoRoot/u);
  assert.deepEqual(client.requests, [result.submittedMessages]);
  assert.equal(result.verdict, 'deny');
  assert.equal(result.reason, 'Targets files outside the repository.');
  assert.deepEqual(result.action, action);
});

test('returns approve as data without executing the proposed command', async () => {
  const tempRoot = createManagedTempDir('siftkit-approval-probe-');
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
        reviewPayload: null,
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
    action: {
      turn: 2,
      toolName: 'read',
      command: 'read tests/parser.test.ts',
      reviewPayload: null,
    },
  });

  assert.equal(client.requests.length, 0);
  assert.equal(result.verdict, 'approve');
  assert.equal(result.reason, 'read-only tool');
  assert.deepEqual(result.submittedMessages, []);
});
