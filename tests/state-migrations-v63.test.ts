import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import path from 'node:path';
import { z } from '../src/lib/zod.js';
import { JsonObjectSchema, JsonValueSchema, type JsonObject } from '../src/lib/json-types.js';
import { parseJsonValueText } from '../src/lib/json.js';
import { getDefaultConfigObject } from '../src/config/defaults.js';
import { readConfig, writeConfig } from '../src/status-server/config-store.js';
import { ensureRunLogsTable } from '../src/status-server/dashboard-runs/table.js';
import { CURRENT_SCHEMA_VERSION, closeRuntimeDatabase, getRuntimeDatabase } from '../src/state/runtime-db.js';
import { getChatSessionPath, readChatSessionFromPath, readChatSessions } from '../src/state/chat-sessions.js';
import { normalizeConfigObject } from '../src/config/normalization.js';
import { readBenchmarkSessionDetail } from '../src/state/dashboard-benchmark.js';
import {
  LEGACY_ACTIVE_MODEL_PRESET_COLUMN as LEGACY_ACTIVE_PRESET_COLUMN,
  LEGACY_ENGINE_CONFIG_KEY as REMOVED_SERVER_KEY,
  LEGACY_ENGINE_SNAPSHOT_KEY as REMOVED_SNAPSHOT_KEY,
  LEGACY_MODEL_PRESETS_COLUMN as LEGACY_PRESETS_COLUMN,
} from '../src/state/migrations/constants.js';
import { createManagedTempDir } from './helpers/temp-dirs.js';
import {
  REMOVED_BACKEND_ID,
  REMOVED_BACKEND_MODEL_FILE,
  REMOVED_BACKEND_STREAM_KIND,
} from './helpers/legacy-backend-fixtures.js';

const TIMESTAMP = '2026-09-01T00:00:00.000Z';
const ColumnNameRowSchema = z.object({ name: z.string() });
const PresetsRowSchema = z.object({ presets_json: z.string(), active_preset_id: z.string().nullable() });
const CountRowSchema = z.object({ count: z.number() });
const VersionRowSchema = z.object({ version: z.number() });
const ForeignKeyViolationRowSchema = z.object({
  table: z.string(), rowid: z.number().nullable(), parent: z.string(), fkid: z.number(),
});
const ForeignKeyViolationsSchema = z.array(ForeignKeyViolationRowSchema);
const REMOVED_STREAM_KIND = REMOVED_BACKEND_STREAM_KIND;

type SeedPresets = { presets: JsonObject[]; activePresetId: string };

function tempDbPath(prefix: string): string {
  return path.join(createManagedTempDir(prefix), 'runtime.sqlite');
}

function defaultPreset(): JsonObject {
  return JsonObjectSchema.parse(getDefaultConfigObject().Server.ModelPresets.Presets[0]);
}

function removedBackendPreset(): JsonObject {
  return {
    ...defaultPreset(),
    id: 'removed-main', label: 'Removed backend', Backend: REMOVED_BACKEND_ID, Model: REMOVED_BACKEND_MODEL_FILE,
    ModelPath: `D:\\models\\${REMOVED_BACKEND_MODEL_FILE}`, ExecutablePath: 'C:\\removed-engine\\server.exe',
    GpuLayers: 99, Threads: 8, KvCacheQuantization: 'q4_1',
  };
}

function exl3Preset(): JsonObject {
  return {
    ...defaultPreset(),
    id: 'exl3-main', label: 'EXL3 main', Backend: 'exl3', Model: 'qwen-exl3',
    // Removed-backend fields that leaked onto an EXL3 preset.
    Threads: 4, FlashAttention: true, KvCacheQuantization: 'q4_0', NcpuMoe: 12,
  };
}

function missingBackendPreset(): JsonObject {
  const preset = exl3Preset();
  delete preset.Backend;
  preset.id = 'missing-backend';
  return preset;
}

/**
 * Builds a database exactly as a v62 build left it: former column names, old
 * inference_runs / benchmark_logs constraints, and rows only the removed backend could produce.
 */
