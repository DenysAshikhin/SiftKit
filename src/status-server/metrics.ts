import * as fs from 'node:fs';
import type { Dict } from '../lib/types.js';
import { writeText } from '../lib/fs.js';
import { createEmptyToolTypeStats } from '../line-read-guidance.js';

export const METRICS_SCHEMA_VERSION = 2;
export const TASK_KINDS = ['summary', 'plan', 'repo-search', 'chat'] as const;
export type TaskKind = typeof TASK_KINDS[number];

export type MetricTotals = {
  inputCharactersTotal: number;
  outputCharactersTotal: number;
  inputTokensTotal: number;
  outputTokensTotal: number;
  thinkingTokensTotal: number;
  toolTokensTotal: number;
  promptCacheTokensTotal: number;
  promptEvalTokensTotal: number;
  requestDurationMsTotal: number;
  completedRequestCount: number;
};

export type ToolTypeStats = {
  calls: number;
  outputCharsTotal: number;
  outputTokensTotal: number;
  outputTokensEstimatedCount: number;
  lineReadCalls: number;
  lineReadLinesTotal: number;
  lineReadTokensTotal: number;
  finishRejections: number;
  semanticRepeatRejects: number;
  stagnationWarnings: number;
  forcedFinishFromStagnation: number;
  promptInsertedTokens: number;
  rawToolResultTokens: number;
  newEvidenceCalls: number;
  noNewEvidenceCalls: number;
  lineReadRecommendedLines?: number;
  lineReadAllowanceTokens?: number;
};

export type ToolStatsByTask = Record<TaskKind, Record<string, ToolTypeStats>>;
export type TaskTotals = Record<TaskKind, MetricTotals>;

export type Metrics = {
  schemaVersion: number;
  inputCharactersTotal: number;
  outputCharactersTotal: number;
  inputTokensTotal: number;
  outputTokensTotal: number;
  thinkingTokensTotal: number;
  toolTokensTotal: number;
  promptCacheTokensTotal: number;
  promptEvalTokensTotal: number;
  requestDurationMsTotal: number;
  completedRequestCount: number;
  taskTotals: TaskTotals;
  toolStats: ToolStatsByTask;
  updatedAtUtc: string | null;
  inputCharactersPerContextToken?: number | null;
  chunkThresholdCharacters?: number | null;
};

function getDefaultMetricTotals(): MetricTotals {
  return {
    inputCharactersTotal: 0,
    outputCharactersTotal: 0,
    inputTokensTotal: 0,
    outputTokensTotal: 0,
    thinkingTokensTotal: 0,
    toolTokensTotal: 0,
    promptCacheTokensTotal: 0,
    promptEvalTokensTotal: 0,
    requestDurationMsTotal: 0,
    completedRequestCount: 0,
  };
}

function getDefaultTaskTotals(): TaskTotals {
  return {
    summary: getDefaultMetricTotals(),
    plan: getDefaultMetricTotals(),
    'repo-search': getDefaultMetricTotals(),
    chat: getDefaultMetricTotals(),
  };
}

function getDefaultToolStats(): ToolStatsByTask {
  return {
    summary: {},
    plan: {},
    'repo-search': {},
    chat: {},
  };
}

export function getDefaultMetrics(): Metrics {
  return {
    schemaVersion: METRICS_SCHEMA_VERSION,
    inputCharactersTotal: 0,
    outputCharactersTotal: 0,
    inputTokensTotal: 0,
    outputTokensTotal: 0,
    thinkingTokensTotal: 0,
    toolTokensTotal: 0,
    promptCacheTokensTotal: 0,
    promptEvalTokensTotal: 0,
    requestDurationMsTotal: 0,
    completedRequestCount: 0,
    taskTotals: getDefaultTaskTotals(),
    toolStats: getDefaultToolStats(),
    updatedAtUtc: null,
  };
}

