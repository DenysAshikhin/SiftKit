import test from 'node:test';
import assert from 'node:assert/strict';

import { TASK_END_REASONS, TaskEndReasonSchema } from '../src/repo-search/engine/task-loop-support.js';

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