function seedV62Database(seed: SeedPresets): string {
  const dbPath = tempDbPath('sk-v63-');
  writeConfig(dbPath, getDefaultConfigObject());
  closeRuntimeDatabase();
  const database = new Database(dbPath);
  ensureRunLogsTable(database);
  database.exec(`
    PRAGMA foreign_keys = OFF;
    ALTER TABLE app_config RENAME COLUMN server_model_presets_json TO ${LEGACY_PRESETS_COLUMN};
    ALTER TABLE app_config RENAME COLUMN server_model_active_preset_id TO ${LEGACY_ACTIVE_PRESET_COLUMN};
    DROP TABLE inference_run_log_chunks;
    DROP TABLE inference_runs;
    CREATE TABLE inference_runs (
      id TEXT PRIMARY KEY,
      backend TEXT NOT NULL CHECK (backend IN ('${REMOVED_BACKEND_ID}', 'exl3')),
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
    DROP TABLE benchmark_logs;
    CREATE TABLE benchmark_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL REFERENCES benchmark_sessions(id) ON DELETE CASCADE,
      attempt_id TEXT REFERENCES benchmark_attempts(id) ON DELETE CASCADE,
      stream_kind TEXT NOT NULL CHECK (stream_kind IN ('orchestrator', 'attempt_stdout', 'attempt_stderr', '${REMOVED_STREAM_KIND}')),
      sequence INTEGER NOT NULL,
      chunk_text TEXT NOT NULL,
      created_at_utc TEXT NOT NULL,
      UNIQUE(session_id, attempt_id, stream_kind, sequence)
    );
  `);
  database.prepare(`
    UPDATE app_config SET ${LEGACY_PRESETS_COLUMN} = ?, ${LEGACY_ACTIVE_PRESET_COLUMN} = ? WHERE id = 1
  `).run(JSON.stringify(seed.presets), seed.activePresetId);
  const insertRunLog = database.prepare(`
    INSERT INTO run_logs (
      run_id, request_id, run_kind, run_group, terminal_state, title, backend, flushed_at_utc
    ) VALUES (?, ?, 'summary_request', 'summary', 'completed', ?, ?, ?)
  `);
  insertRunLog.run('run-removed', 'req-removed', 'removed run', REMOVED_BACKEND_ID, TIMESTAMP);
  insertRunLog.run('run-exl3', 'req-exl3', 'exl3 run', 'exl3', TIMESTAMP);
  insertRunLog.run('run-unknown', 'req-unknown', 'unknown run', null, TIMESTAMP);
  const insertInferenceRun = database.prepare(`
    INSERT INTO inference_runs (id, backend, purpose, status, started_at_utc, updated_at_utc)
    VALUES (?, ?, 'runtime', 'stopped', ?, ?)
  `);
  insertInferenceRun.run('inference-removed', REMOVED_BACKEND_ID, TIMESTAMP, TIMESTAMP);
  insertInferenceRun.run('inference-exl3', 'exl3', TIMESTAMP, TIMESTAMP);
  database.prepare(`
    INSERT INTO benchmark_sessions (
      id, status, question_preset_count, case_count, repetitions,
      current_case_index, current_prompt_index, current_repeat_index,
      restore_status, restore_error, original_config_json,
      started_at_utc, completed_at_utc, updated_at_utc
    ) VALUES ('bench-1', 'completed', 1, 1, 1, NULL, NULL, NULL, 'completed', NULL, '{}', ?, NULL, ?)
  `).run(TIMESTAMP, TIMESTAMP);
  const insertBenchmarkLog = database.prepare(`
    INSERT INTO benchmark_logs (session_id, attempt_id, stream_kind, sequence, chunk_text, created_at_utc)
    VALUES ('bench-1', NULL, ?, ?, ?, ?)
  `);
  insertBenchmarkLog.run('orchestrator', 1, 'orchestrator line', TIMESTAMP);
  insertBenchmarkLog.run(REMOVED_STREAM_KIND, 1, 'removed server stdout', TIMESTAMP);
  database.prepare(`
    INSERT INTO runtime_metadata (key, value, updated_at_utc) VALUES (?, ?, ?)
  `).run(REMOVED_SNAPSHOT_KEY, JSON.stringify({ Model: REMOVED_BACKEND_MODEL_FILE }), TIMESTAMP);
  database.prepare('UPDATE runtime_schema SET version = 62 WHERE id = 1').run();
  database.close();
  return dbPath;
}

