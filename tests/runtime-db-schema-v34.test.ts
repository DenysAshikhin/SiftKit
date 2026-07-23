import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { z } from 'zod';
import { getRuntimeDatabase, closeRuntimeDatabase } from '../src/state/runtime-db.js';

const NameRowSchema = z.array(z.object({ name: z.string() }));

function tempDbPath(prefix: string): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), prefix)), 'runtime.sqlite');
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
    assert.ok(!tables.includes('managed_llama_runs'), 'managed_llama_runs must be gone');
    assert.ok(!tables.includes('managed_llama_log_chunks'), 'managed_llama_log_chunks must be gone');

    const columns = columnNames(dbPath, 'inference_runs');
    assert.ok(columns.includes('backend'), 'inference_runs.backend must exist');
    assert.ok(columns.includes('entrypoint_path'), 'inference_runs.entrypoint_path must exist');
    assert.ok(!columns.includes('script_path'), 'script_path must be renamed');
  } finally {
    closeRuntimeDatabase();
  }
});

test('v33->v34 migration drops the llama-shaped run tables', () => {
  const dbPath = tempDbPath('sk-v34-migrate-');
  const seed = new Database(dbPath);
  seed.exec(`
    CREATE TABLE runtime_schema (id INTEGER PRIMARY KEY CHECK (id = 1), version INTEGER NOT NULL);
    INSERT INTO runtime_schema (id, version) VALUES (1, 33);
    CREATE TABLE managed_llama_runs (
      id TEXT PRIMARY KEY,
      purpose TEXT NOT NULL,
      script_path TEXT,
      status TEXT NOT NULL,
      started_at_utc TEXT NOT NULL,
      updated_at_utc TEXT NOT NULL
    );
    CREATE TABLE managed_llama_log_chunks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id TEXT NOT NULL REFERENCES managed_llama_runs(id) ON DELETE CASCADE,
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
    assert.ok(!tables.includes('managed_llama_runs'), 'managed_llama_runs must be dropped');
    assert.ok(!tables.includes('managed_llama_log_chunks'), 'managed_llama_log_chunks must be dropped');
    assert.ok(tables.includes('inference_runs'), 'inference_runs must be created');
    assert.ok(tables.includes('inference_run_log_chunks'), 'inference_run_log_chunks must be created');
  } finally {
    closeRuntimeDatabase();
  }
});
