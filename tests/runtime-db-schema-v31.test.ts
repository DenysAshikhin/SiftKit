import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { z } from 'zod';
import { CURRENT_SCHEMA_VERSION, getRuntimeDatabase } from '../src/state/runtime-db.js';

const ColumnNameRowSchema = z.array(z.object({ name: z.string() }));

function tempDbPath(prefix: string): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), prefix)), 'runtime.sqlite');
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

test('schema v31 persists inference and EXL3 configuration JSON', () => {
  const dbPath = tempDbPath('sk-v31-fresh-');
  getRuntimeDatabase(dbPath);

  assert.equal(CURRENT_SCHEMA_VERSION, 31);
  assert.ok(columnNames(dbPath).includes('inference_json'));
  assert.ok(columnNames(dbPath).includes('server_exl3_json'));
});

test('v30 migration adds inference and EXL3 configuration columns', () => {
  const dbPath = tempDbPath('sk-v31-migrate-');
  const seed = new Database(dbPath);
  seed.exec(`
    CREATE TABLE runtime_schema (id INTEGER PRIMARY KEY CHECK (id = 1), version INTEGER NOT NULL);
    INSERT INTO runtime_schema (id, version) VALUES (1, 30);
    CREATE TABLE app_config (id INTEGER PRIMARY KEY CHECK (id = 1));
  `);
  seed.close();

  getRuntimeDatabase(dbPath);

  assert.ok(columnNames(dbPath).includes('inference_json'));
  assert.ok(columnNames(dbPath).includes('server_exl3_json'));
});
