import * as fs from 'node:fs';
import Database from 'better-sqlite3';
import { getRuntimeDatabasePath } from '../../config/paths.js';
import { type JsonlEvent } from '../../state/jsonl-transcript.js';
import { ensureRunLogsTable } from './table.js';
import type {
  DashboardRunsQueryOptions,
  RunLogDbRow,
  RunLogGroup,
  RunRecord,
} from './types.js';
import {
  normalizeRunRecordFromDbRow,
  parseJsonlEventsFromText,
  parseJsonObjectText,
} from './run-records.js';

type DatabaseInstance = InstanceType<typeof Database>;

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
  prompt_eval_duration_ms,
  generation_duration_ms,
  speculative_accepted_tokens,
  speculative_generated_tokens,
  duration_ms,
  provider_duration_ms,
  wall_duration_ms
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
  prompt_eval_duration_ms,
  generation_duration_ms,
  speculative_accepted_tokens,
  speculative_generated_tokens,
  duration_ms,
  provider_duration_ms,
  wall_duration_ms,
  request_json,
  planner_debug_json,
  failed_request_json,
  abandoned_request_json,
  repo_search_json,
  repo_search_transcript_jsonl
`;

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
    `).all(limitPerGroup) as RunLogDbRow[]
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
      `).all(...params) as RunLogDbRow[];
    })();
  return rows.map((row) => normalizeRunRecordFromDbRow(row));
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
  `).get(runId) as RunLogDbRow | undefined;
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
