import { randomUUID } from 'node:crypto';
import type { Dict } from '../lib/types.js';
import { getRuntimeDatabase, type RuntimeDatabase } from './runtime-db.js';

export type BenchmarkMatrixSessionStatus = 'running' | 'completed' | 'failed';
export type BenchmarkMatrixBaselineRestoreStatus = 'pending' | 'completed' | 'failed';
export type BenchmarkMatrixRunStatus = 'running' | 'completed' | 'failed';
export type BenchmarkMatrixLogStreamKind =
  | 'launcher_stdout'
  | 'launcher_stderr'
  | 'benchmark_stdout'
  | 'benchmark_stderr'
  | 'stop_stdout'
  | 'stop_stderr'
  | 'force_stop_stdout'
  | 'force_stop_stderr';

const SESSION_STATUSES = new Set<BenchmarkMatrixSessionStatus>(['running', 'completed', 'failed']);
const BASELINE_STATUSES = new Set<BenchmarkMatrixBaselineRestoreStatus>(['pending', 'completed', 'failed']);
const RUN_STATUSES = new Set<BenchmarkMatrixRunStatus>(['running', 'completed', 'failed']);
const LOG_STREAMS = new Set<BenchmarkMatrixLogStreamKind>([
  'launcher_stdout',
  'launcher_stderr',
  'benchmark_stdout',
  'benchmark_stderr',
  'stop_stdout',
  'stop_stderr',
  'force_stop_stdout',
  'force_stop_stderr',
]);

export type BenchmarkMatrixSessionRecord = {
  id: string;
  manifestPath: string;
  fixtureRoot: string;
  configUrl: string;
  promptPrefixFile: string | null;
  requestTimeoutSeconds: number;
  selectedRunIds: string[];
  baselineRestoreStatus: BenchmarkMatrixBaselineRestoreStatus;
  baselineRestoreError: string | null;
  status: BenchmarkMatrixSessionStatus;
  startedAtUtc: string;
  completedAtUtc: string | null;
  updatedAtUtc: string;
};

export type BenchmarkMatrixRunRecord = {
  id: string;
  sessionId: string;
  runIndex: number;
  runIdentifier: string;
  label: string;
  modelId: string;
  modelPath: string;
  startScript: string;
  promptPrefixFile: string | null;
  reasoning: 'on' | 'off' | 'auto';
  sampling: Dict | null;
  status: BenchmarkMatrixRunStatus;
  errorMessage: string | null;
  benchmarkRunUri: string | null;
  startedAtUtc: string;
  completedAtUtc: string | null;
  updatedAtUtc: string;
};

function getDatabase(databasePath?: string): RuntimeDatabase {
  return getRuntimeDatabase(databasePath);
}

function normalizeSessionStatus(value: unknown): BenchmarkMatrixSessionStatus {
  const normalized = String(value || '').trim() as BenchmarkMatrixSessionStatus;
  return SESSION_STATUSES.has(normalized) ? normalized : 'running';
}

function normalizeBaselineStatus(value: unknown): BenchmarkMatrixBaselineRestoreStatus {
  const normalized = String(value || '').trim() as BenchmarkMatrixBaselineRestoreStatus;
  return BASELINE_STATUSES.has(normalized) ? normalized : 'pending';
}

function normalizeRunStatus(value: unknown): BenchmarkMatrixRunStatus {
  const normalized = String(value || '').trim() as BenchmarkMatrixRunStatus;
  return RUN_STATUSES.has(normalized) ? normalized : 'running';
}

function normalizeStream(value: unknown): BenchmarkMatrixLogStreamKind {
  const normalized = String(value || '').trim() as BenchmarkMatrixLogStreamKind;
  if (!LOG_STREAMS.has(normalized)) {
    throw new Error(`Unsupported benchmark-matrix stream kind: ${String(value || '')}`);
  }
  return normalized;
}

function parseJsonObject(value: unknown): Dict | null {
  if (typeof value !== 'string' || !value.trim()) {
    return null;
  }
  try {
    const parsed = JSON.parse(value) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Dict;
    }
  } catch {
    // Ignore malformed JSON.
  }
  return null;
}

function parseStringArray(value: unknown): string[] {
  if (typeof value !== 'string' || !value.trim()) {
    return [];
  }
  try {
    const parsed = JSON.parse(value) as unknown;
    if (Array.isArray(parsed)) {
      return parsed.map((entry) => String(entry || '').trim()).filter(Boolean);
    }
  } catch {
    // Ignore malformed JSON.
  }
  return [];
}

