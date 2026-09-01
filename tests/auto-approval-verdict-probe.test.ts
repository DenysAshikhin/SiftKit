import assert from 'node:assert/strict';
import { existsSync, rmSync } from 'node:fs';
import http from 'node:http';
import { join } from 'node:path';
import test from 'node:test';
import {
  AutoApprovalReplayPayloadSchema,
  AutoApprovalVerdictProbe,
  ConfiguredApprovalVerdictModelClient,
  type ApprovalVerdictModelClient,
} from '../src/repo-search/approval-verdict-probe.js';
import {
  APPROVAL_PAYLOAD_LOCATOR_LINE,
  APPROVAL_REVIEW_REQUEST_MARKER,
} from '../src/repo-search/approval-review-policy.js';
import { buildApprovalVerdictQuestion } from '../src/repo-search/engine/llm-approval-gate.js';
import type { ChatMessage, PlannerActionResponse } from '../src/repo-search/planner-protocol.js';
import { asObject, getAddressInfo } from './helpers/dashboard-http.js';
import { createManagedTempDir } from './helpers/temp-dirs.js';
import { mockSiftConfig } from './helpers/mock-config.js';
import { sendChatCompletionSse } from './helpers/streaming-client.js';
import { parseJsonValueText } from '../src/lib/json.js';
import type { LlamaCppToolDefinition } from '../src/llm-protocol/types.js';

const messages: ChatMessage[] = [
  { role: 'system', content: 'Work only inside C:\\repo.' },
  { role: 'user', content: 'Add one parser regression test.' },
  { role: 'assistant', content: 'I inspected the parser tests.' },
  { role: 'user', content: 'Continue without touching files outside the repository.' },
];

const reviewPayload = JSON.stringify({ toolName: 'edit', args: { path: 'src/cleanup.ts', edits: [{
    oldText: 'cleanCache();',
    newText: 'fs.rmSync(repoRoot, { recursive: true, force: true });',
  }] } }, null, 2);

const pendingMessage: ChatMessage = {
  role: 'assistant',
  content: '',
  tool_calls: [{
    id: 't2_c0',
    type: 'function',
    function: {
      name: 'edit',
      arguments: JSON.stringify({
        path: 'src/cleanup.ts',
        edits: [{
          oldText: 'cleanCache();',
          newText: 'fs.rmSync(repoRoot, { recursive: true, force: true });',
        }],
      }),
    },
  }],
};

const action = {
  turn: 2,
  toolName: 'edit',
  command: 'edit path="src/cleanup.ts" edits=1',
  reviewPayload,
  pendingMessages: [pendingMessage],
};

const replayTools = [{
  type: 'function',
  function: {
    name: 'persisted_review_tool',
    description: 'The exact tool schema persisted with the original request.',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path'],
      additionalProperties: false,
    },
  },
}] satisfies readonly LlamaCppToolDefinition[];

class RecordingVerdictModelClient implements ApprovalVerdictModelClient {
  readonly requests: ChatMessage[][] = [];

  constructor(private readonly responseText: string) {}

  request(
    requestMessages: ChatMessage[],
    pendingMessages: ChatMessage[],
    question: string,
    _tools: readonly LlamaCppToolDefinition[],
  ): Promise<PlannerActionResponse> {
    this.requests.push([...requestMessages, ...pendingMessages, { role: 'user', content: question }]);
    return Promise.resolve({
      text: this.responseText,
      rawText: this.responseText,
      narrationText: this.responseText,
      classification: 'narration',
      thinkingText: '',
      toolCalls: [],
      mockExhausted: false,
      stoppedEarly: false,
    });
  }
}

test('configured verdict replay uses the exact persisted tool schema', async () => {
  let capturedBody = asObject({});
  const server = http.createServer((req, res) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      capturedBody = asObject(parseJsonValueText(body || '{}'));
      sendChatCompletionSse(res, {
        choices: [{ message: { content: '{"verdict":"approve","reason":"safe"}' } }],
      });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const baseUrl = `http://127.0.0.1:${getAddressInfo(server).port}`;
    const config = mockSiftConfig({
      Server: {
        ModelPresets: {
          ActivePresetId: 'default',
          Presets: [{ id: 'default', VisionEnabled: true, Reasoning: 'off', IdleAction: 'unload' }],
        },
      },
    });
    const client = new ConfiguredApprovalVerdictModelClient({
      config,
      baseUrl,
      model: 'mock-model',
      slotId: 0,
      timeoutMs: 5_000,
      thinking: {
        thinkingEnabled: false,
        reasoningContentEnabled: false,
        preserveThinking: false,
      },
    });

    await client.request(messages, [pendingMessage], 'approve?', replayTools);

    assert.deepEqual(capturedBody.tools, replayTools);
    assert.equal(capturedBody.tool_choice, 'none');
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
});

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
    AutoApprovalReplayPayloadSchema.parse({ messages: fullHistory, tools: replayTools, action }),
    { messages: fullHistory, tools: replayTools, action },
  );
  assert.throws(() => AutoApprovalReplayPayloadSchema.parse({ messages: fullHistory, action }));
  assert.throws(() => AutoApprovalReplayPayloadSchema.parse({ messages: [], tools: replayTools, action }));
  assert.throws(() => AutoApprovalReplayPayloadSchema.parse({
    messages,
    tools: replayTools,
    action: { ...action, command: '' },
  }));
  assert.throws(() => AutoApprovalReplayPayloadSchema.parse({
    messages,
    tools: replayTools,
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

  const result = await new AutoApprovalVerdictProbe(client).run({ messages, tools: replayTools, action });

  assert.deepEqual(result.submittedMessages.slice(0, messages.length), messages);
  assert.deepEqual(result.submittedMessages[messages.length], pendingMessage);
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
  ].join('\n')));
  assert.ok(lastContent.includes(APPROVAL_PAYLOAD_LOCATOR_LINE));
  assert.doesNotMatch(lastContent, /independent command reviewer/u);
  assert.doesNotMatch(lastContent, /Decide whether this action should run/u);
  assert.doesNotMatch(lastContent, /fs\.rmSync\(repoRoot/u);
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
      tools: replayTools,
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

  const result = await new AutoApprovalVerdictProbe(client).run({ messages, tools: replayTools, action });

  assert.equal(result.verdict, 'unsure');
  assert.equal(result.reason, 'The write scope is ambiguous.');
});

test('reports a failed verdict after exactly one retry', async () => {
  const client = new RecordingVerdictModelClient('not-json');

  const result = await new AutoApprovalVerdictProbe(client).run({ messages, tools: replayTools, action });

  assert.equal(client.requests.length, 2);
  assert.equal(result.verdict, 'unsure');
  assert.equal(result.reason, 'verdict call failed');
});

test('rejects an approval-exempt read-only action instead of inventing a verdict', async () => {
  const client = new RecordingVerdictModelClient('not-json');

  await assert.rejects(
    () => new AutoApprovalVerdictProbe(client).run({
      messages,
      tools: replayTools,
      action: {
        turn: 2,
        toolName: 'read',
        command: 'read tests/parser.test.ts',
        reviewPayload: null,
      },
    }),
    /read is an approval-exempt read-only tool/u,
  );
  assert.equal(client.requests.length, 0);
});