function normalizeNonNegativeNumber(value: unknown): number | null {
  return Number.isFinite(value) && Number(value) >= 0 ? Number(value) : null;
}

function normalizeMetricTotals(input: unknown): MetricTotals {
  const totals = getDefaultMetricTotals();
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return totals;
  }
  const record = input as Dict;
  const fields: Array<keyof MetricTotals> = [
    'inputCharactersTotal',
    'outputCharactersTotal',
    'inputTokensTotal',
    'outputTokensTotal',
    'thinkingTokensTotal',
    'toolTokensTotal',
    'promptCacheTokensTotal',
    'promptEvalTokensTotal',
    'requestDurationMsTotal',
    'completedRequestCount',
  ];
  for (const field of fields) {
    const normalized = normalizeNonNegativeNumber(record[field]);
    if (normalized !== null) {
      totals[field] = normalized;
    }
  }
  return totals;
}

function normalizeToolTypeStats(input: unknown): ToolTypeStats | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return null;
  }
  const record = input as Dict;
  const calls = normalizeNonNegativeNumber(record.calls);
  const outputCharsTotal = normalizeNonNegativeNumber(record.outputCharsTotal);
  const outputTokensTotal = normalizeNonNegativeNumber(record.outputTokensTotal);
  const outputTokensEstimatedCount = normalizeNonNegativeNumber(record.outputTokensEstimatedCount);
  const lineReadCalls = normalizeNonNegativeNumber(record.lineReadCalls);
  const lineReadLinesTotal = normalizeNonNegativeNumber(record.lineReadLinesTotal);
  const lineReadTokensTotal = normalizeNonNegativeNumber(record.lineReadTokensTotal);
  const finishRejections = normalizeNonNegativeNumber(record.finishRejections);
  const semanticRepeatRejects = normalizeNonNegativeNumber(record.semanticRepeatRejects);
  const stagnationWarnings = normalizeNonNegativeNumber(record.stagnationWarnings);
  const forcedFinishFromStagnation = normalizeNonNegativeNumber(record.forcedFinishFromStagnation);
  const promptInsertedTokens = normalizeNonNegativeNumber(record.promptInsertedTokens);
  const rawToolResultTokens = normalizeNonNegativeNumber(record.rawToolResultTokens);
  const newEvidenceCalls = normalizeNonNegativeNumber(record.newEvidenceCalls);
  const noNewEvidenceCalls = normalizeNonNegativeNumber(record.noNewEvidenceCalls);
  if (
    calls === null
    && outputCharsTotal === null
    && outputTokensTotal === null
    && outputTokensEstimatedCount === null
    && lineReadCalls === null
    && lineReadLinesTotal === null
    && lineReadTokensTotal === null
    && finishRejections === null
    && semanticRepeatRejects === null
    && stagnationWarnings === null
    && forcedFinishFromStagnation === null
    && promptInsertedTokens === null
    && rawToolResultTokens === null
    && newEvidenceCalls === null
    && noNewEvidenceCalls === null
  ) {
    return null;
  }
  return {
    ...createEmptyToolTypeStats(),
    calls: calls ?? 0,
    outputCharsTotal: outputCharsTotal ?? 0,
    outputTokensTotal: outputTokensTotal ?? 0,
    outputTokensEstimatedCount: outputTokensEstimatedCount ?? 0,
    lineReadCalls: lineReadCalls ?? 0,
    lineReadLinesTotal: lineReadLinesTotal ?? 0,
    lineReadTokensTotal: lineReadTokensTotal ?? 0,
    finishRejections: finishRejections ?? 0,
    semanticRepeatRejects: semanticRepeatRejects ?? 0,
    stagnationWarnings: stagnationWarnings ?? 0,
    forcedFinishFromStagnation: forcedFinishFromStagnation ?? 0,
    promptInsertedTokens: promptInsertedTokens ?? 0,
    rawToolResultTokens: rawToolResultTokens ?? 0,
    newEvidenceCalls: newEvidenceCalls ?? 0,
    noNewEvidenceCalls: noNewEvidenceCalls ?? 0,
  };
}