function normalizeSessionRecord(row: Record<string, unknown> | undefined): BenchmarkMatrixSessionRecord | null {
  if (!row || typeof row.id !== 'string') {
    return null;
  }
  return {
    id: row.id,
    manifestPath: typeof row.manifest_path === 'string' ? row.manifest_path : '',
    fixtureRoot: typeof row.fixture_root === 'string' ? row.fixture_root : '',
    configUrl: typeof row.config_url === 'string' ? row.config_url : '',
    promptPrefixFile: typeof row.prompt_prefix_file === 'string' ? row.prompt_prefix_file : null,
    requestTimeoutSeconds: Number.isFinite(row.request_timeout_seconds) ? Number(row.request_timeout_seconds) : 0,
    selectedRunIds: parseStringArray(row.selected_run_ids_json),
    baselineRestoreStatus: normalizeBaselineStatus(row.baseline_restore_status),
    baselineRestoreError: typeof row.baseline_restore_error === 'string' ? row.baseline_restore_error : null,
    status: normalizeSessionStatus(row.status),
    startedAtUtc: typeof row.started_at_utc === 'string' ? row.started_at_utc : new Date(0).toISOString(),
    completedAtUtc: typeof row.completed_at_utc === 'string' ? row.completed_at_utc : null,
    updatedAtUtc: typeof row.updated_at_utc === 'string' ? row.updated_at_utc : new Date(0).toISOString(),
  };
}

function normalizeRunRecord(row: Record<string, unknown> | undefined): BenchmarkMatrixRunRecord | null {
  if (!row || typeof row.id !== 'string' || typeof row.session_id !== 'string') {
    return null;
  }
  const reasoningRaw = String(row.reasoning || '').trim().toLowerCase();
  const reasoning = reasoningRaw === 'on' || reasoningRaw === 'auto' ? reasoningRaw : 'off';
  return {
    id: row.id,
    sessionId: row.session_id,
    runIndex: Number.isFinite(row.run_index) ? Number(row.run_index) : 0,
    runIdentifier: typeof row.run_identifier === 'string' ? row.run_identifier : '',
    label: typeof row.label === 'string' ? row.label : '',
    modelId: typeof row.model_id === 'string' ? row.model_id : '',
    modelPath: typeof row.model_path === 'string' ? row.model_path : '',
    startScript: typeof row.start_script === 'string' ? row.start_script : '',
    promptPrefixFile: typeof row.prompt_prefix_file === 'string' ? row.prompt_prefix_file : null,
    reasoning,
    sampling: parseJsonObject(row.sampling_json),
    status: normalizeRunStatus(row.status),
    errorMessage: typeof row.error_message === 'string' ? row.error_message : null,
    benchmarkRunUri: typeof row.benchmark_run_uri === 'string' ? row.benchmark_run_uri : null,
    startedAtUtc: typeof row.started_at_utc === 'string' ? row.started_at_utc : new Date(0).toISOString(),
    completedAtUtc: typeof row.completed_at_utc === 'string' ? row.completed_at_utc : null,
    updatedAtUtc: typeof row.updated_at_utc === 'string' ? row.updated_at_utc : new Date(0).toISOString(),
  };
}

export function getBenchmarkMatrixSessionUri(id: string): string {
  return `db://benchmark-matrix-sessions/${id}`;
}

export function getBenchmarkMatrixRunUri(id: string): string {
  return `db://benchmark-matrix-runs/${id}`;
}

