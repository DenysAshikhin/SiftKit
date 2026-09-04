import { z } from '../../lib/zod.js';
import { parseJsonValueText } from '../../lib/json.js';
import { JsonValueSchema, type JsonObject, type JsonValue, isJsonObject } from '../../lib/json-types.js';
import type { RuntimeDatabase } from '../database-handle.js';
import { tableExists, tableHasColumn } from './schema-introspection.js';

const REMOVED_BACKEND = 'llama';
const EXL3_BACKEND = 'exl3';
const REMOVED_LAUNCH_SNAPSHOT_KEY = 'runtime_llama_launch_snapshot';

// These keys and values are the v63 contract. They intentionally do not come from the current
// config schema: historical migrations must keep their meaning when the live schema changes.
const V63_PRESET_KEYS: ReadonlySet<string> = new Set([
  'id', 'label', 'Backend', 'Model', 'ExternalServerEnabled', 'BaseUrl', 'ModelPath', 'NumCtx',
  'NcpuMoe', 'ParallelSlots', 'UBatchSize', 'CacheRam', 'CacheRecurrentRam',
  'KvCacheQuantization', 'Temperature', 'TopP', 'TopK', 'MinP', 'PresencePenalty',
  'RepetitionPenalty', 'Reasoning', 'ReasoningEffort', 'ReasoningContent', 'PreserveThinking',
  'MaintainPerStepThinking', 'SpeculativeEnabled', 'SpeculativeDraftMax', 'SpeculativeDynamic',
  'ReasoningBudget', 'ReasoningBudgetMessage', 'StartupTimeoutMs', 'HealthcheckTimeoutMs',
  'HealthcheckIntervalMs', 'SleepIdleSeconds', 'IdleAction', 'VisionEnabled', 'VisionOffload',
  'VisionImageRetention', 'VisionMaxImagePixels',
]);
const V63_CACHE_VALUES: ReadonlySet<string> = new Set([
  'f16', 'q8_0', 'q4_0', 'q5_0', 'q8_0/q4_0', 'q8_0/q5_0',
]);

const AppConfigPresetRowSchema = z.object({ presets_json: z.string(), active_preset_id: z.string().nullable() });
const SnapshotRowSchema = z.object({ id: z.string(), value: z.string() });
const BenchmarkConfigRowSchema = z.object({ id: z.string(), original_config_json: z.string() });
const BenchmarkCaseRowSchema = z.object({ id: z.string(), managed_preset_json: z.string() });
const SequenceRowSchema = z.object({ seq: z.number().nullable() });
const MaxIdRowSchema = z.object({ max_id: z.number().nullable() });

const INFERENCE_RUNS_V64_SQL = `
  CREATE TABLE inference_runs_v64 (
    id TEXT PRIMARY KEY,
    backend TEXT NOT NULL CHECK (backend IN ('exl3')),
    purpose TEXT NOT NULL,
    entrypoint_path TEXT,
    base_url TEXT,
    status TEXT NOT NULL CHECK (status IN ('running', 'ready', 'failed', 'stopped', 'sync_completed')),
    exit_code INTEGER,
    error_message TEXT,
    started_at_utc TEXT NOT NULL,
    finished_at_utc TEXT,
    updated_at_utc TEXT NOT NULL,
    speculative_accepted_tokens INTEGER,
    speculative_generated_tokens INTEGER,
    stdout_character_count INTEGER NOT NULL DEFAULT 0,
    stderr_character_count INTEGER NOT NULL DEFAULT 0,
    metrics_updated_at_utc TEXT
  );
`;

const INFERENCE_RUN_LOG_CHUNKS_SQL = `
  CREATE TABLE inference_run_log_chunks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id TEXT NOT NULL REFERENCES inference_runs(id) ON DELETE CASCADE,
    stream_kind TEXT NOT NULL CHECK (stream_kind IN (
      'launcher_stdout', 'launcher_stderr', 'engine_stdout', 'engine_stderr',
      'startup_review', 'startup_failure'
    )),
    sequence INTEGER NOT NULL,
    chunk_text TEXT NOT NULL,
    created_at_utc TEXT NOT NULL,
    UNIQUE(run_id, stream_kind, sequence)
  );
`;