function migrate(dbPath: string): void {
  getRuntimeDatabase(dbPath);
  closeRuntimeDatabase();
}

function withReadonly<T>(dbPath: string, read: (database: InstanceType<typeof Database>) => T): T {
  const database = new Database(dbPath, { readonly: true });
  try {
    return read(database);
  } finally {
    database.close();
  }
}

function appConfigColumns(dbPath: string): string[] {
  return withReadonly(dbPath, (database) => z.array(ColumnNameRowSchema)
    .parse(database.prepare('PRAGMA table_info(app_config);').all())
    .map((row) => row.name));
}

function readPresets(dbPath: string): { presets: JsonObject[]; activePresetId: string | null } {
  return withReadonly(dbPath, (database) => {
    const row = PresetsRowSchema.parse(database.prepare(`
      SELECT server_model_presets_json AS presets_json, server_model_active_preset_id AS active_preset_id
      FROM app_config WHERE id = 1
    `).get());
    return { presets: z.array(JsonObjectSchema).parse(parseJsonValueText(row.presets_json)), activePresetId: row.active_preset_id };
  });
}

function count(dbPath: string, sql: string): number {
  return withReadonly(dbPath, (database) => CountRowSchema.parse(database.prepare(sql).get()).count);
}

function schemaVersion(dbPath: string): number {
  return withReadonly(dbPath, (database) => VersionRowSchema.parse(
    database.prepare('SELECT version FROM runtime_schema WHERE id = 1').get(),
  ).version);
}

test('v63 renames the preset columns and keeps only exl3 presets with exl3 fields', () => {
  const dbPath = seedV62Database({ presets: [removedBackendPreset(), exl3Preset()], activePresetId: 'removed-main' });
  try {
    migrate(dbPath);

    assert.equal(CURRENT_SCHEMA_VERSION, 64);
    assert.equal(schemaVersion(dbPath), 64);
    const columns = appConfigColumns(dbPath);
    assert.equal(columns.includes('server_model_presets_json'), true);
    assert.equal(columns.includes('server_model_active_preset_id'), true);
    assert.equal(columns.includes(LEGACY_PRESETS_COLUMN), false);
    assert.equal(columns.includes(LEGACY_ACTIVE_PRESET_COLUMN), false);

    const { presets, activePresetId } = readPresets(dbPath);
    assert.equal(presets.length, 1);
    const [survivor] = presets;
    assert.ok(survivor);
    assert.equal(survivor.id, 'exl3-main');
    assert.equal(survivor.Backend, 'exl3');
    assert.equal(survivor.Model, 'qwen-exl3');
    assert.equal('Threads' in survivor, false);
    assert.equal('FlashAttention' in survivor, false);
    assert.equal(survivor.KvCacheQuantization, 'q4_0');
    assert.equal(survivor.NcpuMoe, 12);
    assert.equal(activePresetId, 'exl3-main');

    // The migrated row is a config the current build reads without repair.
    const config = readConfig(dbPath);
    closeRuntimeDatabase();
    assert.equal(config.Server.ModelPresets.ActivePresetId, 'exl3-main');
    assert.equal(config.Server.ModelPresets.Presets[0]?.Backend, 'exl3');
  } finally {
    closeRuntimeDatabase();
  }
});

