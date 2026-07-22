import { randomUUID } from 'node:crypto';
import { z } from '../lib/zod.js';
import { getRuntimeDatabase, type RuntimeDatabase } from './runtime-db.js';
import { formatTimestamp } from '../lib/text-format.js';

const InferenceRunStatusSchema = z.enum(['running', 'ready', 'failed', 'stopped', 'sync_completed']);
export type InferenceRunStatus = z.infer<typeof InferenceRunStatusSchema>;
const InferenceBackendSchema = z.enum(['llama', 'exl3']);
export type InferenceRunBackend = z.infer<typeof InferenceBackendSchema>;
const InferenceRunStreamKindSchema = z.enum([
  'launcher_stdout',
  'launcher_stderr',
  'engine_stdout',
  'engine_stderr',
  'startup_review',
  'startup_failure',
]);
export type InferenceRunStreamKind = z.infer<typeof InferenceRunStreamKindSchema>;

const InferenceRunRowSchema = z.object({
  id: z.string().nullable(),
  backend: z.string().nullable(),
  purpose: z.string().nullable(),
  entrypoint_path: z.string().nullable(),
  base_url: z.string().nullable(),
  status: z.string().nullable(),
  exit_code: z.number().nullable(),
  error_message: z.string().nullable(),
  started_at_utc: z.string().nullable(),
  finished_at_utc: z.string().nullable(),
  updated_at_utc: z.string().nullable(),
  speculative_accepted_tokens: z.number().nullable(),
  speculative_generated_tokens: z.number().nullable(),
  stdout_character_count: z.number().nullable(),
  stderr_character_count: z.number().nullable(),
  metrics_updated_at_utc: z.string().nullable(),
});
type InferenceRunRow = z.infer<typeof InferenceRunRowSchema>;

const RUN_COLUMNS = `id, backend, purpose, entrypoint_path, base_url, status,
           exit_code, error_message, started_at_utc, finished_at_utc, updated_at_utc,
           speculative_accepted_tokens, speculative_generated_tokens,
           stdout_character_count, stderr_character_count, metrics_updated_at_utc`;

const MaxSequenceRowSchema = z.object({ max_sequence: z.number().nullable() });

const InferenceRunLogChunkRowSchema = z.object({
  stream_kind: z.string().nullable(),
  chunk_text: z.string().nullable(),
});

const PENDING_LOG_PEAK_MIN_STREAM_CHARACTER_DELTA = 1024;
const pendingChunkTextByRunId = new Map<string, Map<InferenceRunStreamKind, string>>();
const pendingLogPeakStreamCharactersByRunId = new Map<string, Map<InferenceRunStreamKind, number>>();

export type InferenceRunLogTextStatsByStream = {
  textByStream: Record<InferenceRunStreamKind, string>;
  characterCountByStream: Record<InferenceRunStreamKind, number>;
  truncatedByStream: Record<InferenceRunStreamKind, boolean>;
};

export type InferenceRunPendingLogChunkStats = {
  characterCountByStream: Record<InferenceRunStreamKind, number>;
  totalCharacters: number;
  streamCount: number;
};

export type InferenceRunPendingLogChunkEntry = {
  streamKind: InferenceRunStreamKind;
  chunkText: string;
};

