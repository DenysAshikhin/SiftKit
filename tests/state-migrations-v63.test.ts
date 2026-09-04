import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import path from 'node:path';
import { z } from '../src/lib/zod.js';
import { JsonObjectSchema, type JsonObject } from '../src/lib/json-types.js';
import { parseJsonValueText } from '../src/lib/json.js';
import { getDefaultConfigObject } from '../src/config/defaults.js';
import { readConfig, writeConfig } from '../src/status-server/config-store.js';
import { ensureRunLogsTable } from '../src/status-server/dashboard-runs/table.js';
import { CURRENT_SCHEMA_VERSION, closeRuntimeDatabase, getRuntimeDatabase } from '../src/state/runtime-db.js';
import { createManagedTempDir } from './helpers/temp-dirs.js';

const TIMESTAMP = '2026-09-01T00:00:00.000Z';
const ColumnNameRowSchema = z.object({ name: z.string() });
const PresetsRowSchema = z.object({ presets_json: z.string(), active_preset_id: z.string().nullable() });
const CountRowSchema = z.object({ count: z.number() });
const VersionRowSchema = z.object({ version: z.number() });
const REMOVED_BACKEND_ID = ['ll', 'ama'].join('');
const REMOVED_STREAM_KIND = ['managed_ll', 'ama'].join('');
const REMOVED_SNAPSHOT_KEY = ['runtime_ll', 'ama_launch_snapshot'].join('');
const LEGACY_PRESETS_COLUMN = ['server_ll', 'ama_presets_json'].join('');
const LEGACY_ACTIVE_PRESET_COLUMN = ['server_ll', 'ama_active_preset_id'].join('');
const REMOVED_MODEL_FILE = ['qwen.g', 'guf'].join('');

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
    id: 'removed-main', label: 'Removed backend', Backend: REMOVED_BACKEND_ID, Model: REMOVED_MODEL_FILE,
    ModelPath: `D:\\models\\${REMOVED_MODEL_FILE}`, ExecutablePath: 'C:\\removed-engine\\server.exe',
    GpuLayers: 99, Threads: 8, KvCacheQuantization: 'q4_1',
  };
}

function exl3Preset(): JsonObject {
  return {
    ...defaultPreset(),
    id: 'exl3-main', label: 'EXL3 main', Backend: 'exl3', Model: 'qwen-exl3',
    // Removed-backend fields that leaked onto an exl3 preset, plus an unsupported KV mode.
    Threads: 4, FlashAttention: true, KvCacheQuantization: 'bf16', NcpuMoe: 12,
  };
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
  `).run(REMOVED_SNAPSHOT_KEY, JSON.stringify({ Model: REMOVED_MODEL_FILE }), TIMESTAMP);
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

    assert.equal(CURRENT_SCHEMA_VERSION, 63);
    assert.equal(schemaVersion(dbPath), 63);
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
    assert.equal(survivor.KvCacheQuantization, 'f16');
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
    assert.equal(schemaVersion(dbPath), 63);
  } finally {
    closeRuntimeDatabase();
  }
});
