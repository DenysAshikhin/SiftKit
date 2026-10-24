import assert from 'node:assert/strict';
import test from 'node:test';

import { runTaskLoop } from '../src/repo-search/engine.ts';
import type { SubmissionGate, SubmissionVerdict } from '../src/repo-search/engine/submission-gate.ts';
import { TEST_THROUGHPUT_AUDIT_OPERATION } from './_test-helpers.ts';
import { createMockLoopDefaults } from './helpers/mock-loop-defaults.ts';

const MOCK_LOOP_DEFAULTS = createMockLoopDefaults('siftkit-submission-gate-');
const PASS_VERDICT = { content: '{"verdict":"pass","reason":"supported"}' };

/** Answers each submission from a fixed script and records what it was handed. */
class ScriptedGate implements SubmissionGate {
  readonly answers: string[] = [];
  private readonly verdicts: SubmissionVerdict[];

  constructor(verdicts: SubmissionVerdict[]) {
    this.verdicts = verdicts;
  }

  review(answer: string): Promise<SubmissionVerdict> {
    this.answers.push(answer);
    const verdict = this.verdicts.shift();
    if (verdict === undefined) throw new Error('Unscripted submission.');
    return Promise.resolve(verdict);
  }
}

test('a rejected submission returns its feedback to the same conversation, and the accepted output is the run answer', async () => {
  const gate = new ScriptedGate([
    { kind: 'reject', message: 'Checks failed: `npm test` exited 1.' },
    { kind: 'accept', output: 'report with facts' },
  ]);
  const result = await runTaskLoop({ id: 'submission', question: 'Do the task.' }, {
    throughputAudit: TEST_THROUGHPUT_AUDIT_OPERATION, ...MOCK_LOOP_DEFAULTS, maxTurns: 4, minToolCallsBeforeFinish: 0,
    mockResponses: [{ content: 'first report' }, { content: 'second report' }, PASS_VERDICT],
    mockCommandResults: {}, submissionGate: gate,
  });
  assert.deepEqual(gate.answers, ['first report', 'second report']);
  assert.equal(result.finalOutput, 'report with facts');
  assert.equal(result.reason, 'finish');
});

test('without a gate the first finish is the answer', async () => {
  const result = await runTaskLoop({ id: 'no-gate', question: 'Do the task.' }, {
    throughputAudit: TEST_THROUGHPUT_AUDIT_OPERATION, ...MOCK_LOOP_DEFAULTS, maxTurns: 2, minToolCallsBeforeFinish: 0,
    mockResponses: [{ content: 'only report' }, PASS_VERDICT], mockCommandResults: {},
  });
  assert.equal(result.finalOutput, 'only report');
});