function normalizeTaskTotals(input: unknown): TaskTotals {
  const totals = getDefaultTaskTotals();
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return totals;
  }
  const record = input as Dict;
  for (const taskKind of TASK_KINDS) {
    totals[taskKind] = normalizeMetricTotals(record[taskKind]);
  }
  return totals;
}

function normalizeToolStats(input: unknown): ToolStatsByTask {
  const toolStats = getDefaultToolStats();
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return toolStats;
  }
  const record = input as Dict;
  for (const taskKind of TASK_KINDS) {
    const taskRecord = record[taskKind];
    if (!taskRecord || typeof taskRecord !== 'object' || Array.isArray(taskRecord)) {
      toolStats[taskKind] = {};
      continue;
    }
    const normalized: Record<string, ToolTypeStats> = {};
    for (const [toolType, rawStats] of Object.entries(taskRecord as Dict)) {
      const key = String(toolType || '').trim();
      if (!key) {
        continue;
      }
      const stats = normalizeToolTypeStats(rawStats);
      if (stats) {
        normalized[key] = stats;
      }
    }
    toolStats[taskKind] = normalized;
  }
  return toolStats;
}

function isCurrentSchema(input: unknown): boolean {
  return Boolean(
    input
    && typeof input === 'object'
    && !Array.isArray(input)
    && Number((input as Dict).schemaVersion) === METRICS_SCHEMA_VERSION
  );
}

export function normalizeMetrics(input: unknown): Metrics {
  const metrics = getDefaultMetrics();
  if (!isCurrentSchema(input)) {
    return metrics;
  }
  const record = input as Dict;
  const totals = normalizeMetricTotals(record);
  metrics.inputCharactersTotal = totals.inputCharactersTotal;
  metrics.outputCharactersTotal = totals.outputCharactersTotal;
  metrics.inputTokensTotal = totals.inputTokensTotal;
  metrics.outputTokensTotal = totals.outputTokensTotal;
  metrics.thinkingTokensTotal = totals.thinkingTokensTotal;
  metrics.toolTokensTotal = totals.toolTokensTotal;
  metrics.promptCacheTokensTotal = totals.promptCacheTokensTotal;
  metrics.promptEvalTokensTotal = totals.promptEvalTokensTotal;
  metrics.requestDurationMsTotal = totals.requestDurationMsTotal;
  metrics.completedRequestCount = totals.completedRequestCount;
  metrics.taskTotals = normalizeTaskTotals(record.taskTotals);
  metrics.toolStats = normalizeToolStats(record.toolStats);
  if (typeof record.updatedAtUtc === 'string' && record.updatedAtUtc.trim()) {
    metrics.updatedAtUtc = record.updatedAtUtc;
  }
  return metrics;
}

export function readMetrics(metricsPath: string): Metrics {
  if (!fs.existsSync(metricsPath)) {
    return getDefaultMetrics();
  }
  try {
    return normalizeMetrics(JSON.parse(fs.readFileSync(metricsPath, 'utf8')));
  } catch {
    return getDefaultMetrics();
  }
}

export function writeMetrics(metricsPath: string, metrics: Metrics): void {
  writeText(metricsPath, `${JSON.stringify(normalizeMetrics(metrics), null, 2)}\n`);
}

export function readMetricsWithResetDecision(metricsPath: string): { metrics: Metrics; resetRequired: boolean } {
  if (!fs.existsSync(metricsPath)) {
    return { metrics: getDefaultMetrics(), resetRequired: false };
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(metricsPath, 'utf8')) as unknown;
    const resetRequired = !isCurrentSchema(parsed);
    return {
      metrics: normalizeMetrics(parsed),
      resetRequired,
    };
  } catch {
    return {
      metrics: getDefaultMetrics(),
      resetRequired: false,
    };
  }
}
