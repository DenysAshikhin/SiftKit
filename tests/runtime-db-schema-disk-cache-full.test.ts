import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';

import { insertEngineEvent, listEngineEvents } from '../src/state/engine-events.ts';
import { CURRENT_SCHEMA_VERSION, closeAllRuntimeDatabases, getRuntimeDatabase, getSchemaVersion } from '../src/state/runtime-db.ts';
import { withRuntimeDatabaseConnection } from './helpers/runtime-database-probe.ts';
import { createManagedTempDir } from './helpers/temp-dirs.ts';

// The engine_events table as schema 95 stored it, before disk_cache_full.
const ENGINE_EVENTS_95_SQL = `
  DROP TABLE engine_events;
  CREATE TABLE engine_events (
    id TEXT PRIMARY KEY,
    occurred_at_utc TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('prompt_cache_break', 'engine_error', 'engine_exit')),
    inference_run_id TEXT,
    run_id TEXT,
    turn INTEGER,
    summary TEXT NOT NULL,
    detail TEXT NOT NULL
  );
  CREATE INDEX idx_engine_events_occurred ON engine_events(occurred_at_utc DESC);
  CREATE INDEX idx_engine_events_run ON engine_events(run_id);
  INSERT INTO engine_events VALUES ('e1', '2026-11-19T10:00:00.000Z', 'engine_exit', 'run-a', NULL, NULL, 'Engine exited with code 1', 'trace');
  UPDATE runtime_schema SET version = 95 WHERE id = 1;
`;

test('the 95 to 96 upgrade lets engine_events hold disk_cache_full and keeps every stored event', (t) => {
  t.after(closeAllRuntimeDatabases);
  const dbPath = path.join(createManagedTempDir('siftkit-disk-cache-full-schema-'), 'runtime.sqlite');
  getRuntimeDatabase(dbPath);
  closeAllRuntimeDatabases();
  withRuntimeDatabaseConnection(dbPath, (database) => database.exec(ENGINE_EVENTS_95_SQL));

  const database = getRuntimeDatabase(dbPath);
  assert.equal(getSchemaVersion(database), CURRENT_SCHEMA_VERSION);
  insertEngineEvent(database, { kind: 'disk_cache_full', inferenceRunId: 'run-b', runId: null, turn: null, summary: 'Disk cache full', detail: 'line' });
  assert.deepEqual(listEngineEvents(database, 10).map((event) => [event.id === 'e1' ? 'e1' : 'new', event.kind, event.summary]), [
    ['new', 'disk_cache_full', 'Disk cache full'],
    ['e1', 'engine_exit', 'Engine exited with code 1'],
  ]);
});
