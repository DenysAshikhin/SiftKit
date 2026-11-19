import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';

import { CURRENT_SCHEMA_VERSION, closeAllRuntimeDatabases, getRuntimeDatabase, getSchemaVersion } from '../src/state/runtime-db.ts';
import { readConfig, writeConfig } from '../src/status-server/config-store.ts';
import { getDefaultServerConfig } from './helpers/mock-config.ts';
import { withRuntimeDatabaseConnection } from './helpers/runtime-database-probe.ts';
import { createManagedTempDir } from './helpers/temp-dirs.ts';

/** A config file at `version` whose exl3 engine stores the aim_ll path setting that SiftKit's own copy replaced. */
function seedToolPath(version: number, ramDisk: Record<string, string | null>): string {
  const dbPath = path.join(createManagedTempDir('siftkit-ram-disk-tool-schema-'), 'runtime.sqlite');
  const config = getDefaultServerConfig();
  writeConfig(dbPath, config);
  closeAllRuntimeDatabases();
  withRuntimeDatabaseConnection(dbPath, (database) => {
    database.prepare('UPDATE app_config SET server_exl3_json = ? WHERE id = 1')
      .run(JSON.stringify({ ...config.Server.Engines.Exl3, RamDisk: ramDisk }));
    database.exec(`UPDATE runtime_schema SET version = ${String(version)} WHERE id = 1`);
  });
  return dbPath;
}

test('the 96 to 97 upgrade drops the aim_ll path setting and keeps the drive letter', (t) => {
  t.after(closeAllRuntimeDatabases);
  const dbPath = seedToolPath(96, { ToolPath: 'C:\\aim\\aim_ll.exe', DriveLetter: 'T' });

  assert.equal(getSchemaVersion(getRuntimeDatabase(dbPath)), CURRENT_SCHEMA_VERSION);
  assert.deepEqual(readConfig(dbPath).Server.Engines.Exl3.RamDisk, { DriveLetter: 'T' });
});

test('a file the 94 to 95 upgrade gave a null aim_ll path reaches the current schema without it', (t) => {
  t.after(closeAllRuntimeDatabases);
  const dbPath = seedToolPath(95, { ToolPath: null, DriveLetter: 'S' });

  assert.equal(getSchemaVersion(getRuntimeDatabase(dbPath)), CURRENT_SCHEMA_VERSION);
  assert.deepEqual(readConfig(dbPath).Server.Engines.Exl3.RamDisk, { DriveLetter: 'S' });
});