test('v63 purges removed-backend runs, benchmark logs, and launch snapshot', () => {
  const dbPath = seedV62Database({ presets: [removedBackendPreset(), exl3Preset()], activePresetId: 'exl3-main' });
  try {
    migrate(dbPath);

    assert.equal(count(dbPath, `SELECT COUNT(*) AS count FROM run_logs WHERE backend = '${REMOVED_BACKEND_ID}'`), 0);
    assert.equal(count(dbPath, 'SELECT COUNT(*) AS count FROM run_logs'), 2);
    assert.equal(count(dbPath, `SELECT COUNT(*) AS count FROM inference_runs WHERE backend = '${REMOVED_BACKEND_ID}'`), 0);
    assert.equal(count(dbPath, 'SELECT COUNT(*) AS count FROM inference_runs'), 1);
    assert.equal(count(dbPath, `SELECT COUNT(*) AS count FROM benchmark_logs WHERE stream_kind = '${REMOVED_STREAM_KIND}'`), 0);
    assert.equal(count(dbPath, 'SELECT COUNT(*) AS count FROM benchmark_logs'), 1);
    assert.equal(
      count(dbPath, `SELECT COUNT(*) AS count FROM runtime_metadata WHERE key = '${REMOVED_SNAPSHOT_KEY}'`),
      0,
    );
    assert.equal(readPresets(dbPath).activePresetId, 'exl3-main');
  } finally {
    closeRuntimeDatabase();
  }
});

test('v63 leaves an empty preset list and no active id when no exl3 preset survives', () => {
  const dbPath = seedV62Database({ presets: [removedBackendPreset()], activePresetId: 'removed-main' });
  try {
    migrate(dbPath);

    const { presets, activePresetId } = readPresets(dbPath);
    assert.deepEqual(presets, []);
    assert.equal(activePresetId, null);

    // An empty list reads back as the stock default preset, so the server still starts.
    const config = readConfig(dbPath);
    closeRuntimeDatabase();
    assert.equal(config.Server.ModelPresets.Presets.length, 1);
    assert.equal(config.Server.ModelPresets.Presets[0]?.Backend, 'exl3');
  } finally {
    closeRuntimeDatabase();
  }
});

test('v63 rejects malformed preset JSON without advancing the schema version', () => {
  const dbPath = seedV62Database({ presets: [exl3Preset()], activePresetId: 'exl3-main' });
  const database = new Database(dbPath);
  database.prepare(`UPDATE app_config SET ${LEGACY_PRESETS_COLUMN} = ? WHERE id = 1`).run('{ broken json');
  database.close();
  try {
    assert.throws(() => getRuntimeDatabase(dbPath));
    closeRuntimeDatabase();
    assert.equal(schemaVersion(dbPath), 62);
  } finally {
    closeRuntimeDatabase();
  }
});

test('re-opening a migrated database is a no-op', () => {
  const dbPath = seedV62Database({ presets: [exl3Preset()], activePresetId: 'exl3-main' });
  try {
    migrate(dbPath);
    const first = readPresets(dbPath);
    migrate(dbPath);
    assert.deepEqual(readPresets(dbPath), first);
    assert.equal(schemaVersion(dbPath), 64);
  } finally {
    closeRuntimeDatabase();
  }
});

test('v63 rejects invalid EXL3 cache values without changing data or version', () => {
  const dbPath = seedV62Database({ presets: [exl3Preset()], activePresetId: 'exl3-main' });
  const database = new Database(dbPath);
  const invalid = JSON.stringify([{ ...exl3Preset(), KvCacheQuantization: 'bf16' }]);
  database.prepare(`UPDATE app_config SET ${LEGACY_PRESETS_COLUMN} = ? WHERE id = 1`).run(invalid);
  database.close();
  try {
    assert.throws(() => getRuntimeDatabase(dbPath), /KvCacheQuantization|cache/iu);
    closeRuntimeDatabase();
    assert.equal(schemaVersion(dbPath), 62);
    assert.equal(withReadonly(dbPath, (readOnly) => z.object({ value: z.string() }).parse(readOnly.prepare(
      `SELECT ${LEGACY_PRESETS_COLUMN} AS value FROM app_config WHERE id = 1`,
    ).get()).value), invalid);
  } finally {
    closeRuntimeDatabase();
  }
});

