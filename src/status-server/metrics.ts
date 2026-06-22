import { JsonRecordReader } from '../lib/json-record-reader.js';
import { z } from '../lib/zod.js';
import { JsonObjectSchema, type JsonValue } from '../lib/json-types.js';
import { createEmptyToolTypeStats } from '../line-read-guidance.js';
import { getRuntimeDatabase } from '../state/runtime-db.js';

const PragmaColumnRowSchema = z.object({ name: z.string() });

export type { MetricTotals, ToolTypeStats, ToolStatsByTask } from '@siftkit/contracts';
import type { TaskMetricKind, MetricTotals, ToolTypeStats, ToolStatsByTask } from '@siftkit/contracts';

export const METRICS_SCHEMA_VERSION = 2;
export const TASK_KINDS = ['summary', 'plan', 'repo-search', 'chat'] as const;
export type TaskKind = TaskMetricKind;

export const ToolTypeStatsSchema = z.object({
  calls: z.number(),
  outputCharsTotal: z.number(),
  outputTokensTotal: z.number(),
  outputTokensEstimatedCount: z.number(),
  lineReadCalls: z.number(),
  lineReadLinesTotal: z.number(),
  lineReadTokensTotal: z.number(),
  finishRejections: z.number(),
  semanticRepeatRejects: z.number(),
  stagnationWarnings: z.number(),
  forcedFinishFromStagnation: z.number(),
  promptInsertedTokens: z.number(),
  rawToolResultTokens: z.number(),
  newEvidenceCalls: z.number(),
  noNewEvidenceCalls: z.number(),
  lineReadRecommendedLines: z.number().optional(),
  lineReadAllowanceTokens: z.number().optional(),
});

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
  speculativeAcceptedTokensTotal: number;
  speculativeGeneratedTokensTotal: number;
  requestDurationMsTotal: number;
  wallDurationMsTotal: number;
  stdinWaitMsTotal: number;
  serverPreflightMsTotal: number;
  lockWaitMsTotal: number;
  statusRunningMsTotal: number;
  terminalStatusMsTotal: number;
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
    speculativeAcceptedTokensTotal: 0,
    speculativeGeneratedTokensTotal: 0,
    requestDurationMsTotal: 0,
    wallDurationMsTotal: 0,
    stdinWaitMsTotal: 0,
    serverPreflightMsTotal: 0,
    lockWaitMsTotal: 0,
    statusRunningMsTotal: 0,
    terminalStatusMsTotal: 0,
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
    speculativeAcceptedTokensTotal: 0,
    speculativeGeneratedTokensTotal: 0,
    requestDurationMsTotal: 0,
    wallDurationMsTotal: 0,
    stdinWaitMsTotal: 0,
    serverPreflightMsTotal: 0,
    lockWaitMsTotal: 0,
    statusRunningMsTotal: 0,
    terminalStatusMsTotal: 0,
    completedRequestCount: 0,
    taskTotals: getDefaultTaskTotals(),
    toolStats: getDefaultToolStats(),
    updatedAtUtc: null,
  };
}

function normalizeNonNegativeNumber(value: JsonValue): number | null {
  return Number.isFinite(value) && Number(value) >= 0 ? Number(value) : null;
}

function normalizeMetricTotals(input: JsonValue): MetricTotals {
  const totals = getDefaultMetricTotals();
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return totals;
  }
  const record = JsonRecordReader.asObject(input);
  if (!record) {
    return totals;
  }
  const fields: Array<keyof MetricTotals> = [
    'inputCharactersTotal',
    'outputCharactersTotal',
    'inputTokensTotal',
    'outputTokensTotal',
    'thinkingTokensTotal',
    'toolTokensTotal',
    'promptCacheTokensTotal',
    'promptEvalTokensTotal',
    'speculativeAcceptedTokensTotal',
    'speculativeGeneratedTokensTotal',
    'requestDurationMsTotal',
    'wallDurationMsTotal',
    'stdinWaitMsTotal',
    'serverPreflightMsTotal',
    'lockWaitMsTotal',
    'statusRunningMsTotal',
    'terminalStatusMsTotal',
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

function normalizeToolTypeStats(input: JsonValue): ToolTypeStats | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return null;
  }
  const record = JsonRecordReader.asObject(input);
  if (!record) {
    return null;
  }
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

