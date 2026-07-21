import React from 'react';
import { MetricChart, type MetricSeries } from '../components/MetricChart';
import { CHART_COLORS } from '../lib/metric-chart-colors';
import {
  formatDate,
  formatNumber,
  formatSecondsFromMs,
  formatShortTime,
} from '../lib/format';
import { describeToolType, type ToolMetricRow } from '../metrics-view';
import type { IdleSummarySnapshot, MetricDay, ProviderQuota, WebSearchUsage } from '../types';

export type MetricsTabProps = {
  metrics: MetricDay[];
  idleSummarySnapshots: IdleSummarySnapshot[];
  recentIdlePoints: IdleSummarySnapshot[];
  latestIdleSnapshot: IdleSummarySnapshot | null;
  sortedToolMetricRows: ToolMetricRow[];
  taskRunsGraphSeries: MetricSeries[];
  webSearchUsage: WebSearchUsage | null;
  webSearchQuota: ProviderQuota[] | null;
};

function Tile({ label, value, small }: { label: string; value: string; small?: string }) {
  return (
    <div className="tile">
      <label>{label}</label>
      <span className="n">{value}{small ? <small> {small}</small> : null}</span>
    </div>
  );
}

function ToolMetricDetail({ entry }: { entry: ToolMetricRow }) {
  const avgLines = entry.lineReadCalls > 0 ? Math.round(entry.lineReadLinesTotal / entry.lineReadCalls) : 0;
  const avgTokensPerLine = entry.lineReadLinesTotal > 0 ? entry.lineReadTokensTotal / entry.lineReadLinesTotal : null;
  const insertedAvgTokens = entry.calls > 0 ? Math.round(entry.promptInsertedTokens / entry.calls) : 0;
  const rawAvgTokens = entry.calls > 0 ? Math.round(entry.rawToolResultTokens / entry.calls) : 0;
  const parts: string[] = [];
  if (entry.promptInsertedTokens > 0 || entry.rawToolResultTokens > 0) {
    parts.push(`inserted/raw tok ${formatNumber(insertedAvgTokens)} / ${formatNumber(rawAvgTokens)}`);
  }
  if (entry.lineReadCalls > 0 || entry.lineReadRecommendedLines !== null) {
    parts.push(`avg lines/read ${formatNumber(avgLines)}`);
  }
  if (entry.lineReadLinesTotal > 0 || entry.lineReadRecommendedLines !== null) {
    parts.push(`avg tokens/line ${avgTokensPerLine === null ? '-' : avgTokensPerLine.toFixed(2)}`);
  }
  if (entry.lineReadRecommendedLines !== null) {
    parts.push(`recommended lines ${formatNumber(entry.lineReadRecommendedLines)}`);
  }
  if (entry.lineReadAllowanceTokens !== null) {
    parts.push(`allowance ${formatNumber(entry.lineReadAllowanceTokens)} tok`);
  }
  if (entry.finishRejections > 0 || entry.semanticRepeatRejects > 0 || entry.stagnationWarnings > 0 || entry.forcedFinishFromStagnation > 0) {
    parts.push(`finish/repeat/stall/forced ${formatNumber(entry.finishRejections)} / ${formatNumber(entry.semanticRepeatRejects)} / ${formatNumber(entry.stagnationWarnings)} / ${formatNumber(entry.forcedFinishFromStagnation)}`);
  }
  if (entry.newEvidenceCalls > 0 || entry.noNewEvidenceCalls > 0) {
    parts.push(`new/stale evidence ${formatNumber(entry.newEvidenceCalls)} / ${formatNumber(entry.noNewEvidenceCalls)}`);
  }
  if (parts.length === 0) {
    return null;
  }
  return (
    <tr className="mtable-detail">
      <td colSpan={5}>{parts.join(' · ')}</td>
    </tr>
  );
}

