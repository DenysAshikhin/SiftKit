import * as fs from 'node:fs';
import * as path from 'node:path';
import Database from 'better-sqlite3';
import type { Dict } from '../lib/types.js';
import { getProcessedPromptTokens } from '../lib/provider-helpers.js';
import { getRuntimeRoot } from './paths.js';
import { getRuntimeDatabasePath } from '../config/paths.js';
import { formatInteger, formatElapsed } from '../lib/text-format.js';
import { listFiles, getIsoDateFromStat } from '../lib/fs.js';
import {
  type Metrics,
  type TaskKind,
} from './metrics.js';
import {
  type IdleSummarySnapshot,
  parseSnapshotTaskTotalsJson,
  parseSnapshotToolStatsJson,
  buildIdleSummarySnapshotMessage,
} from './idle-summary.js';
import { type StatusMetadata } from './status-file.js';
import { type JsonlEvent } from '../state/jsonl-transcript.js';
import {
  buildDashboardDailyMetrics as buildDashboardDailyMetricsFromRunsAndSnapshots,
  type DailyMetrics,
} from './dashboard-runs/metrics.js';

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
    if (elapsedMs !== null) {
      logMessage += ` elapsed=${formatElapsed(elapsedMs)}`;
    } else if (totalElapsedMs !== null) {
      logMessage += ` elapsed=${formatElapsed(totalElapsedMs)}`;
    }
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
  exitCode?: number | null;
  outputSnippet?: string;
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

export type RunRecord = {
  id: string;
  kind: string;
  status: string;
  startedAtUtc: string | null;
  finishedAtUtc: string | null;
  title: string;
  model: string | null;
  backend: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  thinkingTokens: number | null;
  toolTokens: number | null;
  promptCacheTokens: number | null;
  promptEvalTokens: number | null;
  speculativeAcceptedTokens: number | null;
  speculativeGeneratedTokens: number | null;
  durationMs: number | null;
  rawPaths: Dict;
};

function normalizeRunRecord(record: Dict): RunRecord {
  return {
    id: String(record.id),
    kind: String(record.kind),
    status: String(record.status),
    startedAtUtc: (record.startedAtUtc as string) || null,
    finishedAtUtc: (record.finishedAtUtc as string) || null,
    title: String(record.title || ''),
    model: (record.model as string) || null,
    backend: (record.backend as string) || null,
    inputTokens: Number.isFinite(record.inputTokens) ? Number(record.inputTokens) : null,
    outputTokens: Number.isFinite(record.outputTokens) ? Number(record.outputTokens) : null,
    thinkingTokens: Number.isFinite(record.thinkingTokens) ? Number(record.thinkingTokens) : null,
    toolTokens: Number.isFinite(record.toolTokens) ? Number(record.toolTokens) : null,
    promptCacheTokens: Number.isFinite(record.promptCacheTokens) ? Number(record.promptCacheTokens) : null,
    promptEvalTokens: Number.isFinite(record.promptEvalTokens) ? Number(record.promptEvalTokens) : null,
    speculativeAcceptedTokens: Number.isFinite(record.speculativeAcceptedTokens) ? Number(record.speculativeAcceptedTokens) : null,
    speculativeGeneratedTokens: Number.isFinite(record.speculativeGeneratedTokens) ? Number(record.speculativeGeneratedTokens) : null,
    durationMs: Number.isFinite(record.durationMs) ? Number(record.durationMs) : null,
    rawPaths: record.rawPaths && typeof record.rawPaths === 'object' ? record.rawPaths as Dict : {},
  };
}

export function loadDashboardRuns(runtimeRoot: string): RunRecord[] {
  void runtimeRoot;
  const databasePath = getRuntimeDatabasePath();
  if (!fs.existsSync(databasePath)) {
    return [];
  }
  const database = new Database(databasePath);
  try {
    return queryDashboardRunsFromDb(database);
  } finally {
    database.close();
  }
}

export function buildDashboardRunDetail(runtimeRoot: string, runId: string): { run: RunRecord; events: JsonlEvent[] } | null {
  void runtimeRoot;
  const databasePath = getRuntimeDatabasePath();
  if (!fs.existsSync(databasePath)) {
    return null;
  }
  const database = new Database(databasePath);
  try {
    return queryDashboardRunDetailFromDb(database, runId);
  } finally {
    database.close();
  }
}

export type DashboardRunsQueryOptions = {
  search?: string;
  kind?: string;
  status?: string;
  initial?: boolean;
  limitPerGroup?: number;
};

const RUN_LOG_LIST_SELECT_COLUMNS = `
  id,
  run_id,
  request_id,
  run_kind,
  run_group,
  terminal_state,
  started_at_utc,
  finished_at_utc,
  title,
  model,
  backend,
  repo_root,
  input_tokens,
  output_tokens,
  thinking_tokens,
  tool_tokens,
  prompt_cache_tokens,
  prompt_eval_tokens,
  speculative_accepted_tokens,
  speculative_generated_tokens,
  duration_ms
`;

const RUN_LOG_DETAIL_SELECT_COLUMNS = `
  id,
  run_id,
  request_id,
  run_kind,
  run_group,
  terminal_state,
  started_at_utc,
  finished_at_utc,
  title,
  model,
  backend,
  repo_root,
  input_tokens,
  output_tokens,
  thinking_tokens,
  tool_tokens,
  prompt_cache_tokens,
  prompt_eval_tokens,
  speculative_accepted_tokens,
  speculative_generated_tokens,
  duration_ms,
  request_json,
  planner_debug_json,
  failed_request_json,
  abandoned_request_json,
  repo_search_json,
  repo_search_transcript_jsonl
`;

type RunLogTerminalState = 'completed' | 'failed' | 'abandoned' | 'unknown';
type RunLogKind =
  | 'summary_request'
  | 'failed_request'
  | 'request_abandoned'
  | 'repo_search'
  | 'chat'
  | 'plan'
  | 'unknown';
type RunLogGroup = 'summary' | 'repo_search' | 'planner' | 'chat' | 'other';
export type DashboardRunLogType = 'all' | RunLogGroup;
export type DashboardRunLogDeleteCriteria =
  | {
    mode: 'count';
    type: DashboardRunLogType;
    count: number;
  }
  | {
    mode: 'before_date';
    type: DashboardRunLogType;
    beforeDate: string;
  };

