import test from 'node:test';
import assert from 'node:assert/strict';

import { ReadWindowGovernor } from '../src/repo-search/engine/read-window-governor.js';

function recordRead(
  governor: ReadWindowGovernor,
  start: number,
  endExclusive: number,
  options: { returnedEndExclusive?: number; pathKey?: string } = {},
) {
  return governor.recordNativeRead({
    pathKey: options.pathKey ?? 'src/a.ts',
    returnedStart: start,
    returnedEndExclusive: options.returnedEndExclusive ?? endExclusive,
  });
}

test('a fresh governor reports an empty summary', () => {
  const governor = new ReadWindowGovernor();
  const summary = governor.summary();
  assert.deepEqual(summary.byFile, []);
  assert.equal(summary.totalLinesRead, 0);
  assert.equal(summary.overlapRatePct, 0);
});

test('a first read counts every line as unique with no overlap', () => {
  const governor = new ReadWindowGovernor();
  const metrics = recordRead(governor, 1, 51);
  assert.equal(metrics.overlapLines, 0);
  assert.equal(metrics.newLinesCovered, 50);
  assert.equal(metrics.cumulativeUniqueLines, 50);
  const summary = governor.summary();
  assert.equal(summary.totalLinesRead, 50);
  assert.equal(summary.totalUniqueLinesRead, 50);
  assert.equal(summary.overlapRatePct, 0);
});

test('a disjoint follow-up read stays overlap-free', () => {
  const governor = new ReadWindowGovernor();
  recordRead(governor, 1, 51);
  const metrics = recordRead(governor, 51, 101);
  assert.equal(metrics.overlapLines, 0);
  assert.equal(metrics.newLinesCovered, 50);
  assert.equal(metrics.cumulativeUniqueLines, 100);
  assert.equal(governor.summary().overlapRatePct, 0);
});

test('a re-read of covered lines is counted as overlap, not new coverage', () => {
  const governor = new ReadWindowGovernor();
  recordRead(governor, 1, 51);
  const metrics = recordRead(governor, 26, 76);
  assert.equal(metrics.overlapLines, 25);
  assert.equal(metrics.newLinesCovered, 25);
  assert.equal(metrics.cumulativeUniqueLines, 75);
  const summary = governor.summary();
  assert.equal(summary.totalLinesRead, 100);
  assert.equal(summary.totalUniqueLinesRead, 75);
  assert.equal(summary.overlapRatePct, 25);
});

test('only the range actually returned after output fitting is recorded', () => {
  const governor = new ReadWindowGovernor();
  // The read planned 200 lines but output fitting truncated it to 20.
  const metrics = recordRead(governor, 1, 201, { returnedEndExclusive: 21 });
  assert.equal(metrics.newLinesCovered, 20);
  assert.equal(governor.summary().totalLinesRead, 20);
  // The untruncated remainder is still unread, so the state map must not claim it.
  assert.deepEqual(governor.stateMap.get('src/a.ts')?.mergedReturnedRanges, [{ start: 1, end: 21 }]);
});

test('read state is tracked per file', () => {
  const governor = new ReadWindowGovernor();
  recordRead(governor, 1, 11);
  recordRead(governor, 1, 21, { pathKey: 'src/b.ts' });
  const summary = governor.summary();
  assert.deepEqual(summary.byFile.map((entry) => entry.pathKey), ['src/a.ts', 'src/b.ts']);
  assert.equal(summary.totalLinesRead, 30);
  assert.equal(summary.byFile[1].totalLinesRead, 20);
});

test('returned ranges are exposed so planRead can skip them', () => {
  const governor = new ReadWindowGovernor();
  recordRead(governor, 1, 11);
  recordRead(governor, 21, 31);
  assert.deepEqual(governor.stateMap.get('src/a.ts')?.mergedReturnedRanges, [
    { start: 1, end: 11 },
    { start: 21, end: 31 },
  ]);
});
