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
const pendingChunkTextByRunId = new Map<string, Map<ManagedLlamaStreamKind, string>>();

export type ManagedLlamaLogTextStatsByStream = {
  textByStream: Record<ManagedLlamaStreamKind, string>;
  characterCountByStream: Record<ManagedLlamaStreamKind, number>;
  truncatedByStream: Record<ManagedLlamaStreamKind, boolean>;
};

export type ManagedLlamaPendingLogChunkStats = {
  characterCountByStream: Record<ManagedLlamaStreamKind, number>;
  totalCharacters: number;
  streamCount: number;
};

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
  speculativeAcceptedTokens: number | null;
  speculativeGeneratedTokens: number | null;
  stdoutCharacterCount: number;
  stderrCharacterCount: number;
  metricsUpdatedAtUtc: string | null;
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

function createEmptyTextByStream(): Record<ManagedLlamaStreamKind, string> {
  return {
    startup_script_stdout: '',
    startup_script_stderr: '',
    llama_stdout: '',
    llama_stderr: '',
    startup_review: '',
    startup_failure: '',
  };
}

function createEmptyCountByStream(): Record<ManagedLlamaStreamKind, number> {
  return {
    startup_script_stdout: 0,
    startup_script_stderr: 0,
    llama_stdout: 0,
    llama_stderr: 0,
    startup_review: 0,
    startup_failure: 0,
  };
}

function createEmptyTruncatedByStream(): Record<ManagedLlamaStreamKind, boolean> {
  return {
    startup_script_stdout: false,
    startup_script_stderr: false,
    llama_stdout: false,
    llama_stderr: false,
    startup_review: false,
    startup_failure: false,
  };
}

function normalizeMaxCharactersPerStream(value: number | null | undefined): number | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (!Number.isFinite(value)) {
    return null;
  }
  return Math.max(0, Math.trunc(value));
}

