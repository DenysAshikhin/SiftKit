import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import path from 'node:path';
import test from 'node:test';

import { getDefaultConfigObject } from '../src/config/defaults.js';
import { z } from '../src/lib/zod.js';
import { writeConfig } from '../src/status-server/config-store.js';
import { closeRuntimeDatabase, CURRENT_SCHEMA_VERSION, getRuntimeDatabase } from '../src/state/runtime-db.js';
import { createManagedTempDir } from './helpers/temp-dirs.js';

const ColumnRowSchema = z.object({ name: z.string() });
const MaxTurnsRowSchema = z.object({ tool_call_max_turns: z.number().nullable() });

test('v55 renames the persisted turn cap back to its honest name', () => {
  const dbPath = path.join(createManagedTempDir('sk-v55-tool-max-turns-'), 'runtime.sqlite');
  try {
    writeConfig(dbPath, getDefaultConfigObject());
    const database = getRuntimeDatabase(dbPath);
    // Simulate a production v54 database: the column still carries the dishonest name.
    database.exec('ALTER TABLE chat_messages RENAME COLUMN tool_call_max_turns TO tool_call_limit;');
    const timestamp = '2026-01-01T00:00:00.000Z';
    database.prepare(`
      INSERT INTO chat_sessions (
        id, title, model_preset_id, model_preset_json, thinking_enabled,
        web_search_enabled, preset_id, mode, plan_repo_root, created_at_utc, updated_at_utc
      ) VALUES ('session-1', 'Session', 'default', '{}', 0, 1, 'chat', 'chat', '.', ?, ?)
    `).run(timestamp, timestamp);
    database.prepare(`
      INSERT INTO chat_messages (
        session_id, id, role, kind, content,
        input_tokens_estimate, output_tokens_estimate, thinking_tokens,
        input_tokens_estimated, output_tokens_estimated, thinking_tokens_estimated,
        tool_call_limit, created_at_utc, compressed_into_summary, position
      ) VALUES ('session-1', 'tool-1', 'assistant', 'assistant_tool_call', 'read', 0, 0, 0, 0, 0, 0, 45, ?, 0, 0)
    `).run(timestamp);
    database.prepare('UPDATE runtime_schema SET version = 54 WHERE id = 1').run();
    closeRuntimeDatabase();

    getRuntimeDatabase(dbPath);
    closeRuntimeDatabase();

    const readonly = new Database(dbPath, { readonly: true });
    try {
      const columns = z.array(ColumnRowSchema).parse(readonly.prepare('PRAGMA table_info(chat_messages)').all());
      assert.equal(columns.some((column) => column.name === 'tool_call_max_turns'), true);
      assert.equal(columns.some((column) => column.name === 'tool_call_limit'), false);
      const row = MaxTurnsRowSchema.parse(readonly.prepare('SELECT tool_call_max_turns FROM chat_messages').get());
      assert.equal(row.tool_call_max_turns, 45);
      const version = z.object({ version: z.number() }).parse(
        readonly.prepare('SELECT version FROM runtime_schema WHERE id = 1').get(),
      );
      assert.equal(version.version, CURRENT_SCHEMA_VERSION);
    } finally {
      readonly.close();
    }
  } finally {
    closeRuntimeDatabase();
  }
});