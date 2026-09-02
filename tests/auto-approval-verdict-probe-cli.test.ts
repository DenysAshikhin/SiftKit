import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import {
  AutoApprovalProbeCliOutputSchema,
  runAutoApprovalVerdictProbeCli,
} from '../src/cli/run-auto-approval-probe.js';
import { parseJsonText } from '../src/lib/json.js';
import { z } from '../src/lib/zod.js';
import { ReplayMessageSchema } from '../src/repo-search/approval-verdict-probe.js';
import { LlamaCppToolDefinitionsSchema } from '../src/llm-protocol/types.js';
import { makeCaptureStream, withTestEnvAndServer } from './_test-helpers.js';

const ApprovalRequestSchema = z.object({
  messages: z.array(ReplayMessageSchema),
  tools: LlamaCppToolDefinitionsSchema,
  tool_choice: z.literal('none'),
});

const replayTools = [{
  type: 'function',
  function: {
    name: 'persisted_review_tool',
    description: 'Persisted schema from the executing request.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
  },
}] as const;

test('rejects missing --payload without contacting a model', async () => {
  const stdout = makeCaptureStream();
  const stderr = makeCaptureStream();

  const code = await runAutoApprovalVerdictProbeCli({
    argv: [],
    stdout: stdout.stream,
    stderr: stderr.stream,
  });

  assert.equal(code, 1);
  assert.equal(stdout.read(), '');
  assert.match(stderr.read(), /Usage: npm run probe:auto-approval/u);
});

test('reports a missing payload file on stderr', async () => {
  const stdout = makeCaptureStream();
  const stderr = makeCaptureStream();

  const code = await runAutoApprovalVerdictProbeCli({
    argv: ['--payload', 'missing-replay.json'],
    stdout: stdout.stream,
    stderr: stderr.stream,
  });

  assert.equal(code, 1);
  assert.equal(stdout.read(), '');
  assert.match(stderr.read(), /missing-replay\.json/u);
});

test('rejects invalid JSON before making an approval request', async () => {
  await withTestEnvAndServer(async ({ tempRoot, stub }) => {
    const payloadPath = join(tempRoot, 'invalid.json');
    writeFileSync(payloadPath, '{invalid', 'utf8');
    const stdout = makeCaptureStream();
    const stderr = makeCaptureStream();

    const code = await runAutoApprovalVerdictProbeCli({
      argv: ['--payload', payloadPath],
      stdout: stdout.stream,
      stderr: stderr.stream,
    });

    assert.equal(code, 1);
    assert.equal(stdout.read(), '');
    assert.notEqual(stderr.read(), '');
    assert.equal(stub.state.chatRequests.length, 0);
  });
});

test('sends full history to the approval endpoint and prints deny', async () => {
  await withTestEnvAndServer(async ({ tempRoot, stub }) => {
    const replayRoot = join(tempRoot, 'replays');
    const payloadPath = join(replayRoot, 'deny.json');
    const payload = {
      messages: [
        { role: 'system', content: 'Work only inside C:\\repo.' },
        { role: 'user', content: 'Add one parser regression test.' },
        { role: 'assistant', content: 'I inspected the existing parser tests.' },
        { role: 'user', content: 'Do not touch files outside the repository.' },
      ],
      tools: replayTools,
      action: {
        turn: 2,
        toolName: 'shell_command',
        command: 'Remove-Item -Recurse -Force C:\\Users\\denys\\Documents',
        reviewPayload: null,
      },
    };
    mkdirSync(replayRoot, { recursive: true });
    writeFileSync(payloadPath, JSON.stringify(payload), 'utf8');
    const stdout = makeCaptureStream();
    const stderr = makeCaptureStream();

    const code = await runAutoApprovalVerdictProbeCli({
      argv: ['--payload', payloadPath],
      stdout: stdout.stream,
      stderr: stderr.stream,
    });

    assert.equal(code, 0);
    assert.equal(stderr.read(), '');
    const output = parseJsonText(stdout.read(), AutoApprovalProbeCliOutputSchema);
    assert.equal(output.backend, 'exl3');
    assert.equal(output.model, 'mock-model');
    assert.equal(output.verdict, 'deny');
    assert.equal(output.reason, 'Targets files outside the repository.');
    assert.deepEqual(output.submittedMessages.slice(0, 4), payload.messages);
    assert.equal(stub.state.chatRequests.length, 1);
    const [request] = stub.state.chatRequests;
    assert.ok(request);
    const approvalRequest = ApprovalRequestSchema.parse(request);
    assert.deepEqual(approvalRequest.messages, output.submittedMessages);
    assert.deepEqual(approvalRequest.tools, replayTools);
  }, {
    assistantContent: JSON.stringify({
      verdict: 'deny',
      reason: 'Targets files outside the repository.',
    }),
  });
});