const BENCHMARK_LOGS_V64_SQL = `
  CREATE TABLE benchmark_logs_v64 (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL REFERENCES benchmark_sessions(id) ON DELETE CASCADE,
    attempt_id TEXT REFERENCES benchmark_attempts(id) ON DELETE CASCADE,
    stream_kind TEXT NOT NULL CHECK (stream_kind IN (
      'orchestrator', 'attempt_stdout', 'attempt_stderr', 'managed_engine'
    )),
    sequence INTEGER NOT NULL,
    chunk_text TEXT NOT NULL,
    created_at_utc TEXT NOT NULL,
    UNIQUE(session_id, attempt_id, stream_kind, sequence)
  );
`;

type PresetDisposition = 'exl3' | 'removed';

function parseMigrationJson(text: string, source: string): JsonValue {
  try {
    return parseJsonValueText(text);
  } catch (error) {
    throw new Error(
      `Cannot migrate ${source}: invalid JSON (${error instanceof Error ? error.message : String(error)}).`,
    );
  }
}

function requireMigrationObject(value: JsonValue, source: string): JsonObject {
  if (!isJsonObject(value)) {
    throw new Error(`Cannot migrate ${source}: expected a JSON object.`);
  }
  return value;
}

function getPresetDisposition(preset: JsonObject, source: string): PresetDisposition {
  if (!Object.hasOwn(preset, 'Backend') || preset.Backend === REMOVED_BACKEND) {
    return 'removed';
  }
  if (preset.Backend === EXL3_BACKEND) {
    return 'exl3';
  }
  throw new Error(`Cannot migrate ${source}: unsupported model preset backend.`);
}

function normalizeExl3Preset(preset: JsonObject, source: string): JsonObject {
  const normalized: JsonObject = {};
  for (const [key, value] of Object.entries(preset)) {
    if (V63_PRESET_KEYS.has(key)) {
      normalized[key] = value;
    }
  }
  if (Object.hasOwn(normalized, 'KvCacheQuantization')) {
    const cacheValue = normalized.KvCacheQuantization;
    if (typeof cacheValue !== 'string' || !V63_CACHE_VALUES.has(cacheValue)) {
      throw new Error(`Cannot migrate ${source}: unsupported KvCacheQuantization.`);
    }
  }
  return normalized;
}

function transformExecutablePresetArray(value: JsonValue, source: string): { presets: JsonObject[]; changed: boolean } {
  if (!Array.isArray(value)) {
    throw new Error(`Cannot migrate ${source}: expected a JSON array of preset objects.`);
  }
  const presets: JsonObject[] = [];
  let changed = false;
  for (const [index, candidate] of value.entries()) {
    const presetSource = `${source}[${index}]`;
    const preset = requireMigrationObject(candidate, presetSource);
    const disposition = getPresetDisposition(preset, presetSource);
    if (disposition === 'removed') {
      changed = true;
      continue;
    }
    const normalized = normalizeExl3Preset(preset, presetSource);
    changed ||= Object.keys(normalized).length !== Object.keys(preset).length
      || Object.entries(normalized).some(([key, nextValue]) => preset[key] !== nextValue);
    presets.push(normalized);
  }
  return { presets, changed };
}

function transformSnapshotPreset(value: JsonValue, source: string): { preset: JsonObject; changed: boolean } {
  const preset = requireMigrationObject(value, source);
  const disposition = getPresetDisposition(preset, source);
  if (disposition === 'removed') {
    if (Object.hasOwn(preset, 'Backend')) {
      return { preset, changed: false };
    }
    return { preset: { ...preset, Backend: REMOVED_BACKEND }, changed: true };
  }
  const normalized = normalizeExl3Preset(preset, source);
  const changed = Object.keys(normalized).length !== Object.keys(preset).length
    || Object.entries(normalized).some(([key, nextValue]) => preset[key] !== nextValue);
  return { preset: normalized, changed };
}

function readActivePresetId(value: JsonValue): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}

function resolveActivePresetId(presets: readonly JsonObject[], requested: JsonValue): string | null {
  const requestedId = readActivePresetId(requested);
  if (requestedId && presets.some((preset) => preset.id === requestedId)) {
    return requestedId;
  }
  const firstId = presets.find((preset) => typeof preset.id === 'string' && preset.id.trim())?.id;
  return typeof firstId === 'string' ? firstId : null;
}

