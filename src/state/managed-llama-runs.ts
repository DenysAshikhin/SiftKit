import { randomUUID } from 'node:crypto';
import { getRuntimeDatabase, type RuntimeDatabase } from './runtime-db.js';

export type ManagedLlamaRunStatus = 'running' | 'ready' | 'failed' | 'stopped' | 'sync_completed';
export type ManagedLlamaStreamKind =
  | 'startup_script_stdout'
  | 'startup_script_stderr'
  | 'llama_stdout'
  | 'llama_stderr'
  | 'startup_review'
  | 'startup_failure';

const ALLOWED_STATUSES = new Set<ManagedLlamaRunStatus>([
  'running',
  'ready',
  'failed',
  'stopped',
  'sync_completed',
]);
const ALLOWED_STREAMS = new Set<ManagedLlamaStreamKind>([
  'startup_script_stdout',
  'startup_script_stderr',
  'llama_stdout',
  'llama_stderr',
  'startup_review',
  'startup_failure',
]);

export type ManagedLlamaRunRecord = {
  id: string;
  purpose: string;
  scriptPath: string | null;
  baseUrl: string | null;
  status: ManagedLlamaRunStatus;
  exitCode: number | null;
  errorMessage: string | null;
  startedAtUtc: string;
  finishedAtUtc: string | null;
  updatedAtUtc: string;
};

function getDatabase(databasePath?: string): RuntimeDatabase {
  return getRuntimeDatabase(databasePath);
}

function normalizeStatus(value: unknown): ManagedLlamaRunStatus {
  const normalized = String(value || '').trim() as ManagedLlamaRunStatus;
  return ALLOWED_STATUSES.has(normalized) ? normalized : 'running';
}

function normalizeStreamKind(value: unknown): ManagedLlamaStreamKind {
  const normalized = String(value || '').trim() as ManagedLlamaStreamKind;
  if (!ALLOWED_STREAMS.has(normalized)) {
    throw new Error(`Unsupported managed llama stream kind: ${String(value || '')}`);
  }
  return normalized;
}

function normalizeRecord(row: Record<string, unknown> | undefined): ManagedLlamaRunRecord | null {
  if (!row || typeof row.id !== 'string') {
    return null;
  }
  return {
    id: row.id,
    purpose: typeof row.purpose === 'string' ? row.purpose : 'unknown',
    scriptPath: typeof row.script_path === 'string' ? row.script_path : null,
    baseUrl: typeof row.base_url === 'string' ? row.base_url : null,
    status: normalizeStatus(row.status),
    exitCode: Number.isFinite(row.exit_code) ? Number(row.exit_code) : null,
    errorMessage: typeof row.error_message === 'string' ? row.error_message : null,
    startedAtUtc: typeof row.started_at_utc === 'string' ? row.started_at_utc : new Date(0).toISOString(),
    finishedAtUtc: typeof row.finished_at_utc === 'string' ? row.finished_at_utc : null,
    updatedAtUtc: typeof row.updated_at_utc === 'string' ? row.updated_at_utc : new Date(0).toISOString(),
  };
}

export function createManagedLlamaRun(options: {
  id?: string;
  purpose: string;
  scriptPath?: string | null;
  baseUrl?: string | null;
  status?: ManagedLlamaRunStatus;
  databasePath?: string;
}): ManagedLlamaRunRecord {
  const database = getDatabase(options.databasePath);
  const id = String(options.id || '').trim() || randomUUID();
  const nowUtc = new Date().toISOString();
  const status = normalizeStatus(options.status || 'running');
  database.prepare(`
    INSERT INTO managed_llama_runs (
      id, purpose, script_path, base_url, status,
      exit_code, error_message, started_at_utc, finished_at_utc, updated_at_utc
    ) VALUES (?, ?, ?, ?, ?, NULL, NULL, ?, NULL, ?)
    ON CONFLICT(id) DO UPDATE SET
      purpose = excluded.purpose,
      script_path = excluded.script_path,
      base_url = excluded.base_url,
      status = excluded.status,
      updated_at_utc = excluded.updated_at_utc
  `).run(
    id,
    String(options.purpose || '').trim() || 'unknown',
    options.scriptPath ?? null,
    options.baseUrl ?? null,
    status,
    nowUtc,
    nowUtc,
  );
  const inserted = readManagedLlamaRun(id, options.databasePath);
  if (!inserted) {
    throw new Error(`Failed to persist managed llama run: ${id}`);
  }
  return inserted;
}

export function updateManagedLlamaRun(options: {
  id: string;
  status: ManagedLlamaRunStatus;
  exitCode?: number | null;
  errorMessage?: string | null;
  finishedAtUtc?: string | null;
  baseUrl?: string | null;
  databasePath?: string;
}): ManagedLlamaRunRecord {
  const runId = String(options.id || '').trim();
  if (!runId) {
    throw new Error('Managed llama run id is required.');
  }
  const database = getDatabase(options.databasePath);
  const nowUtc = new Date().toISOString();
  database.prepare(`
    UPDATE managed_llama_runs
    SET status = ?,
        exit_code = ?,
        error_message = ?,
        finished_at_utc = ?,
        base_url = COALESCE(?, base_url),
        updated_at_utc = ?
    WHERE id = ?
  `).run(
    normalizeStatus(options.status),
    Number.isFinite(options.exitCode) ? Number(options.exitCode) : null,
    options.errorMessage ?? null,
    options.finishedAtUtc ?? nowUtc,
    options.baseUrl ?? null,
    nowUtc,
    runId,
  );
  const updated = readManagedLlamaRun(runId, options.databasePath);
  if (!updated) {
    throw new Error(`Managed llama run not found: ${runId}`);
  }
  return updated;
}

