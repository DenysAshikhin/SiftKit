import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { z } from 'zod';

import { CURRENT_SCHEMA_VERSION, closeAllRuntimeDatabases, getRuntimeDatabase, getSchemaVersion } from '../src/state/runtime-db.ts';
import { saveChatSessionMetadata } from '../src/state/chat-sessions.ts';
import { JsonObjectSchema } from '../src/lib/json-types.ts';
import { readConfig, writeConfig } from '../src/status-server/config-store.ts';
import { createTestChatSession } from './helpers/chat-sessions.ts';
import { getDefaultServerConfig } from './helpers/mock-config.ts';
import { withRuntimeDatabaseConnection } from './helpers/runtime-database-probe.ts';
import { createManagedTempDir } from './helpers/temp-dirs.ts';

const SnapshotRowSchema = z.object({ model_preset_json: z.string() });

/** The default config as a schema-94 file stored it: presets without the RAM-disk fields, an engine without RamDisk. */
function seedSchema94(firstPresetId?: string): string {
  const dbPath = path.join(createManagedTempDir('siftkit-ram-disk-schema-'), 'runtime.sqlite');
  const config = getDefaultServerConfig();
  writeConfig(dbPath, config);
  closeAllRuntimeDatabases();
  const presets = config.Server.ModelPresets.Presets.map(({ RamDiskCache: _on, RamDiskCacheGiB: _gib, ...preset }, index) => (
    index === 0 && firstPresetId !== undefined ? { ...preset, id: firstPresetId } : preset));
  const { RamDisk: _ramDisk, ...engine } = config.Server.Engines.Exl3;
  withRuntimeDatabaseConnection(dbPath, (database) => {
    database.prepare('UPDATE app_config SET server_model_presets_json = ?, server_exl3_json = ? WHERE id = 1')
      .run(JSON.stringify(presets), JSON.stringify(engine));
    database.exec('UPDATE runtime_schema SET version = 94 WHERE id = 1');
  });
  return dbPath;
}

test('the 94 to 95 upgrade turns the RAM disk off on every stored preset and gives the engine its RamDisk setting', (t) => {
  t.after(closeAllRuntimeDatabases);
  const dbPath = seedSchema94();

  assert.equal(getSchemaVersion(getRuntimeDatabase(dbPath)), CURRENT_SCHEMA_VERSION);
  const config = readConfig(dbPath);
  assert.deepEqual(config.Server.ModelPresets.Presets.map((preset) => [preset.RamDiskCache, preset.RamDiskCacheGiB]),
    config.Server.ModelPresets.Presets.map(() => [false, 10]));
  assert.deepEqual(config.Server.Engines.Exl3.RamDisk, { ToolPath: null, DriveLetter: 'S' });
});

test('the 94 to 95 upgrade fails loudly on a stored preset id that cannot name a folder, and leaves the file at 94', (t) => {
  t.after(closeAllRuntimeDatabases);
  const dbPath = seedSchema94('Bad:Id');

  assert.throws(() => getRuntimeDatabase(dbPath), /Model preset id 'Bad:Id' must be lowercase words joined by dashes/u);
  assert.equal(withRuntimeDatabaseConnection(dbPath, (database) => getSchemaVersion(database)), 94);
});

test('the 94 to 95 upgrade adds the RAM-disk fields to chat session snapshots and keeps every value they store', (t) => {
  t.after(closeAllRuntimeDatabases);
  const root = path.join(createManagedTempDir('siftkit-ram-disk-snapshots-'), '.siftkit');
  const dbPath = path.join(root, 'runtime.sqlite');
  const session = createTestChatSession(root);
  saveChatSessionMetadata(root, session);
  const database = getRuntimeDatabase(dbPath);
  const row = SnapshotRowSchema.parse(database.prepare('SELECT model_preset_json FROM chat_sessions WHERE id = ?').get(session.id));
  const { RamDiskCache: _on, RamDiskCacheGiB: _gib, ...stored } = JsonObjectSchema.parse(JSON.parse(row.model_preset_json));
  database.prepare('UPDATE chat_sessions SET model_preset_json = ? WHERE id = ?').run(JSON.stringify(stored), session.id);
  database.exec('UPDATE runtime_schema SET version = 94 WHERE id = 1');
  closeAllRuntimeDatabases();

  const upgraded = getRuntimeDatabase(dbPath);
  const after = SnapshotRowSchema.parse(upgraded.prepare('SELECT model_preset_json FROM chat_sessions WHERE id = ?').get(session.id));
  assert.equal(after.model_preset_json, JSON.stringify({ ...stored, RamDiskCache: false, RamDiskCacheGiB: 10 }));
});
