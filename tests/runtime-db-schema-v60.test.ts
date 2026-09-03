import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import path from 'node:path';
import test from 'node:test';

import { getDefaultConfigObject } from '../src/config/defaults.js';
import { z } from '../src/lib/zod.js';
import { writeConfig } from '../src/status-server/config-store.js';
import {
  closeRuntimeDatabase,
  CURRENT_SCHEMA_VERSION,
  getRuntimeDatabase,
  migrateDatabaseFile,
} from '../src/state/runtime-db.js';
import { createManagedTempDir } from './helpers/temp-dirs.js';

const ToolStatusRowsSchema = z.array(z.object({
  id: z.string(),
  tool_call_status: z.string().nullable(),
}));

const KindRowsSchema = z.array(z.object({
  id: z.string(),
  kind: z.string(),
}));

test('v60 rejects a predecessor chat_messages table without kind', () => {
  const dbPath = path.join(createManagedTempDir('sk-v60-missing-kind-'), 'runtime.sqlite');
  const database = new Database(dbPath);
  database.exec(`
    CREATE TABLE runtime_schema (id INTEGER PRIMARY KEY CHECK (id = 1), version INTEGER NOT NULL);
    INSERT INTO runtime_schema (id, version) VALUES (1, 59);
    CREATE TABLE chat_messages (id TEXT NOT NULL, role TEXT NOT NULL);
  `);
  database.close();

  assert.throws(() => migrateDatabaseFile(dbPath), /requires chat_messages\.kind/u);
});

test('v60 backfills legitimate null kinds from validated roles', () => {
  const dbPath = path.join(createManagedTempDir('sk-v60-null-kinds-'), 'runtime.sqlite');
  const database = new Database(dbPath);
  database.exec(`
    CREATE TABLE runtime_schema (id INTEGER PRIMARY KEY CHECK (id = 1), version INTEGER NOT NULL);
    INSERT INTO runtime_schema (id, version) VALUES (1, 59);
    CREATE TABLE chat_messages (id TEXT NOT NULL, role TEXT NOT NULL, kind TEXT);
    INSERT INTO chat_messages (id, role, kind) VALUES
      ('legacy-user', 'user', NULL),
      ('legacy-assistant', 'assistant', NULL);
  `);
  database.close();

  migrateDatabaseFile(dbPath);

  const readonly = new Database(dbPath, { readonly: true });
  try {
    assert.deepEqual(
      KindRowsSchema.parse(readonly.prepare('SELECT id, kind FROM chat_messages ORDER BY id DESC').all()),
      [
        { id: 'legacy-user', kind: 'user_text' },
        { id: 'legacy-assistant', kind: 'assistant_answer' },
      ],
    );
  } finally {
    readonly.close();
  }
});

test('v60 records running tool status and backfills historical tool calls as done', () => {
  const dbPath = path.join(createManagedTempDir('sk-v60-tool-status-'), 'runtime.sqlite');
  try {
    writeConfig(dbPath, getDefaultConfigObject());
    const database = getRuntimeDatabase(dbPath);
    database.exec('ALTER TABLE chat_messages DROP COLUMN tool_call_status;');
    const timestamp = '2026-01-01T00:00:00.000Z';
    database.prepare(`
      INSERT INTO chat_sessions (
        id, title, model_preset_id, model_preset_json, thinking_enabled,
        web_search_enabled, preset_id, mode, plan_repo_root, created_at_utc, updated_at_utc
      ) VALUES ('session-1', 'Session', 'default', '{}', 0, 1, 'chat', 'chat', '.', ?, ?)
    `).run(timestamp, timestamp);
    const insertMessage = database.prepare(`
      INSERT INTO chat_messages (
        session_id, id, role, kind, content,
        input_tokens_estimate, output_tokens_estimate, thinking_tokens,
        input_tokens_estimated, output_tokens_estimated, thinking_tokens_estimated,
        created_at_utc, compressed_into_summary, position
      ) VALUES ('session-1', ?, 'assistant', ?, 'content', 0, 0, 0, 1, 1, 1, ?, 0, ?)
    `);
    insertMessage.run('tool', 'assistant_tool_call', timestamp, 0);
    insertMessage.run('answer', 'assistant_answer', timestamp, 1);
    database.prepare('UPDATE runtime_schema SET version = 59 WHERE id = 1').run();
    closeRuntimeDatabase();

    migrateDatabaseFile(dbPath);

    const readonly = new Database(dbPath, { readonly: true });
    try {
      const rows = ToolStatusRowsSchema.parse(
        readonly.prepare('SELECT id, tool_call_status FROM chat_messages ORDER BY position').all(),
      );
      assert.deepEqual(rows, [
        { id: 'tool', tool_call_status: 'done' },
        { id: 'answer', tool_call_status: null },
      ]);
      const version = z.object({ version: z.number() }).parse(
        readonly.prepare('SELECT version FROM runtime_schema WHERE id = 1').get(),
      );
      assert.equal(version.version, CURRENT_SCHEMA_VERSION);
      assert.equal(CURRENT_SCHEMA_VERSION, 60);
    } finally {
      readonly.close();
    }
  } finally {
    closeRuntimeDatabase();
  }
});
