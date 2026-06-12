import Database from 'better-sqlite3';
import { formatElapsed, formatInteger } from '../lib/text-format.js';
import { type Metrics } from './metrics.js';
import {
  buildIdleSummarySnapshotMessage,
  type IdleSummarySnapshot,
  parseSnapshotTaskTotalsJson,
  parseSnapshotToolStatsJson,
} from './idle-summary.js';
import { type StatusMetadata } from './status-file.js';
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

export function buildStatusRequestLogMessage(input: StatusRequestLogInput): string {
  const {
    running,
    requestId = null,
    taskKind = null,
    terminalState = null,
    errorMessage = null,
    characterCount = null,
    promptCharacterCount = null,
    promptTokenCount = null,
    rawInputCharacterCount = null,
    chunkIndex = null,
    chunkTotal = null,
    chunkPath = null,
    elapsedMs = null,
    totalElapsedMs = null,
    outputTokens = null,
    toolTokens = null,
    totalOutputTokens = null,
  } = input;
  void requestId;
  const statusText = running ? 'true' : 'false';
  let logMessage = `request ${statusText}`;
  if (typeof taskKind === 'string' && taskKind.trim()) {
    logMessage += ` task=${taskKind.trim()}`;
  }
  if (running) {
    const resolvedPromptCharacterCount = promptCharacterCount ?? characterCount;
    if (rawInputCharacterCount !== null) {
      logMessage += ` raw_chars=${formatInteger(rawInputCharacterCount)}`;
    }
    if (resolvedPromptCharacterCount !== null) {
      logMessage += ` prompt=${formatInteger(resolvedPromptCharacterCount)}`;
      if (promptTokenCount !== null) {
        logMessage += ` (${formatInteger(promptTokenCount)})`;
      }
    }
    if (chunkPath !== null) {
      logMessage += ` chunk ${String(chunkPath)}`;
    } else if (chunkIndex !== null && chunkTotal !== null) {
      logMessage += ` chunk ${chunkIndex}/${chunkTotal}`;
    }
  } else if (terminalState === 'failed') {
    if (rawInputCharacterCount !== null) {
      logMessage += ` raw_chars=${formatInteger(rawInputCharacterCount)}`;
    }
    if (promptCharacterCount !== null) {
      logMessage += ` prompt=${formatInteger(promptCharacterCount)}`;
      if (promptTokenCount !== null) {
        logMessage += ` (${formatInteger(promptTokenCount)})`;
      }
    }
    if (chunkPath !== null) {
      logMessage += ` chunk ${String(chunkPath)}`;
    } else if (chunkIndex !== null && chunkTotal !== null) {
      logMessage += ` chunk ${chunkIndex}/${chunkTotal}`;
    }
    logMessage += ' failed';
    logMessage += elapsedMs !== null
      ? ` elapsed=${formatElapsed(elapsedMs)}`
      : (totalElapsedMs !== null ? ` elapsed=${formatElapsed(totalElapsedMs)}` : '');
    if (errorMessage) {
      logMessage += ` error=${String(errorMessage)}`;
    }
    if (toolTokens !== null) {
      logMessage += ` tool_tokens=${formatInteger(toolTokens)}`;
    }
  } else if (totalElapsedMs !== null) {
    logMessage += ` total_elapsed=${formatElapsed(totalElapsedMs)}`;
    if (totalOutputTokens !== null) {
      logMessage += ` output_tokens=${formatInteger(totalOutputTokens)}`;
    }
    if (toolTokens !== null) {
      logMessage += ` tool_tokens=${formatInteger(toolTokens)}`;
    }
  } else if (elapsedMs !== null) {
    logMessage += ` elapsed=${formatElapsed(elapsedMs)}`;
    if (outputTokens !== null) {
      logMessage += ` output_tokens=${formatInteger(outputTokens)}`;
    }
    if (toolTokens !== null) {
      logMessage += ` tool_tokens=${formatInteger(toolTokens)}`;
    }
  }
  return logMessage;
}

export type RepoSearchProgressEvent = {
  command?: unknown;
  turn?: unknown;
  maxTurns?: unknown;
  promptTokenCount?: unknown;
  elapsedMs?: unknown;
  kind?: string;
  thinkingText?: string;
  answerText?: string;
  exitCode?: number | null;
  outputSnippet?: string;
  outputTokens?: number;
  outputTokensEstimated?: boolean;
  toolCallId?: string;
};

function normalizeRepoSearchCommandForLog(command: unknown): string {
  return String(command || '').replace(/\s+/gu, ' ').trim();
}

export function buildRepoSearchProgressLogMessage(event: RepoSearchProgressEvent | null | undefined, mode: string): string | null {
  const resolvedMode = String(mode || 'repo_search').trim() || 'repo_search';
  const turnLabel = Number.isFinite(Number(event?.turn))
    ? `${Math.max(1, Math.trunc(Number(event?.turn)))}/${Number.isFinite(Number(event?.maxTurns)) ? Math.max(1, Math.trunc(Number(event?.maxTurns))) : '?'}`
    : '?/?';
  const promptTokenCount = Number.isFinite(Number(event?.promptTokenCount))
    ? formatInteger(Math.max(0, Math.trunc(Number(event?.promptTokenCount))))
    : 'null';
  const elapsedMs = Number.isFinite(Number(event?.elapsedMs))
    ? Math.max(0, Math.trunc(Number(event?.elapsedMs)))
    : 0;
  const kind = event?.kind;
  if (kind === 'llm_start' || kind === 'llm_end') {
    return `${resolvedMode} ${kind} turn=${turnLabel} prompt_tokens=${promptTokenCount} elapsed=${formatElapsed(elapsedMs)}`;
  }
  const commandText = normalizeRepoSearchCommandForLog(event?.command);
  if (!commandText) {
    return null;
  }
  return `${resolvedMode} command turn=${turnLabel} prompt_tokens=${promptTokenCount} elapsed=${formatElapsed(elapsedMs)} command=${commandText}`;
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

export type IdleSummarySnapshotDbRow = {
  emitted_at_utc: string | null;
  completed_request_count: number | string | null;
  input_characters_total: number | string | null;
  output_characters_total: number | string | null;
  compression_ratio: number | string | null;
  input_tokens_total: number | string | null;
  output_tokens_total: number | string | null;
  thinking_tokens_total: number | string | null;
  tool_tokens_total: number | string | null;
  prompt_cache_tokens_total: number | string | null;
  prompt_eval_tokens_total: number | string | null;
  speculative_accepted_tokens_total: number | string | null;
  speculative_generated_tokens_total: number | string | null;
  saved_tokens: number | string | null;
  saved_percent: number | string | null;
  request_duration_ms_total: number | string | null;
  wall_duration_ms_total: number | string | null;
  stdin_wait_ms_total: number | string | null;
  server_preflight_ms_total: number | string | null;
  lock_wait_ms_total: number | string | null;
  status_running_ms_total: number | string | null;
  terminal_status_ms_total: number | string | null;
  avg_request_ms: number | string | null;
  avg_tokens_per_second: number | string | null;
  prompt_cache_hit_rate: number | string | null;
  acceptance_rate: number | string | null;
  task_totals_json: string | null;
  tool_stats_json: string | null;
  summary_text: string | null;
};

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
