import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import path from 'node:path';
import test from 'node:test';

import { z } from '../src/lib/zod.js';
import { CURRENT_SCHEMA_VERSION, migrateDatabaseFile } from '../src/state/runtime-db.js';
import { createManagedTempDir } from './helpers/temp-dirs.js';

const HoldRowsSchema = z.array(z.object({
  id: z.string(),
  rejection_reason: z.string().nullable(),
  hold_json: z.string().nullable(),
}));

/** A v60 `candidate_assertions` table, before the hold moved out of `rejection_reason`. */
function seedPredecessor(dbPath: string): void {
  const database = new Database(dbPath);
  database.exec(`
    CREATE TABLE runtime_schema (id INTEGER PRIMARY KEY CHECK (id = 1), version INTEGER NOT NULL);
    INSERT INTO runtime_schema (id, version) VALUES (1, 60);
    CREATE TABLE candidate_assertions (
      id TEXT NOT NULL, status TEXT NOT NULL, rejection_reason TEXT
    );
    INSERT INTO candidate_assertions (id, status, rejection_reason) VALUES
      ('alias', 'needs_confirmation', 'possible_owner_alias:denyz'),
      ('topic', 'needs_confirmation', 'health'),
      ('refused', 'rejected', 'unknown_predicate'),
      ('open', 'pending', NULL);
  `);
  database.close();
}

test('v61 rejects a database without candidate_assertions', () => {
  const dbPath = path.join(createManagedTempDir('sk-v61-missing-table-'), 'runtime.sqlite');
  const database = new Database(dbPath);
  database.exec(`
    CREATE TABLE runtime_schema (id INTEGER PRIMARY KEY CHECK (id = 1), version INTEGER NOT NULL);
    INSERT INTO runtime_schema (id, version) VALUES (1, 60);
  `);
  database.close();

  assert.throws(() => migrateDatabaseFile(dbPath), /requires candidate_assertions/u);
});

test('v61 moves encoded holds into hold_json and clears the reason it borrowed', () => {
  const dbPath = path.join(createManagedTempDir('sk-v61-holds-'), 'runtime.sqlite');
  seedPredecessor(dbPath);

  migrateDatabaseFile(dbPath);

  const readonly = new Database(dbPath, { readonly: true });
  try {
    assert.deepEqual(
      HoldRowsSchema.parse(readonly.prepare(`
        SELECT id, rejection_reason, hold_json FROM candidate_assertions ORDER BY id ASC
      `).all()),
      [
        {
          id: 'alias',
          rejection_reason: null,
          hold_json: '{"kind":"possible_owner_alias","name":"denyz"}',
        },
        { id: 'open', rejection_reason: null, hold_json: null },
        { id: 'refused', rejection_reason: 'unknown_predicate', hold_json: null },
        { id: 'topic', rejection_reason: null, hold_json: '{"kind":"topic","topic":"health"}' },
      ],
    );
    const version = z.object({ version: z.number() }).parse(
      readonly.prepare('SELECT version FROM runtime_schema WHERE id = 1').get(),
    );
    assert.equal(version.version, CURRENT_SCHEMA_VERSION);
    assert.equal(CURRENT_SCHEMA_VERSION, 64);
  } finally {
    readonly.close();
  }
});