export function MetricsTab({
  metrics,
  idleSummarySnapshots,
  recentIdlePoints,
  latestIdleSnapshot,
  sortedToolMetricRows,
  taskRunsGraphSeries,
  webSearchUsage,
  webSearchQuota,
}: MetricsTabProps) {
  return (
    <div className="metrics">
      <div className="graph-grid">
        <MetricChart
          storageId="daily-runs"
          title="Daily Runs"
          subtitle="last 14 days"
          series={[
            { key: 'runs', title: 'Runs', unit: '', color: CHART_COLORS.teal, points: metrics.map((day) => ({ label: day.date, value: day.runs })) },
            { key: 'success', title: 'Completed', unit: '', color: CHART_COLORS.blue, points: metrics.map((day) => ({ label: day.date, value: day.successCount })) },
            { key: 'failed', title: 'Failed', unit: '', color: CHART_COLORS.red, points: metrics.map((day) => ({ label: day.date, value: day.failureCount })) },
          ]}
        />
        <MetricChart
          storageId="daily-token-usage"
          title="Daily Token Usage"
          subtitle="last 14 days · tokens"
          series={[
            { key: 'input-tokens', title: 'Processed Input', unit: 'tok', color: CHART_COLORS.blue, points: metrics.map((day) => ({ label: day.date, value: day.inputTokens })) },
            { key: 'output-tokens', title: 'Output', unit: 'tok', color: CHART_COLORS.amber, points: metrics.map((day) => ({ label: day.date, value: day.outputTokens })) },
            { key: 'thinking-tokens', title: 'Thinking', unit: 'tok', color: '#d4a8ff', points: metrics.map((day) => ({ label: day.date, value: day.thinkingTokens })) },
            { key: 'tool-tokens', title: 'Tool', unit: 'tok', color: '#87d37c', points: metrics.map((day) => ({ label: day.date, value: day.toolTokens })) },
          ]}
        />
        <MetricChart
          storageId="daily-duration"
          title="Average Duration"
          subtitle="last 14 days · ms"
          series={[
            { key: 'avg-duration-ms', title: 'Avg Duration', unit: 'ms', color: CHART_COLORS.teal, points: metrics.map((day) => ({ label: day.date, value: day.avgDurationMs })) },
          ]}
        />
        <MetricChart
          storageId="prompt-cache-hit-rate"
          title="Prompt Cache Hit Rate"
          subtitle="last 14 days"
          series={[
            { key: 'cache-hit-rate', title: 'Cache Hit Rate', unit: '%', color: CHART_COLORS.teal, points: metrics.map((day) => ({ label: day.date, value: Number.isFinite(day.cacheHitRate) ? Number(day.cacheHitRate) * 100 : 0 })) },
            { key: 'cache-tokens', title: 'Cache Tokens', unit: 'tok', color: CHART_COLORS.blue, points: metrics.map((day) => ({ label: day.date, value: day.promptCacheTokens })) },
            { key: 'prompt-eval-tokens', title: 'Prompt Eval Tokens', unit: 'tok', color: CHART_COLORS.amber, points: metrics.map((day) => ({ label: day.date, value: day.promptEvalTokens })) },
          ]}
        />
        <MetricChart
          storageId="speculative-acceptance-rate"
          title="Speculative Acceptance Rate"
          subtitle="last 14 days"
          series={[
            { key: 'acceptance-rate', title: 'Acceptance Rate', unit: '%', color: CHART_COLORS.amber, points: metrics.map((day) => ({ label: day.date, value: Number.isFinite(day.acceptanceRate) ? Number(day.acceptanceRate) * 100 : 0 })) },
            { key: 'accepted-tokens', title: 'Accepted Tokens', unit: 'tok', color: CHART_COLORS.teal, points: metrics.map((day) => ({ label: day.date, value: day.speculativeAcceptedTokens })) },
            { key: 'generated-tokens', title: 'Generated Tokens', unit: 'tok', color: CHART_COLORS.blue, points: metrics.map((day) => ({ label: day.date, value: day.speculativeGeneratedTokens })) },
          ]}
        />
        {idleSummarySnapshots.length > 1 ? (
          <MetricChart
            storageId="recent-snapshot-totals"
            title="Recent Snapshot Totals"
            subtitle="idle snapshots"
            series={[
              { key: 'requests', title: 'Requests', unit: '', color: CHART_COLORS.teal, points: recentIdlePoints.map((snapshot) => ({ label: formatShortTime(snapshot.emittedAtUtc), value: snapshot.completedRequestCount })) },
              { key: 'input', title: 'Processed Input Tokens', unit: 'tok', color: CHART_COLORS.blue, points: recentIdlePoints.map((snapshot) => ({ label: formatShortTime(snapshot.emittedAtUtc), value: snapshot.inputTokensTotal })) },
              { key: 'output', title: 'Output Tokens', unit: 'tok', color: CHART_COLORS.amber, points: recentIdlePoints.map((snapshot) => ({ label: formatShortTime(snapshot.emittedAtUtc), value: snapshot.outputTokensTotal })) },
              { key: 'thinking', title: 'Thinking Tokens', unit: 'tok', color: '#d4a8ff', points: recentIdlePoints.map((snapshot) => ({ label: formatShortTime(snapshot.emittedAtUtc), value: snapshot.thinkingTokensTotal })) },
            ]}
          />
        ) : (
          <div className="graph-card">
            <h3>Recent Snapshot Totals</h3>
            <p className="hint">Waiting for additional idle snapshots.</p>
          </div>
        )}
      </div>

      <div className="graph-card">
        <h3>Tool metrics</h3>
        {sortedToolMetricRows.length > 0 ? (
          <table className="mtable">
            <thead>
              <tr>
                <th>Tool</th>
                <th className="num">Calls</th>
                <th className="num">Avg chars</th>
                <th className="num">Avg tokens</th>
                <th className="num">Est rate</th>
              </tr>
            </thead>
            <tbody>
              {sortedToolMetricRows.map((entry) => {
                const avgChars = entry.calls > 0 ? Math.round(entry.outputCharsTotal / entry.calls) : 0;
                const avgTokens = entry.calls > 0 ? Math.round(entry.outputTokensTotal / entry.calls) : 0;
                const estimatedRate = entry.calls > 0 ? (entry.outputTokensEstimatedCount / entry.calls) * 100 : 0;
                return (
                  <React.Fragment key={entry.toolType}>
                    <tr title={describeToolType(entry.toolType)}>
                      <td>{entry.toolType}</td>
                      <td className="num">{formatNumber(entry.calls)}</td>
                      <td className="num">{formatNumber(avgChars)}</td>
                      <td className="num">{formatNumber(avgTokens)}</td>
                      <td className="num">{estimatedRate.toFixed(1)}%</td>
                    </tr>
                    <ToolMetricDetail entry={entry} />
                  </React.Fragment>
                );
              })}
            </tbody>
          </table>
        ) : (
          <p className="hint">No tool metrics available yet.</p>
        )}
      </div>

      <div className="graph-card">
        <h3>Live Idle Summary</h3>
        {latestIdleSnapshot ? (
          <>
            <p className="hint">Latest: {formatDate(latestIdleSnapshot.emittedAtUtc)}</p>
            <div className="tiles">
              <Tile label="Requests" value={formatNumber(latestIdleSnapshot.completedRequestCount)} />
              <Tile label="Avg request" value={formatSecondsFromMs(latestIdleSnapshot.avgRequestMs)} />
              <Tile label="Gen tokens/s" value={formatNumber(latestIdleSnapshot.avgTokensPerSecond)} />
              <Tile
                label="Processed Input / Output / Thinking"
                value={`${formatNumber(latestIdleSnapshot.inputTokensTotal)} / ${formatNumber(latestIdleSnapshot.outputTokensTotal)} / ${formatNumber(latestIdleSnapshot.thinkingTokensTotal)}`}
              />
              <Tile
                label="Input / Output Ratio"
                value={Number.isFinite(latestIdleSnapshot.inputOutputRatio) ? `${Number(latestIdleSnapshot.inputOutputRatio).toFixed(2)}x` : '-'}
              />
            </div>
          </>
        ) : (
          <p className="hint">No snapshots yet. A summary appears when the backend reaches idle state.</p>
        )}
      </div>

      <div className="graph-card">
        <h3>Web Search</h3>
        {webSearchUsage ? (
          <div className="tiles">
            <Tile label={`This month (${webSearchUsage.currentMonth})`} value={formatNumber(webSearchUsage.currentMonthCount)} />
            <Tile label="All-time" value={formatNumber(webSearchUsage.allTimeCount)} />
            {(webSearchQuota ?? []).map((quota) => (
              <Tile
                key={quota.provider}
                label={`${quota.provider} credits left`}
                value={quota.remaining !== null ? formatNumber(quota.remaining) : '-'}
                small={quota.limit !== null ? `of ${formatNumber(quota.limit)}` : 'limit unknown'}
              />
            ))}
          </div>
        ) : (
          <p className="hint">No searches recorded yet.</p>
        )}
      </div>

      {taskRunsGraphSeries.length > 0 ? (
        <MetricChart storageId="per-task-daily-runs" title="Per-Task Daily Metrics (Runs)" subtitle="runs" series={taskRunsGraphSeries} />
      ) : (
        <div className="graph-card">
          <h3>Per-Task Daily Metrics</h3>
          <p className="hint">No per-task metrics available yet.</p>
        </div>
      )}
    </div>
  );
}
