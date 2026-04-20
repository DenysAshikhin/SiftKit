import Database from 'better-sqlite3';

import type { SiftConfig } from '../../config/index.js';
import {
  TASK_KINDS,
  type Metrics,
  type ToolTypeStats,
  type TaskKind,
  type ToolStatsByTask,
  normalizeMetrics,
} from '../metrics.js';
import {
  aggregateGlobalToolStats,
  buildLineReadGuidance,
  getPlannerPromptBaselinePerToolAllowanceTokens,
  getRepoSearchPromptBaselinePerToolAllowanceTokens,
} from '../../line-read-guidance.js';
import {
  type SnapshotTotals,
  parseSnapshotTaskTotalsJson,
  parseSnapshotToolStatsJson,
  queryRecentSnapshots,
  querySnapshotTotalsBeforeDate,
  querySnapshotTimeseries,
} from '../idle-summary.js';
import type { RunRecord } from '../dashboard-runs.js';

type DatabaseInstance = InstanceType<typeof Database>;

export { type SnapshotTotals } from '../idle-summary.js';

export function getPromptCacheHitRate(promptCacheTokens: unknown, promptEvalTokens: unknown): number | null {
  const cacheTokens = Number(promptCacheTokens) || 0;
  const evalTokens = Number(promptEvalTokens) || 0;
  const totalPromptTokens = cacheTokens + evalTokens;
  if (totalPromptTokens <= 0) {
    return null;
  }
  return cacheTokens / totalPromptTokens;
}

export function getAcceptanceRate(speculativeAcceptedTokens: unknown, speculativeGeneratedTokens: unknown): number | null {
  const acceptedTokens = Number(speculativeAcceptedTokens) || 0;
  const generatedTokens = Number(speculativeGeneratedTokens) || 0;
  if (generatedTokens <= 0) {
    return null;
  }
  return acceptedTokens / generatedTokens;
}

export function getCurrentUtcDateKey(): string {
  return new Date().toISOString().slice(0, 10);
}

export function getSnapshotTotalsBeforeDate(database: DatabaseInstance | null, dateKey: string): SnapshotTotals | null {
  return querySnapshotTotalsBeforeDate(database, dateKey);
}

export type DailyMetrics = {
  date: string;
  runs: number;
  inputTokens: number;
  outputTokens: number;
  thinkingTokens: number;
  toolTokens: number;
  promptCacheTokens: number;
  promptEvalTokens: number;
  speculativeAcceptedTokens: number;
  speculativeGeneratedTokens: number;
  cacheHitRate: number | null;
  acceptanceRate: number | null;
  successCount: number;
  failureCount: number;
  avgDurationMs: number;
};

type DailyAccumulator = DailyMetrics & { durationTotalMs: number; durationCount: number };

function getEmptyDailyAccumulator(date: string): DailyAccumulator {
  return {
    date,
    runs: 0,
    inputTokens: 0,
    outputTokens: 0,
    thinkingTokens: 0,
    toolTokens: 0,
    promptCacheTokens: 0,
    promptEvalTokens: 0,
    speculativeAcceptedTokens: 0,
    speculativeGeneratedTokens: 0,
    cacheHitRate: null,
    acceptanceRate: null,
    successCount: 0,
    failureCount: 0,
    avgDurationMs: 0,
    durationTotalMs: 0,
    durationCount: 0,
  };
}

function finalizeDailyMetrics(byDay: Map<string, DailyAccumulator>): DailyMetrics[] {
  return Array.from(byDay.values())
    .sort((left, right) => left.date.localeCompare(right.date))
    .map((entry) => ({
      date: entry.date,
      runs: entry.runs,
      inputTokens: entry.inputTokens,
      outputTokens: entry.outputTokens,
      thinkingTokens: entry.thinkingTokens,
      toolTokens: entry.toolTokens,
      promptCacheTokens: entry.promptCacheTokens,
      promptEvalTokens: entry.promptEvalTokens,
      speculativeAcceptedTokens: entry.speculativeAcceptedTokens,
      speculativeGeneratedTokens: entry.speculativeGeneratedTokens,
      cacheHitRate: getPromptCacheHitRate(entry.promptCacheTokens, entry.promptEvalTokens),
      acceptanceRate: getAcceptanceRate(entry.speculativeAcceptedTokens, entry.speculativeGeneratedTokens),
      successCount: entry.successCount,
      failureCount: entry.failureCount,
      avgDurationMs: entry.durationCount > 0 ? Math.round(entry.durationTotalMs / entry.durationCount) : 0,
    }));
}

