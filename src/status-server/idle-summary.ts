import Database from 'better-sqlite3';
import {
  type ColorOptions,
  colorize,
  formatElapsed,
  formatGroupedNumber,
  formatInteger,
  formatRatio,
  formatSeconds,
  formatTokensPerSecond,
} from '../lib/text-format.js';

import type { Dict } from '../lib/types.js';
import { getProcessedPromptTokens } from '../lib/provider-helpers.js';
import { createEmptyToolTypeStats } from '../line-read-guidance.js';
import {
  TASK_KINDS,
  type MetricTotals,
  type TaskKind,
  type ToolTypeStats,
} from './metrics.js';
type DatabaseInstance = InstanceType<typeof Database>;

export type SnapshotTaskTotals = Record<TaskKind, MetricTotals>;
export type SnapshotToolStats = Record<TaskKind, Record<string, ToolTypeStats>>;

export type IdleSummarySnapshot = {
  emittedAtUtc: string;
  inputTokensTotal: number;
  outputTokensTotal: number;
  inputOutputRatio: number;
  thinkingTokensTotal: number;
  toolTokensTotal: number;
  promptCacheTokensTotal: number;
  promptEvalTokensTotal: number;
  speculativeAcceptedTokensTotal: number;
  speculativeGeneratedTokensTotal: number;
  inputCharactersTotal: number;
  outputCharactersTotal: number;
  requestDurationMsTotal: number;
  completedRequestCount: number;
  savedTokens: number;
  savedPercent: number;
  compressionRatio: number;
  avgOutputTokensPerRequest: number;
  avgRequestMs: number;
  avgTokensPerSecond: number;
  inputCharactersPerContextToken: number | null;
  chunkThresholdCharacters: number | null;
  taskTotals: SnapshotTaskTotals;
  toolStats: SnapshotToolStats;
};

export type IdleSummarySnapshotRow = IdleSummarySnapshot & { summaryText: string };

function toNonNegativeNumber(value: unknown): number {
  return Number.isFinite(value) && Number(value) >= 0 ? Number(value) : 0;
}

function getDefaultTaskTotals(): SnapshotTaskTotals {
  return {
    summary: {
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
      completedRequestCount: 0,
    },
    plan: {
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
      completedRequestCount: 0,
    },
    'repo-search': {
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
      completedRequestCount: 0,
    },
    chat: {
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
      completedRequestCount: 0,
    },
  };
}

function normalizeTaskTotals(input: unknown): SnapshotTaskTotals {
  const totals = getDefaultTaskTotals();
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return totals;
  }
  const record = input as Dict;
  for (const taskKind of TASK_KINDS) {
    const taskTotals = record[taskKind];
    if (!taskTotals || typeof taskTotals !== 'object' || Array.isArray(taskTotals)) {
      continue;
    }
    const taskRecord = taskTotals as Dict;
    totals[taskKind] = {
      inputCharactersTotal: toNonNegativeNumber(taskRecord.inputCharactersTotal),
      outputCharactersTotal: toNonNegativeNumber(taskRecord.outputCharactersTotal),
      inputTokensTotal: toNonNegativeNumber(taskRecord.inputTokensTotal),
      outputTokensTotal: toNonNegativeNumber(taskRecord.outputTokensTotal),
      thinkingTokensTotal: toNonNegativeNumber(taskRecord.thinkingTokensTotal),
      toolTokensTotal: toNonNegativeNumber(taskRecord.toolTokensTotal),
      promptCacheTokensTotal: toNonNegativeNumber(taskRecord.promptCacheTokensTotal),
      promptEvalTokensTotal: toNonNegativeNumber(taskRecord.promptEvalTokensTotal),
      speculativeAcceptedTokensTotal: toNonNegativeNumber(taskRecord.speculativeAcceptedTokensTotal),
      speculativeGeneratedTokensTotal: toNonNegativeNumber(taskRecord.speculativeGeneratedTokensTotal),
      requestDurationMsTotal: toNonNegativeNumber(taskRecord.requestDurationMsTotal),
      completedRequestCount: toNonNegativeNumber(taskRecord.completedRequestCount),
    };
  }
  return totals;
}

