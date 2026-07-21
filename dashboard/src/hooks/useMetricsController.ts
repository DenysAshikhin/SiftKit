import { useEffect, useState } from 'react';
import { getIdleSummary, getMetrics, getWebSearchQuota } from '../api';
import { buildTaskRunsSeries, buildToolMetricRows } from '../metrics-view';
import type { MetricSeries } from '../components/MetricChart';
import type { IdleSummarySnapshot, MetricDay, ProviderQuota, TaskMetricDay, ToolStatsByTask, WebSearchUsage } from '../types';
import type { MetricsTabProps } from '../tabs/MetricsTab';

export type MetricsController = {
  tabProps: MetricsTabProps;
  metricsError: string | null;
  webSearchUsage: WebSearchUsage | null;
  webSearchQuota: ProviderQuota[] | null;
};

export function useMetricsController(deps: { refreshToken: number; tab: string }): MetricsController {
  const [metrics, setMetrics] = useState<MetricDay[]>([]);
  const [taskMetrics, setTaskMetrics] = useState<TaskMetricDay[]>([]);
  const [toolMetrics, setToolMetrics] = useState<ToolStatsByTask | null>(null);
  const [webSearchUsage, setWebSearchUsage] = useState<WebSearchUsage | null>(null);
  const [webSearchQuota, setWebSearchQuota] = useState<ProviderQuota[] | null>(null);
  const [metricsError, setMetricsError] = useState<string | null>(null);
  const [idleSummarySnapshots, setIdleSummarySnapshots] = useState<IdleSummarySnapshot[]>([]);

  useEffect(() => {
    let cancelled = false;
    async function refreshMetrics() {
      try {
        const [response, idleSummaryResponse] = await Promise.all([
          getMetrics(),
          getIdleSummary(40),
        ]);
        if (!cancelled) {
          setMetrics(response.days);
          setTaskMetrics(Array.isArray(response.taskDays) ? response.taskDays : []);
          setToolMetrics(response.toolStats || null);
          setWebSearchUsage(response.webSearchUsage || null);
          setIdleSummarySnapshots(idleSummaryResponse.snapshots);
          setMetricsError(null);
        }
      } catch (error) {
        if (!cancelled) {
          setMetricsError(error instanceof Error ? error.message : String(error));
        }
      }
    }
    void refreshMetrics();
    return () => { cancelled = true; };
  }, [deps.refreshToken]);

  useEffect(() => {
    if (deps.tab !== 'metrics' && deps.tab !== 'settings') {
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const response = await getWebSearchQuota();
        if (!cancelled) {
          setWebSearchQuota(response.quotas);
        }
      } catch {
        if (!cancelled) {
          setWebSearchQuota(null);
        }
      }
    })();
    return () => { cancelled = true; };
  }, [deps.tab]);

  const latestIdleSnapshot = idleSummarySnapshots[0] || null;
  const recentIdlePoints = idleSummarySnapshots.slice(0, 20).reverse();
  const sortedToolMetricRows = buildToolMetricRows(toolMetrics);
  const taskRunsGraphSeries: MetricSeries[] = buildTaskRunsSeries(taskMetrics).map((entry) => ({
    key: entry.key,
    title: entry.title,
    unit: '',
    color: entry.color,
    points: entry.points,
  }));

  const tabProps: MetricsTabProps = {
    metrics,
    idleSummarySnapshots,
    recentIdlePoints,
    latestIdleSnapshot,
    sortedToolMetricRows,
    taskRunsGraphSeries,
    webSearchUsage,
    webSearchQuota,
  };

  return { tabProps, metricsError, webSearchUsage, webSearchQuota };
}
