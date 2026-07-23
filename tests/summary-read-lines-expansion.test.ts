import assert from 'node:assert/strict';
import test from 'node:test';

import { SummaryPlannerLoopRuntime } from '../src/summary/planner/mode.js';

test('summary read_lines expansion is inert when ExpandReads is disabled', () => {
  const inputLineCount = 50;
  const returnedRanges = [{ start: 1, end: 11 }];

  const expanded = SummaryPlannerLoopRuntime.computeReadLinesRange({
    startLine: 1,
    endLine: 10,
    inputLineCount,
    returnedRanges,
    expandReads: true,
  });
  assert.equal(expanded.start, 11);

  const unchanged = SummaryPlannerLoopRuntime.computeReadLinesRange({
    startLine: 1,
    endLine: 10,
    inputLineCount,
    returnedRanges,
    expandReads: false,
  });
  assert.equal(unchanged.start, 1);
  assert.equal(unchanged.end, 11);
});
