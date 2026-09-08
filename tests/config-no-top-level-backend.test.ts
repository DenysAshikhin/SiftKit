import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import path from 'node:path';

import { getDefaultConfigObject } from '../src/config/defaults.js';
import { normalizeConfigObject } from '../src/config/normalization.js';
import { closeRuntimeDatabase, CURRENT_SCHEMA_VERSION, getRuntimeDatabase } from '../src/state/runtime-db.js';
import { z } from '../src/lib/zod.js';
import { createManagedTempDir } from './helpers/temp-dirs.js';
import { REMOVED_BACKEND_PROVIDER_ID } from './helpers/legacy-backend-fixtures.js';

const ColumnNameRowsSchema = z.array(z.object({ name: z.string() }));
const VersionRowSchema = z.object({ version: z.number() });

function tempDbPath(prefix: string): string {
  return path.join(createManagedTempDir(prefix), 'runtime.sqlite');
}

test('default config has no top-level Backend field', () => {
  assert.equal('Backend' in getDefaultConfigObject(), false);
});

test('normalization rejects a provided top-level Backend', () => {
  assert.throws(
    () => normalizeConfigObject({
      ...getDefaultConfigObject(),
      Backend: REMOVED_BACKEND_PROVIDER_ID,
    }),
    /Unsupported configuration field Backend/u,
  );
});

test('canonical config has no global startup-context switches', () => {
  const config = getDefaultConfigObject();
  assert.equal(Object.hasOwn(config, 'IncludeAgentsMd'), false);
  assert.equal(Object.hasOwn(config, 'IncludeRepoFileListing'), false);
});

test('fresh database uses current backend-neutral schema columns', () => {
  const dbPath = tempDbPath('siftkit-config-current-schema-');
  try {
    getRuntimeDatabase(dbPath);
    const database = new Database(dbPath, { readonly: true });
    try {
      const columns = ColumnNameRowsSchema.parse(database.prepare(
        "SELECT name FROM pragma_table_info('app_config')",
      ).all()).map((row) => row.name);
      assert.equal(columns.includes('backend'), false);
      assert.equal(columns.includes('server_exl3_json'), true);
      assert.equal(columns.includes('server_model_presets_json'), true);
      assert.equal(columns.includes('presets_json'), true);
      assert.equal(columns.includes('web_search_json'), true);
      assert.equal(VersionRowSchema.parse(database.prepare(
        'SELECT version FROM runtime_schema WHERE id = 1',
      ).get()).version, CURRENT_SCHEMA_VERSION);
    } finally {
      database.close();
    }
  } finally {
    closeRuntimeDatabase();
  }
});