export function buildLiveTodayMetrics(currentMetrics: Metrics, idleSummaryDatabase: DatabaseInstance | null): DailyMetrics {
  const day = getCurrentUtcDateKey();
  const totals = normalizeMetrics(currentMetrics);
  const baseline = getSnapshotTotalsBeforeDate(idleSummaryDatabase, day);
  const completedRequestCount = Number(totals.completedRequestCount) || 0;
  const inputTokensTotal = Number(totals.inputTokensTotal) || 0;
  const outputTokensTotal = Number(totals.outputTokensTotal) || 0;
  const thinkingTokensTotal = Number(totals.thinkingTokensTotal) || 0;
  const toolTokensTotal = Number(totals.toolTokensTotal) || 0;
  const promptCacheTokensTotal = Number(totals.promptCacheTokensTotal) || 0;
  const promptEvalTokensTotal = Number(totals.promptEvalTokensTotal) || 0;
  const speculativeAcceptedTokensTotal = Number(totals.speculativeAcceptedTokensTotal) || 0;
  const speculativeGeneratedTokensTotal = Number(totals.speculativeGeneratedTokensTotal) || 0;
  const requestDurationMsTotal = Number(totals.requestDurationMsTotal) || 0;
  const runs = Math.max(0, completedRequestCount - (baseline ? baseline.completedRequestCount : 0));
  const inputTokens = Math.max(0, inputTokensTotal - (baseline ? baseline.inputTokensTotal : 0));
  const outputTokens = Math.max(0, outputTokensTotal - (baseline ? baseline.outputTokensTotal : 0));
  const thinkingTokens = Math.max(0, thinkingTokensTotal - (baseline ? baseline.thinkingTokensTotal : 0));
  const toolTokens = Math.max(0, toolTokensTotal - (baseline ? baseline.toolTokensTotal : 0));
  const promptCacheTokens = Math.max(0, promptCacheTokensTotal - (baseline ? baseline.promptCacheTokensTotal : 0));
  const promptEvalTokens = Math.max(0, promptEvalTokensTotal - (baseline ? baseline.promptEvalTokensTotal : 0));
  const speculativeAcceptedTokens = Math.max(0, speculativeAcceptedTokensTotal - (baseline ? baseline.speculativeAcceptedTokensTotal : 0));
  const speculativeGeneratedTokens = Math.max(0, speculativeGeneratedTokensTotal - (baseline ? baseline.speculativeGeneratedTokensTotal : 0));
  const durationTotalMs = Math.max(0, requestDurationMsTotal - (baseline ? baseline.requestDurationMsTotal : 0));
  return {
    date: day,
    runs,
    inputTokens,
    outputTokens,
    thinkingTokens,
    toolTokens,
    promptCacheTokens,
    promptEvalTokens,
    speculativeAcceptedTokens,
    speculativeGeneratedTokens,
    cacheHitRate: getPromptCacheHitRate(promptCacheTokens, promptEvalTokens),
    acceptanceRate: getAcceptanceRate(speculativeAcceptedTokens, speculativeGeneratedTokens),
    successCount: 0,
    failureCount: 0,
    avgDurationMs: runs > 0 ? Math.round(durationTotalMs / runs) : 0,
  };
}

