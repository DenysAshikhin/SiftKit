import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MetricsTab } from '../src/tabs/MetricsTab';
import type { IdleSummarySnapshot, MetricDay } from '../src/types';

const METRIC_DAY = {
  date: '2026-04-16',
  runs: 3, successCount: 2, failureCount: 1,
  inputTokens: 120, outputTokens: 45, thinkingTokens: 10, toolTokens: 4,
  promptCacheTokens: 20, promptEvalTokens: 40, cacheHitRate: 0.5,
  speculativeAcceptedTokens: 15, speculativeGeneratedTokens: 20, acceptanceRate: 0.75,
  avgDurationMs: 1200,
} satisfies MetricDay;

const IDLE_SNAPSHOT = {
  emittedAtUtc: '2026-04-16T12:00:00.000Z',
  completedRequestCount: 4,
  inputCharactersTotal: 10, outputCharactersTotal: 10,
  inputTokensTotal: 50, outputTokensTotal: 25, thinkingTokensTotal: 5, toolTokensTotal: 1,
  promptCacheTokensTotal: 0, promptEvalTokensTotal: 0,
  inputOutputRatio: 2, savedTokens: 3, savedPercent: 12, compressionRatio: 1.3,
  requestDurationMsTotal: 4000, avgRequestMs: 1000, avgTokensPerSecond: 8, summaryText: '',
} satisfies IdleSummarySnapshot;

test('metrics tab renders graph grid, chart cards, and a numeric tool table', () => {
  const markup = renderToStaticMarkup(
    <MetricsTab
      metrics={[METRIC_DAY]}
      idleSummarySnapshots={[IDLE_SNAPSHOT, IDLE_SNAPSHOT]}
      recentIdlePoints={[IDLE_SNAPSHOT]}
      latestIdleSnapshot={IDLE_SNAPSHOT}
      sortedToolMetricRows={[{
        toolType: 'read_lines',
        calls: 2, outputCharsTotal: 20, outputTokensTotal: 10, outputTokensEstimatedCount: 0,
        lineReadCalls: 1, lineReadLinesTotal: 5, lineReadTokensTotal: 10,
        finishRejections: 0, semanticRepeatRejects: 0, stagnationWarnings: 0, forcedFinishFromStagnation: 0,
        promptInsertedTokens: 0, rawToolResultTokens: 0, newEvidenceCalls: 1, noNewEvidenceCalls: 0,
        lineReadRecommendedLines: 5, lineReadAllowanceTokens: 20,
      }]}
      taskRunsGraphSeries={[]}
      webSearchUsage={null}
      webSearchQuota={null}
    />,
  );

  assert.match(markup, /class="graph-grid"/);
  assert.match(markup, /class="graph-card"/);
  assert.match(markup, /Daily Runs/);
  assert.match(markup, /Daily Token Usage/);
  assert.match(markup, /class="mtable"/);
  assert.match(markup, /class="num"/);
  assert.match(markup, /read_lines/);
  assert.match(markup, /Live Idle Summary/);
  assert.match(markup, /Input \/ Output Ratio/);
});

test('metrics tab renders the web search usage tiles', () => {
  const markup = renderToStaticMarkup(
    <MetricsTab
      metrics={[]}
      idleSummarySnapshots={[]}
      recentIdlePoints={[]}
      latestIdleSnapshot={null}
      sortedToolMetricRows={[]}
      taskRunsGraphSeries={[]}
      webSearchUsage={{ currentMonth: '2026-06', currentMonthCount: 7, allTimeCount: 42 }}
      webSearchQuota={[{ provider: 'tavily', used: 8, limit: 100, remaining: 92 }]}
    />,
  );

  assert.match(markup, /Web Search/);
  assert.match(markup, /class="tile"/);
  assert.match(markup, /7/);
  assert.match(markup, /42/);
});
