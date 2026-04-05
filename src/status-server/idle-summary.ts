import Database from 'better-sqlite3';
import {
  type ColorOptions,
  colorize,
  formatElapsed,
  formatGroupedNumber,
  formatInteger,
  formatPercentage,
  formatRatio,
  formatSeconds,
  formatTokensPerSecond,
} from './formatting.js';

type Dict = Record<string, unknown>;
type DatabaseInstance = InstanceType<typeof Database>;

export type IdleSummarySnapshot = {
  emittedAtUtc: string;
  inputTokensTotal: number;
  outputTokensTotal: number;
  thinkingTokensTotal: number;
  promptCacheTokensTotal: number;
  promptEvalTokensTotal: number;
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
};

export type IdleSummarySnapshotRow = IdleSummarySnapshot & { summaryText: string };

export function buildIdleSummarySnapshot(metrics: Dict, emittedAt: Date = new Date()): IdleSummarySnapshot {
  const inputTokensTotal = Number(metrics.inputTokensTotal) || 0;
  const outputTokensTotal = Number(metrics.outputTokensTotal) || 0;
  const thinkingTokensTotal = Number(metrics.thinkingTokensTotal) || 0;
  const promptCacheTokensTotal = Number(metrics.promptCacheTokensTotal) || 0;
  const promptEvalTokensTotal = Number(metrics.promptEvalTokensTotal) || 0;
  const inputCharactersTotal = Number(metrics.inputCharactersTotal) || 0;
  const outputCharactersTotal = Number(metrics.outputCharactersTotal) || 0;
  const requestDurationMsTotal = Number(metrics.requestDurationMsTotal) || 0;
  const completedRequestCount = Number(metrics.completedRequestCount) || 0;
  const savedTokens = inputTokensTotal - outputTokensTotal;
  const savedPercent = inputTokensTotal > 0 ? savedTokens / inputTokensTotal : Number.NaN;
  const compressionRatio = outputTokensTotal > 0 ? inputTokensTotal / outputTokensTotal : Number.NaN;
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
  return {
    emittedAtUtc: emittedAt.toISOString(),
    inputTokensTotal,
    outputTokensTotal,
    thinkingTokensTotal,
    promptCacheTokensTotal,
    promptEvalTokensTotal,
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
    formatIdleSummarySection('saved', `tokens=${formatInteger(snapshot.savedTokens)} pct=${formatPercentage(snapshot.savedPercent)} ratio=${formatRatio(snapshot.compressionRatio)}`, 33, colorOptions),
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
      prompt_cache_tokens_total INTEGER NOT NULL DEFAULT 0,
      prompt_eval_tokens_total INTEGER NOT NULL DEFAULT 0,
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
      prompt_cache_tokens_total,
      prompt_eval_tokens_total,
      saved_tokens,
      saved_percent,
      compression_ratio,
      request_duration_ms_total,
      avg_request_ms,
      avg_tokens_per_second
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    snapshot.emittedAtUtc,
    snapshot.completedRequestCount,
    snapshot.inputCharactersTotal,
    snapshot.outputCharactersTotal,
    snapshot.inputTokensTotal,
    snapshot.outputTokensTotal,
    snapshot.thinkingTokensTotal,
    snapshot.promptCacheTokensTotal,
    snapshot.promptEvalTokensTotal,
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
