import assert from 'node:assert/strict';
import test from 'node:test';

import { SummaryPlannerLoopRuntime } from '../src/summary/planner/mode.js';

test('summary read_lines expansion is inert when ExpandReads is disabled', () => {
  const noOverlapExpanded = SummaryPlannerLoopRuntime.computeReadLinesRange({
    startLine: 1,
    endLine: 10,
    inputLineCount: 50,
    returnedRanges: [],
    expandReads: true,
  });
  assert.deepEqual(noOverlapExpanded, { hasUnread: true, start: 1, end: 11 });

  const noOverlapWindow = SummaryPlannerLoopRuntime.computeReadLinesRange({
    startLine: 1,
    endLine: 10,
    inputLineCount: 50,
    returnedRanges: [],
    expandReads: false,
  });
  assert.deepEqual(noOverlapWindow, { hasUnread: true, start: 1, end: 11 });

  const expanded = SummaryPlannerLoopRuntime.computeReadLinesRange({
    startLine: 1,
    endLine: 10,
    inputLineCount: 50,
    returnedRanges: [{ start: 1, end: 11 }],
    expandReads: true,
  });
  assert.deepEqual(expanded, { hasUnread: true, start: 11, end: 51 });

  const unchangedOverlap = SummaryPlannerLoopRuntime.computeReadLinesRange({
    startLine: 1,
    endLine: 10,
    inputLineCount: 50,
    returnedRanges: [{ start: 1, end: 11 }],
    expandReads: false,
  });
  assert.deepEqual(unchangedOverlap, { hasUnread: true, start: 1, end: 11 });

  const endLineBoundedExpansion = SummaryPlannerLoopRuntime.computeReadLinesRange({
    startLine: 1,
    endLine: 10,
    inputLineCount: 10,
    returnedRanges: [{ start: 1, end: 11 }],
    expandReads: true,
  });
  assert.deepEqual(endLineBoundedExpansion, { hasUnread: false, start: 11, end: 11 });
});