function transformSnapshotPresetRows(database: RuntimeDatabase): {
  sessions: { id: string; value: string }[];
  cases: { id: string; value: string }[];
} {
  const sessions: { id: string; value: string }[] = [];
  if (tableHasColumn(database, 'chat_sessions', 'model_preset_json')) {
    const rows = z.array(SnapshotRowSchema).parse(database.prepare(`
      SELECT id, model_preset_json AS value
      FROM chat_sessions
      WHERE model_preset_json IS NOT NULL
      ORDER BY id
    `).all());
    for (const row of rows) {
      const source = `chat_sessions[${row.id}].model_preset_json`;
      const transformed = transformSnapshotPreset(parseMigrationJson(row.value, source), source);
      if (transformed.changed) {
        sessions.push({ id: row.id, value: JSON.stringify(transformed.preset) });
      }
    }
  }

  const cases: { id: string; value: string }[] = [];
  if (tableHasColumn(database, 'benchmark_cases', 'managed_preset_json')) {
    const rows = z.array(BenchmarkCaseRowSchema).parse(database.prepare(`
      SELECT id, managed_preset_json
      FROM benchmark_cases
      ORDER BY id
    `).all());
    for (const row of rows) {
      const source = `benchmark_cases[${row.id}].managed_preset_json`;
      const transformed = transformSnapshotPreset(parseMigrationJson(row.managed_preset_json, source), source);
      if (transformed.changed) {
        cases.push({ id: row.id, value: JSON.stringify(transformed.preset) });
      }
    }
  }
  return { sessions, cases };
}

function transformBenchmarkConfig(text: string, source: string): { json: string; changed: boolean } {
  const config = requireMigrationObject(parseMigrationJson(text, source), source);
  if (Object.keys(config).length === 0) {
    return { json: text, changed: false };
  }
  let changed = false;
  let transformed: JsonObject = { ...config };

  if (Object.hasOwn(transformed, 'Backend')) {
    const { Backend: _backend, ...withoutBackend } = transformed;
    transformed = withoutBackend;
    changed = true;
  }
  const serverValue = transformed.Server;
  if (isJsonObject(serverValue)) {
    let server = { ...serverValue };
    for (const key of ['LlamaCpp', 'Exl3'] as const) {
      if (Object.hasOwn(server, key)) {
        const { [key]: _removed, ...withoutRemoved } = server;
        server = withoutRemoved;
        changed = true;
      }
    }
    if (Object.hasOwn(server, 'ModelPresets')) {
      const modelPresetsValue = server.ModelPresets;
      if (!isJsonObject(modelPresetsValue)) {
        throw new Error(`Cannot migrate ${source}.Server.ModelPresets: expected a JSON object.`);
      }
      if (!Object.hasOwn(modelPresetsValue, 'Presets')) {
        throw new Error(`Cannot migrate ${source}.Server.ModelPresets.Presets: expected a JSON array of preset objects.`);
      }
      const transformedPresets = transformExecutablePresetArray(
        JsonValueSchema.parse(modelPresetsValue.Presets),
        `${source}.Server.ModelPresets.Presets`,
      );
      const activePresetId = resolveActivePresetId(
        transformedPresets.presets,
        JsonValueSchema.parse(modelPresetsValue.ActivePresetId ?? null),
      );
      const currentActivePresetId = readActivePresetId(JsonValueSchema.parse(modelPresetsValue.ActivePresetId ?? null));
      if (transformedPresets.changed || currentActivePresetId !== activePresetId) {
        server = {
          ...server,
          ModelPresets: {
            ...modelPresetsValue,
            Presets: transformedPresets.presets,
            ActivePresetId: activePresetId,
          },
        };
        changed = true;
      }
    }
    transformed.Server = server;
  }

  const inferenceValue = transformed.Inference;
  if (isJsonObject(inferenceValue) && Object.hasOwn(inferenceValue, 'SelectedBackend')) {
    const { SelectedBackend: _selectedBackend, ...withoutSelectedBackend } = inferenceValue;
    transformed.Inference = withoutSelectedBackend;
    changed = true;
  }
  const runtimeValue = transformed.Runtime;
  if (isJsonObject(runtimeValue) && Object.hasOwn(runtimeValue, 'Model')) {
    const { Model: _model, ...withoutModel } = runtimeValue;
    transformed.Runtime = withoutModel;
    changed = true;
  }
  return { json: changed ? JSON.stringify(transformed) : text, changed };
}

