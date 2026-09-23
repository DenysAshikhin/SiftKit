import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';

import { SiftPresetCollectionSchema } from '@siftkit/contracts';
import { z } from '../src/lib/zod.js';
import { CURRENT_SCHEMA_VERSION, closeAllRuntimeDatabases, getRuntimeDatabase, getSchemaVersion } from '../src/state/runtime-db.js';
import { writeConfig } from '../src/status-server/config-store.js';
import { JsonObjectSchema, type JsonObject } from '../src/lib/json-types.js';
import { getDefaultServerConfig } from './helpers/mock-config.js';
import { createManagedTempDir } from './helpers/temp-dirs.js';
import { openStoredRuntimeDatabase } from './helpers/stored-runtime-database.js';
import { withRuntimeDatabaseConnection } from './helpers/runtime-database-probe.js';

const PresetsJsonRowSchema = z.object({ presets_json: z.string() });
const ModelPresetsRowSchema = z.object({ server_model_presets_json: z.string() });
const VersionRowSchema = z.object({ version: z.number().int() });

const CURRENT_CATALOG = z.array(JsonObjectSchema).parse(JSON.parse(JSON.stringify(getDefaultServerConfig().Presets)));
const ORCHESTRATOR_BUILTIN = CURRENT_CATALOG.find((preset) => preset.id === 'orchestrator');
assert.ok(ORCHESTRATOR_BUILTIN);

/** The catalog a schema-76 build stored: no orchestrator field and no orchestrator built-in. */
const CATALOG_76: JsonObject[] = CURRENT_CATALOG
  .filter((preset) => preset.id !== 'orchestrator')
  .map(({ orchestrator: _future, ...historic }) => historic);
const CATALOG_74: JsonObject[] = CATALOG_76.map(({ modelPresetId: _future, ...historic }) => historic);

const CUSTOM_76: JsonObject = {
  id: 'custom-investigation', label: 'Custom Investigation', description: 'Custom preset.',
  presetKind: 'repo-search', operationMode: 'read-only', promptPrefix: '', allowedTools: ['read', 'grep'],
  surfaces: ['web'], useForSummary: false, builtin: false, deletable: true, includeAgentsMd: false,
  includeRepoFileListing: false, assistantMemory: false, autoloadFiles: [], repoRootRequired: true,
  maxTurns: 30, modelPresetId: null,
};

function rewind(version: number, presetsJson: string): string {
  const dbPath = path.join(createManagedTempDir(`siftkit-orchestrator-schema-${version}-`), 'runtime.sqlite');
  writeConfig(dbPath, getDefaultServerConfig());
  closeAllRuntimeDatabases();
  withRuntimeDatabaseConnection(dbPath, (database) => {
    database.prepare('UPDATE app_config SET presets_json = ? WHERE id = 1').run(presetsJson);
    database.exec('DROP TABLE orchestrator_events; DROP TABLE orchestrator_attempts; DROP TABLE orchestrator_runs;');
    database.prepare('UPDATE runtime_schema SET version = ? WHERE id = 1').run(version);
  });
  return dbPath;
}

function readStored(dbPath: string): { version: number; presetsJson: string } {
  const database = openStoredRuntimeDatabase(dbPath);
  try {
    return {
      version: VersionRowSchema.parse(database.prepare('SELECT version FROM runtime_schema WHERE id = 1').get()).version,
      presetsJson: PresetsJsonRowSchema.parse(database.prepare('SELECT presets_json FROM app_config WHERE id = 1').get()).presets_json,
    };
  } finally {
    database.close();
  }
}

