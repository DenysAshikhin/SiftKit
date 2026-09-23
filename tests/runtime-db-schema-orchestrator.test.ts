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
import { ORCHESTRATOR_RUNS_78_SQL } from '../src/state/schema-upgrades/orchestrator-runs.js';
import { canonicalRepositoryKey } from '../src/lib/repository-key.js';

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

const ColumnRowsSchema = z.array(z.object({ name: z.string(), type: z.string(), notnull: z.number(), pk: z.number() }).loose());
const IndexRowsSchema = z.array(z.object({ name: z.string(), sql: z.string().nullable() }));

function orchestratorSchema(dbPath: string) {
  const database = getRuntimeDatabase(dbPath);
  const tables = ['orchestrator_attempts', 'orchestrator_events', 'orchestrator_runs'];
  return {
    columns: tables.map((table) => ColumnRowsSchema.parse(database.prepare(`PRAGMA table_info(${table})`).all())
      .map(({ name, type, notnull, pk }) => ({ table, name, type, notnull, pk }))),
    indexes: IndexRowsSchema.parse(database.prepare(
      "SELECT name, sql FROM sqlite_schema WHERE type = 'index' AND tbl_name LIKE 'orchestrator_%' ORDER BY name",
    ).all()),
  };
}

test('the upgrade chain from 77 creates the same orchestrator run tables as a fresh database', () => {
  const freshPath = path.join(createManagedTempDir('siftkit-orchestrator-runs-fresh-'), 'runtime.sqlite');
  const upgradedPath = rewind(77, JSON.stringify(CURRENT_CATALOG));
  try {
    const fresh = orchestratorSchema(freshPath);
    assert.ok(fresh.columns.flat().some((column) => column.table === 'orchestrator_runs' && column.name === 'repo_key'));
    assert.deepEqual(orchestratorSchema(upgradedPath), fresh);
  } finally {
    closeAllRuntimeDatabases();
  }
});

const RepoKeyRowsSchema = z.array(z.object({ run_id: z.string(), repo_key: z.string().nullable() }));

test('the 78 to 79 upgrade keys stored runs by repository identity and leaves vanished repositories unkeyed', () => {
  const repo = createManagedTempDir('siftkit-orchestrator-key-repo-');
  const dbPath = rewind(77, JSON.stringify(CURRENT_CATALOG));
  withRuntimeDatabaseConnection(dbPath, (database) => {
    database.exec(ORCHESTRATOR_RUNS_78_SQL);
    const insert = database.prepare(`INSERT INTO orchestrator_runs
      (run_id, submission_id, request_digest, revision, phase, state_json, created_at_utc, updated_at_utc) VALUES (?, ?, 'd', 0, 'failed', ?, 'a', 'a')`);
    insert.run('present', 's1', JSON.stringify({ request: { repoRoot: `${repo}${path.sep}` } }));
    insert.run('vanished', 's2', JSON.stringify({ request: { repoRoot: path.join(repo, 'gone') } }));
    database.prepare('UPDATE runtime_schema SET version = 78 WHERE id = 1').run();
  });
  try {
    const rows = RepoKeyRowsSchema.parse(getRuntimeDatabase(dbPath).prepare('SELECT run_id, repo_key FROM orchestrator_runs ORDER BY run_id').all());
    assert.deepEqual(rows, [{ run_id: 'present', repo_key: canonicalRepositoryKey(repo) }, { run_id: 'vanished', repo_key: null }]);
  } finally {
    closeAllRuntimeDatabases();
  }
});
