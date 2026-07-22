import Database from 'better-sqlite3';
import { formatElapsed, formatInteger } from '../lib/text-format.js';
import { type Metrics } from './metrics.js';
import {
  buildIdleSummarySnapshotMessage,
  type IdleSummarySnapshot,
  type IdleSummarySnapshotDbRow,
  parseSnapshotTaskTotalsJson,
  parseSnapshotToolStatsJson,
} from './idle-summary.js';
import { type StatusMetadata } from './status-file.js';
import { type ServerLogBody } from './server-logger.js';
import {
  buildDashboardDailyMetrics as buildDashboardDailyMetricsFromRunsAndSnapshots,
  type DailyMetrics,
} from './dashboard-runs/metrics.js';
import { queryDashboardRunsFromDb } from './dashboard-runs/queries.js';

export {
  flushRunArtifactsToDbAndDelete,
  flushRunArtifactsToDbAndDeleteBounded,
  getRunLogFlushTimeoutMs,
  getRunLogMigrationTimeoutMs,
  migrateExistingRunLogsToDbAndDelete,
  migrateExistingRunLogsToDbAndDeleteBounded,
  updateRunLogSpeculativeMetricsByRequestId,
  upsertRepoSearchRun,
  upsertRunArtifactPayload,
  upsertRunLog,
  type RunLogFlushResult,
  type RunLogMigrationResult,
} from './dashboard-runs/artifact-upserts.js';
export {
  deleteDashboardRunLogs,
  previewDashboardRunLogDeletion,
  removeDashboardRunCommandFromLogs,
} from './dashboard-runs/deletion.js';
export {
  buildDashboardRunDetail,
  loadDashboardRuns,
  queryDashboardRunDetailFromDb,
  queryDashboardRunsFromDb,
} from './dashboard-runs/queries.js';
export {
  getTranscriptDurationMsFromText,
  normalizeRunRecord,
  normalizeRunRecordFromDbRow,
  normalizeStatusForRunRecord,
  parseJsonlEventsFromText,
  parseJsonObjectText,
  parseOptionalIsoDate,
} from './dashboard-runs/run-records.js';
export { ensureRunLogsTable } from './dashboard-runs/table.js';
export type { IdleSummarySnapshotDbRow } from './idle-summary.js';
export type {
  DashboardRunLogDeleteCriteria,
  DashboardRunLogType,
  DashboardRunsQueryOptions,
  RunArtifactPayload,
  RunLogDbRow,
  RunLogGroup,
  RunLogKind,
  RunLogTerminalState,
  RunLogUpsertRow,
  RunRecord,
} from './dashboard-runs/types.js';

type DatabaseInstance = InstanceType<typeof Database>;

export type StatusRequestLogInput = {
  running: boolean;
  statusPath?: string;
  requestId?: string | null;
  taskKind?: string | null;
  terminalState?: string | null;
  errorMessage?: string | null;
  characterCount?: number | null;
  promptCharacterCount?: number | null;
  promptTokenCount?: number | null;
  rawInputCharacterCount?: number | null;
  chunkInputCharacterCount?: number | null;
  budgetSource?: string | null;
  inputCharactersPerContextToken?: number | null;
  chunkThresholdCharacters?: number | null;
  chunkIndex?: number | null;
  chunkTotal?: number | null;
  chunkPath?: string | null;
  elapsedMs?: number | null;
  totalElapsedMs?: number | null;
  outputTokens?: number | null;
  toolTokens?: number | null;
  totalOutputTokens?: number | null;
};

/** The `raw_chars` / `prompt` / `chunk` group shared by the running and failed lines. */
function buildStatusPromptParts(
  input: StatusRequestLogInput,
  resolvedPromptCharacterCount: number | null | undefined,
): string[] {
  const {
    promptTokenCount = null,
    rawInputCharacterCount = null,
    chunkIndex = null,
    chunkTotal = null,
    chunkPath = null,
  } = input;
  const parts: string[] = [];
  if (rawInputCharacterCount !== null) {
    parts.push(`raw_chars=${formatInteger(rawInputCharacterCount)}`);
  }
  if (resolvedPromptCharacterCount !== null && resolvedPromptCharacterCount !== undefined) {
    parts.push(promptTokenCount !== null
      ? `prompt=${formatInteger(resolvedPromptCharacterCount)} (${formatInteger(promptTokenCount)})`
      : `prompt=${formatInteger(resolvedPromptCharacterCount)}`);
  }
  if (chunkPath !== null && chunkPath !== undefined) {
    parts.push(`chunk ${chunkPath}`);
  } else if (chunkIndex !== null && chunkIndex !== undefined && chunkTotal !== null && chunkTotal !== undefined) {
    parts.push(`chunk ${chunkIndex}/${chunkTotal}`);
  }
  return parts;
}

