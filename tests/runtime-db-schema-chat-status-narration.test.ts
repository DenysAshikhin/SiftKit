import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';

import { buildChatMessageId, buildChatRunMessageIdPrefix } from '@siftkit/contracts';
import { z } from '../src/lib/zod.js';
import { closeAllRuntimeDatabases, CURRENT_SCHEMA_VERSION, getRuntimeDatabase, getSchemaVersion } from '../src/state/runtime-db.js';
import { createManagedTempDir } from './helpers/temp-dirs.js';

const AT = '2026-09-22T10:00:00.000Z';
const PREFIX = buildChatRunMessageIdPrefix('9a1f6c2e-5d0b-4e47-8a55-2b7f0c1d3e90');
const HIDDEN_STATUS_ID = buildChatMessageId(PREFIX, { kind: 'narration', turn: 1 });
const PROMOTED_ID = buildChatMessageId(PREFIX, { kind: 'narration', turn: 2 });
const PROGRESS_ID = buildChatMessageId(PREFIX, { kind: 'progress' });

const KindRowsSchema = z.array(z.object({ id: z.string(), kind: z.string(), content: z.string() }));

/** A marker-75 database holding the rows a build that hid status updates on `tool_start` wrote. */
function seedMarker75(): string {
  const dbPath = path.join(createManagedTempDir('siftkit-runtime-schema-upgrade-75-status-'), 'runtime.sqlite');
  const database = getRuntimeDatabase(dbPath);
  database.exec(`
    INSERT INTO chat_sessions (id, title, model_preset_id, model_preset_json, thinking_enabled, web_search_enabled, preset_id, mode, plan_repo_root, created_at_utc, updated_at_utc)
      VALUES ('s1', 'Session', 'preset-a', '{}', 1, 0, 'chat', 'chat', 'C:/repo', '${AT}', '${AT}');
  `);
  const insert = database.prepare(`INSERT INTO chat_messages (session_id, id, role, kind, content, input_tokens_estimate, output_tokens_estimate,
    thinking_tokens, input_tokens_estimated, output_tokens_estimated, thinking_tokens_estimated, created_at_utc, compressed_into_summary, position)
    VALUES ('s1', ?, 'assistant', ?, ?, 0, 0, 0, 0, 0, 0, '${AT}', 0, ?)`);
  insert.run(HIDDEN_STATUS_ID, 'assistant_progress', 'Reading the config.', 0);
  insert.run(PROGRESS_ID, 'assistant_progress', 'Step 2 of 5', 1);
  insert.run(PROMOTED_ID, 'assistant_answer', 'Done.', 2);
  database.exec('UPDATE runtime_schema SET version = 75 WHERE id = 1');
  closeAllRuntimeDatabases();
  return dbPath;
}

test('the marker-75 upgrade restores hidden status updates to narration and leaves raw progress and answers alone', () => {
  const dbPath = seedMarker75();
  try {
    const database = getRuntimeDatabase(dbPath);
    assert.equal(getSchemaVersion(database), CURRENT_SCHEMA_VERSION);
    assert.equal(CURRENT_SCHEMA_VERSION, 76);
    const rows = KindRowsSchema.parse(database.prepare('SELECT id, kind, content FROM chat_messages ORDER BY position').all());
    assert.deepEqual(rows, [
      { id: HIDDEN_STATUS_ID, kind: 'assistant_narration', content: 'Reading the config.' },
      { id: PROGRESS_ID, kind: 'assistant_progress', content: 'Step 2 of 5' },
      { id: PROMOTED_ID, kind: 'assistant_answer', content: 'Done.' },
    ]);
  } finally {
    closeAllRuntimeDatabases();
  }
});
