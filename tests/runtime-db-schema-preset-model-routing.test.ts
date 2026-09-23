import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';

import { SiftPresetCollectionSchema } from '@siftkit/contracts';
import { z } from '../src/lib/zod.js';
import {
  CURRENT_SCHEMA_VERSION,
  closeAllRuntimeDatabases,
  getRuntimeDatabase,
  getSchemaVersion,
} from '../src/state/runtime-db.js';
import { writeConfig } from '../src/status-server/config-store.js';
import { getDefaultServerConfig } from './helpers/mock-config.js';
import { createManagedTempDir } from './helpers/temp-dirs.js';
import { JsonObjectSchema, type JsonObject } from '../src/lib/json-types.js';
import { openStoredRuntimeDatabase } from './helpers/stored-runtime-database.js';
import { withRuntimeDatabaseConnection } from './helpers/runtime-database-probe.js';

const PresetsJsonRowSchema = z.object({ presets_json: z.string() });
const ConfigColumnsRowSchema = z.object({
  server_model_presets_json: z.string(),
  assistant_json: z.string(),
});
const CatalogRowSchema = z.object({
  presets_json: z.string(),
  server_model_presets_json: z.string(),
  assistant_json: z.string(),
});
const VersionRowSchema = z.object({ version: z.number().int() });
const RunLogPresetRowSchema = z.object({ operation_preset_json: z.string().nullable() });

/** A custom operation preset in the exact shape schema 74 stored, without modelPresetId. */
const CUSTOM_PRESET_74: JsonObject = {
  id: 'custom-investigation',
  label: 'Custom Investigation',
  description: 'Custom preset created before model routing.',
  presetKind: 'repo-search',
  operationMode: 'read-only',
  promptPrefix: '',
  allowedTools: ['read', 'grep'],
  surfaces: ['web'],
  useForSummary: false,
  builtin: false,
  deletable: true,
  includeAgentsMd: false,
  includeRepoFileListing: false,
  assistantMemory: false,
  autoloadFiles: [],
  repoRootRequired: true,
  maxTurns: 30,
};

function tempDbPath(prefix: string): string {
  return path.join(createManagedTempDir(prefix), 'runtime.sqlite');
}

function readVersion(dbPath: string): number {
  const database = openStoredRuntimeDatabase(dbPath);
  try {
    return VersionRowSchema.parse(
      database.prepare('SELECT version FROM runtime_schema WHERE id = 1').get(),
    ).version;
  } finally {
    database.close();
  }
}

/** The default operation catalog as plain JSON objects, the way a 75 build stores it. */
function currentBuiltinCatalog(): JsonObject[] {
  return z.array(JsonObjectSchema).parse(JSON.parse(JSON.stringify(getDefaultServerConfig().Presets)));
}

/** Drops later fields and built-ins so the stored catalog matches what a 74 build wrote. */
function historicCatalogFromCurrent(presetsJson: string): JsonObject[] {
  const catalog = z.array(JsonObjectSchema).parse(JSON.parse(presetsJson));
  return catalog.filter((preset) => preset.id !== 'orchestrator').map((preset) => {
    const { modelPresetId: _modelPresetId, orchestrator: _orchestrator, ...historic } = preset;
    return historic;
  });
}

/** Later upgrades in the chain: 76 -> 77 adds orchestrator options and its built-in. */
const ORCHESTRATOR_BUILTIN = currentBuiltinCatalog().find((preset) => preset.id === 'orchestrator');
assert.ok(ORCHESTRATOR_BUILTIN);

const HISTORIC_BUILTIN_CATALOG = historicCatalogFromCurrent(JSON.stringify(currentBuiltinCatalog()));
const HISTORIC_REPO_SEARCH = HISTORIC_BUILTIN_CATALOG.find((preset) => preset.id === 'repo-search');
assert.ok(HISTORIC_REPO_SEARCH);

