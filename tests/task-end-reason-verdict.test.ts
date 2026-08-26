import test from 'node:test';
import assert from 'node:assert/strict';

import { TASK_END_REASONS, TaskEndReasonSchema } from '../src/repo-search/engine/task-loop-support.js';
import { buildScorecard } from '../src/repo-search/engine.js';
import type { TaskEndReason, TaskResult } from '../src/repo-search/engine/task-loop-support.js';

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

function buildTaskResult(overrides: Partial<TaskResult> & { reason: TaskEndReason }): TaskResult {
  return {
    id: 'repo-search',
    question: 'q',
    turnsUsed: 3,
    safetyRejects: 0,
    invalidResponses: 0,
    commandFailures: 0,
    finishChallenges: 0,
    commands: [],
    turnThinking: {},
    finalOutput: 'answer',
    compactionSummary: '',
    mutatedPaths: [],
    passed: false,
    missingSignals: [],
    promptTokens: 0,
    outputTokens: 0,
    toolTokens: 0,
    thinkingTokens: 0,
    outputTokensEstimatedCount: 0,
    thinkingTokensEstimatedCount: 0,
    promptCacheTokens: 0,
    promptEvalTokens: 0,
    promptEvalDurationMs: 0,
    generationDurationMs: 0,
    speculativeAcceptedTokens: 0,
    speculativeGeneratedTokens: 0,
    toolStats: {},
    readOverlapSummary: {
      byFile: [],
      totalLinesRead: 0,
      totalUniqueLinesRead: 0,
      totalOverlapLines: 0,
      overlapRatePct: 0,
    },
    ...overrides,
  };
}

test('buildScorecard fails a run that hit the invalid response limit', () => {
  const scorecard = buildScorecard({
    runId: 'r1',
    model: 'm',
    tasks: [buildTaskResult({ reason: 'invalid_response_limit', passed: false })],
  });
  assert.equal(scorecard.verdict, 'fail');
  assert.deepEqual(scorecard.failureReasons, ['repo-search: ended with reason invalid_response_limit']);
});

test('buildScorecard fails a run that ran out of turns', () => {
  const scorecard = buildScorecard({
    runId: 'r2',
    model: 'm',
    tasks: [buildTaskResult({ reason: 'max_turns', passed: false })],
  });
  assert.equal(scorecard.verdict, 'fail');
  assert.deepEqual(scorecard.failureReasons, ['repo-search: ended with reason max_turns']);
});

test('buildScorecard passes a finished run', () => {
  const scorecard = buildScorecard({
    runId: 'r3',
    model: 'm',
    tasks: [buildTaskResult({ reason: 'finish', passed: true })],
  });
  assert.equal(scorecard.verdict, 'pass');
  assert.deepEqual(scorecard.failureReasons, []);
});

test('buildScorecard names the non-zero command exit instead of a bare "task failed"', () => {
  const scorecard = buildScorecard({
    runId: 'r4',
    model: 'm',
    tasks: [buildTaskResult({
      reason: 'finish',
      passed: false,
      commands: [{
        command: 'grep pattern="x"',
        turn: 1,
        safe: true,
        reason: null,
        exitCode: 2,
        output: 'boom',
      }],
    })],
  });
  assert.equal(scorecard.verdict, 'fail');
  assert.deepEqual(scorecard.failureReasons, ['repo-search: commands exited non-zero 1']);
});