export function buildDashboardDailyMetricsFromRuns(runs: RunRecord[]): DailyMetrics[] {
  const byDay = new Map<string, DailyAccumulator>();
  for (const run of runs) {
    const startedAt = run.startedAtUtc || new Date(0).toISOString();
    const day = startedAt.slice(0, 10);
    const current = byDay.get(day) || getEmptyDailyAccumulator(day);
    current.runs += 1;
    current.inputTokens += Number(run.inputTokens || 0);
    current.outputTokens += Number(run.outputTokens || 0);
    current.thinkingTokens += Number(run.thinkingTokens || 0);
    current.toolTokens += Number(run.toolTokens || 0);
    current.promptCacheTokens += Number(run.promptCacheTokens || 0);
    current.promptEvalTokens += Number(run.promptEvalTokens || 0);
    current.speculativeAcceptedTokens += Number(run.speculativeAcceptedTokens || 0);
    current.speculativeGeneratedTokens += Number(run.speculativeGeneratedTokens || 0);
    if (run.status === 'completed') {
      current.successCount += 1;
    } else {
      current.failureCount += 1;
    }
    if (Number.isFinite(run.durationMs) && Number(run.durationMs) >= 0) {
      current.durationTotalMs += Number(run.durationMs);
      current.durationCount += 1;
    }
    byDay.set(day, current);
  }
  return finalizeDailyMetrics(byDay);
}

export function buildDashboardDailyMetricsFromIdleSnapshots(database: DatabaseInstance | null): DailyMetrics[] {
  const rows = querySnapshotTimeseries(database);
  if (!Array.isArray(rows) || rows.length === 0) {
    return [];
  }
  const byDay = new Map<string, DailyAccumulator>();
  let previous: SnapshotTotals | null = null;
  for (const row of rows) {
    const emittedAtUtc = typeof row.emitted_at_utc === 'string' ? row.emitted_at_utc : null;
    if (!emittedAtUtc) {
      continue;
    }
    const day = emittedAtUtc.slice(0, 10);
    const current = byDay.get(day) || getEmptyDailyAccumulator(day);
    const completedRequestCount = Number(row.completed_request_count) || 0;
    const inputTokensTotal = Number(row.input_tokens_total) || 0;
    const outputTokensTotal = Number(row.output_tokens_total) || 0;
    const thinkingTokensTotal = Number(row.thinking_tokens_total) || 0;
    const promptCacheTokensTotal = Number(row.prompt_cache_tokens_total) || 0;
    const promptEvalTokensTotal = Number(row.prompt_eval_tokens_total) || 0;
    const speculativeAcceptedTokensTotal = Number(row.speculative_accepted_tokens_total) || 0;
    const speculativeGeneratedTokensTotal = Number(row.speculative_generated_tokens_total) || 0;
    const toolTokensTotal = Number(row.tool_tokens_total) || 0;
    const taskTotals = parseSnapshotTaskTotalsJson(row.task_totals_json);
    const requestDurationMsTotal = Number(row.request_duration_ms_total) || 0;
    const deltaRuns = Math.max(0, previous ? completedRequestCount - previous.completedRequestCount : completedRequestCount);
    current.runs += deltaRuns;
    current.inputTokens += Math.max(0, previous ? inputTokensTotal - previous.inputTokensTotal : inputTokensTotal);
    current.outputTokens += Math.max(0, previous ? outputTokensTotal - previous.outputTokensTotal : outputTokensTotal);
    current.thinkingTokens += Math.max(0, previous ? thinkingTokensTotal - previous.thinkingTokensTotal : thinkingTokensTotal);
    current.toolTokens += Math.max(0, previous ? toolTokensTotal - previous.toolTokensTotal : toolTokensTotal);
    current.promptCacheTokens += Math.max(0, previous ? promptCacheTokensTotal - previous.promptCacheTokensTotal : promptCacheTokensTotal);
    current.promptEvalTokens += Math.max(0, previous ? promptEvalTokensTotal - previous.promptEvalTokensTotal : promptEvalTokensTotal);
    current.speculativeAcceptedTokens += Math.max(0, previous ? speculativeAcceptedTokensTotal - previous.speculativeAcceptedTokensTotal : speculativeAcceptedTokensTotal);
    current.speculativeGeneratedTokens += Math.max(0, previous ? speculativeGeneratedTokensTotal - previous.speculativeGeneratedTokensTotal : speculativeGeneratedTokensTotal);
    current.durationTotalMs += Math.max(0, previous ? requestDurationMsTotal - previous.requestDurationMsTotal : requestDurationMsTotal);
    current.durationCount += deltaRuns;
    byDay.set(day, current);
    previous = {
      completedRequestCount,
      inputTokensTotal,
      outputTokensTotal,
      thinkingTokensTotal,
      toolTokensTotal,
      promptCacheTokensTotal,
      promptEvalTokensTotal,
      speculativeAcceptedTokensTotal,
      speculativeGeneratedTokensTotal,
      requestDurationMsTotal,
      taskTotals,
    };
  }
  return finalizeDailyMetrics(byDay);
}