// Seed schema-74 config and historical run evidence whose bytes must survive the upgrade.
function rewindToVersion74(
  dbPath: string,
  presetsJson = JSON.stringify([...HISTORIC_BUILTIN_CATALOG, CUSTOM_PRESET_74]),
): void {
  writeConfig(dbPath, getDefaultServerConfig());
  closeAllRuntimeDatabases();
  withRuntimeDatabaseConnection(dbPath, (database) => {
    const row = PresetsJsonRowSchema.parse(
      database.prepare('SELECT presets_json FROM app_config WHERE id = 1').get(),
    );
    const historic = historicCatalogFromCurrent(row.presets_json);
    assert.deepEqual(historic, HISTORIC_BUILTIN_CATALOG);
    database.prepare('UPDATE app_config SET presets_json = ? WHERE id = 1')
      .run(presetsJson);
    database.prepare(`
      INSERT INTO run_logs (
        run_id, request_id, run_kind, run_group, operation_type, operation_preset_id,
        model_preset_id, operation_preset_json, terminal_state, title, flushed_at_utc
      ) VALUES (?, ?, 'repo_search', 'repo_search', 'repo-search', 'repo-search', 'default', ?, 'completed', 'Historical run', '2026-09-01T00:00:00.000Z')
    `).run('run-1', 'request-1', JSON.stringify(HISTORIC_REPO_SEARCH));
    database.exec('DROP TABLE orchestrator_events; DROP TABLE orchestrator_attempts; DROP TABLE orchestrator_runs; UPDATE runtime_schema SET version = 74 WHERE id = 1;');
  });
}

test('a version 74 database upgrades to 75 adding only modelPresetId null to every operation preset', () => {
  const dbPath = tempDbPath('siftkit-preset-model-routing-upgrade-74-');
  try {
    // Seed and snapshot the untouched config columns before rewinding to 74.
    writeConfig(dbPath, getDefaultServerConfig());
    closeAllRuntimeDatabases();
    const seeded = openStoredRuntimeDatabase(dbPath);
    let preservedModelPresetsJson = '';
    let preservedAssistantJson = '';
    try {
      const row = ConfigColumnsRowSchema.parse(
        seeded.prepare('SELECT server_model_presets_json, assistant_json FROM app_config WHERE id = 1').get(),
      );
      preservedModelPresetsJson = row.server_model_presets_json;
      preservedAssistantJson = row.assistant_json;
    } finally {
      seeded.close();
    }
    rewindToVersion74(dbPath);

    const upgraded = getRuntimeDatabase(dbPath);
    assert.equal(getSchemaVersion(upgraded), CURRENT_SCHEMA_VERSION);

    const upgradedRow = CatalogRowSchema.parse(
      upgraded.prepare('SELECT presets_json, server_model_presets_json, assistant_json FROM app_config WHERE id = 1').get(),
    );
    // Other config columns are byte-preserved.
    assert.equal(upgradedRow.server_model_presets_json, preservedModelPresetsJson);
    assert.equal(upgradedRow.assistant_json, preservedAssistantJson);

    // Historical run evidence is byte-preserved.
    const runRow = RunLogPresetRowSchema.parse(
      upgraded.prepare('SELECT operation_preset_json FROM run_logs WHERE run_id = ?').get('run-1'),
    );
    assert.equal(runRow.operation_preset_json, JSON.stringify(HISTORIC_REPO_SEARCH));

    // Every record received exactly modelPresetId: null on top of the historical layout.
    const expected = [...[...HISTORIC_BUILTIN_CATALOG, CUSTOM_PRESET_74]
      .map((preset) => ({ ...preset, modelPresetId: null, orchestrator: null })), ORCHESTRATOR_BUILTIN];
    assert.deepEqual(JSON.parse(upgradedRow.presets_json), expected);
    assert.doesNotThrow(() => SiftPresetCollectionSchema.parse(JSON.parse(upgradedRow.presets_json)));
  } finally {
    closeAllRuntimeDatabases();
  }
});