export function buildStatusRequestLogBody(input: StatusRequestLogInput): ServerLogBody {
  const {
    running,
    taskKind = null,
    terminalState = null,
    errorMessage = null,
    characterCount = null,
    promptCharacterCount = null,
    elapsedMs = null,
    totalElapsedMs = null,
    outputTokens = null,
    toolTokens = null,
    totalOutputTokens = null,
  } = input;
  const parts: string[] = [];
  if (typeof taskKind === 'string' && taskKind.trim()) {
    parts.push(`task=${taskKind.trim()}`);
  }
  if (running) {
    parts.push(...buildStatusPromptParts(input, promptCharacterCount ?? characterCount));
    return { event: 'start', fields: parts.join(' '), severity: 'normal' };
  }
  if (terminalState === 'failed') {
    parts.push(...buildStatusPromptParts(input, promptCharacterCount));
    const failureElapsedMs = elapsedMs ?? totalElapsedMs;
    if (failureElapsedMs !== null) {
      parts.push(`elapsed=${formatElapsed(failureElapsedMs)}`);
    }
    if (errorMessage) {
      parts.push(`error=${String(errorMessage)}`);
    }
    if (toolTokens !== null) {
      parts.push(`tool_tokens=${formatInteger(toolTokens)}`);
    }
    return { event: 'failed', fields: parts.join(' '), severity: 'error' };
  }
  if (totalElapsedMs !== null) {
    parts.push(`total_elapsed=${formatElapsed(totalElapsedMs)}`);
    if (totalOutputTokens !== null) {
      parts.push(`output_tokens=${formatInteger(totalOutputTokens)}`);
    }
  } else if (elapsedMs !== null) {
    parts.push(`elapsed=${formatElapsed(elapsedMs)}`);
    if (outputTokens !== null) {
      parts.push(`output_tokens=${formatInteger(outputTokens)}`);
    }
  }
  if (toolTokens !== null && (totalElapsedMs !== null || elapsedMs !== null)) {
    parts.push(`tool_tokens=${formatInteger(toolTokens)}`);
  }
  return { event: 'done', fields: parts.join(' '), severity: 'ok' };
}

import type { RepoSearchProgressEvent } from '../repo-search/types.js';
export type { RepoSearchProgressEvent };

function normalizeRepoSearchCommandForLog(command: string | undefined): string {
  return String(command || '').replace(/\s+/gu, ' ').trim();
}

export function buildRepoSearchProgressLogBody(event: RepoSearchProgressEvent | null | undefined): ServerLogBody | null {
  const maxTurnsLabel = Number.isFinite(Number(event?.maxTurns))
    ? String(Math.max(1, Math.trunc(Number(event?.maxTurns))))
    : '?';
  const turnLabel = Number.isFinite(Number(event?.turn))
    ? `t${Math.max(1, Math.trunc(Number(event?.turn)))}/${maxTurnsLabel}`
    : 't?/?';
  const promptTokenCount = Number.isFinite(Number(event?.promptTokenCount))
    ? formatInteger(Math.max(0, Math.trunc(Number(event?.promptTokenCount))))
    : 'null';
  const elapsedMs = Number.isFinite(Number(event?.elapsedMs))
    ? Math.max(0, Math.trunc(Number(event?.elapsedMs)))
    : 0;
  const kind = event?.kind;
  const fields = `${turnLabel}  prompt=${promptTokenCount}tok  elapsed=${formatElapsed(elapsedMs)}`;
  if (kind === 'llm_start' || kind === 'llm_end') {
    return { event: kind, fields, severity: 'normal' };
  }
  const commandText = normalizeRepoSearchCommandForLog(event?.command);
  if (!commandText) {
    return null;
  }
  return { event: 'command', fields: `${fields}  ${commandText}`, severity: 'normal' };
}

export function getStatusArtifactPath(metadata: StatusMetadata): string | null {
  if (!metadata.artifactType || !metadata.artifactRequestId) {
    return null;
  }
  if (metadata.artifactType === 'summary_request') {
    return `db://status-artifacts/summary_request/${metadata.artifactRequestId}`;
  }
  if (metadata.artifactType === 'planner_debug') {
    return `db://status-artifacts/planner_debug/${metadata.artifactRequestId}`;
  }
  if (metadata.artifactType === 'planner_failed') {
    return `db://status-artifacts/planner_failed/${metadata.artifactRequestId}`;
  }
  if (metadata.artifactType === 'request_abandoned') {
    return `db://status-artifacts/request_abandoned/${metadata.artifactRequestId}`;
  }
  return null;
}

