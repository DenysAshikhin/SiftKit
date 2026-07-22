import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { CliApprovalPrompter } from '../src/cli/approval-prompter.js';
import { makeCaptureStream } from './_test-helpers.js';

function makePrompter(): { prompter: CliApprovalPrompter; input: PassThrough; output: ReturnType<typeof makeCaptureStream> } {
  const input = new PassThrough();
  const output = makeCaptureStream();
  return { prompter: new CliApprovalPrompter({ input, output: output.stream }), input, output };
}

const EVENT = { kind: 'approval_request', requestId: 'r1', approvalId: 'a1', turn: 3, maxTurns: 24, toolName: 'write', command: 'write path=src/x.ts' };

test('a approves', async () => {
  const { prompter, input, output } = makePrompter();
  const pending = prompter.promptDecision(EVENT);
  input.write('a\n');
  assert.deepEqual(await pending, { kind: 'approve' });
  assert.match(output.read(), /t3\/24 wants to run: write path=src\/x\.ts/u);
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
  assert.deepEqual(await pending, { kind: 'abort' });
  const promptCount = (output.read().match(/\[a\]pprove {2}\[d\]eny {2}a\[b\]ort/gu) || []).length;
  assert.equal(promptCount, 2);
});
