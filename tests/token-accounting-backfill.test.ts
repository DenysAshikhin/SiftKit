import assert from 'node:assert/strict';
import test from 'node:test';
import Database from 'better-sqlite3';

import { z } from '../src/lib/zod.js';
import { migrateChatMessagesToPerRowTokens } from '../src/state/migrations/app-config-migrations.js';

const TableInfoRowSchema = z.object({ name: z.string() });

function createLegacyDatabase() {
  const database = new Database(':memory:');
  database.exec(`
    CREATE TABLE chat_messages (
      session_id TEXT, id TEXT, kind TEXT, thinking_tokens INTEGER,
      output_tokens_estimate INTEGER, associated_tool_tokens INTEGER, position INTEGER
    );
  `);
  return database;
}

test('the answer row aggregate is zeroed when step rows survive', () => {
  const database = createLegacyDatabase();
  database.exec(`
    INSERT INTO chat_messages VALUES
      ('s1', 'm1', 'assistant_thinking', 120, 0, NULL, 0),
      ('s1', 'm2', 'assistant_thinking', 95, 0, NULL, 1),
      ('s1', 'm3', 'assistant_answer', 215, 60, 340, 2);
  `);
  migrateChatMessagesToPerRowTokens(database);
  const answer = database.prepare("SELECT thinking_tokens FROM chat_messages WHERE id = 'm3'").get();
  assert.deepEqual(answer, { thinking_tokens: 0 });
});

test('the aggregate moves to the last surviving thinking row when retention pruned the rest', () => {
  const database = createLegacyDatabase();
  database.exec(`
    INSERT INTO chat_messages VALUES
      ('s2', 'm1', 'assistant_thinking', 95, 0, NULL, 0),
      ('s2', 'm2', 'assistant_answer', 215, 60, 340, 1);
  `);
  migrateChatMessagesToPerRowTokens(database);
  const surviving = database.prepare("SELECT thinking_tokens FROM chat_messages WHERE id = 'm1'").get();
  const answer = database.prepare("SELECT thinking_tokens FROM chat_messages WHERE id = 'm2'").get();
  assert.deepEqual(surviving, { thinking_tokens: 215 });
  assert.deepEqual(answer, { thinking_tokens: 0 });
});

test('the associated_tool_tokens column is dropped', () => {
  const database = createLegacyDatabase();
  database.exec("INSERT INTO chat_messages VALUES ('s3', 'm1', 'assistant_answer', 0, 10, 500, 0);");
  migrateChatMessagesToPerRowTokens(database);
  const columns = z.array(TableInfoRowSchema).parse(
    database.prepare('PRAGMA table_info(chat_messages)').all(),
  );
  assert.equal(columns.some((column) => column.name === 'associated_tool_tokens'), false);
});