test('a version 74 database upgrades once and reopens idempotently at 75', () => {
  const dbPath = tempDbPath('siftkit-preset-model-routing-idempotent-');
  try {
    rewindToVersion74(dbPath);
    const upgraded = getRuntimeDatabase(dbPath);
    assert.equal(getSchemaVersion(upgraded), CURRENT_SCHEMA_VERSION);
    const row = PresetsJsonRowSchema.parse(
      upgraded.prepare('SELECT presets_json FROM app_config WHERE id = 1').get(),
    );
    const catalog = z.array(JsonObjectSchema).parse(JSON.parse(row.presets_json));
    assert.ok(catalog.every((preset) => preset.modelPresetId === null));
    // Reopening at 75 must not touch the catalog again.
    closeAllRuntimeDatabases();
    const reopened = getRuntimeDatabase(dbPath);
    assert.equal(getSchemaVersion(reopened), CURRENT_SCHEMA_VERSION);
    const reopenedRow = PresetsJsonRowSchema.parse(
      reopened.prepare('SELECT presets_json FROM app_config WHERE id = 1').get(),
    );
    assert.equal(reopenedRow.presets_json, row.presets_json);
  } finally {
    closeAllRuntimeDatabases();
  }
});

test('malformed historical catalog JSON aborts the 74 to 75 upgrade and leaves version 74', () => {
  const dbPath = tempDbPath('siftkit-preset-model-routing-malformed-');
  rewindToVersion74(dbPath, '{not-json');
  assert.throws(() => getRuntimeDatabase(dbPath));
  closeAllRuntimeDatabases();
  assert.equal(readVersion(dbPath), 74);
});

test('an impossible historical record shape aborts the 74 to 75 upgrade and leaves version 74', () => {
  const dbPath = tempDbPath('siftkit-preset-model-routing-impossible-');
  const [first, ...rest] = HISTORIC_BUILTIN_CATALOG;
  assert.ok(first);
  const { label: _label, ...withoutLabel } = first;
  rewindToVersion74(dbPath, JSON.stringify([withoutLabel, ...rest, CUSTOM_PRESET_74]));
  assert.throws(() => getRuntimeDatabase(dbPath));
  closeAllRuntimeDatabases();
  assert.equal(readVersion(dbPath), 74);
});

test('a 74 record that already contains modelPresetId aborts the upgrade and leaves version 74', () => {
  const dbPath = tempDbPath('siftkit-preset-model-routing-already-migrated-');
  const [first, ...rest] = HISTORIC_BUILTIN_CATALOG;
  assert.ok(first);
  rewindToVersion74(dbPath, JSON.stringify([{ ...first, modelPresetId: 'default' }, ...rest, CUSTOM_PRESET_74]));
  assert.throws(() => getRuntimeDatabase(dbPath));
  closeAllRuntimeDatabases();
  assert.equal(readVersion(dbPath), 74);
});

for (const invalidFields of [
  { presetKind: 'orchestrator' },
  { operationMode: 'orchestrator' },
  { allowedTools: ['spawn_agent'] },
  { surfaces: ['desktop'] },
]) {
  test(`schema-74 enum values reject ${JSON.stringify(invalidFields)} without changing stored data`, () => {
    const dbPath = tempDbPath('siftkit-preset-model-routing-historical-enum-');
    const presetsJson = JSON.stringify([
      ...HISTORIC_BUILTIN_CATALOG,
      { ...CUSTOM_PRESET_74, ...invalidFields },
    ]);
    rewindToVersion74(dbPath, presetsJson);
    assert.throws(() => getRuntimeDatabase(dbPath));
    closeAllRuntimeDatabases();
    assert.equal(readVersion(dbPath), 74);
    const database = openStoredRuntimeDatabase(dbPath);
    try {
      const row = PresetsJsonRowSchema.parse(
        database.prepare('SELECT presets_json FROM app_config WHERE id = 1').get(),
      );
      assert.equal(row.presets_json, presetsJson);
    } finally {
      database.close();
    }
  });
}
