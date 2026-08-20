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
const PromptTokenRowsSchema = z.array(z.object({
  id: z.string(),
  tool_call_prompt_token_count: z.number().nullable(),
}));

function tempDbPath(prefix: string): string {
  return path.join(createManagedTempDir(prefix), 'runtime.sqlite');
}

// Pre-v48 builds stamped the run-total prompt tokens onto every tool bubble.
function seedStampedPromptTokenDb(dbPath: string): void {
  writeConfig(dbPath, getDefaultConfigObject());
  const database = getRuntimeDatabase(dbPath);
  const timestamp = '2026-01-01T00:00:00.000Z';
  database.prepare(`
    INSERT INTO chat_sessions (
      id, title, model_preset_id, model_preset_json, thinking_enabled,
      web_search_enabled, preset_id, mode, plan_repo_root, condensed_summary,
      created_at_utc, updated_at_utc
    ) VALUES ('session-1', 'Session', 'default', '{}', 0, 1, NULL, 'chat', '.', '', ?, ?)
  `).run(timestamp, timestamp);
  const insertMessage = database.prepare(`
    INSERT INTO chat_messages (
      session_id, id, role, content,
      input_tokens_estimate, output_tokens_estimate, thinking_tokens,
      input_tokens_estimated, output_tokens_estimated, thinking_tokens_estimated,
      tool_call_prompt_token_count, created_at_utc, compressed_into_summary, position
    ) VALUES ('session-1', ?, 'assistant', 'tool', 0, 0, 0, 1, 1, 1, ?, ?, 0, ?)
  `);
  insertMessage.run('tool-1', 207406, timestamp, 0);
  insertMessage.run('tool-2', 207406, timestamp, 1);
  insertMessage.run('tool-3', null, timestamp, 2);
  database.prepare('UPDATE runtime_schema SET version = 47 WHERE id = 1').run();
  closeRuntimeDatabase();
}

function readPromptTokenCounts(dbPath: string): (number | null)[] {
  const database = new Database(dbPath, { readonly: true });
  try {
    return PromptTokenRowsSchema.parse(
      database.prepare('SELECT id, tool_call_prompt_token_count FROM chat_messages ORDER BY position').all(),
    ).map((row) => row.tool_call_prompt_token_count);
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

test('v48 nulls stamped run-total prompt token counts on pre-fix tool rows', () => {
  const dbPath = tempDbPath('sk-v48-prompt-tokens-');
  try {
    seedStampedPromptTokenDb(dbPath);

    getRuntimeDatabase(dbPath);
    closeRuntimeDatabase();

    assert.deepEqual(readPromptTokenCounts(dbPath), [null, null, null]);
    assert.equal(readSchemaVersion(dbPath), CURRENT_SCHEMA_VERSION);
  } finally {
    closeRuntimeDatabase();
  }
});

test('v48 tolerates a chat_messages table that predates the prompt-token column', () => {
  const dbPath = tempDbPath('sk-v48-missing-column-');
  try {
    writeConfig(dbPath, getDefaultConfigObject());
    const database = getRuntimeDatabase(dbPath);
    database.exec('ALTER TABLE chat_messages DROP COLUMN tool_call_prompt_token_count;');
    database.prepare('UPDATE runtime_schema SET version = 47 WHERE id = 1').run();
    closeRuntimeDatabase();

    getRuntimeDatabase(dbPath);
    closeRuntimeDatabase();

    assert.deepEqual(readPromptTokenCounts(dbPath), []);
    assert.equal(readSchemaVersion(dbPath), CURRENT_SCHEMA_VERSION);
  } finally {
    closeRuntimeDatabase();
  }
});
