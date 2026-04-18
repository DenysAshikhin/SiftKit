import React from 'react';
import { InteractiveGraph, type InteractiveSeries } from '../components/InteractiveGraph';
import {
  formatDate,
  formatNumber,
  formatSecondsFromMs,
  formatShortTime,
} from '../lib/format';
import { describeToolType, type ToolMetricRow } from '../metrics-view';
import type { IdleSummarySnapshot, MetricDay } from '../types';

type MetricsTabProps = {
  metrics: MetricDay[];
  idleSummarySnapshots: IdleSummarySnapshot[];
  recentIdlePoints: IdleSummarySnapshot[];
  latestIdleSnapshot: IdleSummarySnapshot | null;
  sortedToolMetricRows: ToolMetricRow[];
  taskRunsGraphSeries: InteractiveSeries[];
};

export function MetricsTab({
  metrics,
  idleSummarySnapshots,
  recentIdlePoints,
  latestIdleSnapshot,
  sortedToolMetricRows,
  taskRunsGraphSeries,
}: MetricsTabProps) {
  return (
    <section className="panel">
      <h2>Metrics</h2>
      <div className="metrics-graph-grid">
        <InteractiveGraph
          storageId="daily-runs"
          title="Daily Runs"
          series={[
            {
              key: 'runs',
              title: 'Runs',
              unit: '',
              color: '#32c2a3',
              points: metrics.map((day) => ({ label: day.date, value: day.runs })),
            },
            {
              key: 'success',
              title: 'Completed',
              unit: '',
              color: '#53b6ff',
              points: metrics.map((day) => ({ label: day.date, value: day.successCount })),
            },
            {
              key: 'failed',
              title: 'Failed',
              unit: '',
              color: '#ff7b72',
              points: metrics.map((day) => ({ label: day.date, value: day.failureCount })),
            },
          ]}
        />
        <InteractiveGraph
          storageId="daily-token-usage"
          title="Daily Token Usage"
          series={[
            {
              key: 'input-tokens',
              title: 'Processed Input',
              unit: 'tok',
              color: '#53b6ff',
              points: metrics.map((day) => ({ label: day.date, value: day.inputTokens })),
            },
            {
              key: 'output-tokens',
              title: 'Output',
              unit: 'tok',
              color: '#ffb86c',
              points: metrics.map((day) => ({ label: day.date, value: day.outputTokens })),
            },
            {
              key: 'thinking-tokens',
              title: 'Thinking',
              unit: 'tok',
              color: '#d4a8ff',
              points: metrics.map((day) => ({ label: day.date, value: day.thinkingTokens })),
            },
            {
              key: 'tool-tokens',
              title: 'Tool',
              unit: 'tok',
              color: '#87d37c',
              points: metrics.map((day) => ({ label: day.date, value: day.toolTokens })),
            },
          ]}
        />
        <InteractiveGraph
          storageId="daily-duration"
          title="Average Duration"
          series={[
            {
              key: 'avg-duration-ms',
              title: 'Avg Duration',
              unit: 'ms',
              color: '#32c2a3',
              points: metrics.map((day) => ({ label: day.date, value: day.avgDurationMs })),
            },
          ]}
        />
        <InteractiveGraph
          storageId="prompt-cache-hit-rate"
          title="Prompt Cache Hit Rate"
          series={[
            {
              key: 'cache-hit-rate',
              title: 'Cache Hit Rate',
              unit: '%',
              color: '#71d36a',
              points: metrics.map((day) => ({ label: day.date, value: Number.isFinite(day.cacheHitRate) ? Number(day.cacheHitRate) * 100 : 0 })),
            },
            {
              key: 'cache-tokens',
              title: 'Cache Tokens',
              unit: 'tok',
              color: '#4fbf90',
              points: metrics.map((day) => ({ label: day.date, value: day.promptCacheTokens })),
            },
            {
              key: 'prompt-eval-tokens',
              title: 'Prompt Eval Tokens',
              unit: 'tok',
              color: '#6ec8ff',
              points: metrics.map((day) => ({ label: day.date, value: day.promptEvalTokens })),
            },
          ]}
        />
        {idleSummarySnapshots.length > 1 ? (
          <InteractiveGraph
            storageId="recent-snapshot-totals"
            title="Recent Snapshot Totals"
            series={[
              {
                key: 'requests',
                title: 'Requests',
                unit: '',
                color: '#32c2a3',
                points: recentIdlePoints.map((snapshot) => ({ label: formatShortTime(snapshot.emittedAtUtc), value: snapshot.completedRequestCount })),
              },
              {
                key: 'input',
                title: 'Processed Input Tokens',
                unit: 'tok',
                color: '#53b6ff',
                points: recentIdlePoints.map((snapshot) => ({ label: formatShortTime(snapshot.emittedAtUtc), value: snapshot.inputTokensTotal })),
              },
              {
                key: 'output',
                title: 'Output Tokens',
                unit: 'tok',
                color: '#ffb86c',
                points: recentIdlePoints.map((snapshot) => ({ label: formatShortTime(snapshot.emittedAtUtc), value: snapshot.outputTokensTotal })),
              },
              {
                key: 'thinking',
                title: 'Thinking Tokens',
                unit: 'tok',
                color: '#d4a8ff',
                points: recentIdlePoints.map((snapshot) => ({ label: formatShortTime(snapshot.emittedAtUtc), value: snapshot.thinkingTokensTotal })),
              },
            ]}
          />
        ) : (
          <section className="idle-summary-history">
            <h3>Recent Snapshot Totals</h3>
            <p className="hint">Waiting for additional idle snapshots.</p>
          </section>
        )}
      </div>
      <section className="idle-summary-top-wrap">
        <div className="idle-top-row">
          <section className="idle-summary-panel idle-summary-compact">
            <h3>Live Idle Summary</h3>
            {latestIdleSnapshot ? (
              <div className="idle-summary-cards">
                <p className="hint idle-latest">Latest: {formatDate(latestIdleSnapshot.emittedAtUtc)}</p>
                <article className="idle-card throughput">
                  <span>Requests</span>
                  <strong>{formatNumber(latestIdleSnapshot.completedRequestCount)}</strong>
                  <span>Avg Request: {formatSecondsFromMs(latestIdleSnapshot.avgRequestMs)}</span>
                  <span>Gen Tokens/s: {formatNumber(latestIdleSnapshot.avgTokensPerSecond)}</span>
                </article>
                <article className="idle-card token-totals">
                  <span>Processed Input / Output / Thinking</span>
                  <strong>
                    {formatNumber(latestIdleSnapshot.inputTokensTotal)} / {formatNumber(latestIdleSnapshot.outputTokensTotal)} / {formatNumber(latestIdleSnapshot.thinkingTokensTotal)}
                  </strong>
                </article>
                <article className="idle-card compression">
                  <span>Input / Output Ratio</span>
                  <strong>{Number.isFinite(latestIdleSnapshot.inputOutputRatio) ? `${Number(latestIdleSnapshot.inputOutputRatio).toFixed(2)}x` : '-'}</strong>
                  <span>Processed input tokens per output token</span>
                </article>
              </div>
            ) : (
              <p className="hint">No snapshots yet. A summary appears when the backend reaches idle state.</p>
            )}
          </section>
          <section className="idle-summary-history idle-tools-panel">
            <h3>Tool Metrics</h3>
            {sortedToolMetricRows.length > 0 ? (
              <div className="idle-metric-card-row">
                {sortedToolMetricRows.map((entry) => {
                  const avgChars = entry.calls > 0 ? Math.round(entry.outputCharsTotal / entry.calls) : 0;
                  const avgTokens = entry.calls > 0 ? Math.round(entry.outputTokensTotal / entry.calls) : 0;
                  const avgLines = entry.lineReadCalls > 0 ? Math.round(entry.lineReadLinesTotal / entry.lineReadCalls) : 0;
                  const avgTokensPerLine = entry.lineReadLinesTotal > 0 ? entry.lineReadTokensTotal / entry.lineReadLinesTotal : null;
                  const estimatedRate = entry.calls > 0 ? (entry.outputTokensEstimatedCount / entry.calls) * 100 : 0;
                  const insertedAvgTokens = entry.calls > 0 ? Math.round(entry.promptInsertedTokens / entry.calls) : 0;
                  const rawAvgTokens = entry.calls > 0 ? Math.round(entry.rawToolResultTokens / entry.calls) : 0;
                  return (
                    <article
                      key={entry.toolType}
                      className="idle-card idle-metric-card metric-tool"
                      title={describeToolType(entry.toolType)}
                    >
                      <strong>{entry.toolType}</strong>
                      <span>Calls: {formatNumber(entry.calls)}</span>
                      <span>Avg chars: {formatNumber(avgChars)}</span>
                      <span>Avg tokens: {formatNumber(avgTokens)}</span>
                      {(entry.promptInsertedTokens > 0 || entry.rawToolResultTokens > 0) && (
                        <span>Avg inserted/raw tok: {formatNumber(insertedAvgTokens)} / {formatNumber(rawAvgTokens)}</span>
                      )}
                      {(entry.lineReadCalls > 0 || entry.lineReadRecommendedLines !== null) && (
                        <span>Avg lines/read: {formatNumber(avgLines)}</span>
                      )}
                      {(entry.lineReadLinesTotal > 0 || entry.lineReadRecommendedLines !== null) && (
                        <span>Avg tokens/line: {avgTokensPerLine === null ? '-' : avgTokensPerLine.toFixed(2)}</span>
                      )}
                      {entry.lineReadRecommendedLines !== null && (
                        <span>Recommended lines: {formatNumber(entry.lineReadRecommendedLines)}</span>
                      )}
                      {entry.lineReadAllowanceTokens !== null && (
                        <span>Allowance: {formatNumber(entry.lineReadAllowanceTokens)} tok</span>
                      )}
                      {(entry.finishRejections > 0 || entry.semanticRepeatRejects > 0 || entry.stagnationWarnings > 0 || entry.forcedFinishFromStagnation > 0) && (
                        <span>Finish/Repeat/Stall/Forced: {formatNumber(entry.finishRejections)} / {formatNumber(entry.semanticRepeatRejects)} / {formatNumber(entry.stagnationWarnings)} / {formatNumber(entry.forcedFinishFromStagnation)}</span>
                      )}
                      {(entry.newEvidenceCalls > 0 || entry.noNewEvidenceCalls > 0) && (
                        <span>New / stale evidence: {formatNumber(entry.newEvidenceCalls)} / {formatNumber(entry.noNewEvidenceCalls)}</span>
                      )}
                      <span>Est rate: {estimatedRate.toFixed(1)}%</span>
                    </article>
                  );
                })}
              </div>
            ) : (
              <p className="hint">No tool metrics available yet.</p>
            )}
          </section>
        </div>
      </section>
      <section className="idle-summary-history">
        <h3>Per-Task Daily Metrics</h3>
        {taskRunsGraphSeries.length > 0 ? (
          <InteractiveGraph
            storageId="per-task-daily-runs"
            title="Per-Task Daily Metrics (Runs)"
            series={taskRunsGraphSeries}
          />
        ) : (
          <p className="hint">No per-task metrics available yet.</p>
        )}
      </section>
    </section>
  );
}