export {
  buildDashboardDailyMetricsFromIdleSnapshots,
  buildDashboardDailyMetricsFromRuns,
  buildDashboardTaskDailyMetrics,
  buildDashboardTaskDailyMetricsFromIdleSnapshots,
  buildDashboardToolStats,
  buildLiveTodayMetrics,
  buildLiveTodayTaskDailyMetrics,
  getAcceptanceRate,
  getCurrentUtcDateKey,
  getPromptCacheHitRate,
  getSnapshotTotalsBeforeDate,
  type DailyMetrics,
  type SnapshotTotals,
  type TaskDailyMetrics,
} from './dashboard-runs/metrics.js';

export function buildDashboardDailyMetrics(runtimeRoot: string, idleSummaryDatabase: DatabaseInstance | null, currentMetrics: Metrics): DailyMetrics[] {
  void runtimeRoot;
  const runs = idleSummaryDatabase ? queryDashboardRunsFromDb(idleSummaryDatabase) : [];
  return buildDashboardDailyMetricsFromRunsAndSnapshots(runs, idleSummaryDatabase, currentMetrics);
}

export type IdleSummarySnapshotRow = IdleSummarySnapshot & { summaryText: string };


export function normalizeIdleSummarySnapshotRow(row: IdleSummarySnapshotDbRow | null): IdleSummarySnapshotRow | null {
  if (!row || typeof row !== 'object') {
    return null;
  }
  const snapshot: IdleSummarySnapshotRow = {
    emittedAtUtc: typeof row.emitted_at_utc === 'string' ? row.emitted_at_utc : '',
    completedRequestCount: Number(row.completed_request_count) || 0,
    inputCharactersTotal: Number(row.input_characters_total) || 0,
    outputCharactersTotal: Number(row.output_characters_total) || 0,
    inputTokensTotal: Number(row.input_tokens_total) || 0,
    outputTokensTotal: Number(row.output_tokens_total) || 0,
    inputOutputRatio: Number.isFinite(row.compression_ratio)
      ? Number(row.compression_ratio)
      : (
        Number(row.output_tokens_total) > 0
          ? (Number(row.input_tokens_total) || 0) / Number(row.output_tokens_total)
          : Number.NaN
      ),
    thinkingTokensTotal: Number(row.thinking_tokens_total) || 0,
    toolTokensTotal: Number(row.tool_tokens_total) || 0,
    promptCacheTokensTotal: Number(row.prompt_cache_tokens_total) || 0,
    promptEvalTokensTotal: Number(row.prompt_eval_tokens_total) || 0,
    speculativeAcceptedTokensTotal: Number(row.speculative_accepted_tokens_total) || 0,
    speculativeGeneratedTokensTotal: Number(row.speculative_generated_tokens_total) || 0,
    savedTokens: Number(row.saved_tokens) || 0,
    savedPercent: Number.isFinite(row.saved_percent) ? Number(row.saved_percent) : Number.NaN,
    compressionRatio: Number.isFinite(row.compression_ratio) ? Number(row.compression_ratio) : Number.NaN,
    requestDurationMsTotal: Number(row.request_duration_ms_total) || 0,
    wallDurationMsTotal: Number(row.wall_duration_ms_total) || 0,
    stdinWaitMsTotal: Number(row.stdin_wait_ms_total) || 0,
    serverPreflightMsTotal: Number(row.server_preflight_ms_total) || 0,
    lockWaitMsTotal: Number(row.lock_wait_ms_total) || 0,
    statusRunningMsTotal: Number(row.status_running_ms_total) || 0,
    terminalStatusMsTotal: Number(row.terminal_status_ms_total) || 0,
    avgRequestMs: Number.isFinite(row.avg_request_ms) ? Number(row.avg_request_ms) : Number.NaN,
    avgTokensPerSecond: Number.isFinite(row.avg_tokens_per_second) ? Number(row.avg_tokens_per_second) : Number.NaN,
    avgOutputTokensPerRequest: Number.NaN,
    inputCharactersPerContextToken: null,
    chunkThresholdCharacters: null,
    taskTotals: parseSnapshotTaskTotalsJson(row.task_totals_json),
    toolStats: parseSnapshotToolStatsJson(row.tool_stats_json),
    summaryText: '',
  };
  snapshot.summaryText = buildIdleSummarySnapshotMessage(snapshot);
  return snapshot;
}
