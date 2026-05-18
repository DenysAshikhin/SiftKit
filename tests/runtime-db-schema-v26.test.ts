import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { getRuntimeDatabase } from '../src/state/runtime-db.js';

function tempDbPath(prefix: string): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), prefix)), 'runtime.sqlite');
}

function columnNames(dbPath: string): string[] {
  const db = new Database(dbPath, { readonly: true });
  try {
    return (db.prepare("SELECT name FROM pragma_table_info('app_config')").all() as { name: string }[])
      .map((r) => r.name);
  } finally {
    db.close();
  }
}

const KEPT_SERVER_COLUMNS = new Set([
  'server_llama_presets_json',
  'server_llama_active_preset_id',
  'server_external_server_enabled',
]);

test('fresh DB base schema has no redundant managed-llama columns', () => {
  const dbPath = tempDbPath('sk-v26-fresh-');
  getRuntimeDatabase(dbPath);
  const cols = columnNames(dbPath);
  assert.ok(cols.includes('server_llama_presets_json'), 'keeps presets json');
  assert.ok(cols.includes('server_llama_active_preset_id'), 'keeps active preset id');
  assert.ok(cols.includes('presets_json'), 'keeps top-level presets');
  assert.ok(!cols.some((c) => c.startsWith('llama_')), 'no llama_* columns');
  assert.ok(
    !cols.some((c) => c.startsWith('server_') && !KEPT_SERVER_COLUMNS.has(c)),
    'no redundant server_* columns',
  );
});

test('v25->v26 migration drops columns and synthesizes a preset when presets json is empty', () => {
  const dbPath = tempDbPath('sk-v26-migrate-');
  // Build a minimal pre-v26 app_config carrying only the columns the v26
  // migration reads or drops, then mark the schema at version 25.
  const seed = new Database(dbPath);
  seed.exec(`
    CREATE TABLE runtime_schema (id INTEGER PRIMARY KEY CHECK (id = 1), version INTEGER NOT NULL);
    INSERT INTO runtime_schema (id, version) VALUES (1, 25);
    CREATE TABLE app_config (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      llama_num_ctx INTEGER,
      server_num_ctx INTEGER,
      server_llama_presets_json TEXT,
      server_llama_active_preset_id TEXT
    );
    INSERT INTO app_config (id, llama_num_ctx, server_num_ctx, server_llama_presets_json)
    VALUES (1, 85000, 85000, '[]');
  `);
  seed.close();

  getRuntimeDatabase(dbPath); // re-runs ensureSchema -> applies the v26 migration

  const cols = columnNames(dbPath);
  assert.ok(!cols.includes('llama_num_ctx'), 'llama_num_ctx dropped');
  assert.ok(!cols.includes('server_num_ctx'), 'server_num_ctx dropped');

  const read = new Database(dbPath, { readonly: true });
  try {
    const row = read.prepare(
      'SELECT server_llama_presets_json AS presets, server_llama_active_preset_id AS active FROM app_config WHERE id = 1',
    ).get() as { presets: string; active: string | null };
    const presets = JSON.parse(row.presets) as { id: string }[];
    assert.equal(presets.length, 1, 'synthesized exactly one preset');
    assert.equal(presets[0].id, 'default');
    assert.equal(row.active, 'default', 'active preset id set');
  } finally {
    read.close();
  }
});
