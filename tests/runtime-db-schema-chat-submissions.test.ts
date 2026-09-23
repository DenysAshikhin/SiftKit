import assert from 'node:assert/strict';
import { join } from 'node:path';
import test from 'node:test';
import { z } from '../src/lib/zod.js';
import { closeAllRuntimeDatabases, CURRENT_SCHEMA_VERSION, getRuntimeDatabase, getSchemaVersion } from '../src/state/runtime-db.js';
import { createManagedTempDir } from './helpers/temp-dirs.js';
import { openStoredRuntimeDatabase } from './helpers/stored-runtime-database.js';

const TableRowSchema = z.object({ sql: z.string() });

test('schema 71 upgrades to the canonical chat submission receipt table', (t) => {
  t.after(closeAllRuntimeDatabases);
  const path = join(createManagedTempDir('chat-submission-schema-'), 'runtime.sqlite');
  const current = getRuntimeDatabase(path);
  current.exec('DROP TABLE chat_submissions; DROP TABLE orchestrator_events; DROP TABLE orchestrator_attempts; DROP TABLE orchestrator_runs; UPDATE runtime_schema SET version = 71 WHERE id = 1;');
  closeAllRuntimeDatabases();

  const upgraded = getRuntimeDatabase(path);
  assert.equal(getSchemaVersion(upgraded), CURRENT_SCHEMA_VERSION);
  const definition = TableRowSchema.parse(upgraded.prepare(
    "SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = 'chat_submissions'",
  ).get()).sql;
  assert.match(definition, /PRIMARY KEY \(session_id, submission_id\)/u);
  assert.match(definition, /run_operation_id TEXT NOT NULL UNIQUE/u);
});

test('schema 71 rejects an unexpected pre-existing chat_submissions table atomically', (t) => {
  t.after(closeAllRuntimeDatabases);
  const path = join(createManagedTempDir('chat-submission-schema-drift-'), 'runtime.sqlite');
  const current = getRuntimeDatabase(path);
  current.exec('DROP TABLE chat_submissions; CREATE TABLE chat_submissions (wrong TEXT); DROP TABLE orchestrator_events; DROP TABLE orchestrator_attempts; DROP TABLE orchestrator_runs; UPDATE runtime_schema SET version = 71 WHERE id = 1;');
  closeAllRuntimeDatabases();

  assert.throws(() => getRuntimeDatabase(path), /chat_submissions/u);
  const raw = openStoredRuntimeDatabase(path);
  try {
    assert.equal(z.object({ version: z.number() }).parse(raw.prepare('SELECT version FROM runtime_schema WHERE id = 1').get()).version, 71);
  } finally {
    raw.close();
  }
});
