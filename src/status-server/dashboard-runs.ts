import * as fs from 'node:fs';
import * as path from 'node:path';
import Database from 'better-sqlite3';
import type { Dict } from '../lib/types.js';
import { getRuntimeRoot } from './paths.js';
import { formatInteger, formatElapsed } from '../lib/text-format.js';
import { listFiles, getIsoDateFromStat } from '../lib/fs.js';
import {
  TASK_KINDS,
  type Metrics,
  type ToolTypeStats,
  type TaskKind,
  type ToolStatsByTask,
  normalizeMetrics,
} from './metrics.js';
import {
  aggregateGlobalToolStats,
  buildLineReadGuidance,
  getPlannerPromptBaselinePerToolAllowanceTokens,
  getRepoSearchPromptBaselinePerToolAllowanceTokens,
} from '../line-read-guidance.js';
import {
  type IdleSummarySnapshot,
  type SnapshotTotals,
  parseSnapshotTaskTotalsJson,
  parseSnapshotToolStatsJson,
  buildIdleSummarySnapshotMessage,
  queryRecentSnapshots,
  querySnapshotTotalsBeforeDate,
  querySnapshotTimeseries,
} from './idle-summary.js';
import { type StatusMetadata } from './status-file.js';
import { type JsonlEvent } from '../state/jsonl-transcript.js';
import type { SiftConfig } from '../config/index.js';

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
  const logsPath = path.join(getRuntimeRoot(), 'logs');
  if (metadata.artifactType === 'summary_request') {
    return path.join(logsPath, 'requests', `request_${metadata.artifactRequestId}.json`);
  }
  if (metadata.artifactType === 'planner_debug') {
    return path.join(logsPath, `planner_debug_${metadata.artifactRequestId}.json`);
  }
  if (metadata.artifactType === 'planner_failed') {
    return path.join(logsPath, 'failed', `request_failed_${metadata.artifactRequestId}.json`);
  }
  if (metadata.artifactType === 'request_abandoned') {
    return path.join(logsPath, 'abandoned', `request_abandoned_${metadata.artifactRequestId}.json`);
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
  promptCacheTokens: number | null;
  promptEvalTokens: number | null;
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
    promptCacheTokens: Number.isFinite(record.promptCacheTokens) ? Number(record.promptCacheTokens) : null,
    promptEvalTokens: Number.isFinite(record.promptEvalTokens) ? Number(record.promptEvalTokens) : null,
    durationMs: Number.isFinite(record.durationMs) ? Number(record.durationMs) : null,
    rawPaths: record.rawPaths && typeof record.rawPaths === 'object' ? record.rawPaths as Dict : {},
  };
}