function appendCappedTail(currentText: string, chunkText: string, maxCharacters: number | null): string {
  if (maxCharacters === null) {
    return `${currentText}${chunkText}`;
  }
  if (maxCharacters <= 0) {
    return '';
  }
  const combinedLength = currentText.length + chunkText.length;
  if (combinedLength <= maxCharacters) {
    return `${currentText}${chunkText}`;
  }
  if (chunkText.length >= maxCharacters) {
    return chunkText.slice(chunkText.length - maxCharacters);
  }
  return `${currentText.slice(combinedLength - maxCharacters)}${chunkText}`;
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
    speculativeAcceptedTokens: Number.isFinite(row.speculative_accepted_tokens) ? Number(row.speculative_accepted_tokens) : null,
    speculativeGeneratedTokens: Number.isFinite(row.speculative_generated_tokens) ? Number(row.speculative_generated_tokens) : null,
    stdoutCharacterCount: Number.isFinite(row.stdout_character_count) ? Number(row.stdout_character_count) : 0,
    stderrCharacterCount: Number.isFinite(row.stderr_character_count) ? Number(row.stderr_character_count) : 0,
    metricsUpdatedAtUtc: typeof row.metrics_updated_at_utc === 'string' ? row.metrics_updated_at_utc : null,
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

function getPendingChunksForRun(runId: string): Map<ManagedLlamaStreamKind, string> {
  let pending = pendingChunkTextByRunId.get(runId);
  if (!pending) {
    pending = new Map<ManagedLlamaStreamKind, string>();
    pendingChunkTextByRunId.set(runId, pending);
  }
  return pending;
}

function createEmptyStreamCharacterCounts(): Record<ManagedLlamaStreamKind, number> {
  return {
    startup_script_stdout: 0,
    startup_script_stderr: 0,
    llama_stdout: 0,
    llama_stderr: 0,
    startup_review: 0,
    startup_failure: 0,
  };
}

export function getManagedLlamaPendingLogChunkStats(runId: string): ManagedLlamaPendingLogChunkStats {
  const normalizedRunId = String(runId || '').trim();
  const counts = createEmptyStreamCharacterCounts();
  const pending = normalizedRunId ? pendingChunkTextByRunId.get(normalizedRunId) : null;
  if (!pending) {
    return {
      characterCountByStream: counts,
      totalCharacters: 0,
      streamCount: 0,
    };
  }
  let totalCharacters = 0;
  let streamCount = 0;
  for (const [streamKind, chunkText] of pending.entries()) {
    const length = chunkText.length;
    counts[streamKind] = length;
    totalCharacters += length;
    streamCount += length > 0 ? 1 : 0;
  }
  return {
    characterCountByStream: counts,
    totalCharacters,
    streamCount,
  };
}

export function bufferManagedLlamaLogChunk(options: {
  runId: string;
  streamKind: ManagedLlamaStreamKind;
  chunkText: string;
}): void {
  const runId = String(options.runId || '').trim();
  if (!runId) {
    throw new Error('Managed llama run id is required for log chunks.');
  }
  const chunkText = String(options.chunkText || '');
  if (!chunkText) {
    return;
  }
  const streamKind = normalizeStreamKind(options.streamKind);
  const pending = getPendingChunksForRun(runId);
  pending.set(streamKind, `${pending.get(streamKind) || ''}${chunkText}`);
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

export function flushManagedLlamaLogChunks(runId: string, databasePath?: string): void {
  const normalizedRunId = String(runId || '').trim();
  if (!normalizedRunId) {
    return;
  }
  const pending = pendingChunkTextByRunId.get(normalizedRunId);
  if (!pending || pending.size === 0) {
    return;
  }
  const entries = [...pending.entries()]
    .map(([streamKind, chunkText]) => ({ streamKind, chunkText }))
    .filter((entry) => entry.chunkText);
  if (entries.length === 0) {
    pendingChunkTextByRunId.delete(normalizedRunId);
    return;
  }
  const database = getDatabase(databasePath);
  database.transaction(() => {
    for (const entry of entries) {
      appendManagedLlamaLogChunk({
        runId: normalizedRunId,
        streamKind: entry.streamKind,
        chunkText: entry.chunkText,
        sequence: getNextChunkSequence(database, normalizedRunId, entry.streamKind),
        databasePath,
      });
    }
  })();
  pendingChunkTextByRunId.delete(normalizedRunId);
}

export function readManagedLlamaRun(id: string, databasePath?: string): ManagedLlamaRunRecord | null {
  const runId = String(id || '').trim();
  if (!runId) {
    return null;
  }
  const database = getDatabase(databasePath);
  const row = database.prepare(`
    SELECT id, purpose, script_path, base_url, status,
           exit_code, error_message, started_at_utc, finished_at_utc, updated_at_utc,
           speculative_accepted_tokens, speculative_generated_tokens,
           stdout_character_count, stderr_character_count, metrics_updated_at_utc
    FROM managed_llama_runs
    WHERE id = ?
  `).get(runId) as Record<string, unknown> | undefined;
  return normalizeRecord(row);
}

export function updateManagedLlamaRunSpeculativeMetrics(options: {
  runId: string;
  speculativeAcceptedTokens: number | null;
  speculativeGeneratedTokens: number | null;
  stdoutCharacterCount: number;
  stderrCharacterCount: number;
  databasePath?: string;
}): boolean {
  const runId = String(options.runId || '').trim();
  if (!runId) {
    return false;
  }
  const database = getDatabase(options.databasePath);
  const nowUtc = new Date().toISOString();
  const result = database.prepare(`
    UPDATE managed_llama_runs
    SET speculative_accepted_tokens = ?,
        speculative_generated_tokens = ?,
        stdout_character_count = ?,
        stderr_character_count = ?,
        metrics_updated_at_utc = ?,
        updated_at_utc = ?
    WHERE id = ?
  `).run(
    options.speculativeAcceptedTokens,
    options.speculativeGeneratedTokens,
    Math.max(0, Math.trunc(options.stdoutCharacterCount)),
    Math.max(0, Math.trunc(options.stderrCharacterCount)),
    nowUtc,
    nowUtc,
    runId,
  );
  return Number(result.changes) > 0;
}

export function readManagedLlamaLogTextByStream(
  runId: string,
  databasePath?: string,
): Record<ManagedLlamaStreamKind, string> {
  return readManagedLlamaLogTextStatsByStream(runId, { databasePath }).textByStream;
}

export function readManagedLlamaLogTextStatsByStream(
  runId: string,
  options: {
    databasePath?: string;
    maxCharactersPerStream?: number | null;
  } = {},
): ManagedLlamaLogTextStatsByStream {
  const normalizedRunId = String(runId || '').trim();
  const maxCharactersPerStream = normalizeMaxCharactersPerStream(options.maxCharactersPerStream);
  const textByStream = createEmptyTextByStream();
  const characterCountByStream = createEmptyCountByStream();
  const truncatedByStream = createEmptyTruncatedByStream();
  const result: ManagedLlamaLogTextStatsByStream = {
    textByStream,
    characterCountByStream,
    truncatedByStream,
  };
  if (!normalizedRunId) {
    return result;
  }
  const database = getDatabase(options.databasePath);
  const rows = database.prepare(`
    SELECT stream_kind, chunk_text
    FROM managed_llama_log_chunks
    WHERE run_id = ?
    ORDER BY stream_kind ASC, sequence ASC, id ASC
  `).all(normalizedRunId) as Array<{ stream_kind?: unknown; chunk_text?: unknown }>;
  for (const row of rows) {
    const streamKind = normalizeStreamKind(row.stream_kind);
    const chunkText = typeof row.chunk_text === 'string' ? row.chunk_text : '';
    characterCountByStream[streamKind] += chunkText.length;
    textByStream[streamKind] = appendCappedTail(textByStream[streamKind], chunkText, maxCharactersPerStream);
  }
  const pending = pendingChunkTextByRunId.get(normalizedRunId);
  if (pending) {
    for (const [streamKind, chunkText] of pending.entries()) {
      characterCountByStream[streamKind] += chunkText.length;
      textByStream[streamKind] = appendCappedTail(textByStream[streamKind], chunkText, maxCharactersPerStream);
    }
  }
  for (const streamKind of ALLOWED_STREAMS) {
    truncatedByStream[streamKind] = textByStream[streamKind].length < characterCountByStream[streamKind];
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
             exit_code, error_message, started_at_utc, finished_at_utc, updated_at_utc,
             speculative_accepted_tokens, speculative_generated_tokens,
             stdout_character_count, stderr_character_count, metrics_updated_at_utc
      FROM managed_llama_runs
      WHERE status = ?
      ORDER BY started_at_utc DESC, id DESC
      LIMIT ?
    `).all(status, limit) as Array<Record<string, unknown>>;
    return rows.map((row) => normalizeRecord(row)).filter((row): row is ManagedLlamaRunRecord => row !== null);
  }
  const rows = database.prepare(`
    SELECT id, purpose, script_path, base_url, status,
           exit_code, error_message, started_at_utc, finished_at_utc, updated_at_utc,
           speculative_accepted_tokens, speculative_generated_tokens,
           stdout_character_count, stderr_character_count, metrics_updated_at_utc
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
  pendingChunkTextByRunId.delete(runId);
  const database = getDatabase(databasePath);
  const result = database.prepare('DELETE FROM managed_llama_runs WHERE id = ?').run(runId);
  return Number(result.changes) > 0;
}

export function deleteManagedLlamaLogChunksOlderThan(options: {
  olderThanUtc: string;
  databasePath?: string;
}): number {
  const olderThanUtc = String(options.olderThanUtc || '').trim();
  if (!olderThanUtc) {
    return 0;
  }
  const database = getDatabase(options.databasePath);
  const result = database.prepare(`
    DELETE FROM managed_llama_log_chunks
    WHERE created_at_utc < ?
      AND run_id NOT IN (
        SELECT id
        FROM managed_llama_runs
        WHERE status = 'running'
      )
  `).run(olderThanUtc);
  return Number(result.changes || 0);
}
