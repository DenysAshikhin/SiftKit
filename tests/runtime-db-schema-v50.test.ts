import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import path from 'node:path';
import test from 'node:test';
import { z } from '../src/lib/zod.js';
import { getDefaultConfigObject } from '../src/config/defaults.js';
import { writeConfig } from '../src/status-server/config-store.js';
import { CURRENT_SCHEMA_VERSION, closeRuntimeDatabase, getRuntimeDatabase } from '../src/state/runtime-db.js';
import { createManagedTempDir } from './helpers/temp-dirs.js';

const SchemaVersionRowSchema = z.object({ version: z.number() });
const FlagRowsSchema = z.array(z.object({ id: z.string(), compressed_into_summary: z.number() }));
const ColumnRowsSchema = z.array(z.object({ name: z.string() }));

function tempDbPath(prefix: string): string {
  return path.join(createManagedTempDir(prefix), 'runtime.sqlite');
}

// Pre-v50 builds stored a 2400-character condensed tail on the session and flagged the
// messages it replaced.
function seedCondensedSessionDb(dbPath: string): void {
  writeConfig(dbPath, getDefaultConfigObject());
  const database = getRuntimeDatabase(dbPath);
  database.exec("ALTER TABLE chat_sessions ADD COLUMN condensed_summary TEXT NOT NULL DEFAULT '';");
  const timestamp = '2026-01-01T00:00:00.000Z';
  database.prepare(`
    INSERT INTO chat_sessions (
      id, title, model_preset_id, model_preset_json, thinking_enabled,
      web_search_enabled, preset_id, mode, plan_repo_root, condensed_summary,
      created_at_utc, updated_at_utc
    ) VALUES ('session-1', 'Session', 'default', '{}', 0, 1, NULL, 'chat', '.', 'old condensed tail', ?, ?)
  `).run(timestamp, timestamp);
  const insertMessage = database.prepare(`
    INSERT INTO chat_messages (
      session_id, id, role, kind, content,
      input_tokens_estimate, output_tokens_estimate, thinking_tokens,
      input_tokens_estimated, output_tokens_estimated, thinking_tokens_estimated,
      created_at_utc, compressed_into_summary, position
    ) VALUES ('session-1', ?, 'assistant', 'assistant_answer', 'message', 0, 0, 0, 1, 1, 1, ?, ?, ?)
  `);
  insertMessage.run('m-1', timestamp, 1, 0);
  insertMessage.run('m-2', timestamp, 1, 1);
  insertMessage.run('m-3', timestamp, 0, 2);
  database.prepare('UPDATE runtime_schema SET version = 49 WHERE id = 1').run();
  closeRuntimeDatabase();
}

function readSessionColumns(dbPath: string): string[] {
  const database = new Database(dbPath, { readonly: true });
  try {
    return ColumnRowsSchema.parse(database.prepare('PRAGMA table_info(chat_sessions)').all())
      .map((row) => row.name);
  } finally {
    database.close();
  }
}

function readFlags(dbPath: string): number[] {
  const database = new Database(dbPath, { readonly: true });
  try {
    return FlagRowsSchema.parse(
      database.prepare('SELECT id, compressed_into_summary FROM chat_messages ORDER BY position').all(),
    ).map((row) => row.compressed_into_summary);
  } finally {
    database.close();
  }
}

function readSchemaVersion(dbPath: string): number {
  const database = new Database(dbPath, { readonly: true });
  try {
    return SchemaVersionRowSchema.parse(
      database.prepare('SELECT version FROM runtime_schema WHERE id = 1').get(),
    ).version;
  } finally {
    database.close();
  }
}

test('v50 drops condensed_summary and replays full history until the next compaction', () => {
  const dbPath = tempDbPath('sk-v50-condensed-');
  try {
    seedCondensedSessionDb(dbPath);

    getRuntimeDatabase(dbPath);
    closeRuntimeDatabase();

    assert.equal(readSessionColumns(dbPath).includes('condensed_summary'), false);
    assert.deepEqual(readFlags(dbPath), [0, 0, 0]);
    assert.equal(readSchemaVersion(dbPath), CURRENT_SCHEMA_VERSION);
  } finally {
    closeRuntimeDatabase();
  }
});

test('v50 tolerates a chat_sessions table that already lacks condensed_summary', () => {
  const dbPath = tempDbPath('sk-v50-missing-column-');
  try {
    writeConfig(dbPath, getDefaultConfigObject());
    getRuntimeDatabase(dbPath).prepare('UPDATE runtime_schema SET version = 49 WHERE id = 1').run();
    closeRuntimeDatabase();

    getRuntimeDatabase(dbPath);
    closeRuntimeDatabase();

    assert.equal(readSessionColumns(dbPath).includes('condensed_summary'), false);
    assert.equal(readSchemaVersion(dbPath), CURRENT_SCHEMA_VERSION);
  } finally {
    closeRuntimeDatabase();
  }
});
