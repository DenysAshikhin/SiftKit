import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import path from 'node:path';
import { z } from 'zod';
import { getRuntimeDatabase, closeRuntimeDatabase } from '../src/state/runtime-db.js';
import { createManagedTempDir } from './helpers/temp-dirs.js';

const NameRowSchema = z.array(z.object({ name: z.string() }));
const LEGACY_PRESETS_COLUMN = ['server_ll', 'ama_presets_json'].join('');
const LEGACY_ACTIVE_PRESET_COLUMN = ['server_ll', 'ama_active_preset_id'].join('');
const LEGACY_RUNS_TABLE = ['managed_ll', 'ama_runs'].join('');
const LEGACY_LOG_CHUNKS_TABLE = ['managed_ll', 'ama_log_chunks'].join('');

function tempDbPath(prefix: string): string {
  return path.join(createManagedTempDir(prefix), 'runtime.sqlite');
}

function tableNames(dbPath: string): string[] {
  const db = new Database(dbPath, { readonly: true });
  try {
    return NameRowSchema
      .parse(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all())
      .map((row) => row.name);
  } finally {
    db.close();
  }
}

function columnNames(dbPath: string, table: string): string[] {
  const db = new Database(dbPath, { readonly: true });
  try {
    return NameRowSchema
      .parse(db.prepare(`SELECT name FROM pragma_table_info('${table}')`).all())
      .map((row) => row.name);
  } finally {
    db.close();
  }
}

test('current schema exposes backend-neutral inference run tables', () => {
  const dbPath = tempDbPath('sk-current-fresh-');
  try {
    getRuntimeDatabase(dbPath);

    const tables = tableNames(dbPath);
    assert.ok(tables.includes('inference_runs'), 'inference_runs must exist');
    assert.ok(tables.includes('inference_run_log_chunks'), 'inference_run_log_chunks must exist');
    assert.ok(!tables.includes(LEGACY_RUNS_TABLE), 'removed run table must be gone');
    assert.ok(!tables.includes(LEGACY_LOG_CHUNKS_TABLE), 'removed log chunk table must be gone');

    const columns = columnNames(dbPath, 'inference_runs');
    assert.ok(columns.includes('backend'), 'inference_runs.backend must exist');
    assert.ok(columns.includes('entrypoint_path'), 'inference_runs.entrypoint_path must exist');
    assert.ok(!columns.includes('script_path'), 'script_path must be renamed');
  } finally {
    closeRuntimeDatabase();
  }
});

test('v33->v34 migration drops the removed backend run tables', () => {
  const dbPath = tempDbPath('sk-v34-migrate-');
  getRuntimeDatabase(dbPath);
  closeRuntimeDatabase();
  const seed = new Database(dbPath);
  seed.exec(`
    ALTER TABLE app_config RENAME COLUMN server_model_presets_json TO ${LEGACY_PRESETS_COLUMN};
    ALTER TABLE app_config RENAME COLUMN server_model_active_preset_id TO ${LEGACY_ACTIVE_PRESET_COLUMN};
    UPDATE runtime_schema SET version = 33 WHERE id = 1;
    CREATE TABLE ${LEGACY_RUNS_TABLE} (
      id TEXT PRIMARY KEY,
      purpose TEXT NOT NULL,
      script_path TEXT,
      status TEXT NOT NULL,
      started_at_utc TEXT NOT NULL,
      updated_at_utc TEXT NOT NULL
    );
    CREATE TABLE ${LEGACY_LOG_CHUNKS_TABLE} (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id TEXT NOT NULL REFERENCES ${LEGACY_RUNS_TABLE}(id) ON DELETE CASCADE,
      stream_kind TEXT NOT NULL,
      sequence INTEGER NOT NULL,
      chunk_text TEXT NOT NULL,
      created_at_utc TEXT NOT NULL
    );
  `);
  seed.close();

  try {
    getRuntimeDatabase(dbPath);

    const tables = tableNames(dbPath);
    assert.ok(!tables.includes(LEGACY_RUNS_TABLE), 'removed run table must be dropped');
    assert.ok(!tables.includes(LEGACY_LOG_CHUNKS_TABLE), 'removed log chunk table must be dropped');
    assert.ok(tables.includes('inference_runs'), 'inference_runs must be created');
    assert.ok(tables.includes('inference_run_log_chunks'), 'inference_run_log_chunks must be created');
  } finally {
    closeRuntimeDatabase();
  }
});