test('a version 76 database upgrades to 77 adding null options and the protected orchestrator built-in', () => {
  const dbPath = rewind(76, JSON.stringify([...CATALOG_76, CUSTOM_76]));
  try {
    const before = openStoredRuntimeDatabase(dbPath);
    const modelPresetsJson = ModelPresetsRowSchema.parse(
      before.prepare('SELECT server_model_presets_json FROM app_config WHERE id = 1').get()).server_model_presets_json;
    before.close();

    const database = getRuntimeDatabase(dbPath);
    assert.equal(getSchemaVersion(database), CURRENT_SCHEMA_VERSION);
    const row = PresetsJsonRowSchema.parse(database.prepare('SELECT presets_json FROM app_config WHERE id = 1').get());
    assert.deepEqual(JSON.parse(row.presets_json), [
      ...[...CATALOG_76, CUSTOM_76].map((preset) => ({ ...preset, orchestrator: null })),
      ORCHESTRATOR_BUILTIN,
    ]);
    assert.doesNotThrow(() => SiftPresetCollectionSchema.parse(JSON.parse(row.presets_json)));
    assert.equal(ModelPresetsRowSchema.parse(
      database.prepare('SELECT server_model_presets_json FROM app_config WHERE id = 1').get()).server_model_presets_json, modelPresetsJson);
  } finally {
    closeAllRuntimeDatabases();
  }
});

test('the complete 74 to 77 chain yields the current catalog shape with every assignment preserved', () => {
  const dbPath = rewind(74, JSON.stringify(CATALOG_74));
  try {
    const database = getRuntimeDatabase(dbPath);
    const row = PresetsJsonRowSchema.parse(database.prepare('SELECT presets_json FROM app_config WHERE id = 1').get());
    assert.deepEqual(JSON.parse(row.presets_json), [
      ...CATALOG_74.map((preset) => ({ ...preset, modelPresetId: null, orchestrator: null })),
      ORCHESTRATOR_BUILTIN,
    ]);
  } finally {
    closeAllRuntimeDatabases();
  }
});

test('a custom preset already named orchestrator aborts the upgrade with a rename instruction and leaves 76', () => {
  const conflicting = JSON.stringify([...CATALOG_76, { ...CUSTOM_76, id: 'orchestrator' }]);
  const dbPath = rewind(76, conflicting);
  assert.throws(() => getRuntimeDatabase(dbPath), /Custom preset 'orchestrator' conflicts with the built-in orchestrator preset; rename it/u);
  closeAllRuntimeDatabases();
  assert.deepEqual(readStored(dbPath), { version: 76, presetsJson: conflicting });
});

test('a 76 record that already carries orchestrator options aborts the upgrade and leaves 76', () => {
  const stored = JSON.stringify([...CATALOG_76, { ...CUSTOM_76, orchestrator: null }]);
  const dbPath = rewind(76, stored);
  assert.throws(() => getRuntimeDatabase(dbPath));
  closeAllRuntimeDatabases();
  assert.deepEqual(readStored(dbPath), { version: 76, presetsJson: stored });
});

const TableSqlRowsSchema = z.array(z.object({ name: z.string(), sql: z.string() }));

function orchestratorTableSql(dbPath: string): Array<{ name: string; sql: string }> {
  return TableSqlRowsSchema.parse(getRuntimeDatabase(dbPath).prepare(
    "SELECT name, sql FROM sqlite_schema WHERE type = 'table' AND name LIKE 'orchestrator_%' ORDER BY name",
  ).all());
}

test('the 77 to 78 upgrade creates the same orchestrator run tables as a fresh database', () => {
  const freshPath = path.join(createManagedTempDir('siftkit-orchestrator-runs-fresh-'), 'runtime.sqlite');
  const upgradedPath = rewind(77, JSON.stringify(CURRENT_CATALOG));
  try {
    const fresh = orchestratorTableSql(freshPath);
    assert.deepEqual(fresh.map((row) => row.name), ['orchestrator_attempts', 'orchestrator_events', 'orchestrator_runs']);
    assert.deepEqual(orchestratorTableSql(upgradedPath), fresh);
  } finally {
    closeAllRuntimeDatabases();
  }
});