test('v63 rejects explicit unexpected preset backends and treats omitted backends as removed', () => {
  const dbPath = seedV62Database({ presets: [missingBackendPreset(), { ...exl3Preset(), Backend: 'other' }], activePresetId: 'missing-backend' });
  try {
    assert.throws(() => getRuntimeDatabase(dbPath), /backend/iu);
    closeRuntimeDatabase();
    assert.equal(schemaVersion(dbPath), 62);
  } finally {
    closeRuntimeDatabase();
  }
});

test('v63 applies frozen EXL3 transforms to snapshots and preserves removed history as removed', () => {
  const dbPath = seedV62Database({ presets: [exl3Preset()], activePresetId: 'exl3-main' });
  const database = new Database(dbPath);
  const snapshotWithoutBackend = { ...missingBackendPreset(), id: 'historical-missing', Threads: 3 };
  const explicitRemovedSnapshot = { ...removedBackendPreset(), id: 'historical-removed' };
  database.prepare(`
    INSERT INTO chat_sessions (
      id, title, model_preset_id, model_preset_json, thinking_enabled,
      web_search_enabled, preset_id, mode, plan_repo_root, created_at_utc, updated_at_utc
    ) VALUES ('chat-exl3', 'EXL3', 'exl3-main', ?, 0, 1, 'chat', 'chat', '.', ?, ?),
      ('chat-missing', 'Missing', 'historical-missing', ?, 0, 1, 'chat', 'chat', '.', ?, ?)
  `).run(
    JSON.stringify({ ...exl3Preset(), Threads: 3 }), TIMESTAMP, TIMESTAMP,
    JSON.stringify(snapshotWithoutBackend), TIMESTAMP, TIMESTAMP,
  );
  const baseConfig = JsonObjectSchema.parse(JsonValueSchema.parse(getDefaultConfigObject()));
  const baseServer = JsonObjectSchema.parse(baseConfig.Server);
  const baseInference = JsonObjectSchema.parse(baseConfig.Inference);
  const baseRuntime = JsonObjectSchema.parse(baseConfig.Runtime);
  const originalConfig = {
    ...baseConfig,
    Inference: { ...baseInference, SelectedBackend: 'exl3' },
    Runtime: { ...baseRuntime, Model: 'obsolete' },
    Server: {
      ...baseServer,
      ModelPresets: { Presets: [exl3Preset(), missingBackendPreset(), explicitRemovedSnapshot], ActivePresetId: 'missing-backend' },
      [REMOVED_SERVER_KEY]: { Model: 'obsolete' },
      Exl3: { Model: 'obsolete' },
    },
  };
  database.prepare(`
    INSERT INTO benchmark_sessions (
      id, status, question_preset_count, case_count, repetitions,
      current_case_index, current_prompt_index, current_repeat_index,
      restore_status, restore_error, original_config_json,
      started_at_utc, completed_at_utc, updated_at_utc
    ) VALUES ('bench-snapshot', 'completed', 1, 1, 1, NULL, NULL, NULL, 'completed', NULL, ?, ?, NULL, ?)
  `).run(JSON.stringify(originalConfig), TIMESTAMP, TIMESTAMP);
  database.prepare(`
    INSERT INTO benchmark_cases (
      id, session_id, case_index, label, managed_preset_id, managed_preset_label,
      managed_preset_json, spec_override_json, created_at_utc
    ) VALUES ('case-snapshot', 'bench-snapshot', 0, 'snapshot', 'exl3-main', 'EXL3', ?, '{}', ?)
  `).run(JSON.stringify(snapshotWithoutBackend), TIMESTAMP);
  database.close();

  try {
    migrate(dbPath);
    const readOnly = new Database(dbPath, { readonly: true });
    try {
      const chatSnapshots = z.array(z.object({ id: z.string(), model_preset_json: z.string() })).parse(
        readOnly.prepare('SELECT id, model_preset_json FROM chat_sessions ORDER BY id').all(),
      );
      const migratedExl3 = JsonObjectSchema.parse(parseJsonValueText(chatSnapshots.find((row) => row.id === 'chat-exl3')?.model_preset_json ?? ''));
      assert.equal(migratedExl3.KvCacheQuantization, 'q4_0');
      assert.equal('Threads' in migratedExl3, false);
      const migratedMissing = JsonObjectSchema.parse(parseJsonValueText(chatSnapshots.find((row) => row.id === 'chat-missing')?.model_preset_json ?? ''));
      assert.equal(migratedMissing.Backend, REMOVED_BACKEND_ID);
      assert.equal(migratedMissing.Threads, 3);
      const benchmark = JsonObjectSchema.parse(parseJsonValueText(z.object({ original_config_json: z.string() }).parse(
        readOnly.prepare('SELECT original_config_json FROM benchmark_sessions WHERE id = \'bench-snapshot\'').get(),
      ).original_config_json));
      assert.equal(JsonObjectSchema.parse(benchmark.Inference).SelectedBackend, undefined);
      const benchmarkServer = JsonObjectSchema.parse(benchmark.Server);
      assert.equal(REMOVED_SERVER_KEY in benchmarkServer, false);
      assert.equal('Exl3' in benchmarkServer, false);
      assert.ok(benchmarkServer.Engines);
      const benchmarkPresets = z.array(JsonObjectSchema).parse(JsonObjectSchema.parse(benchmarkServer.ModelPresets).Presets);
      assert.equal(benchmarkPresets.length, 1);
      assert.equal(benchmarkPresets[0]?.Backend, 'exl3');
      assert.deepEqual(JsonObjectSchema.parse(parseJsonValueText(z.object({ managed_preset_json: z.string() }).parse(
        readOnly.prepare('SELECT managed_preset_json FROM benchmark_cases WHERE id = \'case-snapshot\'').get(),
      ).managed_preset_json)).Backend, REMOVED_BACKEND_ID);
    } finally {
      readOnly.close();
    }
    const restoredConfig = normalizeConfigObject(parseJsonValueText(withReadonly(dbPath, (readOnly) => z.object({ value: z.string() }).parse(
      readOnly.prepare("SELECT original_config_json AS value FROM benchmark_sessions WHERE id = 'bench-snapshot'").get(),
    ).value)));
    assert.equal(restoredConfig.Server.ModelPresets.ActivePresetId, 'exl3-main');
    assert.equal(restoredConfig.Server.ModelPresets.Presets.length, 1);
    const exl3Session = readChatSessionFromPath(getChatSessionPath(path.dirname(dbPath), 'chat-exl3'));
    assert.ok(exl3Session);
    assert.equal(exl3Session.modelPreset.Backend, 'exl3');
    assert.throws(() => readChatSessions(path.dirname(dbPath)), new RegExp(`Backend|exl3|${REMOVED_BACKEND_ID}|Threads`, 'iu'));
    assert.equal(readBenchmarkSessionDetail('bench-snapshot', dbPath)?.session.id, 'bench-snapshot');
  } finally {
    closeRuntimeDatabase();
  }
});