type RunLogUpsertRow = {
  runId: string;
  requestId: string;
  runKind: RunLogKind;
  runGroup: RunLogGroup;
  terminalState: RunLogTerminalState;
  startedAtUtc: string | null;
  finishedAtUtc: string | null;
  title: string;
  model: string | null;
  backend: string | null;
  repoRoot: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  thinkingTokens: number | null;
  toolTokens: number | null;
  promptCacheTokens: number | null;
  promptEvalTokens: number | null;
  speculativeAcceptedTokens: number | null;
  speculativeGeneratedTokens: number | null;
  durationMs: number | null;
  requestJson: string | null;
  plannerDebugJson: string | null;
  failedRequestJson: string | null;
  abandonedRequestJson: string | null;
  repoSearchJson: string | null;
  repoSearchTranscriptJsonl: string | null;
  sourcePathsJson: string;
  flushedAtUtc: string;
};

function normalizeSearchToken(value: string | undefined): string {
  return String(value || '').trim().toLowerCase();
}

function isRunLogGroup(value: string): value is RunLogGroup {
  return value === 'summary'
    || value === 'repo_search'
    || value === 'planner'
    || value === 'chat'
    || value === 'other';
}

function toNonNegativeInteger(value: unknown): number | null {
  if (!Number.isFinite(Number(value))) {
    return null;
  }
  const next = Math.max(0, Math.trunc(Number(value)));
  return Number.isFinite(next) ? next : null;
}

function getProcessedInputTokensValue(
  inputTokens: unknown,
  promptCacheTokens: unknown,
  promptEvalTokens: unknown,
): number | null {
  return toNonNegativeInteger(getProcessedPromptTokens(inputTokens, promptCacheTokens, promptEvalTokens));
}

function parseJsonObjectText(text: string | null): Dict | null {
  if (typeof text !== 'string' || !text.trim()) {
    return null;
  }
  try {
    const parsed = JSON.parse(text) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return null;
    }
    return parsed as Dict;
  } catch {
    return null;
  }
}

function parseJsonlEventsFromText(text: string | null): JsonlEvent[] {
  if (typeof text !== 'string' || !text.trim()) {
    return [];
  }
  const events: JsonlEvent[] = [];
  for (const raw of text.split(/\r?\n/gu)) {
    const line = raw.trim();
    if (!line) {
      continue;
    }
    try {
      const parsed = JSON.parse(line) as unknown;
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        continue;
      }
      const payload = parsed as Dict;
      events.push({
        kind: typeof payload.kind === 'string' ? payload.kind : 'event',
        at: typeof payload.at === 'string' ? payload.at : null,
        payload,
      });
    } catch {
      // ignore malformed lines
    }
  }
  return events;
}

function getTranscriptDurationMsFromText(text: string | null): number | null {
  const events = parseJsonlEventsFromText(text);
  const points = events
    .map((event) => Date.parse(event.at || ''))
    .filter((value) => Number.isFinite(value));
  if (points.length < 2) {
    return null;
  }
  return Math.max(0, Math.max(...points) - Math.min(...points));
}

function normalizeStatusForRunRecord(terminalState: string): string {
  if (terminalState === 'abandoned') {
    return 'failed';
  }
  if (terminalState === 'completed' || terminalState === 'failed') {
    return terminalState;
  }
  return 'running';
}

function normalizeRunRecordFromDbRow(row: Dict): RunRecord {
  return normalizeRunRecord({
    id: String(row.run_id || ''),
    kind: String(row.run_kind || 'unknown'),
    status: normalizeStatusForRunRecord(String(row.terminal_state || 'unknown')),
    startedAtUtc: typeof row.started_at_utc === 'string' ? row.started_at_utc : null,
    finishedAtUtc: typeof row.finished_at_utc === 'string' ? row.finished_at_utc : null,
    title: String(row.title || ''),
    model: typeof row.model === 'string' ? row.model : null,
    backend: typeof row.backend === 'string' ? row.backend : null,
    inputTokens: toNonNegativeInteger(row.input_tokens),
    outputTokens: toNonNegativeInteger(row.output_tokens),
    thinkingTokens: toNonNegativeInteger(row.thinking_tokens),
    toolTokens: toNonNegativeInteger(row.tool_tokens),
    promptCacheTokens: toNonNegativeInteger(row.prompt_cache_tokens),
    promptEvalTokens: toNonNegativeInteger(row.prompt_eval_tokens),
    speculativeAcceptedTokens: toNonNegativeInteger(row.speculative_accepted_tokens),
    speculativeGeneratedTokens: toNonNegativeInteger(row.speculative_generated_tokens),
    durationMs: toNonNegativeInteger(row.duration_ms),
    rawPaths: {},
  });
}

