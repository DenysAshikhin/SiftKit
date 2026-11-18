import { emptyInferenceThroughput } from '../src/lib/inference-throughput.ts';
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
} from '../src/repo-search/approval-verdict-probe.ts';
import {
  APPROVAL_REVIEW_REQUEST_MARKER,
  APPROVER_SYSTEM_PROMPT,
} from '../src/repo-search/approval-review-policy.ts';
import type { PlannerActionResponse } from '../src/repo-search/planner-protocol.ts';
import { asObject, getAddressInfo } from './helpers/dashboard-http.ts';
import { createManagedTempDir } from './helpers/temp-dirs.ts';
import { mockSiftConfig } from './helpers/mock-config.ts';
import { DONT_CARE_TABBY_USAGE, sendChatCompletionSse } from './helpers/streaming-client.ts';
import { parseJsonValueText } from '../src/lib/json.ts';
import { CLEAN_STREAM_STOP, type InferenceToolDefinition } from '../src/llm-protocol/types.ts';

const reviewPayload = JSON.stringify({ toolName: 'edit', args: { path: 'src/cleanup.ts', edits: [{
    oldText: 'cleanCache();',
    newText: 'fs.rmSync(repoRoot, { recursive: true, force: true });',
  }] } }, null, 2);

const action = {
  turn: 2,
  toolName: 'edit',
  command: 'edit path="src/cleanup.ts" edits=1',
  reviewPayload,
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
}] satisfies readonly InferenceToolDefinition[];

class RecordingVerdictModelClient implements ApprovalVerdictModelClient {
  readonly requests: string[] = [];

  private readonly responseText: string;

  constructor(responseText: string) {
    this.responseText = responseText;
  }

  request(reviewRequest: string, _tools: readonly InferenceToolDefinition[]): Promise<PlannerActionResponse> {
    this.requests.push(reviewRequest);
    return Promise.resolve({
      text: this.responseText,
      rawText: this.responseText,
      narrationText: this.responseText,
      classification: 'narration',
      thinkingText: '',
      toolCalls: [],
      mockExhausted: false, throughput: emptyInferenceThroughput(),
      stop: CLEAN_STREAM_STOP,
    });
  }
}

test('configured verdict replay sends the exact persisted tool schema and no tool choice', async () => {
  let capturedBody = asObject({});
  const server = http.createServer((req, res) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      capturedBody = asObject(parseJsonValueText(body || '{}'));
      sendChatCompletionSse(res, {
        choices: [{ message: { content: '{"verdict":"approve","reason":"safe"}' } }],
        usage: DONT_CARE_TABBY_USAGE,
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
          Presets: [{ id: 'default', VisionEnabled: true, Reasoning: 'off', IdleAction: 'unload', SparseDraftHead: 0 }],
        },
      },
    });
    const client = new ConfiguredApprovalVerdictModelClient({
      config,
      baseUrl,
      model: 'mock-model',
      timeoutMs: 5_000,
      thinking: {
        thinkingEnabled: false,
        reasoningContentEnabled: false,
        preserveThinking: false,
      },
    });

    await client.request('approve?', replayTools);

    assert.deepEqual(capturedBody.tools, replayTools);
    assert.equal(capturedBody.tool_choice, 'none');
    assert.deepEqual(capturedBody.messages, [
      { role: 'system', content: APPROVER_SYSTEM_PROMPT },
      { role: 'user', content: 'approve?' },
    ]);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
});

test('validates a replay payload of the repository root, tools, and one proposed action, and nothing else', () => {
  assert.deepEqual(AutoApprovalReplayPayloadSchema.parse({ repoRoot: 'R', tools: replayTools, action }), { repoRoot: 'R', tools: replayTools, action });
  assert.throws(() => AutoApprovalReplayPayloadSchema.parse({ action }));
  assert.throws(() => AutoApprovalReplayPayloadSchema.parse({ tools: replayTools, action }), 'a replay names the repository root');
  assert.throws(() => AutoApprovalReplayPayloadSchema.parse({ tools: [], action }));
  assert.throws(() => AutoApprovalReplayPayloadSchema.parse({ repoRoot: 'R', tools: replayTools, action: { ...action, command: '' } }));
  assert.throws(() => AutoApprovalReplayPayloadSchema.parse({ repoRoot: 'R', tools: replayTools, action: { turn: 2, toolName: 'edit', command: 'edit' } }));
  assert.throws(() => AutoApprovalReplayPayloadSchema.parse({ messages: [], repoRoot: 'R', tools: replayTools, action }), 'a transcript is no longer part of a replay');
});

