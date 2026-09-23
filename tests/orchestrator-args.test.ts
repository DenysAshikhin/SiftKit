import assert from 'node:assert/strict';
import test from 'node:test';

import { parseOrchestratorInvocation } from '../src/cli/orchestrator-args.js';

const RUN_ID = '00000000-0000-4000-8000-000000000001';
const APPROVAL_ID = '00000000-0000-4000-8000-000000000002';

test('a start takes a task, a plan, or both, with the default orchestrator preset and approval', () => {
  assert.deepEqual(parseOrchestratorInvocation(['Add', 'a', 'greeting'], 'C:/repo'), {
    kind: 'start', task: 'Add a greeting', planPath: null, presetId: 'orchestrator', approval: 'auto', repoRoot: 'C:/repo',
  });
  assert.deepEqual(parseOrchestratorInvocation(['--plan', 'docs/plan.md', '--preset', 'my-orch', '--approval', 'interactive',
    '--repo', 'D:/other'], 'C:/repo'), {
    kind: 'start', task: null, planPath: 'docs/plan.md', presetId: 'my-orch', approval: 'interactive', repoRoot: 'D:/other',
  });
});

test('invalid starts and flags fail with a precise message', () => {
  assert.throws(() => parseOrchestratorInvocation([], 'C:/repo'), /needs a task, --plan <path>, or both/u);
  assert.throws(() => parseOrchestratorInvocation(['--plan'], 'C:/repo'), /Missing value for --plan/u);
  assert.throws(() => parseOrchestratorInvocation(['--approval', 'sometimes', 'x'], 'C:/repo'), /Invalid --approval value: sometimes/u);
  assert.throws(() => parseOrchestratorInvocation(['--model', 'm', 'x'], 'C:/repo'), /Unknown orchestrator option: --model/u);
});

test('control verbs parse exact run and approval IDs', () => {
  assert.deepEqual(parseOrchestratorInvocation(['status', RUN_ID], '.'), { kind: 'status', runId: RUN_ID });
  assert.deepEqual(parseOrchestratorInvocation(['abort', RUN_ID], '.'), { kind: 'abort', runId: RUN_ID });
  assert.deepEqual(parseOrchestratorInvocation(['attach', RUN_ID, '--after', '7'], '.'), { kind: 'attach', runId: RUN_ID, afterSequence: 7 });
  assert.deepEqual(parseOrchestratorInvocation(['decide', RUN_ID, APPROVAL_ID, 'deny', '--reason', 'Out of scope.'], '.'),
    { kind: 'decide', runId: RUN_ID, approvalId: APPROVAL_ID, decision: 'deny', reason: 'Out of scope.' });
  assert.throws(() => parseOrchestratorInvocation(['decide', RUN_ID, APPROVAL_ID, 'deny'], '.'), /deny requires --reason/u);
  assert.throws(() => parseOrchestratorInvocation(['status', 'not-a-uuid'], '.'), /Invalid orchestrator run ID: not-a-uuid/u);
  assert.throws(() => parseOrchestratorInvocation(['attach', RUN_ID, '--after', '-1'], '.'), /Missing value for --after|Invalid --after/u);
});