function getNextChunkSequence(
  database: RuntimeDatabase,
  runId: string,
  streamKind: ManagedLlamaStreamKind,
): number {
  const row = database.prepare(`
    SELECT MAX(sequence) AS max_sequence
    FROM managed_llama_log_chunks
    WHERE run_id = ? AND stream_kind = ?
  `).get(runId, streamKind) as { max_sequence?: number | null } | undefined;
  const current = Number.isFinite(row?.max_sequence) ? Number(row?.max_sequence) : -1;
  return current + 1;
}

export function appendManagedLlamaLogChunk(options: {
  runId: string;
  streamKind: ManagedLlamaStreamKind;
  chunkText: string;
  sequence?: number;
  databasePath?: string;
}): void {
  const runId = String(options.runId || '').trim();
  if (!runId) {
    throw new Error('Managed llama run id is required for log chunks.');
  }
  const chunkText = String(options.chunkText || '');
  if (!chunkText) {
    return;
  }
  const database = getDatabase(options.databasePath);
  const streamKind = normalizeStreamKind(options.streamKind);
  const sequence = Number.isFinite(options.sequence)
    ? Math.max(0, Math.trunc(Number(options.sequence)))
    : getNextChunkSequence(database, runId, streamKind);
  database.prepare(`
    INSERT INTO managed_llama_log_chunks (
      run_id, stream_kind, sequence, chunk_text, created_at_utc
    ) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(run_id, stream_kind, sequence) DO UPDATE SET
      chunk_text = managed_llama_log_chunks.chunk_text || excluded.chunk_text
  `).run(
    runId,
    streamKind,
    sequence,
    chunkText,
    new Date().toISOString(),
  );
}

export function readManagedLlamaRun(id: string, databasePath?: string): ManagedLlamaRunRecord | null {
  const runId = String(id || '').trim();
  if (!runId) {
    return null;
  }
  const database = getDatabase(databasePath);
  const row = database.prepare(`
    SELECT id, purpose, script_path, base_url, status,
           exit_code, error_message, started_at_utc, finished_at_utc, updated_at_utc
    FROM managed_llama_runs
    WHERE id = ?
  `).get(runId) as Record<string, unknown> | undefined;
  return normalizeRecord(row);
}

export function readManagedLlamaLogTextByStream(
  runId: string,
  databasePath?: string,
): Record<ManagedLlamaStreamKind, string> {
  const normalizedRunId = String(runId || '').trim();
  const result: Record<ManagedLlamaStreamKind, string> = {
    startup_script_stdout: '',
    startup_script_stderr: '',
    llama_stdout: '',
    llama_stderr: '',
    startup_review: '',
    startup_failure: '',
  };
  if (!normalizedRunId) {
    return result;
  }
  const database = getDatabase(databasePath);
  const rows = database.prepare(`
    SELECT stream_kind, chunk_text
    FROM managed_llama_log_chunks
    WHERE run_id = ?
    ORDER BY stream_kind ASC, sequence ASC, id ASC
  `).all(normalizedRunId) as Array<{ stream_kind?: unknown; chunk_text?: unknown }>;
  for (const row of rows) {
    const streamKind = normalizeStreamKind(row.stream_kind);
    result[streamKind] = `${result[streamKind]}${typeof row.chunk_text === 'string' ? row.chunk_text : ''}`;
  }
  return result;
}

export function listManagedLlamaRuns(options: {
  limit?: number;
  status?: ManagedLlamaRunStatus | '';
  databasePath?: string;
} = {}): ManagedLlamaRunRecord[] {
  const database = getDatabase(options.databasePath);
  const limit = Number.isFinite(options.limit) ? Math.max(1, Math.trunc(Number(options.limit))) : 100;
  const status = String(options.status || '').trim();
  if (status && ALLOWED_STATUSES.has(status as ManagedLlamaRunStatus)) {
    const rows = database.prepare(`
      SELECT id, purpose, script_path, base_url, status,
             exit_code, error_message, started_at_utc, finished_at_utc, updated_at_utc
      FROM managed_llama_runs
      WHERE status = ?
      ORDER BY started_at_utc DESC, id DESC
      LIMIT ?
    `).all(status, limit) as Array<Record<string, unknown>>;
    return rows.map((row) => normalizeRecord(row)).filter((row): row is ManagedLlamaRunRecord => row !== null);
  }
  const rows = database.prepare(`
    SELECT id, purpose, script_path, base_url, status,
           exit_code, error_message, started_at_utc, finished_at_utc, updated_at_utc
    FROM managed_llama_runs
    ORDER BY started_at_utc DESC, id DESC
    LIMIT ?
  `).all(limit) as Array<Record<string, unknown>>;
  return rows.map((row) => normalizeRecord(row)).filter((row): row is ManagedLlamaRunRecord => row !== null);
}

export function deleteManagedLlamaRun(id: string, databasePath?: string): boolean {
  const runId = String(id || '').trim();
  if (!runId) {
    return false;
  }
  const database = getDatabase(databasePath);
  const result = database.prepare('DELETE FROM managed_llama_runs WHERE id = ?').run(runId);
  return Number(result.changes) > 0;
}
