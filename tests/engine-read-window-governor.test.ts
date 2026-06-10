import test from 'node:test';
import assert from 'node:assert/strict';

import { ReadWindowGovernor } from '../src/repo-search/engine/read-window-governor.js';
import type { ParsedGetContentReadWindow } from '../src/repo-search/engine/read-overlap.js';

function window(start: number, end: number): ParsedGetContentReadWindow {
  return {
    pathKey: 'src/a.ts',
    pathExpression: 'src/a.ts',
    requestedSkip: start - 1,
    requestedFirst: end - start,
    requestedStart: start,
    requestedEnd: end,
    hasExplicitSkip: true,
  };
}

test('planAdjustment returns null before any read of the file', () => {
  const governor = new ReadWindowGovernor();
  assert.equal(
    governor.planAdjustment({
      parsedReadWindow: window(1, 50),
      perToolCapTokens: 1000,
      currentGetContentStats: null,
      historicalGetContentStats: null,
      expandReads: true,
    }),
    null,
  );
});

test('recordExecution tracks overlap across reads of the same file', () => {
  const governor = new ReadWindowGovernor();
  const first = governor.recordExecution({
    parsedReadWindow: window(1, 100), executedReadWindow: window(1, 100), turn: 1, adjusted: false,
  });
  assert.equal(first.overlapLines, 0);
  assert.equal(first.newLinesCovered, 99);
  assert.equal(first.cumulativeUniqueLines, 99);
  const second = governor.recordExecution({
    parsedReadWindow: window(50, 150), executedReadWindow: window(50, 150), turn: 2, adjusted: false,
  });
  assert.equal(second.overlapLines, 50);
  assert.equal(second.newLinesCovered, 50);
  assert.equal(second.cumulativeUniqueLines, 149);
});

test('recordExecution without a matching executed window only increments the read count', () => {
  const governor = new ReadWindowGovernor();
  const metrics = governor.recordExecution({
    parsedReadWindow: window(1, 10), executedReadWindow: null, turn: 1, adjusted: false,
  });
  assert.deepEqual(metrics, { overlapLines: 0, newLinesCovered: 0, cumulativeUniqueLines: 0 });
  // second call for the same path now sees a prior read -> planAdjustment can engage
  assert.equal(governor.readCount('src/a.ts'), 1);
});

test('applyFitTruncation rolls back unique-line accounting when output was cut', () => {
  const governor = new ReadWindowGovernor();
  const metrics = governor.recordExecution({
    parsedReadWindow: window(1, 100), executedReadWindow: window(1, 100), turn: 1, adjusted: false,
  });
  governor.applyFitTruncation({
    parsedReadWindow: window(1, 100), executedReadWindow: window(1, 100),
    fittedReturnedSegmentCount: 40, metrics,
  });
  assert.equal(metrics.newLinesCovered, 40);
  assert.equal(metrics.cumulativeUniqueLines, 40);
  const summary = governor.summary();
  assert.equal(summary.byFile.length, 1);
  assert.equal(summary.byFile[0].uniqueLinesRead, 40);
});

test('planAdjustment shifts a repeated overlapping read past the already-returned range', () => {
  const governor = new ReadWindowGovernor();
  const firstMetrics = governor.recordExecution({
    parsedReadWindow: window(1, 100), executedReadWindow: window(1, 100), turn: 1, adjusted: false,
  });
  governor.applyFitTruncation({
    parsedReadWindow: window(1, 100), executedReadWindow: window(1, 100),
    fittedReturnedSegmentCount: null, metrics: firstMetrics,
  });
  const planned = governor.planAdjustment({
    parsedReadWindow: window(1, 50),
    perToolCapTokens: 1000,
    currentGetContentStats: null,
    historicalGetContentStats: null,
    expandReads: true,
  });
  assert.ok(planned !== null);
  assert.ok(planned.adjustment.adjustedStart >= 100);
  assert.ok(planned.commandToRun.includes('-Skip'));
  assert.equal(planned.adjustment.requestedStart, 1);
  assert.equal(planned.adjustment.requestedEnd, 50);
});

test('planAdjustment returns null when the requested window needs no adjustment', () => {
  const governor = new ReadWindowGovernor();
  governor.recordExecution({
    parsedReadWindow: window(1, 10), executedReadWindow: null, turn: 1, adjusted: false,
  });
  // No returned/executed ranges recorded -> a large aligned window stays as requested.
  assert.equal(
    governor.planAdjustment({
      parsedReadWindow: window(0, 200),
      perToolCapTokens: 8, // minLinesFromCap = 1 -> requested length wins
      currentGetContentStats: null,
      historicalGetContentStats: null,
      expandReads: true,
    }),
    null,
  );
});

test('applyFitTruncation ignores executed windows for a different file', () => {
  const governor = new ReadWindowGovernor();
  const metrics = governor.recordExecution({
    parsedReadWindow: window(1, 100), executedReadWindow: window(1, 100), turn: 1, adjusted: false,
  });
  const otherFileWindow = { ...window(1, 100), pathKey: 'src/other.ts' };
  governor.applyFitTruncation({
    parsedReadWindow: window(1, 100), executedReadWindow: otherFileWindow,
    fittedReturnedSegmentCount: 5, metrics,
  });
  assert.equal(metrics.newLinesCovered, 99);
});

test('applyFitTruncation records no returned range when fitting removes every line', () => {
  const governor = new ReadWindowGovernor();
  const metrics = governor.recordExecution({
    parsedReadWindow: window(1, 100), executedReadWindow: window(1, 100), turn: 1, adjusted: false,
  });
  governor.applyFitTruncation({
    parsedReadWindow: window(1, 100), executedReadWindow: window(1, 100),
    fittedReturnedSegmentCount: 0, metrics,
  });
  const state = governor.stateMap.get('src/a.ts');
  assert.deepEqual(state?.mergedReturnedRanges, []);
  assert.equal(metrics.newLinesCovered, 0);
});

test('recordNativeReturnedRange merges returned ranges in the shared state map', () => {
  const governor = new ReadWindowGovernor();
  governor.recordNativeReturnedRange('src/a.ts', { start: 1, end: 20 });
  governor.recordNativeReturnedRange('src/a.ts', { start: 15, end: 30 });
  const state = governor.stateMap.get('src/a.ts');
  assert.deepEqual(state?.mergedReturnedRanges, [{ start: 1, end: 30 }]);
});

test('planAdjustment does not expand narrow reads when expandReads is disabled', () => {
  const governor = new ReadWindowGovernor();
  const firstMetrics = governor.recordExecution({
    parsedReadWindow: window(1, 100),
    executedReadWindow: window(1, 100),
    turn: 1,
    adjusted: false,
  });
  governor.applyFitTruncation({
    parsedReadWindow: window(1, 100),
    executedReadWindow: window(1, 100),
    fittedReturnedSegmentCount: null,
    metrics: firstMetrics,
  });

  const planned = governor.planAdjustment({
    parsedReadWindow: window(1, 50),
    perToolCapTokens: 1000,
    currentGetContentStats: null,
    historicalGetContentStats: null,
    expandReads: false,
  });

  assert.equal(planned, null);
  const secondMetrics = governor.recordExecution({
    parsedReadWindow: window(1, 50),
    executedReadWindow: window(1, 50),
    turn: 2,
    adjusted: false,
  });
  assert.equal(secondMetrics.overlapLines > 0, true);
});