export function createBenchmarkMatrixSession(options: {
  id?: string;
  manifestPath: string;
  fixtureRoot: string;
  configUrl: string;
  promptPrefixFile?: string | null;
  requestTimeoutSeconds: number;
  selectedRunIds: string[];
  databasePath?: string;
}): BenchmarkMatrixSessionRecord {
  const database = getDatabase(options.databasePath);
  const id = String(options.id || '').trim() || randomUUID();
  const nowUtc = new Date().toISOString();
  database.prepare(`
    INSERT INTO benchmark_matrix_sessions (
      id, manifest_path, fixture_root, config_url, prompt_prefix_file,
      request_timeout_seconds, selected_run_ids_json,
      baseline_restore_status, baseline_restore_error, status,
      started_at_utc, completed_at_utc, updated_at_utc
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', NULL, 'running', ?, NULL, ?)
    ON CONFLICT(id) DO UPDATE SET
      manifest_path = excluded.manifest_path,
      fixture_root = excluded.fixture_root,
      config_url = excluded.config_url,
      prompt_prefix_file = excluded.prompt_prefix_file,
      request_timeout_seconds = excluded.request_timeout_seconds,
      selected_run_ids_json = excluded.selected_run_ids_json,
      updated_at_utc = excluded.updated_at_utc
  `).run(
    id,
    String(options.manifestPath || '').trim(),
    String(options.fixtureRoot || '').trim(),
    String(options.configUrl || '').trim(),
    options.promptPrefixFile ?? null,
    Number.isFinite(options.requestTimeoutSeconds) ? Math.max(1, Math.trunc(Number(options.requestTimeoutSeconds))) : 1,
    JSON.stringify(Array.isArray(options.selectedRunIds) ? options.selectedRunIds : []),
    nowUtc,
    nowUtc,
  );
  const created = readBenchmarkMatrixSession(id, options.databasePath);
  if (!created) {
    throw new Error(`Failed to persist benchmark matrix session: ${id}`);
  }
  return created;
}

export function updateBenchmarkMatrixSession(options: {
  id: string;
  status?: BenchmarkMatrixSessionStatus;
  baselineRestoreStatus?: BenchmarkMatrixBaselineRestoreStatus;
  baselineRestoreError?: string | null;
  completedAtUtc?: string | null;
  databasePath?: string;
}): BenchmarkMatrixSessionRecord {
  const id = String(options.id || '').trim();
  if (!id) {
    throw new Error('Benchmark matrix session id is required.');
  }
  const database = getDatabase(options.databasePath);
  const nowUtc = new Date().toISOString();
  const previous = readBenchmarkMatrixSession(id, options.databasePath);
  if (!previous) {
    throw new Error(`Benchmark matrix session not found: ${id}`);
  }
  database.prepare(`
    UPDATE benchmark_matrix_sessions
    SET status = ?,
        baseline_restore_status = ?,
        baseline_restore_error = ?,
        completed_at_utc = ?,
        updated_at_utc = ?
    WHERE id = ?
  `).run(
    options.status ? normalizeSessionStatus(options.status) : previous.status,
    options.baselineRestoreStatus ? normalizeBaselineStatus(options.baselineRestoreStatus) : previous.baselineRestoreStatus,
    options.baselineRestoreError ?? previous.baselineRestoreError,
    options.completedAtUtc ?? previous.completedAtUtc,
    nowUtc,
    id,
  );
  const updated = readBenchmarkMatrixSession(id, options.databasePath);
  if (!updated) {
    throw new Error(`Benchmark matrix session not found after update: ${id}`);
  }
  return updated;
}

export function createBenchmarkMatrixRun(options: {
  id?: string;
  sessionId: string;
  runIndex: number;
  runIdentifier: string;
  label: string;
  modelId: string;
  modelPath: string;
  startScript: string;
  promptPrefixFile?: string | null;
  reasoning: 'on' | 'off' | 'auto';
  sampling?: Dict | null;
  databasePath?: string;
}): BenchmarkMatrixRunRecord {
  const database = getDatabase(options.databasePath);
  const id = String(options.id || '').trim() || randomUUID();
  const nowUtc = new Date().toISOString();
  database.prepare(`
    INSERT INTO benchmark_matrix_runs (
      id, session_id, run_index, run_identifier, label, model_id, model_path,
      start_script, prompt_prefix_file, reasoning, sampling_json, status,
      error_message, benchmark_run_uri, started_at_utc, completed_at_utc, updated_at_utc
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'running', NULL, NULL, ?, NULL, ?)
    ON CONFLICT(id) DO UPDATE SET
      status = excluded.status,
      error_message = excluded.error_message,
      benchmark_run_uri = excluded.benchmark_run_uri,
      completed_at_utc = excluded.completed_at_utc,
      updated_at_utc = excluded.updated_at_utc
  `).run(
    id,
    String(options.sessionId || '').trim(),
    Number.isFinite(options.runIndex) ? Math.max(0, Math.trunc(Number(options.runIndex))) : 0,
    String(options.runIdentifier || '').trim(),
    String(options.label || '').trim(),
    String(options.modelId || '').trim(),
    String(options.modelPath || '').trim(),
    String(options.startScript || '').trim(),
    options.promptPrefixFile ?? null,
    String(options.reasoning || 'off').trim(),
    options.sampling ? JSON.stringify(options.sampling) : null,
    nowUtc,
    nowUtc,
  );
  const created = readBenchmarkMatrixRun(id, options.databasePath);
  if (!created) {
    throw new Error(`Failed to persist benchmark matrix run: ${id}`);
  }
  return created;
}

