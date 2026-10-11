import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';

import { SiftPresetCollectionSchema, SiftPresetSchema } from '@siftkit/contracts';
import { JsonObjectSchema } from '../src/lib/json-types.ts';
import { z } from '../src/lib/zod.ts';
import { CURRENT_SCHEMA_VERSION, closeAllRuntimeDatabases, getRuntimeDatabase, getSchemaVersion } from '../src/state/runtime-db.ts';
import { writeConfig } from '../src/status-server/config-store.ts';
import { getDefaultServerConfig } from './helpers/mock-config.ts';
import { withRuntimeDatabaseConnection } from './helpers/runtime-database-probe.ts';
import { createManagedTempDir } from './helpers/temp-dirs.ts';

const PresetsJsonRowSchema = z.object({ presets_json: z.string() });
const CURRENT_CATALOG = z.array(JsonObjectSchema).parse(JSON.parse(JSON.stringify(getDefaultServerConfig().Presets)));

test('the 79 to 80 upgrade removes the orchestrator options from every stored preset', () => {
  const catalog79 = CURRENT_CATALOG.map((preset) => ({ ...preset,
    orchestrator: preset.presetKind === 'orchestrator' ? { maxSubagents: 3 } : null }));
  const dbPath = path.join(createManagedTempDir('siftkit-orchestrator-options-79-'), 'runtime.sqlite');
  writeConfig(dbPath, getDefaultServerConfig());
  closeAllRuntimeDatabases();
  withRuntimeDatabaseConnection(dbPath, (database) => {
    database.prepare('UPDATE app_config SET presets_json = ? WHERE id = 1').run(JSON.stringify(catalog79));
    database.prepare('UPDATE runtime_schema SET version = 79 WHERE id = 1').run();
  });
  try {
    const database = getRuntimeDatabase(dbPath);
    assert.equal(getSchemaVersion(database), CURRENT_SCHEMA_VERSION);
    const stored = z.array(JsonObjectSchema).parse(JSON.parse(
      PresetsJsonRowSchema.parse(database.prepare('SELECT presets_json FROM app_config WHERE id = 1').get()).presets_json));
    assert.deepEqual(stored, CURRENT_CATALOG);
    assert.doesNotThrow(() => SiftPresetCollectionSchema.parse(stored));
  } finally {
    closeAllRuntimeDatabases();
  }
});

test('a preset that still carries orchestrator options is rejected', () => {
  const orchestrator = getDefaultServerConfig().Presets.find((preset) => preset.id === 'orchestrator');
  assert.ok(orchestrator);
  assert.equal(SiftPresetSchema.safeParse({ ...orchestrator, orchestrator: { maxSubagents: 1 } }).success, false);
});