export function buildDashboardDailyMetrics(
  runs: RunRecord[],
  idleSummaryDatabase: DatabaseInstance | null,
  currentMetrics: Metrics,
): DailyMetrics[] {
  const runDays = buildDashboardDailyMetricsFromRuns(runs);
  const runByDay = new Map(runDays.map((day) => [day.date, day] as const));
  const liveToday = buildLiveTodayMetrics(currentMetrics, idleSummaryDatabase);
  const snapshotDays = buildDashboardDailyMetricsFromIdleSnapshots(idleSummaryDatabase);
  if (snapshotDays.length > 0) {
    const merged = snapshotDays.map((day) => {
      const runDay = runByDay.get(day.date);
      if (!runDay) {
        return day;
      }
      return {
        ...day,
        successCount: runDay.successCount,
        failureCount: runDay.failureCount,
      };
    });
    const todayRunDay = runByDay.get(liveToday.date);
    const liveTodayMerged = todayRunDay
      ? { ...liveToday, successCount: todayRunDay.successCount, failureCount: todayRunDay.failureCount }
      : liveToday;
    const mergedWithoutToday = merged.filter((day) => day.date !== liveToday.date);
    return [...mergedWithoutToday, liveTodayMerged].sort((left, right) => left.date.localeCompare(right.date));
  }
  const todayRunDay = runByDay.get(liveToday.date);
  const liveTodayMerged = todayRunDay
    ? { ...liveToday, successCount: todayRunDay.successCount, failureCount: todayRunDay.failureCount }
    : liveToday;
  const runDaysWithoutToday = runDays.filter((day) => day.date !== liveToday.date);
  return [...runDaysWithoutToday, liveTodayMerged].sort((left, right) => left.date.localeCompare(right.date));
}

export type TaskDailyMetrics = {
  date: string;
  taskKind: TaskKind;
  runs: number;
  inputTokens: number;
  outputTokens: number;
  thinkingTokens: number;
  toolTokens: number;
  promptCacheTokens: number;
  promptEvalTokens: number;
  avgDurationMs: number;
};

type TaskDailyAccumulator = TaskDailyMetrics & { durationTotalMs: number; durationCount: number };

function getEmptyTaskDailyAccumulator(date: string, taskKind: TaskKind): TaskDailyAccumulator {
  return {
    date,
    taskKind,
    runs: 0,
    inputTokens: 0,
    outputTokens: 0,
    thinkingTokens: 0,
    toolTokens: 0,
    promptCacheTokens: 0,
    promptEvalTokens: 0,
    avgDurationMs: 0,
    durationTotalMs: 0,
    durationCount: 0,
  };
}

function toTaskAccumulatorMap(days: TaskDailyMetrics[]): Map<string, TaskDailyAccumulator> {
  const map = new Map<string, TaskDailyAccumulator>();
  for (const day of days) {
    const key = `${day.date}|${day.taskKind}`;
    map.set(key, {
      ...day,
      durationTotalMs: Number(day.avgDurationMs || 0) * Number(day.runs || 0),
      durationCount: Number(day.runs || 0),
    });
  }
  return map;
}

