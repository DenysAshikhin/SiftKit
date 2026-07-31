import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import path from 'node:path';
import { z } from 'zod';
import { closeRuntimeDatabase, getRuntimeDatabase } from '../src/state/runtime-db.js';
import { createAppConfigMigrationFixture } from './helpers/app-config-migration-fixture.js';
import { createManagedTempDir } from './helpers/temp-dirs.js';

// The cached runtime DB handle keeps a file inside the temp dir open on Windows, which
// blocks the exit-time registry sweep. Root after() runs before the exit handler.
after(() => closeRuntimeDatabase());

const ColumnNameRowSchema = z.array(z.object({ name: z.string() }));

function tempDbPath(prefix: string): string {
  return path.join(createManagedTempDir(prefix), 'runtime.sqlite');
}

function columnNames(dbPath: string): string[] {
  const db = new Database(dbPath, { readonly: true });
  try {
    return ColumnNameRowSchema
      .parse(db.prepare("SELECT name FROM pragma_table_info('app_config')").all())
      .map((row) => row.name);
  } finally {
    db.close();
  }
}

test('current schema persists inference and EXL3 configuration JSON', () => {
  const dbPath = tempDbPath('sk-v32-fresh-');
  getRuntimeDatabase(dbPath);

  assert.ok(columnNames(dbPath).includes('inference_json'));
  assert.ok(columnNames(dbPath).includes('server_exl3_json'));
});

test('v30 migration adds inference and EXL3 configuration columns', () => {
  const dbPath = tempDbPath('sk-v32-migrate-');
  const seed = new Database(dbPath);
  seed.exec(`
    CREATE TABLE runtime_schema (id INTEGER PRIMARY KEY CHECK (id = 1), version INTEGER NOT NULL);
    INSERT INTO runtime_schema (id, version) VALUES (1, 30);
  `);
  createAppConfigMigrationFixture(seed, {
    omitExpandReads: true,
    omitInference: true,
    omitServerExl3: true,
  });
  seed.close();

  getRuntimeDatabase(dbPath);

  assert.ok(columnNames(dbPath).includes('inference_json'));
  assert.ok(columnNames(dbPath).includes('server_exl3_json'));
});
