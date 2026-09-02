import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';

import { z } from '../src/lib/zod.js';
import { closeRuntimeDatabase, getRuntimeDatabase } from '../src/state/runtime-db.js';
import { createManagedTempDir } from './helpers/temp-dirs.js';

const ColumnRowsSchema = z.array(z.object({ name: z.string() }));
const EventRowsSchema = z.array(z.object({
  id: z.string(), mouse_idle_seconds: z.number(), keyboard_idle_seconds: z.number(),
}));

/** A v57 database whose activity events still carry the single combined `idle_seconds`. */
function seedV57Database(): string {
  const dbPath = path.join(createManagedTempDir('sk-v58-'), 'runtime.sqlite');
  const database = new Database(dbPath);
  database.exec(`
    CREATE TABLE runtime_schema (id INTEGER PRIMARY KEY CHECK (id = 1), version INTEGER NOT NULL);
    INSERT INTO runtime_schema (id, version) VALUES (1, 57);
    CREATE TABLE assistant_activity_events (
      id TEXT PRIMARY KEY,
      owner_id TEXT NOT NULL,
      captured_at_utc TEXT NOT NULL,
      application_id TEXT,
      process_name TEXT,
      normalized_title TEXT,
      fullscreen INTEGER NOT NULL CHECK (fullscreen IN (0, 1)),
      idle_seconds INTEGER NOT NULL CHECK (idle_seconds >= 0),
      session_locked INTEGER NOT NULL CHECK (session_locked IN (0, 1)),
      session_id TEXT
    );
    INSERT INTO assistant_activity_events VALUES
      ('aevt_1', 'own_local', '2026-08-10T09:00:00.000Z', 'app:code', 'Code.exe', 'SiftKit', 0, 4, 0, NULL),
      ('aevt_2', 'own_local', '2026-08-10T09:01:00.000Z', 'app:code', 'Code.exe', 'SiftKit', 0, 130, 0, NULL);
  `);
  database.close();
  return dbPath;
}

test('v58 splits the combined activity idle column into mouse and keyboard, seeding both', () => {
  const dbPath = seedV57Database();
  try {
    getRuntimeDatabase(dbPath);
    closeRuntimeDatabase();

    const database = new Database(dbPath);
    try {
      const columns = ColumnRowsSchema.parse(
        database.prepare('PRAGMA table_info(assistant_activity_events)').all(),
      ).map((column) => column.name);
      assert.ok(columns.includes('mouse_idle_seconds'));
      assert.ok(columns.includes('keyboard_idle_seconds'));
      assert.ok(!columns.includes('idle_seconds'));
      assert.deepEqual(EventRowsSchema.parse(database.prepare(`
        SELECT id, mouse_idle_seconds, keyboard_idle_seconds
        FROM assistant_activity_events ORDER BY id
      `).all()), [
        { id: 'aevt_1', mouse_idle_seconds: 4, keyboard_idle_seconds: 4 },
        { id: 'aevt_2', mouse_idle_seconds: 130, keyboard_idle_seconds: 130 },
      ]);
      assert.throws(
        () => database.prepare('UPDATE assistant_activity_events SET keyboard_idle_seconds = -1').run(),
        /CHECK constraint failed/,
      );
    } finally {
      database.close();
    }
  } finally {
    fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
  }
});
