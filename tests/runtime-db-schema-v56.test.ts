import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';

import { createAppConfigMigrationFixture } from './helpers/app-config-migration-fixture.js';
import { FixedClock } from '../src/assistant/clock.js';
import { BackgroundWorkDecisionStore } from '../src/assistant/storage/background-work-decision-store.js';
import { LOCAL_OWNER_ID } from '../src/assistant/storage/schema.js';
import {
  BACKGROUND_WORK_DECISIONS_METADATA_KEY, REMOVED_COMBINED_INPUT_IDLE_REASON,
} from '../src/state/migrations/constants.js';
import { closeRuntimeDatabase, getRuntimeDatabase } from '../src/state/runtime-db.js';
import { createManagedTempDir } from './helpers/temp-dirs.js';

const KEPT_DECISION = {
  recordedAtUtc: '2026-08-31T12:00:00.000Z',
  reason: 'server_busy',
  queuedJobCount: 3,
  pendingCaptureCount: 5,
  details: {},
};

/** A v55 database whose decision history still carries the removed combined-input reason. */
function seedV55Database(): string {
  const tempRoot = createManagedTempDir('sk-v56-');
  const dbPath = path.join(tempRoot, 'runtime.sqlite');
  const database = new Database(dbPath);
  createAppConfigMigrationFixture(database);
  database.exec(`
    CREATE TABLE runtime_schema (id INTEGER PRIMARY KEY CHECK (id = 1), version INTEGER NOT NULL);
    INSERT INTO runtime_schema (id, version) VALUES (1, 55);
    -- Every real database of this vintage carries the assistant tables; v61 refuses to run
    -- without them.
    CREATE TABLE candidate_assertions (
      id TEXT NOT NULL, status TEXT NOT NULL, rejection_reason TEXT
    );
    CREATE TABLE runtime_metadata (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at_utc TEXT NOT NULL
    );
  `);
  database.prepare('INSERT INTO runtime_metadata (key, value, updated_at_utc) VALUES (?, ?, ?)').run(
    BACKGROUND_WORK_DECISIONS_METADATA_KEY,
    JSON.stringify({
      [LOCAL_OWNER_ID]: [
        {
          recordedAtUtc: '2026-08-31T11:59:00.000Z',
          reason: REMOVED_COMBINED_INPUT_IDLE_REASON,
          queuedJobCount: 3,
          pendingCaptureCount: 5,
          details: { inputIdleSeconds: 12, requiredIdleSeconds: 180 },
        },
        KEPT_DECISION,
        {
          recordedAtUtc: '2026-08-31T12:01:00.000Z',
          reason: REMOVED_COMBINED_INPUT_IDLE_REASON,
          queuedJobCount: 2,
          pendingCaptureCount: 5,
          details: { inputIdleSeconds: 40, requiredIdleSeconds: 180 },
        },
      ],
      other_owner: [KEPT_DECISION],
    }),
    '2026-08-31T12:01:00.000Z',
  );
  database.close();
  return dbPath;
}

test('v56 migration drops decision history entries whose reason no longer exists', () => {
  const dbPath = seedV55Database();
  try {
    const database = getRuntimeDatabase(dbPath);
    const store = new BackgroundWorkDecisionStore(database, new FixedClock('2026-09-01T00:00:00.000Z'));
    assert.deepEqual(store.list(LOCAL_OWNER_ID), [KEPT_DECISION]);
    assert.deepEqual(store.list('other_owner'), [KEPT_DECISION]);
  } finally {
    closeRuntimeDatabase();
    fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
  }
});
