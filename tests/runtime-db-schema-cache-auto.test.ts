import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';

import { CURRENT_SCHEMA_VERSION, closeAllRuntimeDatabases, getRuntimeDatabase, getSchemaVersion } from '../src/state/runtime-db.ts';
import { readConfig, writeConfig } from '../src/status-server/config-store.ts';
import { getDefaultServerConfig } from './helpers/mock-config.ts';
import { withRuntimeDatabaseConnection } from './helpers/runtime-database-probe.ts';
import { createManagedTempDir } from './helpers/temp-dirs.ts';

/** The default presets as a schema-91 file stored them: no CacheAuto or CacheContexts. */
function schema91Presets() {
  return getDefaultServerConfig().Server.ModelPresets.Presets.map(({ CacheAuto: _auto, CacheContexts: _contexts, ...preset }) => preset);
}

/** A schema-91 file whose stored model presets are exactly `storedPresetsJson`. */
function seedSchema91(storedPresetsJson: string): string {
  const dbPath = path.join(createManagedTempDir('siftkit-cache-auto-'), 'runtime.sqlite');
  writeConfig(dbPath, getDefaultServerConfig());
  closeAllRuntimeDatabases();
  withRuntimeDatabaseConnection(dbPath, (database) => {
    database.prepare('UPDATE app_config SET server_model_presets_json = ? WHERE id = 1').run(storedPresetsJson);
    database.exec('UPDATE runtime_schema SET version = 91 WHERE id = 1');
  });
  return dbPath;
}

test('the 91 to 92 upgrade keeps every stored model preset on its manual RAM sizes', (t) => {
  t.after(closeAllRuntimeDatabases);
  const dbPath = seedSchema91(JSON.stringify(schema91Presets()));

  assert.equal(getSchemaVersion(getRuntimeDatabase(dbPath)), CURRENT_SCHEMA_VERSION);
  const presets = readConfig(dbPath).Server.ModelPresets.Presets;
  assert.ok(presets.length > 0);
  assert.deepEqual(presets.map((preset) => [preset.CacheAuto, preset.CacheContexts]), presets.map(() => [false, 1.1]));
});

test('the 91 to 92 upgrade keeps auto sizing already stored on a preset', (t) => {
  t.after(closeAllRuntimeDatabases);
  const dbPath = seedSchema91(JSON.stringify(schema91Presets().map((preset) => ({ ...preset, CacheAuto: true, CacheContexts: 1.5 }))));

  getRuntimeDatabase(dbPath);
  const presets = readConfig(dbPath).Server.ModelPresets.Presets;
  assert.deepEqual(presets.map((preset) => [preset.CacheAuto, preset.CacheContexts]), presets.map(() => [true, 1.5]));
});

test('the 91 to 92 upgrade fails loudly on unreadable stored model presets and leaves the file at 91', (t) => {
  t.after(closeAllRuntimeDatabases);
  const dbPath = seedSchema91(JSON.stringify({ not: 'a preset list' }));

  assert.throws(() => getRuntimeDatabase(dbPath), /Stored model presets are unreadable/u);
  assert.equal(withRuntimeDatabaseConnection(dbPath, (database) => getSchemaVersion(database)), 91);
});