function migrateAppAndSnapshotJson(database: RuntimeDatabase): void {
  let appUpdate: { presetsJson: string; activePresetId: string | null } | null = null;
  if (tableHasColumn(database, 'app_config', 'server_model_presets_json')) {
    const rawRow = database.prepare(`
      SELECT server_model_presets_json AS presets_json, server_model_active_preset_id AS active_preset_id
      FROM app_config WHERE id = 1
    `).get();
    if (rawRow != null) {
      const row = AppConfigPresetRowSchema.parse(rawRow);
      const parsed = parseMigrationJson(row.presets_json, 'app_config.server_model_presets_json');
      const transformed = transformExecutablePresetArray(parsed, 'app_config.server_model_presets_json');
      const activePresetId = resolveActivePresetId(transformed.presets, row.active_preset_id);
      if (transformed.changed || row.active_preset_id !== activePresetId) {
        appUpdate = { presetsJson: JSON.stringify(transformed.presets), activePresetId };
      }
    }
  }

  const snapshots = transformSnapshotPresetRows(database);
  const benchmarkSessions: { id: string; value: string }[] = [];
  if (tableHasColumn(database, 'benchmark_sessions', 'original_config_json')) {
    const rows = z.array(BenchmarkConfigRowSchema).parse(database.prepare(`
      SELECT id, original_config_json
      FROM benchmark_sessions
      ORDER BY id
    `).all());
    for (const row of rows) {
      const source = `benchmark_sessions[${row.id}].original_config_json`;
      const transformed = transformBenchmarkConfig(row.original_config_json, source);
      if (transformed.changed) {
        benchmarkSessions.push({ id: row.id, value: transformed.json });
      }
    }
  }

  if (appUpdate) {
    database.prepare(`
      UPDATE app_config
      SET server_model_presets_json = ?, server_model_active_preset_id = ?
      WHERE id = 1
    `).run(appUpdate.presetsJson, appUpdate.activePresetId);
  }
  if (snapshots.sessions.length > 0) {
    const update = database.prepare('UPDATE chat_sessions SET model_preset_json = ? WHERE id = ?');
    for (const row of snapshots.sessions) {
      update.run(row.value, row.id);
    }
  }
  if (snapshots.cases.length > 0) {
    const update = database.prepare('UPDATE benchmark_cases SET managed_preset_json = ? WHERE id = ?');
    for (const row of snapshots.cases) {
      update.run(row.value, row.id);
    }
  }
  if (benchmarkSessions.length > 0) {
    const update = database.prepare('UPDATE benchmark_sessions SET original_config_json = ? WHERE id = ?');
    for (const row of benchmarkSessions) {
      update.run(row.value, row.id);
    }
  }
}

function rebuildInferenceTables(database: RuntimeDatabase): void {
  const hasRuns = tableExists(database, 'inference_runs');
  const hasChunks = tableExists(database, 'inference_run_log_chunks');
  database.exec(INFERENCE_RUNS_V64_SQL);
  if (hasRuns) {
    database.exec(`
      INSERT INTO inference_runs_v64 (
        id, backend, purpose, entrypoint_path, base_url, status, exit_code, error_message,
        started_at_utc, finished_at_utc, updated_at_utc, speculative_accepted_tokens,
        speculative_generated_tokens, stdout_character_count, stderr_character_count,
        metrics_updated_at_utc
      )
      SELECT
        id, backend, purpose, entrypoint_path, base_url, status, exit_code, error_message,
        started_at_utc, finished_at_utc, updated_at_utc, speculative_accepted_tokens,
        speculative_generated_tokens, stdout_character_count, stderr_character_count,
        metrics_updated_at_utc
      FROM inference_runs
      WHERE backend <> 'llama'
    `);
  }
  if (hasRuns && hasChunks) {
    database.exec(`
      DELETE FROM inference_run_log_chunks
      WHERE run_id IN (SELECT id FROM inference_runs WHERE backend = 'llama');
    `);
  }
  if (hasRuns) {
    database.exec('DROP TABLE inference_runs;');
  }
  database.exec('ALTER TABLE inference_runs_v64 RENAME TO inference_runs;');
  if (!hasChunks) {
    database.exec(INFERENCE_RUN_LOG_CHUNKS_SQL);
  }
  database.exec(`
    CREATE INDEX idx_inference_runs_started ON inference_runs(started_at_utc DESC);
    CREATE INDEX idx_inference_runs_status_started ON inference_runs(status, started_at_utc DESC);
    CREATE INDEX idx_inference_runs_backend_started ON inference_runs(backend, started_at_utc DESC);
    CREATE INDEX IF NOT EXISTS idx_inference_run_log_chunks_run_stream
      ON inference_run_log_chunks(run_id, stream_kind, sequence ASC);
    CREATE INDEX IF NOT EXISTS idx_inference_run_log_chunks_created_at
      ON inference_run_log_chunks(created_at_utc);
  `);
}

