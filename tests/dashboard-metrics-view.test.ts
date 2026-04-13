import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildTaskRunsSeries,
  describeToolType,
  getGraphHoverIndex,
  sortToolMetricsByCalls,
  type ToolMetricRow,
} from '../dashboard/src/metrics-view.ts';
import type { TaskMetricDay } from '../dashboard/src/types.ts';

test('sortToolMetricsByCalls sorts by calls descending', () => {
  const rows: ToolMetricRow[] = [
    { taskKind: 'plan', toolType: 'get-content', calls: 38 },
    { taskKind: 'repo-search', toolType: 'get-content', calls: 2196 },
    { taskKind: 'summary', toolType: 'get-childitem', calls: 1 },
    { taskKind: 'repo-search', toolType: 'get-childitem', calls: 50 },
  ];

  assert.deepEqual(
    sortToolMetricsByCalls(rows).map((row) => `${row.taskKind}:${row.toolType}:${row.calls}`),
    [
      'repo-search:get-content:2196',
      'repo-search:get-childitem:50',
      'plan:get-content:38',
      'summary:get-childitem:1',
    ],
  );
});

test('describeToolType returns known descriptions and fallback text', () => {
  assert.equal(
    describeToolType('get-content'),
    'Reads file contents from disk for code inspection and extraction.',
  );
  assert.equal(
    describeToolType('custom-tool'),
    'custom-tool: tool call used in agent workflows for discovery or execution.',
  );
});

test('getGraphHoverIndex only returns index inside graph bounds', () => {
  assert.equal(getGraphHoverIndex(6, -1, 520), null);
  assert.equal(getGraphHoverIndex(6, 521, 520), null);
  assert.equal(getGraphHoverIndex(6, 260, 520), 3);
});

test('buildTaskRunsSeries combines task rows into line series by date', () => {
  const rows: TaskMetricDay[] = [
    {
      date: '2026-04-08',
      taskKind: 'summary',
      runs: 0,
      inputTokens: 0,
      outputTokens: 0,
      thinkingTokens: 0,
      toolTokens: 0,
      promptCacheTokens: 0,
      promptEvalTokens: 0,
      avgDurationMs: 0,
    },
    {
      date: '2026-04-09',
      taskKind: 'summary',
      runs: 80,
      inputTokens: 1,
      outputTokens: 1,
      thinkingTokens: 1,
      toolTokens: 1,
      promptCacheTokens: 1,
      promptEvalTokens: 1,
      avgDurationMs: 1,
    },
    {
      date: '2026-04-08',
      taskKind: 'repo-search',
      runs: 33,
      inputTokens: 1,
      outputTokens: 1,
      thinkingTokens: 1,
      toolTokens: 1,
      promptCacheTokens: 1,
      promptEvalTokens: 1,
      avgDurationMs: 1,
    },
  ];

  const series = buildTaskRunsSeries(rows);
  assert.deepEqual(
    series.map((item) => item.key),
    ['runs-summary', 'runs-repo-search'],
  );
  assert.deepEqual(
    series[0]?.points,
    [
      { label: '2026-04-08', value: 0 },
      { label: '2026-04-09', value: 80 },
    ],
  );
  assert.deepEqual(
    series[1]?.points,
    [
      { label: '2026-04-08', value: 33 },
      { label: '2026-04-09', value: 0 },
    ],
  );
});