test('v64 repairs already-v63 tables and preserves retained child rows while enforcing constraints', () => {
  const dbPath = seedV62Database({ presets: [exl3Preset()], activePresetId: 'exl3-main' });
  const database = new Database(dbPath);
  database.exec(`
    PRAGMA foreign_keys = OFF;
    ALTER TABLE app_config RENAME COLUMN ${LEGACY_PRESETS_COLUMN} TO server_model_presets_json;
    ALTER TABLE app_config RENAME COLUMN ${LEGACY_ACTIVE_PRESET_COLUMN} TO server_model_active_preset_id;
    CREATE TABLE inference_run_log_chunks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id TEXT NOT NULL REFERENCES inference_runs(id) ON DELETE CASCADE,
      stream_kind TEXT NOT NULL CHECK (stream_kind IN ('launcher_stdout', 'engine_stdout')),
      sequence INTEGER NOT NULL, chunk_text TEXT NOT NULL, created_at_utc TEXT NOT NULL,
      UNIQUE(run_id, stream_kind, sequence)
    );
    INSERT INTO inference_run_log_chunks (run_id, stream_kind, sequence, chunk_text, created_at_utc)
    VALUES ('inference-exl3', 'engine_stdout', 0, 'retained', '${TIMESTAMP}');
  `);
  database.prepare('UPDATE runtime_schema SET version = 63 WHERE id = 1').run();
  database.close();
  try {
    migrate(dbPath);
    assert.equal(schemaVersion(dbPath), 64);
    assert.equal(count(dbPath, "SELECT COUNT(*) AS count FROM inference_run_log_chunks WHERE run_id = 'inference-exl3'"), 1);
    const migrated = new Database(dbPath);
    try {
      assert.throws(() => migrated.prepare(`INSERT INTO inference_runs (id, backend, purpose, status, started_at_utc, updated_at_utc) VALUES ('bad', '${REMOVED_BACKEND_ID}', 'x', 'stopped', ?, ?)` ).run(TIMESTAMP, TIMESTAMP), /CHECK constraint failed/);
      assert.throws(() => migrated.prepare(`INSERT INTO benchmark_logs (session_id, stream_kind, sequence, chunk_text, created_at_utc) VALUES ('bench-1', '${REMOVED_BACKEND_STREAM_KIND}', 9, 'bad', ?)` ).run(TIMESTAMP), /CHECK constraint failed/);
      migrated.prepare("INSERT INTO benchmark_logs (session_id, stream_kind, sequence, chunk_text, created_at_utc) VALUES ('bench-1', 'managed_engine', 9, 'retained engine', ?)").run(TIMESTAMP);
      assert.equal(z.object({ id: z.number() }).parse(migrated.prepare("SELECT id FROM benchmark_logs WHERE stream_kind = 'managed_engine'").get()).id, 3);
      assert.equal(ForeignKeyViolationsSchema.parse(migrated.prepare('PRAGMA foreign_key_check').all()).length, 0);
    } finally {
      migrated.close();
    }
  } finally {
    closeRuntimeDatabase();
  }
});

