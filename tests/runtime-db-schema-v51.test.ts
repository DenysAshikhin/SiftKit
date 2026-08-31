import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import path from 'node:path';
import test from 'node:test';

import { getDefaultConfigObject } from '../src/config/defaults.js';
import { z } from '../src/lib/zod.js';
import { writeConfig } from '../src/status-server/config-store.js';
import { closeRuntimeDatabase, CURRENT_SCHEMA_VERSION, getRuntimeDatabase } from '../src/state/runtime-db.js';
import { createManagedTempDir } from './helpers/temp-dirs.js';

const ActivityRowsSchema = z.array(z.object({
  id: z.string(),
  tool_call_activity_kind: z.string().nullable(),
  tool_call_activity_subject_kind: z.string().nullable(),
  tool_call_activity_subject_value: z.string().nullable(),
}));

test('v51 adds activity kind and explicitly marks historical tool rows as command activity', () => {
  const dbPath = path.join(createManagedTempDir('sk-v51-tool-activity-'), 'runtime.sqlite');
  try {
    writeConfig(dbPath, getDefaultConfigObject());
    const database = getRuntimeDatabase(dbPath);
    database.exec('ALTER TABLE chat_messages DROP COLUMN tool_call_activity_kind;');
    const timestamp = '2026-01-01T00:00:00.000Z';
    database.prepare(`
      INSERT INTO chat_sessions (
        id, title, model_preset_id, model_preset_json, thinking_enabled,
        web_search_enabled, preset_id, mode, plan_repo_root, created_at_utc, updated_at_utc
      ) VALUES ('session-1', 'Session', 'default', '{}', 0, 1, NULL, 'chat', '.', ?, ?)
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
    database.prepare('UPDATE runtime_schema SET version = 50 WHERE id = 1').run();
    closeRuntimeDatabase();

    getRuntimeDatabase(dbPath);
    closeRuntimeDatabase();

    const readonly = new Database(dbPath, { readonly: true });
    try {
      const rows = ActivityRowsSchema.parse(
        readonly.prepare(`
          SELECT id, tool_call_activity_kind,
                 tool_call_activity_subject_kind,
                 tool_call_activity_subject_value
          FROM chat_messages ORDER BY position
        `).all(),
      );
      assert.deepEqual(rows, [
        {
          id: 'tool',
          tool_call_activity_kind: 'command',
          tool_call_activity_subject_kind: 'none',
          tool_call_activity_subject_value: null,
        },
        {
          id: 'answer',
          tool_call_activity_kind: null,
          tool_call_activity_subject_kind: null,
          tool_call_activity_subject_value: null,
        },
      ]);
      const version = z.object({ version: z.number() }).parse(
        readonly.prepare('SELECT version FROM runtime_schema WHERE id = 1').get(),
      );
      assert.equal(version.version, CURRENT_SCHEMA_VERSION);
      assert.equal(CURRENT_SCHEMA_VERSION, 54);
    } finally {
      readonly.close();
    }
  } finally {
    closeRuntimeDatabase();
  }
});
