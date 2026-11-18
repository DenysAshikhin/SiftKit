import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { z } from 'zod';

import { closeAllRuntimeDatabases, CURRENT_SCHEMA_VERSION, getRuntimeDatabase, getSchemaVersion } from '../src/state/runtime-db.ts';
import { upgradeEngineEvents } from '../src/state/schema-upgrades/engine-events.ts';
import { createManagedTempDir } from './helpers/temp-dirs.ts';

const NameRowsSchema = z.array(z.object({ name: z.string() }));

test('the 93 to 94 upgrade creates engine_events and its indexes, and repeating it is harmless', (t) => {
  t.after(closeAllRuntimeDatabases);
  const dbPath = path.join(createManagedTempDir('engine-events-upgrade-'), 'runtime.sqlite');
  getRuntimeDatabase(dbPath).exec('DROP TABLE engine_events; UPDATE runtime_schema SET version = 93 WHERE id = 1');
  closeAllRuntimeDatabases();

  const database = getRuntimeDatabase(dbPath);
  assert.equal(getSchemaVersion(database), CURRENT_SCHEMA_VERSION);
  const names = NameRowsSchema.parse(database.prepare(
    "SELECT name FROM sqlite_master WHERE tbl_name = 'engine_events' AND name NOT LIKE 'sqlite_%' ORDER BY name",
  ).all()).map((row) => row.name);
  assert.deepEqual(names, ['engine_events', 'idx_engine_events_occurred', 'idx_engine_events_run']);
  assert.doesNotThrow(() => upgradeEngineEvents(database));
});
