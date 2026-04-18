import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildToolMetricRows,
  buildTaskRunsSeries,
  describeToolType,
  getGraphHoverIndex,
  sortToolMetricsByCalls,
  type ToolMetricRow,
} from '../dashboard/src/metrics-view.ts';
import type { TaskMetricDay, ToolStatsByTask } from '../dashboard/src/types.ts';

test('buildToolMetricRows merges task kinds into one row per tool', () => {
  const stats: ToolStatsByTask = {
    summary: {
      'get-content': {
        calls: 2,
        outputCharsTotal: 20,
        outputTokensTotal: 10,
        outputTokensEstimatedCount: 4,
        lineReadCalls: 1,
        lineReadLinesTotal: 5,
        lineReadTokensTotal: 10,
        finishRejections: 1,
        semanticRepeatRejects: 0,
        stagnationWarnings: 0,
        forcedFinishFromStagnation: 0,
        promptInsertedTokens: 3,
        rawToolResultTokens: 6,
        newEvidenceCalls: 1,
        noNewEvidenceCalls: 0,
        lineReadRecommendedLines: 25,
        lineReadAllowanceTokens: 400,
      },
    },
    plan: {
      'get-content': {
        calls: 3,
        outputCharsTotal: 30,
        outputTokensTotal: 12,
        outputTokensEstimatedCount: 6,
        lineReadCalls: 2,
        lineReadLinesTotal: 7,
        lineReadTokensTotal: 14,
        finishRejections: 0,
        semanticRepeatRejects: 1,
        stagnationWarnings: 2,
        forcedFinishFromStagnation: 3,
        promptInsertedTokens: 4,
        rawToolResultTokens: 8,
        newEvidenceCalls: 0,
        noNewEvidenceCalls: 2,
        lineReadRecommendedLines: 40,
        lineReadAllowanceTokens: 600,
      },
      rg: {
        calls: 5,
        outputCharsTotal: 50,
        outputTokensTotal: 20,
        outputTokensEstimatedCount: 10,
        lineReadCalls: 0,
        lineReadLinesTotal: 0,
        lineReadTokensTotal: 0,
        finishRejections: 0,
        semanticRepeatRejects: 0,
        stagnationWarnings: 0,
        forcedFinishFromStagnation: 0,
        promptInsertedTokens: 0,
        rawToolResultTokens: 0,
        newEvidenceCalls: 3,
        noNewEvidenceCalls: 1,
      },
    },
    'repo-search': {},
    chat: {},
  };

  assert.deepEqual(buildToolMetricRows(stats), [
    {
      toolType: 'get-content',
      calls: 5,
      outputCharsTotal: 50,
      outputTokensTotal: 22,
      outputTokensEstimatedCount: 10,
      lineReadCalls: 3,
      lineReadLinesTotal: 12,
      lineReadTokensTotal: 24,
      finishRejections: 1,
      semanticRepeatRejects: 1,
      stagnationWarnings: 2,
      forcedFinishFromStagnation: 3,
      promptInsertedTokens: 7,
      rawToolResultTokens: 14,
      newEvidenceCalls: 1,
      noNewEvidenceCalls: 2,
      lineReadRecommendedLines: 40,
      lineReadAllowanceTokens: 600,
    },
    {
      toolType: 'rg',
      calls: 5,
      outputCharsTotal: 50,
      outputTokensTotal: 20,
      outputTokensEstimatedCount: 10,
      lineReadCalls: 0,
      lineReadLinesTotal: 0,
      lineReadTokensTotal: 0,
      finishRejections: 0,
      semanticRepeatRejects: 0,
      stagnationWarnings: 0,
      forcedFinishFromStagnation: 0,
      promptInsertedTokens: 0,
      rawToolResultTokens: 0,
      newEvidenceCalls: 3,
      noNewEvidenceCalls: 1,
      lineReadRecommendedLines: null,
      lineReadAllowanceTokens: null,
    },
  ]);
});

test('sortToolMetricsByCalls sorts by calls descending then tool name', () => {
  const rows: ToolMetricRow[] = [
    { toolType: 'get-content', calls: 38 },
    { toolType: 'rg', calls: 2196 },
    { toolType: 'get-childitem', calls: 38 },
    { toolType: 'find_text', calls: 1 },
  ];

  assert.deepEqual(
    sortToolMetricsByCalls(rows).map((row) => `${row.toolType}:${row.calls}`),
    [
      'rg:2196',
      'get-childitem:38',
      'get-content:38',
      'find_text:1',
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
