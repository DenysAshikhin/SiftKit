import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test, { mock } from 'node:test';
import Database from 'better-sqlite3';

import { SystemClock } from '../../src/assistant/clock.js';
import { z } from '../../src/lib/zod.js';
import { closeAllRuntimeDatabases, getRuntimeDatabase } from '../../src/state/runtime-db.js';
import { createManagedTempDir } from '../helpers/temp-dirs.js';

// File storage: what a failed open leaves behind in the runtime database file itself.
const TableNameRowsSchema = z.array(z.object({ name: z.string() }));

function tempDbPath(prefix: string): string {
  return path.join(createManagedTempDir(prefix), 'runtime.sqlite');
}

test('unreadable files are rejected without destructive recovery', () => {
  const dbPath = tempDbPath('siftkit-runtime-schema-unreadable-');
  const original = Buffer.from('this is not sqlite', 'utf8');
  writeFileSync(dbPath, original);
  try {
    assert.throws(() => getRuntimeDatabase(dbPath));
    assert.deepEqual(readFileSync(dbPath), original);
  } finally {
    closeAllRuntimeDatabases();
  }
});

test('fresh bootstrap rolls back schema and seed rows when the clock fails', () => {
  const dbPath = tempDbPath('siftkit-runtime-schema-rollback-');
  const clockMock = mock.method(SystemClock.prototype, 'nowUtc', () => {
    throw new Error('clock failed');
  });
  try {
    assert.throws(() => getRuntimeDatabase(dbPath), /clock failed/u);
  } finally {
    clockMock.mock.restore();
    closeAllRuntimeDatabases();
  }

  const database = new Database(dbPath, { readonly: true });
  try {
    const names = TableNameRowsSchema.parse(database.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table'",
    ).all()).map((row) => row.name);
    assert.deepEqual(names, []);
  } finally {
    database.close();
  }
});
