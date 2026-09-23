import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import Database from 'better-sqlite3';
import path from 'node:path';
import test from 'node:test';

import { z } from '../../src/lib/zod.js';
import {
  closeAllRuntimeDatabases,
  closeRuntimeDatabase,
  getRuntimeDatabase,
} from '../../src/state/runtime-db.js';
import { twoPaths, readValues } from '../helpers/runtime-db-lifecycle-fixtures.js';

const JournalModeRowSchema = z.object({ journal_mode: z.string() });

test('opening a second database leaves the first handle open and usable', () => {
  const { firstPath, secondPath } = twoPaths('runtime-db-lifecycle-scoped-');
  try {
    const first = getRuntimeDatabase(firstPath);
    first.exec("CREATE TABLE audit_value(value TEXT); INSERT INTO audit_value VALUES ('A')");
    const second = getRuntimeDatabase(secondPath);
    assert.notEqual(first, second);
    assert.equal(first.open, true);
    first.exec("INSERT INTO audit_value VALUES ('A2')");
    assert.deepEqual(readValues(first), ['A', 'A2']);

    closeRuntimeDatabase(secondPath);
    assert.equal(second.open, false);
    assert.equal(first.open, true);
    assert.deepEqual(first.prepare('SELECT value FROM audit_value ORDER BY value').all(), [{ value: 'A' }, { value: 'A2' }]);
    assert.equal(JournalModeRowSchema.parse(first.prepare('PRAGMA journal_mode').get()).journal_mode, 'wal');
  } finally {
    closeAllRuntimeDatabases();
  }
});

// The flush worker and the server share one file. An ordinary close must not switch the
// journal back to rollback mode under the other connection, and cleanup must still succeed.
test('closing one connection leaves a concurrent connection in WAL mode and usable', () => {
  const { firstPath } = twoPaths('runtime-db-lifecycle-wal-');
  const first = getRuntimeDatabase(firstPath);
  first.exec("CREATE TABLE audit_value(value TEXT); INSERT INTO audit_value VALUES ('A')");
  const second = new Database(firstPath);
  try {
    assert.equal(JournalModeRowSchema.parse(second.prepare('PRAGMA journal_mode').get()).journal_mode, 'wal');
    closeRuntimeDatabase(firstPath);
    assert.equal(first.open, false);
    assert.equal(JournalModeRowSchema.parse(second.prepare('PRAGMA journal_mode').get()).journal_mode, 'wal');
    second.exec("INSERT INTO audit_value VALUES ('B')");
    assert.deepEqual(readValues(second), ['A', 'B']);
  } finally {
    second.close();
    closeAllRuntimeDatabases();
  }
  assert.doesNotThrow(() => rmSync(path.dirname(firstPath), { recursive: true, force: false }));
});
