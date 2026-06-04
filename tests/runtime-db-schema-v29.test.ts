import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { getRuntimeDatabase } from '../src/state/runtime-db.js';

function tempDbPath(prefix: string): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), prefix)), 'runtime.sqlite');
}

function columnNames(dbPath: string, table: string): string[] {
  const db = new Database(dbPath, { readonly: true });
  try {
    return (db.prepare(`SELECT name FROM pragma_table_info('${table}')`).all() as { name: string }[])
      .map((r) => r.name);
  } finally {
    db.close();
  }
}

test('fresh DB schema includes web search columns', () => {
  const dbPath = tempDbPath('sk-v29-fresh-');
  getRuntimeDatabase(dbPath);
  assert.ok(columnNames(dbPath, 'chat_sessions').includes('web_search_enabled'));
  assert.ok(columnNames(dbPath, 'app_config').includes('web_search_json'));
});

test('v28->v29 migration adds web search columns', () => {
  const dbPath = tempDbPath('sk-v29-migrate-');
  const seed = new Database(dbPath);
  seed.exec(`
    CREATE TABLE runtime_schema (id INTEGER PRIMARY KEY CHECK (id = 1), version INTEGER NOT NULL);
    INSERT INTO runtime_schema (id, version) VALUES (1, 28);
    CREATE TABLE app_config (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      server_llama_presets_json TEXT,
      server_llama_active_preset_id TEXT
    );
    CREATE TABLE chat_sessions (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      model TEXT,
      context_window_tokens INTEGER NOT NULL,
      thinking_enabled INTEGER NOT NULL CHECK (thinking_enabled IN (0, 1)),
      preset_id TEXT,
      mode TEXT NOT NULL CHECK (mode IN ('chat', 'plan', 'repo-search')),
      plan_repo_root TEXT NOT NULL,
      condensed_summary TEXT NOT NULL,
      created_at_utc TEXT NOT NULL,
      updated_at_utc TEXT NOT NULL
    );
  `);
  seed.close();

  getRuntimeDatabase(dbPath);

  assert.ok(columnNames(dbPath, 'chat_sessions').includes('web_search_enabled'));
  assert.ok(columnNames(dbPath, 'app_config').includes('web_search_json'));
});