export function loadDashboardRuns(runtimeRoot: string): RunRecord[] {
  void runtimeRoot;
  const databasePath = path.join(getRuntimeRoot(), 'status', 'idle-summary.sqlite');
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
  const databasePath = path.join(getRuntimeRoot(), 'status', 'idle-summary.sqlite');
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

function toNonNegativeInteger(value: unknown): number | null {
  if (!Number.isFinite(Number(value))) {
    return null;
  }
  const next = Math.max(0, Math.trunc(Number(value)));
  return Number.isFinite(next) ? next : null;
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
    promptCacheTokens: toNonNegativeInteger(row.prompt_cache_tokens),
    promptEvalTokens: toNonNegativeInteger(row.prompt_eval_tokens),
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
}

export function upsertRunLog(database: DatabaseInstance, row: RunLogUpsertRow): void {
  ensureRunLogsTable(database);
  database.prepare(`
    INSERT INTO run_logs (
      run_id, request_id, run_kind, run_group, terminal_state,
      started_at_utc, finished_at_utc, title, model, backend, repo_root,
      input_tokens, output_tokens, thinking_tokens, tool_tokens, prompt_cache_tokens, prompt_eval_tokens, duration_ms,
      request_json, planner_debug_json, failed_request_json, abandoned_request_json, repo_search_json, repo_search_transcript_jsonl,
      source_paths_json, flushed_at_utc, source_deleted_at_utc
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
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
      WITH ranked AS (
        SELECT *,
               ROW_NUMBER() OVER (
                 PARTITION BY run_group
                 ORDER BY COALESCE(started_at_utc, '1970-01-01T00:00:00.000Z') DESC, id DESC
               ) AS run_group_rank
        FROM run_logs
      )
      SELECT * FROM ranked
      WHERE run_group_rank <= ?
      ORDER BY COALESCE(started_at_utc, '1970-01-01T00:00:00.000Z') DESC, id DESC
    `).all(limitPerGroup) as Dict[]
    : (() => {
      const whereClauses: string[] = [];
      const params: string[] = [];
      if (kind) {
        whereClauses.push('lower(run_kind) = ?');
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
        SELECT * FROM run_logs
        ${whereSql}
        ORDER BY COALESCE(started_at_utc, '1970-01-01T00:00:00.000Z') DESC, id DESC
      `).all(...params) as Dict[];
    })();
  return rows.map((row) => normalizeRunRecordFromDbRow(row));
}

export function queryDashboardRunDetailFromDb(
  database: DatabaseInstance,
  runId: string,
): { run: RunRecord; events: JsonlEvent[] } | null {
  ensureRunLogsTable(database);
  const row = database.prepare(`
    SELECT * FROM run_logs WHERE run_id = ? LIMIT 1
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
    inputTokens: toNonNegativeInteger(requestPayload?.inputTokens ?? failedRequestPayload?.inputTokens ?? repoTotals?.promptTokens ?? null),
    outputTokens: toNonNegativeInteger(requestPayload?.outputTokens ?? failedRequestPayload?.outputTokens ?? abandonedPayload?.outputTokensTotal ?? repoTotals?.outputTokens ?? null),
    thinkingTokens: toNonNegativeInteger(requestPayload?.thinkingTokens ?? failedRequestPayload?.thinkingTokens ?? repoTotals?.thinkingTokens ?? null),
    toolTokens: toNonNegativeInteger(repoTotals?.toolTokens ?? null),
    promptCacheTokens: toNonNegativeInteger(requestPayload?.promptCacheTokens ?? failedRequestPayload?.promptCacheTokens ?? repoTotals?.promptCacheTokens ?? null),
    promptEvalTokens: toNonNegativeInteger(requestPayload?.promptEvalTokens ?? failedRequestPayload?.promptEvalTokens ?? repoTotals?.promptEvalTokens ?? null),
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
  ensureRunLogsTable(database);
  let migratedCount = 0;
  for (const requestId of collectRunLogRequestIdsFromDisk()) {
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
  return migratedCount;
}

export function getPromptCacheHitRate(promptCacheTokens: unknown, promptEvalTokens: unknown): number | null {
  const cacheTokens = Number(promptCacheTokens) || 0;
  const evalTokens = Number(promptEvalTokens) || 0;
  const totalPromptTokens = cacheTokens + evalTokens;
  if (totalPromptTokens <= 0) {
    return null;
  }
  return cacheTokens / totalPromptTokens;
}

export function getCurrentUtcDateKey(): string {
  return new Date().toISOString().slice(0, 10);
}

export { type SnapshotTotals } from './idle-summary.js';

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
  cacheHitRate: number | null;
  successCount: number;
  failureCount: number;
  avgDurationMs: number;
};

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
  const requestDurationMsTotal = Number(totals.requestDurationMsTotal) || 0;
  const runs = Math.max(0, completedRequestCount - (baseline ? baseline.completedRequestCount : 0));
  const inputTokens = Math.max(0, inputTokensTotal - (baseline ? baseline.inputTokensTotal : 0));
  const outputTokens = Math.max(0, outputTokensTotal - (baseline ? baseline.outputTokensTotal : 0));
  const thinkingTokens = Math.max(0, thinkingTokensTotal - (baseline ? baseline.thinkingTokensTotal : 0));
  const toolTokens = Math.max(0, toolTokensTotal - (baseline ? baseline.toolTokensTotal : 0));
  const promptCacheTokens = Math.max(0, promptCacheTokensTotal - (baseline ? baseline.promptCacheTokensTotal : 0));
  const promptEvalTokens = Math.max(0, promptEvalTokensTotal - (baseline ? baseline.promptEvalTokensTotal : 0));
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
    cacheHitRate: getPromptCacheHitRate(promptCacheTokens, promptEvalTokens),
    successCount: 0,
    failureCount: 0,
    avgDurationMs: runs > 0 ? Math.round(durationTotalMs / runs) : 0,
  };
}

type DailyAccumulator = DailyMetrics & { durationTotalMs: number; durationCount: number };

export function buildDashboardDailyMetricsFromRuns(database: DatabaseInstance | null): DailyMetrics[] {
  const runs = database ? queryDashboardRunsFromDb(database) : [];
  const byDay = new Map<string, DailyAccumulator>();
  for (const run of runs) {
    const startedAt = run.startedAtUtc || new Date(0).toISOString();
    const day = startedAt.slice(0, 10);
    const current: DailyAccumulator = byDay.get(day) || {
      date: day,
      runs: 0,
      inputTokens: 0,
      outputTokens: 0,
      thinkingTokens: 0,
      toolTokens: 0,
      promptCacheTokens: 0,
      promptEvalTokens: 0,
      cacheHitRate: null,
      successCount: 0,
      failureCount: 0,
      avgDurationMs: 0,
      durationTotalMs: 0,
      durationCount: 0,
    };
    current.runs += 1;
    current.inputTokens += Number(run.inputTokens || 0);
    current.outputTokens += Number(run.outputTokens || 0);
    current.thinkingTokens += Number(run.thinkingTokens || 0);
    current.toolTokens += 0;
    current.promptCacheTokens += Number(run.promptCacheTokens || 0);
    current.promptEvalTokens += Number(run.promptEvalTokens || 0);
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
      cacheHitRate: getPromptCacheHitRate(entry.promptCacheTokens, entry.promptEvalTokens),
      successCount: entry.successCount,
      failureCount: entry.failureCount,
      avgDurationMs: entry.durationCount > 0 ? Math.round(entry.durationTotalMs / entry.durationCount) : 0,
    }));
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
    const current: DailyAccumulator = byDay.get(day) || {
      date: day,
      runs: 0,
      inputTokens: 0,
      outputTokens: 0,
      thinkingTokens: 0,
      toolTokens: 0,
      promptCacheTokens: 0,
      promptEvalTokens: 0,
      cacheHitRate: null,
      successCount: 0,
      failureCount: 0,
      avgDurationMs: 0,
      durationTotalMs: 0,
      durationCount: 0,
    };
    const completedRequestCount = Number(row.completed_request_count) || 0;
    const inputTokensTotal = Number(row.input_tokens_total) || 0;
    const outputTokensTotal = Number(row.output_tokens_total) || 0;
    const thinkingTokensTotal = Number(row.thinking_tokens_total) || 0;
    const promptCacheTokensTotal = Number(row.prompt_cache_tokens_total) || 0;
    const promptEvalTokensTotal = Number(row.prompt_eval_tokens_total) || 0;
    const toolTokensTotal = Number(row.tool_tokens_total) || 0;
    const taskTotals = parseSnapshotTaskTotalsJson(row.task_totals_json);
    const requestDurationMsTotal = Number(row.request_duration_ms_total) || 0;
    const deltaRuns = Math.max(0, previous ? completedRequestCount - previous.completedRequestCount : completedRequestCount);
    const deltaInput = Math.max(0, previous ? inputTokensTotal - previous.inputTokensTotal : inputTokensTotal);
    const deltaOutput = Math.max(0, previous ? outputTokensTotal - previous.outputTokensTotal : outputTokensTotal);
    const deltaThinking = Math.max(0, previous ? thinkingTokensTotal - previous.thinkingTokensTotal : thinkingTokensTotal);
    const deltaTool = Math.max(0, previous ? toolTokensTotal - previous.toolTokensTotal : toolTokensTotal);
    const deltaPromptCache = Math.max(0, previous ? promptCacheTokensTotal - previous.promptCacheTokensTotal : promptCacheTokensTotal);
    const deltaPromptEval = Math.max(0, previous ? promptEvalTokensTotal - previous.promptEvalTokensTotal : promptEvalTokensTotal);
    const deltaDuration = Math.max(0, previous ? requestDurationMsTotal - previous.requestDurationMsTotal : requestDurationMsTotal);
    current.runs += deltaRuns;
    current.inputTokens += deltaInput;
    current.outputTokens += deltaOutput;
    current.thinkingTokens += deltaThinking;
    current.toolTokens += deltaTool;
    current.promptCacheTokens += deltaPromptCache;
    current.promptEvalTokens += deltaPromptEval;
    current.durationTotalMs += deltaDuration;
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
      requestDurationMsTotal,
      taskTotals,
    };
  }
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
      cacheHitRate: getPromptCacheHitRate(entry.promptCacheTokens, entry.promptEvalTokens),
      successCount: entry.successCount,
      failureCount: entry.failureCount,
      avgDurationMs: entry.durationCount > 0 ? Math.round(entry.durationTotalMs / entry.durationCount) : 0,
    }));
}

export function buildDashboardDailyMetrics(runtimeRoot: string, idleSummaryDatabase: DatabaseInstance | null, currentMetrics: Metrics): DailyMetrics[] {
  void runtimeRoot;
  const runDays = buildDashboardDailyMetricsFromRuns(idleSummaryDatabase);
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
  const repoSearchAllowance = getRepoSearchPromptBaselinePerToolAllowanceTokens(config);
  const plannerAllowance = getPlannerPromptBaselinePerToolAllowanceTokens(config);
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
    thinkingTokensTotal: Number(row.thinking_tokens_total) || 0,
    toolTokensTotal: Number(row.tool_tokens_total) || 0,
    promptCacheTokensTotal: Number(row.prompt_cache_tokens_total) || 0,
    promptEvalTokensTotal: Number(row.prompt_eval_tokens_total) || 0,
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
