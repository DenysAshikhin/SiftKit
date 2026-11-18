import assert from 'node:assert/strict';
import { join } from 'node:path';
import test from 'node:test';
import { z } from 'zod';

import { closeAllRuntimeDatabases, CURRENT_SCHEMA_VERSION, getRuntimeDatabase, getSchemaVersion } from '../src/state/runtime-db.ts';
import { getChatSessionPath, readChatSessionFromPath, saveChatSessionMetadata } from '../src/state/chat-sessions.ts';
import { JsonObjectSchema } from '../src/lib/json-types.ts';
import { createTestChatSession } from './helpers/chat-sessions.ts';
import { createManagedTempDir } from './helpers/temp-dirs.ts';
import { openStoredRuntimeDatabase } from './helpers/stored-runtime-database.ts';

const SnapshotRowSchema = z.object({ model_preset_json: z.string() });

/** A schema-92 file whose one chat session snapshot is rewritten by `edit`. */
function seedSchema92(edit: (snapshot: z.infer<typeof JsonObjectSchema>) => string) {
  const root = join(createManagedTempDir('chat-preset-snapshots-'), '.siftkit');
  const session = createTestChatSession(root);
  saveChatSessionMetadata(root, session);
  const database = getRuntimeDatabase(join(root, 'runtime.sqlite'));
  const row = SnapshotRowSchema.parse(database.prepare('SELECT model_preset_json FROM chat_sessions WHERE id = ?').get(session.id));
  database.prepare('UPDATE chat_sessions SET model_preset_json = ? WHERE id = ?').run(edit(JsonObjectSchema.parse(JSON.parse(row.model_preset_json))), session.id);
  database.exec('UPDATE runtime_schema SET version = 92 WHERE id = 1');
  closeAllRuntimeDatabases();
  return { root, sessionId: session.id, dbPath: join(root, 'runtime.sqlite') };
}

test('the 92 to 93 upgrade gives chat session snapshots the preset fields added since they were stored', (t) => {
  t.after(closeAllRuntimeDatabases);
  const seeded = seedSchema92(({ SparseDraftHead: _head, CacheAuto: _auto, CacheContexts: _contexts, ...snapshot }) => JSON.stringify(snapshot));

  assert.equal(getSchemaVersion(getRuntimeDatabase(seeded.dbPath)), CURRENT_SCHEMA_VERSION);
  const preset = readChatSessionFromPath(getChatSessionPath(seeded.root, seeded.sessionId))?.modelPreset;
  assert.deepEqual([preset?.SparseDraftHead, preset?.CacheAuto, preset?.CacheContexts], [0, false, 1.1]);
});

test('the 92 to 93 upgrade keeps values a chat session snapshot already stores', (t) => {
  t.after(closeAllRuntimeDatabases);
  const seeded = seedSchema92((snapshot) => JSON.stringify({ ...snapshot, SparseDraftHead: 8192, CacheAuto: true, CacheContexts: 1.5 }));

  getRuntimeDatabase(seeded.dbPath);
  const preset = readChatSessionFromPath(getChatSessionPath(seeded.root, seeded.sessionId))?.modelPreset;
  assert.deepEqual([preset?.SparseDraftHead, preset?.CacheAuto, preset?.CacheContexts], [8192, true, 1.5]);
});

test('the 92 to 93 upgrade fails loudly on an unreadable snapshot and leaves the file at 92', (t) => {
  t.after(closeAllRuntimeDatabases);
  const seeded = seedSchema92(() => JSON.stringify(['not', 'a', 'preset']));

  assert.throws(() => getRuntimeDatabase(seeded.dbPath), /Chat session .* model preset snapshot is unreadable/u);
  const stored = openStoredRuntimeDatabase(seeded.dbPath);
  try {
    assert.equal(getSchemaVersion(stored), 92);
  } finally { stored.close(); }
});
