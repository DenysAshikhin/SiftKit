import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import path from 'node:path';
import { z } from 'zod';
import { closeRuntimeDatabase, getRuntimeDatabase } from '../src/state/runtime-db.js';
import { createAppConfigMigrationFixture } from './helpers/app-config-migration-fixture.js';
import { createManagedTempDir } from './helpers/temp-dirs.js';

// The cached runtime DB handle keeps a file inside the temp dir open on Windows, which
// blocks the exit-time registry sweep. Root after() runs before the exit handler.
after(() => closeRuntimeDatabase());

const ColumnNameRowSchema = z.array(z.object({ name: z.string() }));

function tempDbPath(prefix: string): string {
  return path.join(createManagedTempDir(prefix), 'runtime.sqlite');
}

function columnNames(dbPath: string, table: string): string[] {
  const db = new Database(dbPath, { readonly: true });
  try {
    return ColumnNameRowSchema
      .parse(db.prepare(`SELECT name FROM pragma_table_info('${table}')`).all())
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
  createAppConfigMigrationFixture(seed, {
    omitExpandReads: true,
    omitInference: true,
    omitServerExl3: true,
    omitWebSearch: true,
  });
  seed.close();

  getRuntimeDatabase(dbPath);

  assert.ok(columnNames(dbPath, 'chat_sessions').includes('web_search_enabled'));
  assert.ok(columnNames(dbPath, 'app_config').includes('web_search_json'));
});