export function buildLiveTodayTaskDailyMetrics(currentMetrics: Metrics, idleSummaryDatabase: DatabaseInstance | null): TaskDailyMetrics[] {
  const date = getCurrentUtcDateKey();
  const totals = normalizeMetrics(currentMetrics);
  const baseline = getSnapshotTotalsBeforeDate(idleSummaryDatabase, date);
  return TASK_KINDS.map((taskKind) => {
    const current = totals.taskTotals[taskKind];
    const previous = baseline ? baseline.taskTotals[taskKind] : null;
    const runs = Math.max(0, Number(current.completedRequestCount || 0) - Number(previous?.completedRequestCount || 0));
    const inputTokens = Math.max(0, Number(current.inputTokensTotal || 0) - Number(previous?.inputTokensTotal || 0));
    const outputTokens = Math.max(0, Number(current.outputTokensTotal || 0) - Number(previous?.outputTokensTotal || 0));
    const thinkingTokens = Math.max(0, Number(current.thinkingTokensTotal || 0) - Number(previous?.thinkingTokensTotal || 0));
    const toolTokens = Math.max(0, Number(current.toolTokensTotal || 0) - Number(previous?.toolTokensTotal || 0));
    const promptCacheTokens = Math.max(0, Number(current.promptCacheTokensTotal || 0) - Number(previous?.promptCacheTokensTotal || 0));
    const promptEvalTokens = Math.max(0, Number(current.promptEvalTokensTotal || 0) - Number(previous?.promptEvalTokensTotal || 0));
    const durationTotalMs = Math.max(0, Number(current.requestDurationMsTotal || 0) - Number(previous?.requestDurationMsTotal || 0));
    return {
      date,
      taskKind,
      runs,
      inputTokens,
      outputTokens,
      thinkingTokens,
      toolTokens,
      promptCacheTokens,
      promptEvalTokens,
      avgDurationMs: runs > 0 ? Math.round(durationTotalMs / runs) : 0,
    };
  });
}

export function buildDashboardTaskDailyMetricsFromIdleSnapshots(database: DatabaseInstance | null): TaskDailyMetrics[] {
  const rows = querySnapshotTimeseries(database);
  if (!Array.isArray(rows) || rows.length === 0) {
    return [];
  }
  const byKey = new Map<string, TaskDailyAccumulator>();
  let previousTaskTotals = parseSnapshotTaskTotalsJson(null);
  for (const row of rows) {
    const emittedAtUtc = typeof row.emitted_at_utc === 'string' ? row.emitted_at_utc : null;
    if (!emittedAtUtc) {
      continue;
    }
    const day = emittedAtUtc.slice(0, 10);
    const taskTotals = parseSnapshotTaskTotalsJson(row.task_totals_json);
    for (const taskKind of TASK_KINDS) {
      const key = `${day}|${taskKind}`;
      const current = byKey.get(key) || getEmptyTaskDailyAccumulator(day, taskKind);
      const currentTotals = taskTotals[taskKind];
      const previousTotals = previousTaskTotals[taskKind];
      const deltaRuns = Math.max(0, Number(currentTotals.completedRequestCount || 0) - Number(previousTotals.completedRequestCount || 0));
      current.runs += deltaRuns;
      current.inputTokens += Math.max(0, Number(currentTotals.inputTokensTotal || 0) - Number(previousTotals.inputTokensTotal || 0));
      current.outputTokens += Math.max(0, Number(currentTotals.outputTokensTotal || 0) - Number(previousTotals.outputTokensTotal || 0));
      current.thinkingTokens += Math.max(0, Number(currentTotals.thinkingTokensTotal || 0) - Number(previousTotals.thinkingTokensTotal || 0));
      current.toolTokens += Math.max(0, Number(currentTotals.toolTokensTotal || 0) - Number(previousTotals.toolTokensTotal || 0));
      current.promptCacheTokens += Math.max(0, Number(currentTotals.promptCacheTokensTotal || 0) - Number(previousTotals.promptCacheTokensTotal || 0));
      current.promptEvalTokens += Math.max(0, Number(currentTotals.promptEvalTokensTotal || 0) - Number(previousTotals.promptEvalTokensTotal || 0));
      current.durationTotalMs += Math.max(0, Number(currentTotals.requestDurationMsTotal || 0) - Number(previousTotals.requestDurationMsTotal || 0));
      current.durationCount += deltaRuns;
      byKey.set(key, current);
    }
    previousTaskTotals = taskTotals;
  }
  return Array.from(byKey.values())
    .sort((left, right) => left.date.localeCompare(right.date) || left.taskKind.localeCompare(right.taskKind))
    .map((entry) => ({
      date: entry.date,
      taskKind: entry.taskKind,
      runs: entry.runs,
      inputTokens: entry.inputTokens,
      outputTokens: entry.outputTokens,
      thinkingTokens: entry.thinkingTokens,
      toolTokens: entry.toolTokens,
      promptCacheTokens: entry.promptCacheTokens,
      promptEvalTokens: entry.promptEvalTokens,
      avgDurationMs: entry.durationCount > 0 ? Math.round(entry.durationTotalMs / entry.durationCount) : 0,
    }));
}