export type InferenceRunRecord = {
  id: string;
  backend: InferenceRunBackend;
  purpose: string;
  entrypointPath: string | null;
  baseUrl: string | null;
  status: InferenceRunStatus;
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

function normalizeStatus(value: string | null | undefined): InferenceRunStatus {
  const result = InferenceRunStatusSchema.safeParse(String(value || '').trim());
  return result.success ? result.data : 'running';
}

function normalizeBackend(value: string | null | undefined): InferenceRunBackend {
  const result = InferenceBackendSchema.safeParse(String(value || '').trim());
  if (!result.success) {
    throw new Error(`Unsupported inference run backend: ${String(value || '')}`);
  }
  return result.data;
}

function normalizeStreamKind(value: string | null | undefined): InferenceRunStreamKind {
  const result = InferenceRunStreamKindSchema.safeParse(String(value || '').trim());
  if (!result.success) {
    throw new Error(`Unsupported inference run stream kind: ${String(value || '')}`);
  }
  return result.data;
}

function createEmptyTextByStream(): Record<InferenceRunStreamKind, string> {
  return {
    launcher_stdout: '',
    launcher_stderr: '',
    engine_stdout: '',
    engine_stderr: '',
    startup_review: '',
    startup_failure: '',
  };
}

function createEmptyCountByStream(): Record<InferenceRunStreamKind, number> {
  return {
    launcher_stdout: 0,
    launcher_stderr: 0,
    engine_stdout: 0,
    engine_stderr: 0,
    startup_review: 0,
    startup_failure: 0,
  };
}

function createEmptyTruncatedByStream(): Record<InferenceRunStreamKind, boolean> {
  return {
    launcher_stdout: false,
    launcher_stderr: false,
    engine_stdout: false,
    engine_stderr: false,
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

function normalizeRecord(row: InferenceRunRow | undefined): InferenceRunRecord | null {
  if (!row || typeof row.id !== 'string') {
    return null;
  }
  return {
    id: row.id,
    backend: normalizeBackend(row.backend),
    purpose: typeof row.purpose === 'string' ? row.purpose : 'unknown',
    entrypointPath: typeof row.entrypoint_path === 'string' ? row.entrypoint_path : null,
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

export function createInferenceRun(options: {
  id?: string;
  backend: InferenceRunBackend;
  purpose: string;
  entrypointPath?: string | null;
  baseUrl?: string | null;
  status?: InferenceRunStatus;
  databasePath?: string;
}): InferenceRunRecord {
  const database = getDatabase(options.databasePath);
  const id = String(options.id || '').trim() || randomUUID();
  const nowUtc = new Date().toISOString();
  const status = normalizeStatus(options.status || 'running');
  database.prepare(`
    INSERT INTO inference_runs (
      id, backend, purpose, entrypoint_path, base_url, status,
      exit_code, error_message, started_at_utc, finished_at_utc, updated_at_utc
    ) VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, ?, NULL, ?)
    ON CONFLICT(id) DO UPDATE SET
      backend = excluded.backend,
      purpose = excluded.purpose,
      entrypoint_path = excluded.entrypoint_path,
      base_url = excluded.base_url,
      status = excluded.status,
      updated_at_utc = excluded.updated_at_utc
  `).run(
    id,
    normalizeBackend(options.backend),
    String(options.purpose || '').trim() || 'unknown',
    options.entrypointPath ?? null,
    options.baseUrl ?? null,
    status,
    nowUtc,
    nowUtc,
  );
  const inserted = readInferenceRun(id, options.databasePath);
  if (!inserted) {
    throw new Error(`Failed to persist inference run: ${id}`);
  }
  return inserted;
}

export function updateInferenceRun(options: {
  id: string;
  status: InferenceRunStatus;
  exitCode?: number | null;
  errorMessage?: string | null;
  finishedAtUtc?: string | null;
  baseUrl?: string | null;
  databasePath?: string;
}): InferenceRunRecord {
  const runId = String(options.id || '').trim();
  if (!runId) {
    throw new Error('Inference run id is required.');
  }
  const database = getDatabase(options.databasePath);
  const nowUtc = new Date().toISOString();
  database.prepare(`
    UPDATE inference_runs
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
  const updated = readInferenceRun(runId, options.databasePath);
  if (!updated) {
    throw new Error(`Inference run not found: ${runId}`);
  }
  return updated;
}

function getNextChunkSequence(
  database: RuntimeDatabase,
  runId: string,
  streamKind: InferenceRunStreamKind,
): number {
  const rawRow = database.prepare(`
    SELECT MAX(sequence) AS max_sequence
    FROM inference_run_log_chunks
    WHERE run_id = ? AND stream_kind = ?
  `).get(runId, streamKind);
  const row = rawRow == null ? undefined : MaxSequenceRowSchema.parse(rawRow);
  const current = Number.isFinite(row?.max_sequence) ? Number(row?.max_sequence) : -1;
  return current + 1;
}

function getPendingChunksForRun(runId: string): Map<InferenceRunStreamKind, string> {
  let pending = pendingChunkTextByRunId.get(runId);
  if (!pending) {
    pending = new Map<InferenceRunStreamKind, string>();
    pendingChunkTextByRunId.set(runId, pending);
  }
  return pending;
}

function getPendingChunkCharacterCount(pending: Map<InferenceRunStreamKind, string>): number {
  let totalCharacters = 0;
  for (const chunkText of pending.values()) {
    totalCharacters += chunkText.length;
  }
  return totalCharacters;
}

function shouldLogPendingChunkPeak(options: {
  runId: string;
  streamKind: InferenceRunStreamKind;
  streamCharacters: number;
}): boolean {
  let characterCountByStream = pendingLogPeakStreamCharactersByRunId.get(options.runId);
  if (!characterCountByStream) {
    characterCountByStream = new Map<InferenceRunStreamKind, number>();
    pendingLogPeakStreamCharactersByRunId.set(options.runId, characterCountByStream);
  }
  const previousStreamCharacters = characterCountByStream.get(options.streamKind) || 0;
  if (Math.abs(options.streamCharacters - previousStreamCharacters) < PENDING_LOG_PEAK_MIN_STREAM_CHARACTER_DELTA) {
    return false;
  }
  characterCountByStream.set(options.streamKind, options.streamCharacters);
  return true;
}

function logPendingChunkPeak(options: {
  runId: string;
  streamKind: InferenceRunStreamKind;
  pendingCharacters: number;
  streamCharacters: number;
}): void {
  process.stdout.write(
    `${formatTimestamp()} inference_run pending_log_peak run_id=${options.runId} `
    + `pending_chars=${options.pendingCharacters} stream=${options.streamKind} `
    + `stream_chars=${options.streamCharacters}\n`,
  );
}

function createEmptyStreamCharacterCounts(): Record<InferenceRunStreamKind, number> {
  return {
    launcher_stdout: 0,
    launcher_stderr: 0,
    engine_stdout: 0,
    engine_stderr: 0,
    startup_review: 0,
    startup_failure: 0,
  };
}

export function getInferenceRunPendingLogChunkStats(runId: string): InferenceRunPendingLogChunkStats {
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

export function consumeInferenceRunPendingLogChunks(runId: string): InferenceRunPendingLogChunkEntry[] {
  const normalizedRunId = String(runId || '').trim();
  if (!normalizedRunId) {
    return [];
  }
  const pending = pendingChunkTextByRunId.get(normalizedRunId);
  if (!pending) {
    return [];
  }
  pendingChunkTextByRunId.delete(normalizedRunId);
  pendingLogPeakStreamCharactersByRunId.delete(normalizedRunId);
  return [...pending.entries()]
    .map(([streamKind, chunkText]) => ({ streamKind, chunkText }))
    .filter((entry) => entry.chunkText.length > 0);
}

export function restoreInferenceRunPendingLogChunks(runId: string, entries: InferenceRunPendingLogChunkEntry[]): void {
  const normalizedRunId = String(runId || '').trim();
  if (!normalizedRunId) {
    return;
  }
  for (const entry of entries) {
    bufferInferenceRunLogChunk({
      runId: normalizedRunId,
      streamKind: entry.streamKind,
      chunkText: entry.chunkText,
    });
  }
}

export function bufferInferenceRunLogChunk(options: {
  runId: string;
  streamKind: InferenceRunStreamKind;
  chunkText: string;
}): void {
  const runId = String(options.runId || '').trim();
  if (!runId) {
    throw new Error('Inference run id is required for log chunks.');
  }
  const chunkText = String(options.chunkText || '');
  if (!chunkText) {
    return;
  }
  const streamKind = normalizeStreamKind(options.streamKind);
  const pending = getPendingChunksForRun(runId);
  const nextStreamText = `${pending.get(streamKind) || ''}${chunkText}`;
  pending.set(streamKind, nextStreamText);
  const pendingCharacters = getPendingChunkCharacterCount(pending);
  if (shouldLogPendingChunkPeak({ runId, streamKind, streamCharacters: nextStreamText.length })) {
    logPendingChunkPeak({
      runId,
      streamKind,
      pendingCharacters,
      streamCharacters: nextStreamText.length,
    });
  }
}

export function appendInferenceRunLogChunk(options: {
  runId: string;
  streamKind: InferenceRunStreamKind;
  chunkText: string;
  sequence?: number;
  databasePath?: string;
}): void {
  const runId = String(options.runId || '').trim();
  if (!runId) {
    throw new Error('Inference run id is required for log chunks.');
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
    INSERT INTO inference_run_log_chunks (
      run_id, stream_kind, sequence, chunk_text, created_at_utc
    ) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(run_id, stream_kind, sequence) DO UPDATE SET
      chunk_text = inference_run_log_chunks.chunk_text || excluded.chunk_text
  `).run(
    runId,
    streamKind,
    sequence,
    chunkText,
    new Date().toISOString(),
  );
}

export function flushInferenceRunLogChunks(runId: string, databasePath?: string): void {
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
    pendingLogPeakStreamCharactersByRunId.delete(normalizedRunId);
    return;
  }
  const database = getDatabase(databasePath);
  database.transaction(() => {
    for (const entry of entries) {
      appendInferenceRunLogChunk({
        runId: normalizedRunId,
        streamKind: entry.streamKind,
        chunkText: entry.chunkText,
        sequence: getNextChunkSequence(database, normalizedRunId, entry.streamKind),
        databasePath,
      });
    }
  })();
  pendingChunkTextByRunId.delete(normalizedRunId);
  pendingLogPeakStreamCharactersByRunId.delete(normalizedRunId);
}

export function readInferenceRun(id: string, databasePath?: string): InferenceRunRecord | null {
  const runId = String(id || '').trim();
  if (!runId) {
    return null;
  }
  const database = getDatabase(databasePath);
  const rawRow = database.prepare(`
    SELECT ${RUN_COLUMNS}
    FROM inference_runs
    WHERE id = ?
  `).get(runId);
  return normalizeRecord(rawRow == null ? undefined : InferenceRunRowSchema.parse(rawRow));
}

export function updateInferenceRunSpeculativeMetrics(options: {
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
    UPDATE inference_runs
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

export function readInferenceRunLogTextByStream(
  runId: string,
  databasePath?: string,
): Record<InferenceRunStreamKind, string> {
  return readInferenceRunLogTextStatsByStream(runId, { databasePath }).textByStream;
}

export function readInferenceRunLogTextStatsByStream(
  runId: string,
  options: {
    databasePath?: string;
    maxCharactersPerStream?: number | null;
  } = {},
): InferenceRunLogTextStatsByStream {
  const normalizedRunId = String(runId || '').trim();
  const maxCharactersPerStream = normalizeMaxCharactersPerStream(options.maxCharactersPerStream);
  const textByStream = createEmptyTextByStream();
  const characterCountByStream = createEmptyCountByStream();
  const truncatedByStream = createEmptyTruncatedByStream();
  const result: InferenceRunLogTextStatsByStream = {
    textByStream,
    characterCountByStream,
    truncatedByStream,
  };
  if (!normalizedRunId) {
    return result;
  }
  const database = getDatabase(options.databasePath);
  const rows = z.array(InferenceRunLogChunkRowSchema).parse(database.prepare(`
    SELECT stream_kind, chunk_text
    FROM inference_run_log_chunks
    WHERE run_id = ?
    ORDER BY stream_kind ASC, sequence ASC, id ASC
  `).all(normalizedRunId));
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
  for (const streamKind of InferenceRunStreamKindSchema.options) {
    truncatedByStream[streamKind] = textByStream[streamKind].length < characterCountByStream[streamKind];
  }
  return result;
}

export function listInferenceRuns(options: {
  limit?: number;
  status?: InferenceRunStatus | '';
  backend?: InferenceRunBackend | '';
  databasePath?: string;
} = {}): InferenceRunRecord[] {
  const database = getDatabase(options.databasePath);
  const limit = Number.isFinite(options.limit) ? Math.max(1, Math.trunc(Number(options.limit))) : 100;
  const conditions: string[] = [];
  const params: Array<string | number> = [];
  const status = String(options.status || '').trim();
  if (status && InferenceRunStatusSchema.safeParse(status).success) {
    conditions.push('status = ?');
    params.push(status);
  }
  const backend = String(options.backend || '').trim();
  if (backend && InferenceBackendSchema.safeParse(backend).success) {
    conditions.push('backend = ?');
    params.push(backend);
  }
  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  params.push(limit);
  const rows = z.array(InferenceRunRowSchema).parse(database.prepare(`
    SELECT ${RUN_COLUMNS}
    FROM inference_runs
    ${whereClause}
    ORDER BY started_at_utc DESC, id DESC
    LIMIT ?
  `).all(...params));
  return rows.map((row) => normalizeRecord(row)).filter((row): row is InferenceRunRecord => row !== null);
}

export function deleteInferenceRun(id: string, databasePath?: string): boolean {
  const runId = String(id || '').trim();
  if (!runId) {
    return false;
  }
  pendingChunkTextByRunId.delete(runId);
  pendingLogPeakStreamCharactersByRunId.delete(runId);
  const database = getDatabase(databasePath);
  const result = database.prepare('DELETE FROM inference_runs WHERE id = ?').run(runId);
  return Number(result.changes) > 0;
}

export function deleteInferenceRunLogChunksOlderThan(options: {
  olderThanUtc: string;
  databasePath?: string;
}): number {
  const olderThanUtc = String(options.olderThanUtc || '').trim();
  if (!olderThanUtc) {
    return 0;
  }
  const database = getDatabase(options.databasePath);
  const result = database.prepare(`
    DELETE FROM inference_run_log_chunks
    WHERE created_at_utc < ?
      AND run_id NOT IN (
        SELECT id
        FROM inference_runs
        WHERE status = 'running'
      )
  `).run(olderThanUtc);
  return Number(result.changes || 0);
}
