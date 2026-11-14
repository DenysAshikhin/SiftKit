import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';

import { CURRENT_SCHEMA_VERSION, closeAllRuntimeDatabases, getRuntimeDatabase, getSchemaVersion } from '../src/state/runtime-db.ts';
import { readConfig, writeConfig } from '../src/status-server/config-store.ts';
import { getDefaultServerConfig } from './helpers/mock-config.ts';
import { withRuntimeDatabaseConnection } from './helpers/runtime-database-probe.ts';
import { createManagedTempDir } from './helpers/temp-dirs.ts';

/** The default presets as a schema-90 file stored them: no SparseDraftHead. */
function schema90Presets() {
  return getDefaultServerConfig().Server.ModelPresets.Presets.map(({ SparseDraftHead: _added, ...preset }) => preset);
}

/** A schema-90 file whose stored model presets are exactly `storedPresetsJson`. */
function seedSchema90(storedPresetsJson: string): string {
  const dbPath = path.join(createManagedTempDir('siftkit-sparse-draft-head-'), 'runtime.sqlite');
  writeConfig(dbPath, getDefaultServerConfig());
  closeAllRuntimeDatabases();
  withRuntimeDatabaseConnection(dbPath, (database) => {
    database.prepare('UPDATE app_config SET server_model_presets_json = ? WHERE id = 1').run(storedPresetsJson);
    database.exec('UPDATE runtime_schema SET version = 90 WHERE id = 1');
  });
  return dbPath;
}

test('the 90 to 91 upgrade gives every stored model preset a full draft head', (t) => {
  t.after(closeAllRuntimeDatabases);
  const dbPath = seedSchema90(JSON.stringify(schema90Presets()));

  assert.equal(getSchemaVersion(getRuntimeDatabase(dbPath)), CURRENT_SCHEMA_VERSION);
  const presets = readConfig(dbPath).Server.ModelPresets.Presets;
  assert.ok(presets.length > 0);
  assert.deepEqual(presets.map((preset) => preset.SparseDraftHead), presets.map(() => 0));
});

test('the 90 to 91 upgrade keeps a column count already stored on a preset', (t) => {
  t.after(closeAllRuntimeDatabases);
  const dbPath = seedSchema90(JSON.stringify(schema90Presets().map((preset) => ({ ...preset, SparseDraftHead: 8192 }))));

  getRuntimeDatabase(dbPath);
  const presets = readConfig(dbPath).Server.ModelPresets.Presets;
  assert.deepEqual(presets.map((preset) => preset.SparseDraftHead), presets.map(() => 8192));
});

test('the 90 to 91 upgrade fails loudly on unreadable stored model presets and leaves the file at 90', (t) => {
  t.after(closeAllRuntimeDatabases);
  const dbPath = seedSchema90(JSON.stringify({ not: 'a preset list' }));

  assert.throws(() => getRuntimeDatabase(dbPath), /Stored model presets are unreadable/u);
  assert.equal(withRuntimeDatabaseConnection(dbPath, (database) => getSchemaVersion(database)), 90);
});