export function buildDashboardTaskDailyMetrics(idleSummaryDatabase: DatabaseInstance | null, currentMetrics: Metrics): TaskDailyMetrics[] {
  const snapshotDays = buildDashboardTaskDailyMetricsFromIdleSnapshots(idleSummaryDatabase);
  const liveToday = buildLiveTodayTaskDailyMetrics(currentMetrics, idleSummaryDatabase);
  if (snapshotDays.length === 0) {
    return liveToday;
  }
  const today = getCurrentUtcDateKey();
  const merged = toTaskAccumulatorMap(snapshotDays.filter((entry) => entry.date !== today));
  for (const liveEntry of liveToday) {
    const key = `${liveEntry.date}|${liveEntry.taskKind}`;
    merged.set(key, {
      ...liveEntry,
      durationTotalMs: Number(liveEntry.avgDurationMs || 0) * Number(liveEntry.runs || 0),
      durationCount: Number(liveEntry.runs || 0),
    });
  }
  return Array.from(merged.values())
    .sort((left, right) => left.date.localeCompare(right.date) || left.taskKind.localeCompare(right.taskKind))
    .map((entry) => ({
      date: entry.date,
      taskKind: entry.taskKind,
      runs: entry.runs,
      inputTokens: entry.inputTokens,
      outputTokens: entry.outputTokens,
      thinkingTokens: entry.thinkingTokens,
      toolTokens: entry.toolTokens,
      promptCacheTokens: entry.promptCacheTokens,
      promptEvalTokens: entry.promptEvalTokens,
      avgDurationMs: entry.avgDurationMs,
    }));
}

export function buildDashboardToolStats(
  idleSummaryDatabase: DatabaseInstance | null,
  currentMetrics: Metrics,
  config: SiftConfig,
): ToolStatsByTask {
  const currentToolStats = normalizeMetrics(currentMetrics).toolStats;
  const latestSnapshotRow = idleSummaryDatabase ? queryRecentSnapshots(idleSummaryDatabase, 1)[0] : null;
  const latestSnapshotToolStats = latestSnapshotRow ? parseSnapshotToolStatsJson(latestSnapshotRow.tool_stats_json) : null;
  const baseToolStats = latestSnapshotToolStats && Object.values(latestSnapshotToolStats).some((entry) => Object.keys(entry || {}).length > 0)
    ? latestSnapshotToolStats
    : currentToolStats;
  const globalToolStats = aggregateGlobalToolStats(baseToolStats);
  let repoSearchAllowance: number | null = null;
  let plannerAllowance: number | null = null;
  try {
    repoSearchAllowance = getRepoSearchPromptBaselinePerToolAllowanceTokens(config);
  } catch {
    repoSearchAllowance = null;
  }
  try {
    plannerAllowance = getPlannerPromptBaselinePerToolAllowanceTokens(config);
  } catch {
    plannerAllowance = null;
  }
  const result = {} as ToolStatsByTask;
  for (const taskKind of TASK_KINDS) {
    const nextByTool: Record<string, ToolTypeStats> = {};
    for (const [toolType, stats] of Object.entries(baseToolStats[taskKind] || {})) {
      const guidance = buildLineReadGuidance({
        toolName: toolType,
        toolStats: globalToolStats,
        perToolAllowanceTokens: toolType === 'get-content'
          ? repoSearchAllowance
          : toolType === 'read_lines'
            ? plannerAllowance
            : null,
      });
      nextByTool[toolType] = guidance
        ? {
          ...stats,
          lineReadRecommendedLines: guidance.recommendedLines,
          lineReadAllowanceTokens: guidance.perToolAllowanceTokens,
        }
        : { ...stats };
    }
    result[taskKind] = nextByTool;
  }
  return result;
}