function getDefaultToolStats(): SnapshotToolStats {
  return {
    summary: {},
    plan: {},
    'repo-search': {},
    chat: {},
  };
}

function normalizeToolStats(input: unknown): SnapshotToolStats {
  const stats = getDefaultToolStats();
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return stats;
  }
  const record = input as Dict;
  for (const taskKind of TASK_KINDS) {
    const taskStats = record[taskKind];
    if (!taskStats || typeof taskStats !== 'object' || Array.isArray(taskStats)) {
      continue;
    }
    const normalizedByType: Record<string, ToolTypeStats> = {};
    for (const [toolTypeRaw, rawStats] of Object.entries(taskStats as Dict)) {
      const toolType = String(toolTypeRaw || '').trim();
      if (!toolType || !rawStats || typeof rawStats !== 'object' || Array.isArray(rawStats)) {
        continue;
      }
      const statRecord = rawStats as Dict;
      normalizedByType[toolType] = {
        ...createEmptyToolTypeStats(),
        calls: toNonNegativeNumber(statRecord.calls),
        outputCharsTotal: toNonNegativeNumber(statRecord.outputCharsTotal),
        outputTokensTotal: toNonNegativeNumber(statRecord.outputTokensTotal),
        outputTokensEstimatedCount: toNonNegativeNumber(statRecord.outputTokensEstimatedCount),
        lineReadCalls: toNonNegativeNumber(statRecord.lineReadCalls),
        lineReadLinesTotal: toNonNegativeNumber(statRecord.lineReadLinesTotal),
        lineReadTokensTotal: toNonNegativeNumber(statRecord.lineReadTokensTotal),
        finishRejections: toNonNegativeNumber(statRecord.finishRejections),
        semanticRepeatRejects: toNonNegativeNumber(statRecord.semanticRepeatRejects),
        stagnationWarnings: toNonNegativeNumber(statRecord.stagnationWarnings),
        forcedFinishFromStagnation: toNonNegativeNumber(statRecord.forcedFinishFromStagnation),
        promptInsertedTokens: toNonNegativeNumber(statRecord.promptInsertedTokens),
        rawToolResultTokens: toNonNegativeNumber(statRecord.rawToolResultTokens),
        newEvidenceCalls: toNonNegativeNumber(statRecord.newEvidenceCalls),
        noNewEvidenceCalls: toNonNegativeNumber(statRecord.noNewEvidenceCalls),
      };
    }
    stats[taskKind] = normalizedByType;
  }
  return stats;
}