function readBenchmarkLogSequence(database: RuntimeDatabase): number {
  if (!tableExists(database, 'sqlite_sequence')) {
    return 0;
  }
  const rawRow = database.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'benchmark_logs'").get();
  const row = rawRow == null ? undefined : SequenceRowSchema.parse(rawRow);
  return Math.max(0, Number(row?.seq) || 0);
}

function rebuildBenchmarkLogs(database: RuntimeDatabase): void {
  const hasLogs = tableExists(database, 'benchmark_logs');
  const previousSequence = hasLogs ? readBenchmarkLogSequence(database) : 0;
  database.exec(BENCHMARK_LOGS_V64_SQL);
  if (hasLogs) {
    database.exec(`
      INSERT INTO benchmark_logs_v64 (
        id, session_id, attempt_id, stream_kind, sequence, chunk_text, created_at_utc
      )
      SELECT id, session_id, attempt_id, stream_kind, sequence, chunk_text, created_at_utc
      FROM benchmark_logs
      WHERE stream_kind <> 'managed_llama'
    `);
    database.exec('DROP TABLE benchmark_logs;');
  }
  database.exec(`
    ALTER TABLE benchmark_logs_v64 RENAME TO benchmark_logs;
    CREATE INDEX idx_benchmark_logs_session_stream
      ON benchmark_logs(session_id, attempt_id, stream_kind, sequence ASC);
  `);
  const rawMaxId = database.prepare('SELECT MAX(id) AS max_id FROM benchmark_logs').get();
  const maxId = rawMaxId == null ? 0 : Number(MaxIdRowSchema.parse(rawMaxId).max_id) || 0;
  const sequence = Math.max(previousSequence, maxId);
  if (sequence > 0 && tableExists(database, 'sqlite_sequence')) {
    const result = database.prepare("UPDATE sqlite_sequence SET seq = ? WHERE name = 'benchmark_logs'").run(sequence);
    if (Number(result.changes) === 0) {
      database.prepare("INSERT INTO sqlite_sequence (name, seq) VALUES ('benchmark_logs', ?)").run(sequence);
    }
  }
}

export function migrateRuntimeToExl3Only(database: RuntimeDatabase): void {
  if (tableHasColumn(database, 'app_config', 'server_llama_presets_json')) {
    if (tableHasColumn(database, 'app_config', 'server_model_presets_json')) {
      throw new Error('Cannot migrate app_config: both historical and current preset columns exist.');
    }
    database.exec(`
      ALTER TABLE app_config RENAME COLUMN server_llama_presets_json TO server_model_presets_json;
      ALTER TABLE app_config RENAME COLUMN server_llama_active_preset_id TO server_model_active_preset_id;
    `);
  }

  migrateAppAndSnapshotJson(database);
  if (tableHasColumn(database, 'run_logs', 'backend')) {
    database.prepare('DELETE FROM run_logs WHERE backend = ?').run(REMOVED_BACKEND);
  }
  if (tableExists(database, 'runtime_metadata')) {
    database.prepare('DELETE FROM runtime_metadata WHERE key = ?').run(REMOVED_LAUNCH_SNAPSHOT_KEY);
  }
  rebuildInferenceTables(database);
  rebuildBenchmarkLogs(database);
}
