import assert from 'node:assert/strict';
import { join } from 'node:path';
import test from 'node:test';
import { z } from 'zod';
import { closeAllRuntimeDatabases, CURRENT_SCHEMA_VERSION, getRuntimeDatabase, getSchemaVersion } from '../src/state/runtime-db.ts';
import { getChatSessionPath, readChatSessionFromPath, saveChatSessionMetadata } from '../src/state/chat-sessions.ts';
import { createTestChatSession } from './helpers/chat-sessions.ts';
import { createManagedTempDir } from './helpers/temp-dirs.ts';
import { beginRepoAgentTestRun } from './helpers/chat-run-recorder.ts';
import { JsonObjectSchema } from '../src/lib/json-types.ts';
import { digestStableJson } from '../src/lib/json-digest.ts';
import { ChatJournalStore } from '../src/state/chat-journal.ts';
import { openStoredRuntimeDatabase } from './helpers/stored-runtime-database.ts';

function seedImplicitRunSelection(corruptDigest = false, explicitChoice?: string) {
  const { root, database, recorder } = beginRepoAgentTestRun('chat-model-selection-settings-');
  const row = z.object({ body_json: z.string() }).parse(database.prepare('SELECT body_json FROM chat_run_events WHERE operation_id = ? AND sequence = 1').get(recorder.operationId));
  const body = JsonObjectSchema.parse(JSON.parse(row.body_json));
  const settings = JsonObjectSchema.parse(body.settings);
  if (explicitChoice === undefined) delete settings.modelPresetOverrideId;
  else settings.modelPresetOverrideId = explicitChoice;
  body.settings = settings;
  database.prepare('UPDATE chat_runs SET effective_settings_json = ? WHERE operation_id = ?').run(JSON.stringify(settings), recorder.operationId);
  database.prepare('UPDATE chat_run_events SET body_json = ?, payload_digest = ? WHERE operation_id = ? AND sequence = 1')
    .run(JSON.stringify(body), corruptDigest ? 'corrupt' : digestStableJson(body), recorder.operationId);
  database.exec('UPDATE runtime_schema SET version = 81 WHERE id = 1');
  closeAllRuntimeDatabases();
  return { path: join(root, 'runtime.sqlite'), operationId: recorder.operationId };
}

test('schema 81 migrates implicit run choices to explicit null without changing journal identity', (t) => {
  t.after(closeAllRuntimeDatabases);
  const seeded = seedImplicitRunSelection();
  const database = getRuntimeDatabase(seeded.path);
  const store = new ChatJournalStore(database);
  assert.equal(store.readRun(seeded.operationId)?.settings?.modelPresetOverrideId, null);
  const event = Array.from(store.readAll(seeded.operationId))[0];
  assert.ok(event && event.event.kind === 'run_started');
  assert.equal(event.event.settings.modelPresetOverrideId, null);
  assert.equal(event.operationId, seeded.operationId);
  assert.equal(event.sequence, 1);
  assert.equal(getSchemaVersion(database), CURRENT_SCHEMA_VERSION);
});

test('schema 81 refuses a corrupt journal digest instead of laundering it during selection migration', (t) => {
  t.after(closeAllRuntimeDatabases);
  const seeded = seedImplicitRunSelection(true);
  assert.throws(() => getRuntimeDatabase(seeded.path), /corrupt payload digest/u);
  const stored = openStoredRuntimeDatabase(seeded.path);
  try {
    assert.equal(getSchemaVersion(stored), 81);
    const row = z.object({ effective_settings_json: z.string() }).parse(stored.prepare('SELECT effective_settings_json FROM chat_runs WHERE operation_id = ?').get(seeded.operationId));
    assert.equal(Object.hasOwn(JsonObjectSchema.parse(JSON.parse(row.effective_settings_json)), 'modelPresetOverrideId'), false);
  } finally { stored.close(); }
});

test('schema 81 preserves an explicit model choice and its journal hash', (t) => {
  t.after(closeAllRuntimeDatabases);
  const seeded = seedImplicitRunSelection(false, 'chosen-model');
  const before = openStoredRuntimeDatabase(seeded.path);
  const rowSchema = z.object({ body_json: z.string(), payload_digest: z.string() });
  const original = rowSchema.parse(before.prepare('SELECT body_json, payload_digest FROM chat_run_events WHERE operation_id = ?').get(seeded.operationId));
  before.close();
  const migrated = getRuntimeDatabase(seeded.path);
  assert.equal(new ChatJournalStore(migrated).readRun(seeded.operationId)?.settings?.modelPresetOverrideId, 'chosen-model');
  assert.deepEqual(rowSchema.parse(migrated.prepare('SELECT body_json, payload_digest FROM chat_run_events WHERE operation_id = ?').get(seeded.operationId)), original);
});

test('schema 80 adds an inherited model choice while preserving the stored session', (t) => {
  t.after(closeAllRuntimeDatabases);
  const root = join(createManagedTempDir('chat-model-selection-schema-'), '.siftkit');
  const session = createTestChatSession(root);
  saveChatSessionMetadata(root, session);
  const dbPath = join(root, 'runtime.sqlite');
  const current = getRuntimeDatabase(dbPath);
  current.exec('ALTER TABLE chat_sessions DROP COLUMN model_preset_override_id; UPDATE runtime_schema SET version = 80 WHERE id = 1');
  closeAllRuntimeDatabases();

  const upgraded = getRuntimeDatabase(dbPath);
  assert.equal(getSchemaVersion(upgraded), CURRENT_SCHEMA_VERSION);
  const loaded = readChatSessionFromPath(getChatSessionPath(root, session.id));
  assert.ok(loaded);
  assert.equal(loaded.modelPresetOverrideId, null);
  assert.equal(loaded.title, session.title);
  assert.deepEqual(loaded.modelPreset, session.modelPreset);
  saveChatSessionMetadata(root, { ...loaded, modelPresetOverrideId: 'chosen-model' });
  closeAllRuntimeDatabases();
  assert.equal(readChatSessionFromPath(getChatSessionPath(root, session.id))?.modelPresetOverrideId, 'chosen-model');
  const columns = z.array(z.object({ name: z.string() })).parse(getRuntimeDatabase(dbPath).prepare('PRAGMA table_info(chat_sessions)').all());
  assert.equal(columns.filter(column => column.name === 'model_preset_override_id').length, 1);
});