function parseJsonRecord(value: unknown): unknown {
  if (typeof value !== 'string' || !value.trim()) {
    return null;
  }
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

export function parseSnapshotTaskTotalsJson(value: unknown): SnapshotTaskTotals {
  return normalizeTaskTotals(parseJsonRecord(value));
}

export function parseSnapshotToolStatsJson(value: unknown): SnapshotToolStats {
  return normalizeToolStats(parseJsonRecord(value));
}

export function buildIdleSummarySnapshot(metrics: Dict, emittedAt: Date = new Date()): IdleSummarySnapshot {
  const inputTokensTotal = Number(metrics.inputTokensTotal) || 0;
  const outputTokensTotal = Number(metrics.outputTokensTotal) || 0;
  const inputOutputRatio = outputTokensTotal > 0 ? inputTokensTotal / outputTokensTotal : Number.NaN;
  const thinkingTokensTotal = Number(metrics.thinkingTokensTotal) || 0;
  const toolTokensTotal = Number(metrics.toolTokensTotal) || 0;
  const promptCacheTokensTotal = Number(metrics.promptCacheTokensTotal) || 0;
  const promptEvalTokensTotal = Number(metrics.promptEvalTokensTotal) || 0;
  const speculativeAcceptedTokensTotal = Number(metrics.speculativeAcceptedTokensTotal) || 0;
  const speculativeGeneratedTokensTotal = Number(metrics.speculativeGeneratedTokensTotal) || 0;
  const inputCharactersTotal = Number(metrics.inputCharactersTotal) || 0;
  const outputCharactersTotal = Number(metrics.outputCharactersTotal) || 0;
  const requestDurationMsTotal = Number(metrics.requestDurationMsTotal) || 0;
  const completedRequestCount = Number(metrics.completedRequestCount) || 0;
  const savedTokens = inputTokensTotal - outputTokensTotal;
  const savedPercent = inputTokensTotal > 0 ? savedTokens / inputTokensTotal : Number.NaN;
  const compressionRatio = inputOutputRatio;
  const avgOutputTokensPerRequest = completedRequestCount > 0 ? outputTokensTotal / completedRequestCount : Number.NaN;
  const avgRequestMs = completedRequestCount > 0 ? requestDurationMsTotal / completedRequestCount : Number.NaN;
  const avgTokensPerSecond = requestDurationMsTotal > 0 && outputTokensTotal > 0
    ? outputTokensTotal / (requestDurationMsTotal / 1000)
    : Number.NaN;
  const inputCharactersPerContextToken = Number.isFinite(metrics.inputCharactersPerContextToken) && Number(metrics.inputCharactersPerContextToken) > 0
    ? Number(metrics.inputCharactersPerContextToken)
    : null;
  const chunkThresholdCharacters = Number.isFinite(metrics.chunkThresholdCharacters) && Number(metrics.chunkThresholdCharacters) > 0
    ? Number(metrics.chunkThresholdCharacters)
    : null;
  const taskTotals = normalizeTaskTotals(metrics.taskTotals);
  const toolStats = normalizeToolStats(metrics.toolStats);
  return {
    emittedAtUtc: emittedAt.toISOString(),
    inputTokensTotal,
    outputTokensTotal,
    inputOutputRatio,
    thinkingTokensTotal,
    toolTokensTotal,
    promptCacheTokensTotal,
    promptEvalTokensTotal,
    speculativeAcceptedTokensTotal,
    speculativeGeneratedTokensTotal,
    inputCharactersTotal,
    outputCharactersTotal,
    requestDurationMsTotal,
    completedRequestCount,
    savedTokens,
    savedPercent,
    compressionRatio,
    avgOutputTokensPerRequest,
    avgRequestMs,
    avgTokensPerSecond,
    inputCharactersPerContextToken,
    chunkThresholdCharacters,
    taskTotals,
    toolStats,
  };
}

function formatIdleSummarySection(label: string, content: string, colorCode: number, colorOptions: ColorOptions = {}): string {
  const visibleLabel = `${label}:`;
  const spacing = ' '.repeat(Math.max(1, 8 - visibleLabel.length));
  return `  ${colorize(label, colorCode, colorOptions)}:${spacing}${content}`;
}

export function buildIdleSummarySnapshotMessage(snapshot: IdleSummarySnapshot, colorOptions: ColorOptions = {}): string {
  const lines = [
    `requests=${formatInteger(snapshot.completedRequestCount)}`,
    formatIdleSummarySection('input', `chars=${formatInteger(snapshot.inputCharactersTotal)} tokens=${formatInteger(snapshot.inputTokensTotal)}`, 36, colorOptions),
    formatIdleSummarySection('output', `chars=${formatInteger(snapshot.outputCharactersTotal)} tokens=${formatInteger(snapshot.outputTokensTotal)} avg_tokens_per_request=${formatGroupedNumber(snapshot.avgOutputTokensPerRequest, 2)}`, 32, colorOptions),
    formatIdleSummarySection('ratio', `input/output=${formatRatio(snapshot.inputOutputRatio)}`, 33, colorOptions),
  ];
  const budgetParts: string[] = [];
  if (snapshot.inputCharactersPerContextToken !== null) {
    budgetParts.push(`chars_per_token=${formatGroupedNumber(snapshot.inputCharactersPerContextToken, 3)}`);
  }
  if (snapshot.chunkThresholdCharacters !== null) {
    budgetParts.push(`chunk_threshold_chars=${formatInteger(snapshot.chunkThresholdCharacters)}`);
  }
  if (budgetParts.length > 0) {
    lines.push(formatIdleSummarySection('budget', budgetParts.join(' '), 35, colorOptions));
  }
  lines.push(formatIdleSummarySection('timing', `total=${formatElapsed(snapshot.requestDurationMsTotal)} avg_request=${formatSeconds(snapshot.avgRequestMs)} gen_tokens_per_s=${formatTokensPerSecond(snapshot.avgTokensPerSecond)}`, 34, colorOptions));
  return lines.join('\n');
}

export function buildIdleMetricsLogMessage(metrics: Dict, colorOptions: ColorOptions = {}): string {
  return buildIdleSummarySnapshotMessage(buildIdleSummarySnapshot(metrics), colorOptions);
}

function normalizeSqlNumber(value: unknown): number | null {
  return Number.isFinite(value) ? Number(value) : null;
}

export function ensureIdleSummarySnapshotsTable(database: DatabaseInstance): void {
  try {
    database.exec(`
      CREATE TABLE IF NOT EXISTS idle_summary_snapshots (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        emitted_at_utc TEXT NOT NULL,
        completed_request_count INTEGER NOT NULL,
        input_characters_total INTEGER NOT NULL,
        output_characters_total INTEGER NOT NULL,
        input_tokens_total INTEGER NOT NULL,
        output_tokens_total INTEGER NOT NULL,
        thinking_tokens_total INTEGER NOT NULL,
        tool_tokens_total INTEGER NOT NULL DEFAULT 0,
        prompt_cache_tokens_total INTEGER NOT NULL DEFAULT 0,
        prompt_eval_tokens_total INTEGER NOT NULL DEFAULT 0,
        speculative_accepted_tokens_total INTEGER NOT NULL DEFAULT 0,
        speculative_generated_tokens_total INTEGER NOT NULL DEFAULT 0,
        task_totals_json TEXT NOT NULL DEFAULT '{}',
        tool_stats_json TEXT NOT NULL DEFAULT '{}',
        saved_tokens INTEGER NOT NULL,
        saved_percent REAL,
        compression_ratio REAL,
        request_duration_ms_total INTEGER NOT NULL,
        avg_request_ms REAL,
        avg_tokens_per_second REAL
      );
    `);
    const existingColumns = (database.prepare('PRAGMA table_info(idle_summary_snapshots)').all() as Array<{ name: unknown }>)
      .map((column) => String(column.name));
    if (!existingColumns.includes('thinking_tokens_total')) {
      database.exec('ALTER TABLE idle_summary_snapshots ADD COLUMN thinking_tokens_total INTEGER NOT NULL DEFAULT 0;');
    }
    if (!existingColumns.includes('prompt_cache_tokens_total')) {
      database.exec('ALTER TABLE idle_summary_snapshots ADD COLUMN prompt_cache_tokens_total INTEGER NOT NULL DEFAULT 0;');
    }
    if (!existingColumns.includes('prompt_eval_tokens_total')) {
      database.exec('ALTER TABLE idle_summary_snapshots ADD COLUMN prompt_eval_tokens_total INTEGER NOT NULL DEFAULT 0;');
    }
    if (!existingColumns.includes('speculative_accepted_tokens_total')) {
      database.exec('ALTER TABLE idle_summary_snapshots ADD COLUMN speculative_accepted_tokens_total INTEGER NOT NULL DEFAULT 0;');
    }
    if (!existingColumns.includes('speculative_generated_tokens_total')) {
      database.exec('ALTER TABLE idle_summary_snapshots ADD COLUMN speculative_generated_tokens_total INTEGER NOT NULL DEFAULT 0;');
    }
    if (!existingColumns.includes('tool_tokens_total')) {
      database.exec('ALTER TABLE idle_summary_snapshots ADD COLUMN tool_tokens_total INTEGER NOT NULL DEFAULT 0;');
    }
    if (!existingColumns.includes('task_totals_json')) {
      database.exec('ALTER TABLE idle_summary_snapshots ADD COLUMN task_totals_json TEXT NOT NULL DEFAULT \'{}\';');
    }
    if (!existingColumns.includes('tool_stats_json')) {
      database.exec('ALTER TABLE idle_summary_snapshots ADD COLUMN tool_stats_json TEXT NOT NULL DEFAULT \'{}\';');
    }
    const rows = database.prepare(`
      SELECT
        id,
        input_tokens_total,
        output_tokens_total,
        prompt_cache_tokens_total,
        prompt_eval_tokens_total,
        task_totals_json
      FROM idle_summary_snapshots
      ORDER BY id ASC
    `).all() as Array<{
      id: number;
      input_tokens_total: number;
      output_tokens_total: number;
      prompt_cache_tokens_total: number;
      prompt_eval_tokens_total: number;
      task_totals_json: string;
    }>;
    const updateRow = database.prepare(`
      UPDATE idle_summary_snapshots
      SET
        input_tokens_total = ?,
        prompt_eval_tokens_total = ?,
        task_totals_json = ?,
        saved_tokens = ?,
        saved_percent = ?,
        compression_ratio = ?
      WHERE id = ?
    `);
    for (const row of rows) {
      const inputTokensTotal = Number(getProcessedPromptTokens(
        row.input_tokens_total,
        row.prompt_cache_tokens_total,
        row.prompt_eval_tokens_total,
      ) || 0);
      const promptEvalTokensTotal = inputTokensTotal;
      const outputTokensTotal = Number(row.output_tokens_total) || 0;
      const savedTokens = inputTokensTotal - outputTokensTotal;
      const savedPercent = inputTokensTotal > 0 ? savedTokens / inputTokensTotal : Number.NaN;
      const inputOutputRatio = outputTokensTotal > 0 ? inputTokensTotal / outputTokensTotal : Number.NaN;
      const taskTotals = normalizeTaskTotals(parseJsonRecord(row.task_totals_json));
      for (const taskKind of TASK_KINDS) {
        const taskTotalsRecord = taskTotals[taskKind];
        const taskInputTokens = Number(getProcessedPromptTokens(
          taskTotalsRecord.inputTokensTotal,
          taskTotalsRecord.promptCacheTokensTotal,
          taskTotalsRecord.promptEvalTokensTotal,
        ) || 0);
        taskTotalsRecord.inputTokensTotal = taskInputTokens;
        taskTotalsRecord.promptEvalTokensTotal = taskInputTokens;
      }
      updateRow.run(
        inputTokensTotal,
        promptEvalTokensTotal,
        JSON.stringify(taskTotals),
        savedTokens,
        normalizeSqlNumber(savedPercent),
        normalizeSqlNumber(inputOutputRatio),
        row.id,
      );
    }
  } catch {
    return;
  }
}

export function persistIdleSummarySnapshot(database: DatabaseInstance, snapshot: IdleSummarySnapshot): void {
  database.prepare(`
    INSERT INTO idle_summary_snapshots (
      emitted_at_utc,
      completed_request_count,
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
      task_totals_json,
      tool_stats_json,
      saved_tokens,
      saved_percent,
      compression_ratio,
      request_duration_ms_total,
      avg_request_ms,
      avg_tokens_per_second
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    snapshot.emittedAtUtc,
    snapshot.completedRequestCount,
    snapshot.inputCharactersTotal,
    snapshot.outputCharactersTotal,
    snapshot.inputTokensTotal,
    snapshot.outputTokensTotal,
    snapshot.thinkingTokensTotal,
    snapshot.toolTokensTotal,
    snapshot.promptCacheTokensTotal,
    snapshot.promptEvalTokensTotal,
    snapshot.speculativeAcceptedTokensTotal,
    snapshot.speculativeGeneratedTokensTotal,
    JSON.stringify(snapshot.taskTotals),
    JSON.stringify(snapshot.toolStats),
    snapshot.savedTokens,
    normalizeSqlNumber(snapshot.savedPercent),
    normalizeSqlNumber(snapshot.compressionRatio),
    snapshot.requestDurationMsTotal,
    normalizeSqlNumber(snapshot.avgRequestMs),
    normalizeSqlNumber(snapshot.avgTokensPerSecond)
  );
}

export function normalizeIdleSummarySnapshotRowNumber(value: unknown): number | null {
  return normalizeSqlNumber(value);
}

export type SnapshotTotals = {
  completedRequestCount: number;
  inputTokensTotal: number;
  outputTokensTotal: number;
  thinkingTokensTotal: number;
  toolTokensTotal: number;
  promptCacheTokensTotal: number;
  promptEvalTokensTotal: number;
  speculativeAcceptedTokensTotal: number;
  speculativeGeneratedTokensTotal: number;
  requestDurationMsTotal: number;
  taskTotals: SnapshotTaskTotals;
};

export function querySnapshotTotalsBeforeDate(database: DatabaseInstance | null, dateKey: string): SnapshotTotals | null {
  if (!database) {
    return null;
  }
  const row = database
    .prepare(`
      SELECT
        completed_request_count,
        input_tokens_total,
        output_tokens_total,
        thinking_tokens_total,
        tool_tokens_total,
        prompt_cache_tokens_total,
        prompt_eval_tokens_total,
        speculative_accepted_tokens_total,
        speculative_generated_tokens_total,
        request_duration_ms_total,
        task_totals_json
      FROM idle_summary_snapshots
      WHERE emitted_at_utc < ?
      ORDER BY emitted_at_utc DESC, id DESC
      LIMIT 1
    `)
    .get(`${dateKey}T00:00:00.000Z`) as Dict | undefined;
  if (!row || typeof row !== 'object') {
    return null;
  }
  return {
    completedRequestCount: Number(row.completed_request_count) || 0,
    inputTokensTotal: Number(row.input_tokens_total) || 0,
    outputTokensTotal: Number(row.output_tokens_total) || 0,
    thinkingTokensTotal: Number(row.thinking_tokens_total) || 0,
    toolTokensTotal: Number(row.tool_tokens_total) || 0,
    promptCacheTokensTotal: Number(row.prompt_cache_tokens_total) || 0,
    promptEvalTokensTotal: Number(row.prompt_eval_tokens_total) || 0,
    speculativeAcceptedTokensTotal: Number(row.speculative_accepted_tokens_total) || 0,
    speculativeGeneratedTokensTotal: Number(row.speculative_generated_tokens_total) || 0,
    requestDurationMsTotal: Number(row.request_duration_ms_total) || 0,
    taskTotals: parseSnapshotTaskTotalsJson(row.task_totals_json),
  };
}

export type SnapshotTimeseriesRow = Dict;

export function querySnapshotTimeseries(database: DatabaseInstance | null): SnapshotTimeseriesRow[] {
  if (!database) {
    return [];
  }
  return database
    .prepare(`
      SELECT
        emitted_at_utc,
        completed_request_count,
        input_tokens_total,
        output_tokens_total,
        thinking_tokens_total,
        tool_tokens_total,
        prompt_cache_tokens_total,
        prompt_eval_tokens_total,
        speculative_accepted_tokens_total,
        speculative_generated_tokens_total,
        request_duration_ms_total,
        task_totals_json,
        tool_stats_json
      FROM idle_summary_snapshots
      ORDER BY emitted_at_utc ASC, id ASC
    `)
    .all() as Dict[];
}

export function queryRecentSnapshots(database: DatabaseInstance, limit: number): Dict[] {
  return database
    .prepare(`
      SELECT emitted_at_utc, completed_request_count, input_characters_total, output_characters_total,
             input_tokens_total, output_tokens_total, thinking_tokens_total, tool_tokens_total, prompt_cache_tokens_total,
             prompt_eval_tokens_total, speculative_accepted_tokens_total, speculative_generated_tokens_total,
             task_totals_json, tool_stats_json, saved_tokens, saved_percent, compression_ratio,
             request_duration_ms_total, avg_request_ms, avg_tokens_per_second
      FROM idle_summary_snapshots ORDER BY id DESC LIMIT ?
    `)
    .all(limit) as Dict[];
}