export function updateBenchmarkMatrixRun(options: {
  id: string;
  status: BenchmarkMatrixRunStatus;
  errorMessage?: string | null;
  benchmarkRunUri?: string | null;
  completedAtUtc?: string | null;
  databasePath?: string;
}): BenchmarkMatrixRunRecord {
  const id = String(options.id || '').trim();
  if (!id) {
    throw new Error('Benchmark matrix run id is required.');
  }
  const database = getDatabase(options.databasePath);
  const nowUtc = new Date().toISOString();
  database.prepare(`
    UPDATE benchmark_matrix_runs
    SET status = ?,
        error_message = ?,
        benchmark_run_uri = ?,
        completed_at_utc = ?,
        updated_at_utc = ?
    WHERE id = ?
  `).run(
    normalizeRunStatus(options.status),
    options.errorMessage ?? null,
    options.benchmarkRunUri ?? null,
    options.completedAtUtc ?? nowUtc,
    nowUtc,
    id,
  );
  const updated = readBenchmarkMatrixRun(id, options.databasePath);
  if (!updated) {
    throw new Error(`Benchmark matrix run not found: ${id}`);
  }
  return updated;
}

function getNextLogSequence(
  database: RuntimeDatabase,
  runId: string,
  streamKind: BenchmarkMatrixLogStreamKind,
): number {
  const row = database.prepare(`
    SELECT MAX(sequence) AS max_sequence
    FROM benchmark_matrix_logs
    WHERE run_id = ? AND stream_kind = ?
  `).get(runId, streamKind) as { max_sequence?: number | null } | undefined;
  const current = Number.isFinite(row?.max_sequence) ? Number(row?.max_sequence) : -1;
  return current + 1;
}

export function appendBenchmarkMatrixLogChunk(options: {
  runId: string;
  streamKind: BenchmarkMatrixLogStreamKind;
  chunkText: string;
  sequence?: number;
  databasePath?: string;
}): void {
  const runId = String(options.runId || '').trim();
  if (!runId) {
    throw new Error('Benchmark matrix run id is required for logs.');
  }
  const chunkText = String(options.chunkText || '');
  if (!chunkText) {
    return;
  }
  const database = getDatabase(options.databasePath);
  const streamKind = normalizeStream(options.streamKind);
  const sequence = Number.isFinite(options.sequence)
    ? Math.max(0, Math.trunc(Number(options.sequence)))
    : getNextLogSequence(database, runId, streamKind);
  database.prepare(`
    INSERT INTO benchmark_matrix_logs (
      run_id, stream_kind, sequence, chunk_text, created_at_utc
    ) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(run_id, stream_kind, sequence) DO UPDATE SET
      chunk_text = benchmark_matrix_logs.chunk_text || excluded.chunk_text
  `).run(
    runId,
    streamKind,
    sequence,
    chunkText,
    new Date().toISOString(),
  );
}

export function readBenchmarkMatrixSession(id: string, databasePath?: string): BenchmarkMatrixSessionRecord | null {
  const sessionId = String(id || '').trim();
  if (!sessionId) {
    return null;
  }
  const database = getDatabase(databasePath);
  const row = database.prepare(`
    SELECT id, manifest_path, fixture_root, config_url, prompt_prefix_file,
           request_timeout_seconds, selected_run_ids_json,
           baseline_restore_status, baseline_restore_error, status,
           started_at_utc, completed_at_utc, updated_at_utc
    FROM benchmark_matrix_sessions
    WHERE id = ?
  `).get(sessionId) as Record<string, unknown> | undefined;
  return normalizeSessionRecord(row);
}

export function readBenchmarkMatrixRun(id: string, databasePath?: string): BenchmarkMatrixRunRecord | null {
  const runId = String(id || '').trim();
  if (!runId) {
    return null;
  }
  const database = getDatabase(databasePath);
  const row = database.prepare(`
    SELECT id, session_id, run_index, run_identifier, label, model_id, model_path,
           start_script, prompt_prefix_file, reasoning, sampling_json, status,
           error_message, benchmark_run_uri, started_at_utc, completed_at_utc, updated_at_utc
    FROM benchmark_matrix_runs
    WHERE id = ?
  `).get(runId) as Record<string, unknown> | undefined;
  return normalizeRunRecord(row);
}