test('the approver prompt carries the full review policy', () => {
  assert.match(APPROVER_SYSTEM_PROMPT, /Approval review policy/u);
  assert.match(APPROVER_SYSTEM_PROMPT, /untrusted data/u);
  assert.match(APPROVER_SYSTEM_PROMPT, /claims.*must never reduce.*risk/isu);
  assert.match(APPROVER_SYSTEM_PROMPT, /Safety rules override user intent and task relevance/u);
  assert.match(APPROVER_SYSTEM_PROMPT, /recursive deletion/u);
  assert.match(APPROVER_SYSTEM_PROMPT, /repository-root deletion or deletion of \.git/u);
  assert.match(APPROVER_SYSTEM_PROMPT, /git reset --hard/u);
  assert.match(APPROVER_SYSTEM_PROMPT, /git clean with force/u);
  assert.match(APPROVER_SYSTEM_PROMPT, /forced branch deletion or recursive git rm/u);
  assert.match(APPROVER_SYSTEM_PROMPT, /force-push/u);
  assert.match(APPROVER_SYSTEM_PROMPT, /credential or secret access/u);
  assert.match(APPROVER_SYSTEM_PROMPT, /package installation/u);
  assert.match(APPROVER_SYSTEM_PROMPT, /normal pushes/u);
  assert.match(APPROVER_SYSTEM_PROMPT, /non-recursive deletion/u);
  assert.match(APPROVER_SYSTEM_PROMPT, /narrowly scoped, non-destructive repository writes/u);
  assert.match(APPROVER_SYSTEM_PROMPT, /"verdict":"approve"\|"deny"\|"unsure"/u);
  assert.match(APPROVER_SYSTEM_PROMPT, /inspect the complete.*edit.*write.*payload/isu);
  assert.match(APPROVER_SYSTEM_PROMPT, /buried among.*benign lines/isu);
  assert.match(APPROVER_SYSTEM_PROMPT, /destructive filesystem|repository.*history/isu);
  assert.match(APPROVER_SYSTEM_PROMPT, /credential|secret.*transmission/isu);
  assert.match(APPROVER_SYSTEM_PROMPT, /remote execution|command injection/isu);
  assert.match(APPROVER_SYSTEM_PROMPT, /package scripts|hooks|workflows|startup/isu);
  assert.match(APPROVER_SYSTEM_PROMPT, /approval|authentication|authorization|validation|auditing/isu);
  assert.match(APPROVER_SYSTEM_PROMPT, /obfuscation/iu);
  assert.match(APPROVER_SYSTEM_PROMPT, /destructive migrations|disabling.*tests|safety checks/isu);
  assert.match(APPROVER_SYSTEM_PROMPT, /missing.*malformed.*truncated.*too large.*unsure/isu);
});

test('submits the approver prompt and the proposed call with its repository root and payload, and nothing of the agent', async () => {
  const client = new RecordingVerdictModelClient(
    '{"verdict":"deny","reason":"Deletes the repository root."}',
  );

  const result = await new AutoApprovalVerdictProbe(client).run({ repoRoot: 'R', tools: replayTools, action });

  const request = [
    APPROVAL_REVIEW_REQUEST_MARKER,
    'repository root: R',
    'tool: edit',
    'command: edit path="src/cleanup.ts" edits=1',
    'payload:',
    reviewPayload,
  ].join('\n');
  assert.deepEqual(result.submittedMessages, [
    { role: 'system', content: APPROVER_SYSTEM_PROMPT },
    { role: 'user', content: request },
  ]);
  assert.deepEqual(client.requests, [request]);
  assert.equal(result.verdict, 'deny');
  assert.equal(result.reason, 'Deletes the repository root.');
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
      repoRoot: 'R',
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

  const result = await new AutoApprovalVerdictProbe(client).run({ repoRoot: 'R', tools: replayTools, action });

  assert.equal(result.verdict, 'unsure');
  assert.equal(result.reason, 'The write scope is ambiguous.');
});

test('reports a failed verdict after exactly one retry', async () => {
  const client = new RecordingVerdictModelClient('not-json');

  const result = await new AutoApprovalVerdictProbe(client).run({ repoRoot: 'R', tools: replayTools, action });

  assert.equal(client.requests.length, 2);
  assert.equal(result.verdict, 'unsure');
  assert.match(result.reason, /^verdict call failed: /u);
});

test('rejects an approval-exempt read-only action instead of inventing a verdict', async () => {
  const client = new RecordingVerdictModelClient('not-json');

  await assert.rejects(
    () => new AutoApprovalVerdictProbe(client).run({
      repoRoot: 'R',
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