function normalizeTaskTotals(input: JsonValue): TaskTotals {
  const totals = getDefaultTaskTotals();
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return totals;
  }
  const record = JsonRecordReader.asObject(input);
  if (!record) {
    return totals;
  }
  for (const taskKind of TASK_KINDS) {
    totals[taskKind] = normalizeMetricTotals(record[taskKind]);
  }
  return totals;
}

function normalizeToolStats(input: JsonValue): ToolStatsByTask {
  const toolStats = getDefaultToolStats();
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return toolStats;
  }
  const record = JsonRecordReader.asObject(input);
  if (!record) {
    return toolStats;
  }
  for (const taskKind of TASK_KINDS) {
    const taskRecord = record[taskKind];
    if (!taskRecord || typeof taskRecord !== 'object' || Array.isArray(taskRecord)) {
      toolStats[taskKind] = {};
      continue;
    }
    const normalized: Record<string, ToolTypeStats> = {};
    const statsRecord = JsonRecordReader.asObject(taskRecord);
    if (!statsRecord) {
      toolStats[taskKind] = {};
      continue;
    }
    for (const [toolType, rawStats] of Object.entries(statsRecord)) {
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

function isCurrentSchema(input: JsonValue): boolean {
  return Boolean(
    input
    && typeof input === 'object'
    && !Array.isArray(input)
    && Number(JsonRecordReader.asObject(input)?.schemaVersion) === METRICS_SCHEMA_VERSION
  );
}

type RuntimeMetricsDatabase = ReturnType<typeof getRuntimeDatabase>;

const TIMING_TOTAL_COLUMNS: Array<{ name: string; sql: string }> = [
  { name: 'wall_duration_ms_total', sql: 'ALTER TABLE runtime_metrics_totals ADD COLUMN wall_duration_ms_total INTEGER NOT NULL DEFAULT 0;' },
  { name: 'stdin_wait_ms_total', sql: 'ALTER TABLE runtime_metrics_totals ADD COLUMN stdin_wait_ms_total INTEGER NOT NULL DEFAULT 0;' },
  { name: 'server_preflight_ms_total', sql: 'ALTER TABLE runtime_metrics_totals ADD COLUMN server_preflight_ms_total INTEGER NOT NULL DEFAULT 0;' },
  { name: 'lock_wait_ms_total', sql: 'ALTER TABLE runtime_metrics_totals ADD COLUMN lock_wait_ms_total INTEGER NOT NULL DEFAULT 0;' },
  { name: 'status_running_ms_total', sql: 'ALTER TABLE runtime_metrics_totals ADD COLUMN status_running_ms_total INTEGER NOT NULL DEFAULT 0;' },
  { name: 'terminal_status_ms_total', sql: 'ALTER TABLE runtime_metrics_totals ADD COLUMN terminal_status_ms_total INTEGER NOT NULL DEFAULT 0;' },
];

function ensureRuntimeMetricsTimingColumns(database: RuntimeMetricsDatabase): void {
  const columns = z.array(PragmaColumnRowSchema)
    .parse(database.prepare('PRAGMA table_info(runtime_metrics_totals)').all())
    .map((column) => String(column.name));
  const missing = TIMING_TOTAL_COLUMNS
    .filter((column) => !columns.includes(column.name))
    .map((column) => column.sql);
  if (missing.length > 0) {
    database.exec(missing.join('\n'));
  }
}

export function normalizeMetrics(input: JsonValue): Metrics {
  const metrics = getDefaultMetrics();
  if (!isCurrentSchema(input)) {
    return metrics;
  }
  const record = JsonRecordReader.asObject(input);
  if (!record) {
    return getDefaultMetrics();
  }
  const totals = normalizeMetricTotals(record);
  metrics.inputCharactersTotal = totals.inputCharactersTotal;
  metrics.outputCharactersTotal = totals.outputCharactersTotal;
  metrics.inputTokensTotal = totals.inputTokensTotal;
  metrics.outputTokensTotal = totals.outputTokensTotal;
  metrics.thinkingTokensTotal = totals.thinkingTokensTotal;
  metrics.toolTokensTotal = totals.toolTokensTotal;
  metrics.promptCacheTokensTotal = totals.promptCacheTokensTotal;
  metrics.promptEvalTokensTotal = totals.promptEvalTokensTotal;
  metrics.speculativeAcceptedTokensTotal = totals.speculativeAcceptedTokensTotal;
  metrics.speculativeGeneratedTokensTotal = totals.speculativeGeneratedTokensTotal;
  metrics.requestDurationMsTotal = totals.requestDurationMsTotal;
  metrics.wallDurationMsTotal = totals.wallDurationMsTotal;
  metrics.stdinWaitMsTotal = totals.stdinWaitMsTotal;
  metrics.serverPreflightMsTotal = totals.serverPreflightMsTotal;
  metrics.lockWaitMsTotal = totals.lockWaitMsTotal;
  metrics.statusRunningMsTotal = totals.statusRunningMsTotal;
  metrics.terminalStatusMsTotal = totals.terminalStatusMsTotal;
  metrics.completedRequestCount = totals.completedRequestCount;
  metrics.taskTotals = normalizeTaskTotals(record.taskTotals);
  metrics.toolStats = normalizeToolStats(record.toolStats);
  if (typeof record.updatedAtUtc === 'string' && record.updatedAtUtc.trim()) {
    metrics.updatedAtUtc = record.updatedAtUtc;
  }
  return metrics;
}

export function readMetrics(metricsPath: string): Metrics {
  const database = getRuntimeDatabase(metricsPath);
  ensureRuntimeMetricsTimingColumns(database);
  const row = database.prepare(`
    SELECT
      schema_version,
      input_characters_total,
      output_characters_total,
      input_tokens_total,
      output_tokens_total,
      thinking_tokens_total,
      tool_tokens_total,
      prompt_cache_tokens_total,
      prompt_eval_tokens_total,
      speculative_accepted_tokens_total,
      speculative_generated_tokens_total,
      request_duration_ms_total,
      wall_duration_ms_total,
      stdin_wait_ms_total,
      server_preflight_ms_total,
      lock_wait_ms_total,
      status_running_ms_total,
      terminal_status_ms_total,
      completed_request_count,
      task_totals_json,
      tool_stats_json,
      updated_at_utc
    FROM runtime_metrics_totals
    WHERE id = 1
  `).get();
  if (row == null) {
    return getDefaultMetrics();
  }
  const metricsRow = JsonObjectSchema.parse(row);
  return normalizeMetrics({
    schemaVersion: Number(metricsRow.schema_version),
    inputCharactersTotal: Number(metricsRow.input_characters_total),
    outputCharactersTotal: Number(metricsRow.output_characters_total),
    inputTokensTotal: Number(metricsRow.input_tokens_total),
    outputTokensTotal: Number(metricsRow.output_tokens_total),
    thinkingTokensTotal: Number(metricsRow.thinking_tokens_total),
    toolTokensTotal: Number(metricsRow.tool_tokens_total),
    promptCacheTokensTotal: Number(metricsRow.prompt_cache_tokens_total),
    promptEvalTokensTotal: Number(metricsRow.prompt_eval_tokens_total),
    speculativeAcceptedTokensTotal: Number(metricsRow.speculative_accepted_tokens_total),
    speculativeGeneratedTokensTotal: Number(metricsRow.speculative_generated_tokens_total),
    requestDurationMsTotal: Number(metricsRow.request_duration_ms_total),
    wallDurationMsTotal: Number(metricsRow.wall_duration_ms_total),
    stdinWaitMsTotal: Number(metricsRow.stdin_wait_ms_total),
    serverPreflightMsTotal: Number(metricsRow.server_preflight_ms_total),
    lockWaitMsTotal: Number(metricsRow.lock_wait_ms_total),
    statusRunningMsTotal: Number(metricsRow.status_running_ms_total),
    terminalStatusMsTotal: Number(metricsRow.terminal_status_ms_total),
    completedRequestCount: Number(metricsRow.completed_request_count),
    taskTotals: (() => {
      try {
        return JSON.parse(String(metricsRow.task_totals_json || '{}'));
      } catch {
        return {};
      }
    })(),
    toolStats: (() => {
      try {
        return JSON.parse(String(metricsRow.tool_stats_json || '{}'));
      } catch {
        return {};
      }
    })(),
    updatedAtUtc: typeof metricsRow.updated_at_utc === 'string' ? metricsRow.updated_at_utc : null,
  });
}

export function writeMetrics(metricsPath: string, metrics: Metrics): void {
  const database = getRuntimeDatabase(metricsPath);
  ensureRuntimeMetricsTimingColumns(database);
  const normalized = normalizeMetrics(metrics);
  database.prepare(`
    INSERT INTO runtime_metrics_totals (
      id,
      schema_version,
      input_characters_total,
      output_characters_total,
      input_tokens_total,
      output_tokens_total,
      thinking_tokens_total,
      tool_tokens_total,
      prompt_cache_tokens_total,
      prompt_eval_tokens_total,
      speculative_accepted_tokens_total,
      speculative_generated_tokens_total,
      request_duration_ms_total,
      wall_duration_ms_total,
      stdin_wait_ms_total,
      server_preflight_ms_total,
      lock_wait_ms_total,
      status_running_ms_total,
      terminal_status_ms_total,
      completed_request_count,
      task_totals_json,
      tool_stats_json,
     updated_at_utc
    ) VALUES (
      1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
    )
    ON CONFLICT(id) DO UPDATE SET
      schema_version = excluded.schema_version,
      input_characters_total = excluded.input_characters_total,
      output_characters_total = excluded.output_characters_total,
      input_tokens_total = excluded.input_tokens_total,
      output_tokens_total = excluded.output_tokens_total,
      thinking_tokens_total = excluded.thinking_tokens_total,
      tool_tokens_total = excluded.tool_tokens_total,
      prompt_cache_tokens_total = excluded.prompt_cache_tokens_total,
      prompt_eval_tokens_total = excluded.prompt_eval_tokens_total,
      speculative_accepted_tokens_total = excluded.speculative_accepted_tokens_total,
      speculative_generated_tokens_total = excluded.speculative_generated_tokens_total,
      request_duration_ms_total = excluded.request_duration_ms_total,
      wall_duration_ms_total = excluded.wall_duration_ms_total,
      stdin_wait_ms_total = excluded.stdin_wait_ms_total,
      server_preflight_ms_total = excluded.server_preflight_ms_total,
      lock_wait_ms_total = excluded.lock_wait_ms_total,
      status_running_ms_total = excluded.status_running_ms_total,
      terminal_status_ms_total = excluded.terminal_status_ms_total,
      completed_request_count = excluded.completed_request_count,
      task_totals_json = excluded.task_totals_json,
      tool_stats_json = excluded.tool_stats_json,
      updated_at_utc = excluded.updated_at_utc
  `).run(
    normalized.schemaVersion,
    normalized.inputCharactersTotal,
    normalized.outputCharactersTotal,
    normalized.inputTokensTotal,
    normalized.outputTokensTotal,
    normalized.thinkingTokensTotal,
    normalized.toolTokensTotal,
    normalized.promptCacheTokensTotal,
    normalized.promptEvalTokensTotal,
    normalized.speculativeAcceptedTokensTotal,
    normalized.speculativeGeneratedTokensTotal,
    normalized.requestDurationMsTotal,
    normalized.wallDurationMsTotal,
    normalized.stdinWaitMsTotal,
    normalized.serverPreflightMsTotal,
    normalized.lockWaitMsTotal,
    normalized.statusRunningMsTotal,
    normalized.terminalStatusMsTotal,
    normalized.completedRequestCount,
    JSON.stringify(normalized.taskTotals),
    JSON.stringify(normalized.toolStats),
    normalized.updatedAtUtc,
  );
}

export function readMetricsWithResetDecision(metricsPath: string): { metrics: Metrics; resetRequired: boolean } {
  return {
    metrics: readMetrics(metricsPath),
    resetRequired: false,
  };
}