export function ensureRunLogsTable(database: DatabaseInstance): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS run_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id TEXT NOT NULL UNIQUE,
      request_id TEXT NOT NULL,
      run_kind TEXT NOT NULL
        CHECK (run_kind IN ('summary_request','failed_request','request_abandoned','repo_search','chat','plan','unknown')),
      run_group TEXT NOT NULL
        CHECK (run_group IN ('summary','repo_search','planner','chat','other')),
      terminal_state TEXT NOT NULL
        CHECK (terminal_state IN ('completed','failed','abandoned','unknown')),
      started_at_utc TEXT,
      finished_at_utc TEXT,
      title TEXT NOT NULL,
      model TEXT,
      backend TEXT,
      repo_root TEXT,
      input_tokens INTEGER,
      output_tokens INTEGER,
      thinking_tokens INTEGER,
      tool_tokens INTEGER,
      prompt_cache_tokens INTEGER,
      prompt_eval_tokens INTEGER,
      speculative_accepted_tokens INTEGER,
      speculative_generated_tokens INTEGER,
      duration_ms INTEGER,
      request_json TEXT,
      planner_debug_json TEXT,
      failed_request_json TEXT,
      abandoned_request_json TEXT,
      repo_search_json TEXT,
      repo_search_transcript_jsonl TEXT,
      source_paths_json TEXT NOT NULL DEFAULT '[]',
      flushed_at_utc TEXT NOT NULL,
      source_deleted_at_utc TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_run_logs_started ON run_logs(started_at_utc DESC);
    CREATE INDEX IF NOT EXISTS idx_run_logs_group_started ON run_logs(run_group, started_at_utc DESC);
    CREATE INDEX IF NOT EXISTS idx_run_logs_kind_started ON run_logs(run_kind, started_at_utc DESC);
  `);
  const existingColumns = (database.prepare('PRAGMA table_info(run_logs)').all() as Array<{ name: unknown }>)
    .map((column) => String(column.name));
  if (!existingColumns.includes('speculative_accepted_tokens')) {
    database.exec('ALTER TABLE run_logs ADD COLUMN speculative_accepted_tokens INTEGER;');
  }
  if (!existingColumns.includes('speculative_generated_tokens')) {
    database.exec('ALTER TABLE run_logs ADD COLUMN speculative_generated_tokens INTEGER;');
  }
  database.exec(`
    UPDATE run_logs
    SET
      prompt_eval_tokens = CASE
        WHEN prompt_eval_tokens IS NOT NULL AND prompt_eval_tokens > 0 THEN prompt_eval_tokens
        WHEN input_tokens IS NULL THEN prompt_eval_tokens
        ELSE MAX(input_tokens - COALESCE(prompt_cache_tokens, 0), 0)
      END,
      input_tokens = CASE
        WHEN prompt_eval_tokens IS NOT NULL AND prompt_eval_tokens > 0 THEN prompt_eval_tokens
        WHEN input_tokens IS NULL THEN NULL
        ELSE MAX(input_tokens - COALESCE(prompt_cache_tokens, 0), 0)
      END
    WHERE input_tokens IS NOT NULL
  `);
}

export function upsertRunLog(database: DatabaseInstance, row: RunLogUpsertRow): void {
  ensureRunLogsTable(database);
  database.prepare(`
    INSERT INTO run_logs (
      run_id, request_id, run_kind, run_group, terminal_state,
      started_at_utc, finished_at_utc, title, model, backend, repo_root,
      input_tokens, output_tokens, thinking_tokens, tool_tokens, prompt_cache_tokens, prompt_eval_tokens, speculative_accepted_tokens, speculative_generated_tokens, duration_ms,
      request_json, planner_debug_json, failed_request_json, abandoned_request_json, repo_search_json, repo_search_transcript_jsonl,
      source_paths_json, flushed_at_utc, source_deleted_at_utc
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
    ON CONFLICT(run_id) DO UPDATE SET
      request_id = excluded.request_id,
      run_kind = CASE WHEN excluded.run_kind = 'unknown' THEN run_logs.run_kind ELSE excluded.run_kind END,
      run_group = CASE WHEN excluded.run_group = 'other' THEN run_logs.run_group ELSE excluded.run_group END,
      terminal_state = CASE WHEN excluded.terminal_state = 'unknown' THEN run_logs.terminal_state ELSE excluded.terminal_state END,
      started_at_utc = COALESCE(excluded.started_at_utc, run_logs.started_at_utc),
      finished_at_utc = COALESCE(excluded.finished_at_utc, run_logs.finished_at_utc),
      title = CASE WHEN excluded.title = '' THEN run_logs.title ELSE excluded.title END,
      model = COALESCE(excluded.model, run_logs.model),
      backend = COALESCE(excluded.backend, run_logs.backend),
      repo_root = COALESCE(excluded.repo_root, run_logs.repo_root),
      input_tokens = COALESCE(excluded.input_tokens, run_logs.input_tokens),
      output_tokens = COALESCE(excluded.output_tokens, run_logs.output_tokens),
      thinking_tokens = COALESCE(excluded.thinking_tokens, run_logs.thinking_tokens),
      tool_tokens = COALESCE(excluded.tool_tokens, run_logs.tool_tokens),
      prompt_cache_tokens = COALESCE(excluded.prompt_cache_tokens, run_logs.prompt_cache_tokens),
      prompt_eval_tokens = COALESCE(excluded.prompt_eval_tokens, run_logs.prompt_eval_tokens),
      speculative_accepted_tokens = COALESCE(excluded.speculative_accepted_tokens, run_logs.speculative_accepted_tokens),
      speculative_generated_tokens = COALESCE(excluded.speculative_generated_tokens, run_logs.speculative_generated_tokens),
      duration_ms = COALESCE(excluded.duration_ms, run_logs.duration_ms),
      request_json = COALESCE(excluded.request_json, run_logs.request_json),
      planner_debug_json = COALESCE(excluded.planner_debug_json, run_logs.planner_debug_json),
      failed_request_json = COALESCE(excluded.failed_request_json, run_logs.failed_request_json),
      abandoned_request_json = COALESCE(excluded.abandoned_request_json, run_logs.abandoned_request_json),
      repo_search_json = COALESCE(excluded.repo_search_json, run_logs.repo_search_json),
      repo_search_transcript_jsonl = COALESCE(excluded.repo_search_transcript_jsonl, run_logs.repo_search_transcript_jsonl),
      source_paths_json = excluded.source_paths_json,
      flushed_at_utc = excluded.flushed_at_utc
  `).run(
    row.runId,
    row.requestId,
    row.runKind,
    row.runGroup,
    row.terminalState,
    row.startedAtUtc,
    row.finishedAtUtc,
    row.title,
    row.model,
    row.backend,
    row.repoRoot,
    row.inputTokens,
    row.outputTokens,
    row.thinkingTokens,
    row.toolTokens,
    row.promptCacheTokens,
    row.promptEvalTokens,
    row.speculativeAcceptedTokens,
    row.speculativeGeneratedTokens,
    row.durationMs,
    row.requestJson,
    row.plannerDebugJson,
    row.failedRequestJson,
    row.abandonedRequestJson,
    row.repoSearchJson,
    row.repoSearchTranscriptJsonl,
    row.sourcePathsJson,
    row.flushedAtUtc,
  );
}

export function upsertRunArtifactPayload(options: {
  database: DatabaseInstance;
  requestId: string;
  artifactType: 'summary_request' | 'planner_debug' | 'planner_failed' | 'request_abandoned';
  artifactPayload: Dict;
}): void {
  const requestId = String(options.requestId || '').trim();
  if (!requestId) {
    return;
  }
  const nowUtc = new Date().toISOString();
  const artifactJson = JSON.stringify(options.artifactPayload || {}, null, 2);
  let runKind: RunLogKind = 'unknown';
  let runGroup: RunLogGroup = 'other';
  let terminalState: RunLogTerminalState = 'unknown';
  let requestJson: string | null = null;
  let plannerDebugJson: string | null = null;
  let failedRequestJson: string | null = null;
  let abandonedRequestJson: string | null = null;
  if (options.artifactType === 'summary_request') {
    runKind = 'summary_request';
    runGroup = 'summary';
    terminalState = options.artifactPayload?.error ? 'failed' : 'completed';
    requestJson = artifactJson;
  } else if (options.artifactType === 'planner_debug') {
    runKind = 'plan';
    runGroup = 'planner';
    plannerDebugJson = artifactJson;
  } else if (options.artifactType === 'planner_failed') {
    runKind = 'failed_request';
    runGroup = 'summary';
    terminalState = 'failed';
    failedRequestJson = artifactJson;
  } else if (options.artifactType === 'request_abandoned') {
    runKind = 'request_abandoned';
    runGroup = 'summary';
    terminalState = 'abandoned';
    abandonedRequestJson = artifactJson;
  }
  upsertRunLog(options.database, {
    runId: requestId,
    requestId,
    runKind,
    runGroup,
    terminalState,
    startedAtUtc: parseOptionalIsoDate(
      options.artifactPayload?.createdAtUtc
      || options.artifactPayload?.abandonedAtUtc
      || options.artifactPayload?.finishedAtUtc
      || options.artifactPayload?.updatedAtUtc
      || nowUtc,
    ),
    finishedAtUtc: terminalState === 'unknown' ? null : nowUtc,
    title: resolveTitle(
      requestId,
      runKind,
      options.artifactType === 'summary_request' ? options.artifactPayload : null,
      options.artifactType === 'planner_failed' ? options.artifactPayload : null,
      options.artifactType === 'request_abandoned' ? options.artifactPayload : null,
      null,
    ),
    model: typeof options.artifactPayload?.model === 'string' ? options.artifactPayload.model : null,
    backend: typeof options.artifactPayload?.backend === 'string' ? options.artifactPayload.backend : null,
    repoRoot: typeof options.artifactPayload?.repoRoot === 'string' ? options.artifactPayload.repoRoot : null,
    inputTokens: getProcessedInputTokensValue(
      options.artifactPayload?.inputTokens,
      options.artifactPayload?.promptCacheTokens,
      options.artifactPayload?.promptEvalTokens,
    ),
    outputTokens: toNonNegativeInteger(options.artifactPayload?.outputTokens),
    thinkingTokens: toNonNegativeInteger(options.artifactPayload?.thinkingTokens),
    toolTokens: toNonNegativeInteger(options.artifactPayload?.toolTokens),
    promptCacheTokens: toNonNegativeInteger(options.artifactPayload?.promptCacheTokens),
    promptEvalTokens: toNonNegativeInteger(options.artifactPayload?.promptEvalTokens),
    speculativeAcceptedTokens: toNonNegativeInteger(options.artifactPayload?.speculativeAcceptedTokens),
    speculativeGeneratedTokens: toNonNegativeInteger(options.artifactPayload?.speculativeGeneratedTokens),
    durationMs: toNonNegativeInteger(options.artifactPayload?.requestDurationMs),
    requestJson,
    plannerDebugJson,
    failedRequestJson,
    abandonedRequestJson,
    repoSearchJson: null,
    repoSearchTranscriptJsonl: null,
    sourcePathsJson: '[]',
    flushedAtUtc: nowUtc,
  });
}

export function upsertRepoSearchRun(options: {
  database: DatabaseInstance;
  requestId: string;
  taskKind: 'plan' | 'repo-search';
  prompt: string;
  repoRoot: string;
  model: string | null;
  requestMaxTokens: number | null;
  maxTurns: number | null;
  transcriptText: string;
  artifactPayload: Dict;
  terminalState: 'completed' | 'failed';
  startedAtUtc: string;
  finishedAtUtc: string;
  requestDurationMs: number;
  promptTokens: number | null;
  outputTokens: number | null;
  thinkingTokens: number | null;
  toolTokens: number | null;
  promptCacheTokens: number | null;
  promptEvalTokens: number | null;
  speculativeAcceptedTokens?: number | null;
  speculativeGeneratedTokens?: number | null;
}): void {
  const runKind: RunLogKind = options.taskKind === 'plan' ? 'plan' : 'repo_search';
  const runGroup: RunLogGroup = options.taskKind === 'plan' ? 'planner' : 'repo_search';
  const repoSearchJson = JSON.stringify(options.artifactPayload || {}, null, 2);
  upsertRunLog(options.database, {
    runId: options.requestId,
    requestId: options.requestId,
    runKind,
    runGroup,
    terminalState: options.terminalState,
    startedAtUtc: options.startedAtUtc,
    finishedAtUtc: options.finishedAtUtc,
    title: options.prompt,
    model: options.model,
    backend: 'llama.cpp',
    repoRoot: options.repoRoot,
    inputTokens: getProcessedInputTokensValue(options.promptTokens, options.promptCacheTokens, options.promptEvalTokens),
    outputTokens: toNonNegativeInteger(options.outputTokens),
    thinkingTokens: toNonNegativeInteger(options.thinkingTokens),
    toolTokens: toNonNegativeInteger(options.toolTokens),
    promptCacheTokens: toNonNegativeInteger(options.promptCacheTokens),
    promptEvalTokens: toNonNegativeInteger(options.promptEvalTokens),
    speculativeAcceptedTokens: toNonNegativeInteger(options.speculativeAcceptedTokens),
    speculativeGeneratedTokens: toNonNegativeInteger(options.speculativeGeneratedTokens),
    durationMs: toNonNegativeInteger(options.requestDurationMs),
    requestJson: null,
    plannerDebugJson: null,
    failedRequestJson: options.terminalState === 'failed' ? repoSearchJson : null,
    abandonedRequestJson: null,
    repoSearchJson,
    repoSearchTranscriptJsonl: options.transcriptText,
    sourcePathsJson: '[]',
    flushedAtUtc: options.finishedAtUtc,
  });
}

export function queryDashboardRunsFromDb(
  database: DatabaseInstance,
  options: DashboardRunsQueryOptions = {},
): RunRecord[] {
  ensureRunLogsTable(database);
  const search = normalizeSearchToken(options.search);
  const kind = normalizeSearchToken(options.kind);
  const status = normalizeSearchToken(options.status);
  const shouldApplyInitialCap = options.initial === true && !search && !kind && !status;
  const limitPerGroup = Math.max(1, Math.min(200, Number.isFinite(Number(options.limitPerGroup)) ? Math.trunc(Number(options.limitPerGroup)) : 20));
  const rows = shouldApplyInitialCap
    ? database.prepare(`
      SELECT ${RUN_LOG_LIST_SELECT_COLUMNS}
      FROM run_logs
      ORDER BY COALESCE(finished_at_utc, started_at_utc, '1970-01-01T00:00:00.000Z') DESC, id DESC
      LIMIT ?
    `).all(limitPerGroup) as Dict[]
    : (() => {
      const whereClauses: string[] = [];
      const params: string[] = [];
      if (kind) {
        whereClauses.push(isRunLogGroup(kind) ? 'lower(run_group) = ?' : 'lower(run_kind) = ?');
        params.push(kind);
      }
      if (status) {
        whereClauses.push('lower(terminal_state) = ?');
        params.push(status);
      }
      if (search) {
        whereClauses.push('(lower(title) LIKE ? OR lower(run_id) LIKE ?)');
        const likePattern = `%${search}%`;
        params.push(likePattern, likePattern);
      }
      const whereSql = whereClauses.length > 0 ? `WHERE ${whereClauses.join(' AND ')}` : '';
      return database.prepare(`
        SELECT ${RUN_LOG_LIST_SELECT_COLUMNS}
        FROM run_logs
        ${whereSql}
        ORDER BY COALESCE(started_at_utc, '1970-01-01T00:00:00.000Z') DESC, id DESC
      `).all(...params) as Dict[];
    })();
  return rows.map((row) => normalizeRunRecordFromDbRow(row));
}

function buildRunLogTypeWhereClause(type: DashboardRunLogType): { clause: string; params: string[] } {
  if (type === 'all') {
    return { clause: '', params: [] };
  }
  return {
    clause: 'WHERE run_group = ?',
    params: [type],
  };
}

function buildRunLogTimestampSql(): string {
  return `COALESCE(started_at_utc, finished_at_utc, flushed_at_utc, '1970-01-01T00:00:00.000Z')`;
}

function listRunLogIdsForDeletion(database: DatabaseInstance, criteria: DashboardRunLogDeleteCriteria): string[] {
  ensureRunLogsTable(database);
  const { clause, params } = buildRunLogTypeWhereClause(criteria.type);
  if (criteria.mode === 'count') {
    return database.prepare(`
      SELECT run_id
      FROM run_logs
      ${clause}
      ORDER BY ${buildRunLogTimestampSql()} ASC, id ASC
      LIMIT ?
    `).all(...params, criteria.count).map((row) => String((row as Dict).run_id || ''));
  }
  return database.prepare(`
    SELECT run_id
    FROM run_logs
    ${clause ? `${clause} AND ` : 'WHERE '}${buildRunLogTimestampSql()} < ?
    ORDER BY ${buildRunLogTimestampSql()} ASC, id ASC
  `).all(...params, `${criteria.beforeDate}T00:00:00.000Z`).map((row) => String((row as Dict).run_id || ''));
}

export function previewDashboardRunLogDeletion(
  database: DatabaseInstance,
  criteria: DashboardRunLogDeleteCriteria,
): { matchCount: number } {
  return {
    matchCount: listRunLogIdsForDeletion(database, criteria).length,
  };
}

export function deleteDashboardRunLogs(
  database: DatabaseInstance,
  criteria: DashboardRunLogDeleteCriteria,
): { deletedCount: number; deletedRunIds: string[] } {
  const deletedRunIds = listRunLogIdsForDeletion(database, criteria);
  if (deletedRunIds.length === 0) {
    return {
      deletedCount: 0,
      deletedRunIds,
    };
  }
  const placeholders = deletedRunIds.map(() => '?').join(', ');
  database.prepare(`
    DELETE FROM run_logs
    WHERE run_id IN (${placeholders})
  `).run(...deletedRunIds);
  return {
    deletedCount: deletedRunIds.length,
    deletedRunIds,
  };
}

export function queryDashboardRunDetailFromDb(
  database: DatabaseInstance,
  runId: string,
): { run: RunRecord; events: JsonlEvent[] } | null {
  ensureRunLogsTable(database);
  const row = database.prepare(`
    SELECT ${RUN_LOG_DETAIL_SELECT_COLUMNS}
    FROM run_logs
    WHERE run_id = ?
    LIMIT 1
  `).get(runId) as Dict | undefined;
  if (!row || typeof row !== 'object') {
    return null;
  }
  const run = normalizeRunRecordFromDbRow(row);
  const events: JsonlEvent[] = [];
  events.push(...parseJsonlEventsFromText(typeof row.repo_search_transcript_jsonl === 'string' ? row.repo_search_transcript_jsonl : null));
  const requestPayload = parseJsonObjectText(typeof row.request_json === 'string' ? row.request_json : null);
  if (requestPayload) {
    events.push({ kind: 'summary_request', at: run.startedAtUtc, payload: requestPayload });
  }
  const plannerPayload = parseJsonObjectText(typeof row.planner_debug_json === 'string' ? row.planner_debug_json : null);
  if (plannerPayload) {
    events.push({ kind: 'planner_debug', at: run.startedAtUtc, payload: plannerPayload });
  }
  const failedPayload = parseJsonObjectText(typeof row.failed_request_json === 'string' ? row.failed_request_json : null);
  if (failedPayload) {
    events.push({ kind: 'failed_request', at: run.startedAtUtc, payload: failedPayload });
  }
  const abandonedPayload = parseJsonObjectText(typeof row.abandoned_request_json === 'string' ? row.abandoned_request_json : null);
  if (abandonedPayload) {
    events.push({ kind: 'request_abandoned', at: run.startedAtUtc, payload: abandonedPayload });
  }
  const repoPayload = parseJsonObjectText(typeof row.repo_search_json === 'string' ? row.repo_search_json : null);
  if (repoPayload) {
    events.push({ kind: 'repo_search', at: run.startedAtUtc, payload: repoPayload });
  }
  return { run, events };
}

type RunArtifactPaths = {
  requestPath: string | null;
  plannerDebugPath: string | null;
  failedRequestPath: string | null;
  abandonedRequestPath: string | null;
  repoSearchPath: string | null;
  repoSearchTranscriptPath: string | null;
};

function buildRunArtifactPaths(requestId: string): RunArtifactPaths {
  const logsRoot = path.join(getRuntimeRoot(), 'logs');
  const requestPath = path.join(logsRoot, 'requests', `request_${requestId}.json`);
  const plannerDebugPath = path.join(logsRoot, `planner_debug_${requestId}.json`);
  const failedRequestPath = path.join(logsRoot, 'failed', `request_failed_${requestId}.json`);
  const abandonedRequestPath = path.join(logsRoot, 'abandoned', `request_abandoned_${requestId}.json`);
  const repoCandidates = [
    path.join(logsRoot, 'repo_search', 'failed', `request_${requestId}.json`),
    path.join(logsRoot, 'repo_search', 'succesful', `request_${requestId}.json`),
  ];
  const repoSearchPath = repoCandidates.find((candidate) => fs.existsSync(candidate)) || null;
  const repoSearchTranscriptPath = (
    repoSearchPath
    && fs.existsSync(repoSearchPath.replace(/\.json$/iu, '.jsonl'))
  )
    ? repoSearchPath.replace(/\.json$/iu, '.jsonl')
    : null;
  return {
    requestPath: fs.existsSync(requestPath) ? requestPath : null,
    plannerDebugPath: fs.existsSync(plannerDebugPath) ? plannerDebugPath : null,
    failedRequestPath: fs.existsSync(failedRequestPath) ? failedRequestPath : null,
    abandonedRequestPath: fs.existsSync(abandonedRequestPath) ? abandonedRequestPath : null,
    repoSearchPath,
    repoSearchTranscriptPath,
  };
}

function readTextIfExists(targetPath: string | null): string | null {
  if (!targetPath || !fs.existsSync(targetPath)) {
    return null;
  }
  return fs.readFileSync(targetPath, 'utf8');
}

function parseOptionalIsoDate(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) {
    return null;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

function parseRepoSearchTotals(payload: Dict | null): Dict | null {
  if (!payload || !payload.totals || typeof payload.totals !== 'object' || Array.isArray(payload.totals)) {
    return null;
  }
  return payload.totals as Dict;
}

function resolveRunKindAndGroup(
  taskKind: TaskKind | null,
  hasRepoSearch: boolean,
  hasAbandoned: boolean,
  hasSummaryRequest: boolean,
  hasFailedRequest: boolean,
): { runKind: RunLogKind; runGroup: RunLogGroup } {
  if (hasRepoSearch) {
    return taskKind === 'plan'
      ? { runKind: 'plan', runGroup: 'planner' }
      : { runKind: 'repo_search', runGroup: 'repo_search' };
  }
  if (hasAbandoned) {
    return { runKind: 'request_abandoned', runGroup: 'summary' };
  }
  if (hasSummaryRequest) {
    return { runKind: 'summary_request', runGroup: 'summary' };
  }
  if (hasFailedRequest) {
    return { runKind: 'failed_request', runGroup: 'summary' };
  }
  if (taskKind === 'chat') {
    return { runKind: 'chat', runGroup: 'chat' };
  }
  if (taskKind === 'plan') {
    return { runKind: 'plan', runGroup: 'planner' };
  }
  if (taskKind === 'repo-search') {
    return { runKind: 'repo_search', runGroup: 'repo_search' };
  }
  return { runKind: 'unknown', runGroup: 'other' };
}

function resolveTerminalState(
  explicitTerminalState: RunLogTerminalState | null,
  requestPayload: Dict | null,
  failedRequestPayload: Dict | null,
  abandonedPayload: Dict | null,
  repoSearchPayload: Dict | null,
): RunLogTerminalState {
  if (explicitTerminalState && explicitTerminalState !== 'unknown') {
    return explicitTerminalState;
  }
  if (abandonedPayload) {
    return 'abandoned';
  }
  if (failedRequestPayload) {
    return 'failed';
  }
  if (repoSearchPayload) {
    return repoSearchPayload.error || repoSearchPayload.verdict === 'fail' ? 'failed' : 'completed';
  }
  if (requestPayload) {
    return requestPayload.error ? 'failed' : 'completed';
  }
  return explicitTerminalState || 'unknown';
}

function resolveTitle(
  requestId: string,
  runKind: RunLogKind,
  requestPayload: Dict | null,
  failedRequestPayload: Dict | null,
  abandonedPayload: Dict | null,
  repoSearchPayload: Dict | null,
): string {
  if (requestPayload) {
    const question = typeof requestPayload.question === 'string' && requestPayload.question.trim()
      ? requestPayload.question.trim()
      : null;
    const prompt = typeof requestPayload.prompt === 'string' && requestPayload.prompt.trim()
      ? requestPayload.prompt.trim()
      : null;
    if (question) return question;
    if (prompt) return prompt;
  }
  if (failedRequestPayload && typeof failedRequestPayload.question === 'string' && failedRequestPayload.question.trim()) {
    return failedRequestPayload.question.trim();
  }
  if (abandonedPayload && typeof abandonedPayload.reason === 'string' && abandonedPayload.reason.trim()) {
    return abandonedPayload.reason.trim();
  }
  if (repoSearchPayload && typeof repoSearchPayload.prompt === 'string' && repoSearchPayload.prompt.trim()) {
    return repoSearchPayload.prompt.trim();
  }
  return `${runKind} ${requestId}`;
}

function buildRunLogRow(options: {
  requestId: string;
  taskKind: TaskKind | null;
  terminalState: RunLogTerminalState | null;
  nowUtc: string;
  artifactPaths: RunArtifactPaths;
}): RunLogUpsertRow | null {
  const requestJson = readTextIfExists(options.artifactPaths.requestPath);
  const plannerDebugJson = readTextIfExists(options.artifactPaths.plannerDebugPath);
  const failedRequestJson = readTextIfExists(options.artifactPaths.failedRequestPath);
  const abandonedRequestJson = readTextIfExists(options.artifactPaths.abandonedRequestPath);
  const repoSearchJson = readTextIfExists(options.artifactPaths.repoSearchPath);
  let repoSearchTranscriptJsonl = readTextIfExists(options.artifactPaths.repoSearchTranscriptPath);

  const requestPayload = parseJsonObjectText(requestJson);
  const failedRequestPayload = parseJsonObjectText(failedRequestJson);
  const abandonedPayload = parseJsonObjectText(abandonedRequestJson);
  const repoSearchPayload = parseJsonObjectText(repoSearchJson);

  const transcriptPathFromPayload = (
    repoSearchPayload
    && typeof repoSearchPayload.transcriptPath === 'string'
    && repoSearchPayload.transcriptPath.trim()
  )
    ? repoSearchPayload.transcriptPath.trim()
    : null;
  if (!repoSearchTranscriptJsonl && transcriptPathFromPayload && fs.existsSync(transcriptPathFromPayload)) {
    repoSearchTranscriptJsonl = fs.readFileSync(transcriptPathFromPayload, 'utf8');
  }

  if (
    requestJson === null
    && plannerDebugJson === null
    && failedRequestJson === null
    && abandonedRequestJson === null
    && repoSearchJson === null
    && repoSearchTranscriptJsonl === null
  ) {
    return null;
  }

  const hasRepoSearch = repoSearchJson !== null || repoSearchTranscriptJsonl !== null;
  const hasAbandoned = abandonedRequestJson !== null;
  const hasSummaryRequest = requestJson !== null;
  const hasFailedRequest = failedRequestJson !== null;
  const { runKind, runGroup } = resolveRunKindAndGroup(
    options.taskKind,
    hasRepoSearch,
    hasAbandoned,
    hasSummaryRequest,
    hasFailedRequest,
  );
  const terminalState = resolveTerminalState(
    options.terminalState,
    requestPayload,
    failedRequestPayload,
    abandonedPayload,
    repoSearchPayload,
  );
  const repoTotals = parseRepoSearchTotals(repoSearchPayload);
  const startedAtUtc = parseOptionalIsoDate(
    requestPayload?.createdAtUtc
      || failedRequestPayload?.createdAtUtc
      || abandonedPayload?.abandonedAtUtc
      || abandonedPayload?.createdAtUtc
      || repoSearchPayload?.createdAtUtc,
  ) || getIsoDateFromStat(
    options.artifactPaths.requestPath
      || options.artifactPaths.failedRequestPath
      || options.artifactPaths.abandonedRequestPath
      || options.artifactPaths.repoSearchPath
      || options.artifactPaths.plannerDebugPath
      || path.join(getRuntimeRoot(), 'logs'),
  );
  const sourcePaths = [
    options.artifactPaths.requestPath,
    options.artifactPaths.plannerDebugPath,
    options.artifactPaths.failedRequestPath,
    options.artifactPaths.abandonedRequestPath,
    options.artifactPaths.repoSearchPath,
    options.artifactPaths.repoSearchTranscriptPath,
    transcriptPathFromPayload,
  ].filter((entry): entry is string => Boolean(entry && entry.trim()));
  const uniqueSourcePaths = Array.from(new Set(sourcePaths));

  return {
    runId: options.requestId,
    requestId: options.requestId,
    runKind,
    runGroup,
    terminalState,
    startedAtUtc,
    finishedAtUtc: options.nowUtc,
    title: resolveTitle(options.requestId, runKind, requestPayload, failedRequestPayload, abandonedPayload, repoSearchPayload),
    model: typeof requestPayload?.model === 'string'
      ? requestPayload.model
      : (typeof repoSearchPayload?.model === 'string' ? repoSearchPayload.model : null),
    backend: typeof requestPayload?.backend === 'string'
      ? requestPayload.backend
      : (runKind === 'repo_search' || runKind === 'plan' ? 'llama.cpp' : null),
    repoRoot: typeof repoSearchPayload?.repoRoot === 'string' ? repoSearchPayload.repoRoot : null,
    inputTokens: getProcessedInputTokensValue(
      requestPayload?.inputTokens ?? failedRequestPayload?.inputTokens ?? repoTotals?.promptTokens ?? null,
      requestPayload?.promptCacheTokens ?? failedRequestPayload?.promptCacheTokens ?? repoTotals?.promptCacheTokens ?? null,
      requestPayload?.promptEvalTokens ?? failedRequestPayload?.promptEvalTokens ?? repoTotals?.promptEvalTokens ?? null,
    ),
    outputTokens: toNonNegativeInteger(requestPayload?.outputTokens ?? failedRequestPayload?.outputTokens ?? abandonedPayload?.outputTokensTotal ?? repoTotals?.outputTokens ?? null),
    thinkingTokens: toNonNegativeInteger(requestPayload?.thinkingTokens ?? failedRequestPayload?.thinkingTokens ?? repoTotals?.thinkingTokens ?? null),
    toolTokens: toNonNegativeInteger(repoTotals?.toolTokens ?? null),
    promptCacheTokens: toNonNegativeInteger(requestPayload?.promptCacheTokens ?? failedRequestPayload?.promptCacheTokens ?? repoTotals?.promptCacheTokens ?? null),
    promptEvalTokens: toNonNegativeInteger(requestPayload?.promptEvalTokens ?? failedRequestPayload?.promptEvalTokens ?? repoTotals?.promptEvalTokens ?? null),
    speculativeAcceptedTokens: toNonNegativeInteger(requestPayload?.speculativeAcceptedTokens ?? failedRequestPayload?.speculativeAcceptedTokens ?? repoTotals?.speculativeAcceptedTokens ?? null),
    speculativeGeneratedTokens: toNonNegativeInteger(requestPayload?.speculativeGeneratedTokens ?? failedRequestPayload?.speculativeGeneratedTokens ?? repoTotals?.speculativeGeneratedTokens ?? null),
    durationMs: toNonNegativeInteger(
      requestPayload?.requestDurationMs
        ?? failedRequestPayload?.requestDurationMs
        ?? abandonedPayload?.totalElapsedMs
        ?? getTranscriptDurationMsFromText(repoSearchTranscriptJsonl)
        ?? null,
    ),
    requestJson,
    plannerDebugJson,
    failedRequestJson,
    abandonedRequestJson,
    repoSearchJson,
    repoSearchTranscriptJsonl,
    sourcePathsJson: JSON.stringify(uniqueSourcePaths),
    flushedAtUtc: options.nowUtc,
  };
}

export function flushRunArtifactsToDbAndDelete(options: {
  database: DatabaseInstance;
  requestId: string;
  terminalState?: RunLogTerminalState | null;
  taskKind?: TaskKind | null;
}): boolean {
  const requestId = String(options.requestId || '').trim();
  if (!requestId) {
    return false;
  }
  ensureRunLogsTable(options.database);
  const nowUtc = new Date().toISOString();
  const row = buildRunLogRow({
    requestId,
    taskKind: options.taskKind ?? null,
    terminalState: options.terminalState ?? null,
    nowUtc,
    artifactPaths: buildRunArtifactPaths(requestId),
  });
  if (!row) {
    return false;
  }
  options.database.transaction(() => {
    upsertRunLog(options.database, row);
  })();
  const rawSourcePaths = JSON.parse(row.sourcePathsJson) as unknown[];
  const sourcePaths = rawSourcePaths
    .filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0);
  let deletedEverySource = true;
  for (const sourcePath of sourcePaths) {
    if (!fs.existsSync(sourcePath)) {
      continue;
    }
    try {
      fs.unlinkSync(sourcePath);
    } catch {
      if (fs.existsSync(sourcePath)) {
        deletedEverySource = false;
      }
    }
  }
  if (deletedEverySource) {
    options.database.prepare(`
      UPDATE run_logs
      SET source_deleted_at_utc = ?
      WHERE run_id = ?
    `).run(nowUtc, requestId);
  }
  return true;
}

const DEFAULT_RUN_LOG_FLUSH_TIMEOUT_MS = 250;
const DEFAULT_RUN_LOG_MIGRATION_TIMEOUT_MS = 2000;

function readNonNegativeIntegerEnv(key: string, fallback: number): number {
  const parsed = Number.parseInt(String(process.env[key] || ''), 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

export function getRunLogFlushTimeoutMs(): number {
  return readNonNegativeIntegerEnv('SIFTKIT_RUN_LOG_FLUSH_TIMEOUT_MS', DEFAULT_RUN_LOG_FLUSH_TIMEOUT_MS);
}

export function getRunLogMigrationTimeoutMs(): number {
  return readNonNegativeIntegerEnv('SIFTKIT_RUN_LOG_MIGRATION_TIMEOUT_MS', DEFAULT_RUN_LOG_MIGRATION_TIMEOUT_MS);
}

export type RunLogFlushResult = {
  flushed: boolean;
  timedOut: boolean;
  elapsedMs: number;
};

export function flushRunArtifactsToDbAndDeleteBounded(options: {
  database: DatabaseInstance;
  requestId: string;
  terminalState?: RunLogTerminalState | null;
  taskKind?: TaskKind | null;
  timeoutMs?: number | null;
}): RunLogFlushResult {
  const startedAt = Date.now();
  const flushed = flushRunArtifactsToDbAndDelete(options);
  const elapsedMs = Math.max(0, Date.now() - startedAt);
  const timeoutMs = Number.isFinite(Number(options.timeoutMs)) ? Math.max(0, Number(options.timeoutMs)) : Number.POSITIVE_INFINITY;
  return {
    flushed,
    timedOut: Number.isFinite(timeoutMs) && elapsedMs > timeoutMs,
    elapsedMs,
  };
}

function collectRunLogRequestIdsFromDisk(): string[] {
  const logsRoot = path.join(getRuntimeRoot(), 'logs');
  const requestIds = new Set<string>();
  const collectFromDirectory = (targetPath: string, pattern: RegExp): void => {
    for (const filePath of listFiles(targetPath)) {
      const match = pattern.exec(path.basename(filePath));
      if (match && match[1]) {
        requestIds.add(match[1]);
      }
    }
  };
  collectFromDirectory(path.join(logsRoot, 'requests'), /^request_(.+)\.json$/iu);
  collectFromDirectory(path.join(logsRoot, 'failed'), /^request_failed_(.+)\.json$/iu);
  collectFromDirectory(path.join(logsRoot, 'abandoned'), /^request_abandoned_(.+)\.json$/iu);
  collectFromDirectory(logsRoot, /^planner_debug_(.+)\.json$/iu);
  collectFromDirectory(path.join(logsRoot, 'repo_search', 'failed'), /^request_(.+)\.jsonl?$/iu);
  collectFromDirectory(path.join(logsRoot, 'repo_search', 'succesful'), /^request_(.+)\.jsonl?$/iu);
  return Array.from(requestIds).sort((left, right) => left.localeCompare(right));
}

export function migrateExistingRunLogsToDbAndDelete(database: DatabaseInstance): number {
  return migrateExistingRunLogsToDbAndDeleteBounded(database).migratedCount;
}

export type RunLogMigrationResult = {
  migratedCount: number;
  timedOut: boolean;
  elapsedMs: number;
};

export function migrateExistingRunLogsToDbAndDeleteBounded(
  database: DatabaseInstance,
  options: { timeoutMs?: number | null } = {},
): RunLogMigrationResult {
  ensureRunLogsTable(database);
  const startedAt = Date.now();
  const timeoutMs = Number.isFinite(Number(options.timeoutMs))
    ? Math.max(0, Number(options.timeoutMs))
    : Number.POSITIVE_INFINITY;
  let migratedCount = 0;
  for (const requestId of collectRunLogRequestIdsFromDisk()) {
    if (Number.isFinite(timeoutMs) && (Date.now() - startedAt) > timeoutMs) {
      return {
        migratedCount,
        timedOut: true,
        elapsedMs: Math.max(0, Date.now() - startedAt),
      };
    }
    try {
      if (flushRunArtifactsToDbAndDelete({
        database,
        requestId,
        terminalState: null,
        taskKind: null,
      })) {
        migratedCount += 1;
      }
    } catch {
      // continue best-effort migration
    }
  }
  return {
    migratedCount,
    timedOut: false,
    elapsedMs: Math.max(0, Date.now() - startedAt),
  };
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

export function normalizeIdleSummarySnapshotRow(row: Dict | null): IdleSummarySnapshotRow | null {
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
