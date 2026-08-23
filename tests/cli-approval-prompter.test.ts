import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { CliApprovalPrompter } from '../src/cli/approval-prompter.js';
import { CLIENT_ABORT_MESSAGE } from '../src/repo-search/engine/approval-gate.js';
import type { ApprovalRequestProgressEvent } from '../src/repo-search/types.js';
import { makeCaptureStream } from './_test-helpers.js';

function makePrompter(): { prompter: CliApprovalPrompter; input: PassThrough; output: ReturnType<typeof makeCaptureStream> } {
  const input = new PassThrough();
  const output = makeCaptureStream();
  return { prompter: new CliApprovalPrompter({ input, output: output.stream }), input, output };
}

// An approval_request carries no maxTurns, so the prompt shows the turn alone.
const EVENT: ApprovalRequestProgressEvent = {
  kind: 'approval_request',
  requestId: 'r1',
  approvalId: 'a1',
  turn: 3,
  toolName: 'write',
  command: 'write path=src/x.ts',
  reviewPayload: '{\n  "content": "destructive-sentinel"\n}',
};

test('a approves', async () => {
  const { prompter, input, output } = makePrompter();
  const pending = prompter.promptDecision(EVENT);
  input.write('a\n');
  assert.deepEqual(await pending, { kind: 'approve' });
  const rendered = output.read();
  assert.match(rendered, /t3 wants to run: write path=src\/x\.ts/u);
  assert.match(rendered, /Proposed edit\/write payload:/u);
  assert.equal((rendered.match(/destructive-sentinel/gu) ?? []).length, 1);
});

test('d asks for a reason and denies with it', async () => {
  const { prompter, input, output } = makePrompter();
  const pending = prompter.promptDecision(EVENT);
  input.write('d\n');
  input.write('wrong file\n');
  assert.deepEqual(await pending, { kind: 'deny', reason: 'wrong file' });
  assert.match(output.read(), /reason \(enter to skip\)/u);
});

test('b aborts; unrecognized keys re-prompt', async () => {
  const { prompter, input, output } = makePrompter();
  const pending = prompter.promptDecision(EVENT);
  input.write('x\n');
  input.write('b\n');
  assert.deepEqual(await pending, { kind: 'abort', reason: CLIENT_ABORT_MESSAGE });
  const promptCount = (output.read().match(/\[a\]pprove {2}\[d\]eny {2}a\[b\]ort/gu) || []).length;
  assert.equal(promptCount, 2);
});