test('v64 rolls back table rebuilds when foreign-key validation finds an orphan child', () => {
  const dbPath = seedV62Database({ presets: [exl3Preset()], activePresetId: 'exl3-main' });
  const database = new Database(dbPath);
  database.exec(`
    PRAGMA foreign_keys = OFF;
    ALTER TABLE app_config RENAME COLUMN ${LEGACY_PRESETS_COLUMN} TO server_model_presets_json;
    ALTER TABLE app_config RENAME COLUMN ${LEGACY_ACTIVE_PRESET_COLUMN} TO server_model_active_preset_id;
    CREATE TABLE inference_run_log_chunks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id TEXT NOT NULL REFERENCES inference_runs(id) ON DELETE CASCADE,
      stream_kind TEXT NOT NULL CHECK (stream_kind IN ('launcher_stdout', 'engine_stdout')),
      sequence INTEGER NOT NULL, chunk_text TEXT NOT NULL, created_at_utc TEXT NOT NULL,
      UNIQUE(run_id, stream_kind, sequence)
    );
    INSERT INTO inference_run_log_chunks (run_id, stream_kind, sequence, chunk_text, created_at_utc)
    VALUES ('orphan', 'engine_stdout', 0, 'orphan', '${TIMESTAMP}');
  `);
  database.prepare('UPDATE runtime_schema SET version = 63 WHERE id = 1').run();
  database.close();

  try {
    assert.throws(() => getRuntimeDatabase(dbPath), /foreign key/iu);
    closeRuntimeDatabase();
    assert.equal(schemaVersion(dbPath), 63);
    assert.equal(count(dbPath, "SELECT COUNT(*) AS count FROM inference_run_log_chunks WHERE run_id = 'orphan'"), 1);
    assert.equal(appConfigColumns(dbPath).includes(LEGACY_PRESETS_COLUMN), false);
    assert.equal(appConfigColumns(dbPath).includes('server_model_presets_json'), true);
  } finally {
    closeRuntimeDatabase();
  }
});
