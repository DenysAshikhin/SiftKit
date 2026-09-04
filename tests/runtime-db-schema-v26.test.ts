import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import path from 'node:path';
import { z } from 'zod';
import { CURRENT_SCHEMA_VERSION, getRuntimeDatabase, migrateDatabaseFile } from '../src/state/runtime-db.js';
import { migrateAppConfigToPresetSourceOfTruth } from '../src/state/migrations/app-config-migrations.js';
import {
  LEGACY_ACTIVE_MODEL_PRESET_COLUMN,
  LEGACY_MODEL_PRESETS_COLUMN,
} from '../src/state/migrations/constants.js';
import { createAppConfigMigrationFixture } from './helpers/app-config-migration-fixture.js';
import { createManagedTempDir } from './helpers/temp-dirs.js';
import {
  REMOVED_BACKEND_COLUMN_PREFIX,
  REMOVED_BACKEND_CONTEXT_COLUMN,
} from './helpers/legacy-backend-fixtures.js';

const ColumnNameRowSchema = z.array(z.object({ name: z.string() }));
const PresetRowSchema = z.object({ presets: z.string(), active: z.string().nullable() });
const REMOVED_NUM_CTX_COLUMN = REMOVED_BACKEND_CONTEXT_COLUMN;
const REMOVED_COLUMN_PREFIX = REMOVED_BACKEND_COLUMN_PREFIX;
const LEGACY_PRESETS_COLUMN = LEGACY_MODEL_PRESETS_COLUMN;

function tempDbPath(prefix: string): string {
  return path.join(createManagedTempDir(prefix), 'runtime.sqlite');
}

function columnNames(dbPath: string): string[] {
  const db = new Database(dbPath, { readonly: true });
  try {
    return ColumnNameRowSchema
      .parse(db.prepare("SELECT name FROM pragma_table_info('app_config')").all())
      .map((r) => r.name);
  } finally {
    db.close();
  }
}

const KEPT_SERVER_COLUMNS = new Set([
  'server_model_presets_json',
  'server_model_active_preset_id',
  'server_external_server_enabled',
  'server_exl3_json',
]);

test('fresh DB base schema has no redundant removed-backend columns', () => {
  const dbPath = tempDbPath('sk-v26-fresh-');
  getRuntimeDatabase(dbPath);
  const cols = columnNames(dbPath);
  assert.ok(cols.includes('server_model_presets_json'), 'keeps presets json');
  assert.ok(cols.includes('server_model_active_preset_id'), 'keeps active preset id');
  assert.ok(cols.includes('presets_json'), 'keeps top-level presets');
  assert.ok(!cols.some((c) => c.startsWith(REMOVED_COLUMN_PREFIX)), 'no removed-backend columns');
  assert.ok(
    !cols.some((c) => c.startsWith('server_') && !KEPT_SERVER_COLUMNS.has(c)),
    'no redundant server_* columns',
  );
});

function seedV25Database(): string {
  const dbPath = tempDbPath('sk-v26-migrate-');
  // Build a minimal pre-v26 app_config carrying only the columns the v26
  // migration reads or drops, then mark the schema at version 25.
  const seed = new Database(dbPath);
  seed.exec(`
    CREATE TABLE runtime_schema (id INTEGER PRIMARY KEY CHECK (id = 1), version INTEGER NOT NULL);
    INSERT INTO runtime_schema (id, version) VALUES (1, 25);
  `);
  createAppConfigMigrationFixture(seed, {
    omitExpandReads: true,
    omitInference: true,
    omitServerExl3: true,
    omitWebSearch: true,
  });
  seed.exec(`
    ALTER TABLE app_config ADD COLUMN ${REMOVED_NUM_CTX_COLUMN} INTEGER;
    ALTER TABLE app_config ADD COLUMN server_num_ctx INTEGER;
    INSERT INTO app_config (id, ${REMOVED_NUM_CTX_COLUMN}, server_num_ctx, ${LEGACY_PRESETS_COLUMN})
    VALUES (1, 85000, 85000, '[]');
  `);
  seed.close();
  return dbPath;
}

test('v25->v26 migration drops columns and synthesizes a preset when presets json is empty', () => {
  const dbPath = seedV25Database();
  const database = new Database(dbPath);
  try {
    migrateAppConfigToPresetSourceOfTruth(database);
  } finally {
    database.close();
  }

  const cols = columnNames(dbPath);
  assert.ok(!cols.includes(REMOVED_NUM_CTX_COLUMN), 'removed backend context column dropped');
  assert.ok(!cols.includes('server_num_ctx'), 'server_num_ctx dropped');

  const read = new Database(dbPath, { readonly: true });
  try {
    const row = PresetRowSchema.parse(read.prepare(
      `SELECT ${LEGACY_PRESETS_COLUMN} AS presets, ${LEGACY_ACTIVE_MODEL_PRESET_COLUMN} AS active FROM app_config WHERE id = 1`,
    ).get());
    const presets = z.array(z.object({ id: z.string() })).parse(JSON.parse(row.presets));
    assert.equal(presets.length, 1, 'synthesized exactly one preset');
    assert.equal(presets[0].id, 'default');
    assert.equal(row.active, 'default', 'active preset id set');
  } finally {
    read.close();
  }
});

test('public upgrade from v25 removes the synthesized historical preset', () => {
  const dbPath = seedV25Database();
  migrateDatabaseFile(dbPath);
  const database = new Database(dbPath, { readonly: true });
  try {
    const row = PresetRowSchema.parse(database.prepare(
      'SELECT server_model_presets_json AS presets, server_model_active_preset_id AS active FROM app_config WHERE id = 1',
    ).get());
    assert.equal(row.presets, '[]');
    assert.equal(row.active, null);
    assert.equal(z.object({ version: z.number() }).parse(database.prepare(
      'SELECT version FROM runtime_schema WHERE id = 1',
    ).get()).version, CURRENT_SCHEMA_VERSION);
    const columns = columnNames(dbPath);
    assert.equal(columns.includes(REMOVED_NUM_CTX_COLUMN), false);
    assert.equal(columns.includes('server_num_ctx'), false);
  } finally {
    database.close();
  }
});