export function listBenchmarkMatrixSessions(options: {
  limit?: number;
  status?: BenchmarkMatrixSessionStatus | '';
  databasePath?: string;
} = {}): BenchmarkMatrixSessionRecord[] {
  const database = getDatabase(options.databasePath);
  const limit = Number.isFinite(options.limit) ? Math.max(1, Math.trunc(Number(options.limit))) : 50;
  const status = String(options.status || '').trim();
  if (status && SESSION_STATUSES.has(status as BenchmarkMatrixSessionStatus)) {
    const rows = database.prepare(`
      SELECT id, manifest_path, fixture_root, config_url, prompt_prefix_file,
             request_timeout_seconds, selected_run_ids_json,
             baseline_restore_status, baseline_restore_error, status,
             started_at_utc, completed_at_utc, updated_at_utc
      FROM benchmark_matrix_sessions
      WHERE status = ?
      ORDER BY started_at_utc DESC, id DESC
      LIMIT ?
    `).all(status, limit) as Array<Record<string, unknown>>;
    return rows.map((row) => normalizeSessionRecord(row)).filter((row): row is BenchmarkMatrixSessionRecord => row !== null);
  }
  const rows = database.prepare(`
    SELECT id, manifest_path, fixture_root, config_url, prompt_prefix_file,
           request_timeout_seconds, selected_run_ids_json,
           baseline_restore_status, baseline_restore_error, status,
           started_at_utc, completed_at_utc, updated_at_utc
    FROM benchmark_matrix_sessions
    ORDER BY started_at_utc DESC, id DESC
    LIMIT ?
  `).all(limit) as Array<Record<string, unknown>>;
  return rows.map((row) => normalizeSessionRecord(row)).filter((row): row is BenchmarkMatrixSessionRecord => row !== null);
}

export function listBenchmarkMatrixRunsForSession(
  sessionId: string,
  databasePath?: string,
): BenchmarkMatrixRunRecord[] {
  const normalizedSessionId = String(sessionId || '').trim();
  if (!normalizedSessionId) {
    return [];
  }
  const database = getDatabase(databasePath);
  const rows = database.prepare(`
    SELECT id, session_id, run_index, run_identifier, label, model_id, model_path,
           start_script, prompt_prefix_file, reasoning, sampling_json, status,
           error_message, benchmark_run_uri, started_at_utc, completed_at_utc, updated_at_utc
    FROM benchmark_matrix_runs
    WHERE session_id = ?
    ORDER BY run_index ASC, run_identifier ASC
  `).all(normalizedSessionId) as Array<Record<string, unknown>>;
  return rows.map((row) => normalizeRunRecord(row)).filter((row): row is BenchmarkMatrixRunRecord => row !== null);
}

export function readBenchmarkMatrixRunLogTextByStream(
  runId: string,
  databasePath?: string,
): Record<BenchmarkMatrixLogStreamKind, string> {
  const normalizedRunId = String(runId || '').trim();
  const output: Record<BenchmarkMatrixLogStreamKind, string> = {
    launcher_stdout: '',
    launcher_stderr: '',
    benchmark_stdout: '',
    benchmark_stderr: '',
    stop_stdout: '',
    stop_stderr: '',
    force_stop_stdout: '',
    force_stop_stderr: '',
  };
  if (!normalizedRunId) {
    return output;
  }
  const database = getDatabase(databasePath);
  const rows = database.prepare(`
    SELECT stream_kind, chunk_text
    FROM benchmark_matrix_logs
    WHERE run_id = ?
    ORDER BY stream_kind ASC, sequence ASC, id ASC
  `).all(normalizedRunId) as Array<{ stream_kind?: unknown; chunk_text?: unknown }>;
  for (const row of rows) {
    const stream = normalizeStream(row.stream_kind);
    output[stream] = `${output[stream]}${typeof row.chunk_text === 'string' ? row.chunk_text : ''}`;
  }
  return output;
}

export function deleteBenchmarkMatrixSession(id: string, databasePath?: string): boolean {
  const sessionId = String(id || '').trim();
  if (!sessionId) {
    return false;
  }
  const database = getDatabase(databasePath);
  const result = database.prepare('DELETE FROM benchmark_matrix_sessions WHERE id = ?').run(sessionId);
  return Number(result.changes) > 0;
}
