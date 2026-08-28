import test from 'node:test';
import assert from 'node:assert/strict';

import { TASK_END_REASONS, TaskEndReasonSchema } from '../src/repo-search/engine/task-loop-support.js';
import { buildScorecard } from '../src/repo-search/engine.js';
import { buildMockTaskResult } from './_test-helpers.js';

test('TASK_END_REASONS lists every reason the loop can assign', () => {
  assert.deepEqual([...TASK_END_REASONS].sort(), [
    'finish',
    'forced_finish_attempt_limit',
    'invalid_response_limit',
    'max_turns',
    'mock_responses_exhausted',
  ]);
});

test('TaskEndReasonSchema rejects an unknown reason', () => {
  assert.equal(TaskEndReasonSchema.safeParse('finish').success, true);
  assert.equal(TaskEndReasonSchema.safeParse('totally_new_reason').success, false);
});

test('buildScorecard fails a run that hit the invalid response limit', () => {
  const scorecard = buildScorecard({
    runId: 'r1',
    model: 'm',
    tasks: [buildMockTaskResult({ reason: 'invalid_response_limit' })],
  });
  assert.equal(scorecard.verdict, 'fail');
  assert.deepEqual(scorecard.failureReasons, ['repo-search: ended with reason invalid_response_limit']);
});

test('buildScorecard fails a run that ran out of turns', () => {
  const scorecard = buildScorecard({
    runId: 'r2',
    model: 'm',
    tasks: [buildMockTaskResult({ reason: 'max_turns' })],
  });
  assert.equal(scorecard.verdict, 'fail');
  assert.deepEqual(scorecard.failureReasons, ['repo-search: ended with reason max_turns']);
});

test('buildScorecard passes a finished run', () => {
  const scorecard = buildScorecard({
    runId: 'r3',
    model: 'm',
    tasks: [buildMockTaskResult({ reason: 'finish' })],
  });
  assert.equal(scorecard.verdict, 'pass');
  assert.deepEqual(scorecard.failureReasons, []);
});

test('buildScorecard reports only the end reason for an evicted run with non-zero exits', () => {
  const scorecard = buildScorecard({
    runId: 'r4',
    model: 'm',
    tasks: [buildMockTaskResult({
      reason: 'max_turns',
      nonZeroExits: 1,
      commands: [{
        command: 'grep pattern="x"',
        activityKind: 'search',
        activitySubject: { kind: 'none' },
        turn: 1,
        safe: true,
        reason: null,
        exitCode: 2,
        output: 'boom',
      }],
    })],
  });
  assert.equal(scorecard.verdict, 'fail');
  assert.deepEqual(scorecard.failureReasons, ['repo-search: ended with reason max_turns']);
});

test('buildScorecard derives the verdict from the end reason alone', () => {
  for (const reason of TASK_END_REASONS) {
    const scorecard = buildScorecard({
      runId: `r-${reason}`,
      model: 'm',
      tasks: [buildMockTaskResult({ reason })],
    });
    assert.equal(scorecard.verdict, reason === 'finish' ? 'pass' : 'fail');
    assert.equal(scorecard.totals.passed + scorecard.totals.failed, scorecard.totals.tasks);
  }
});

test('buildScorecard passes a finished run whose commands exited non-zero', () => {
  const scorecard = buildScorecard({
    runId: 'r5',
    model: 'm',
    tasks: [buildMockTaskResult({
      reason: 'finish',
      nonZeroExits: 2,
      commands: [{
        command: 'grep pattern="x"',
        activityKind: 'search',
        activitySubject: { kind: 'none' },
        turn: 1,
        safe: true,
        reason: null,
        exitCode: 1,
        output: 'red run',
      }],
    })],
  });
  assert.equal(scorecard.verdict, 'pass');
  assert.deepEqual(scorecard.failureReasons, []);
});
