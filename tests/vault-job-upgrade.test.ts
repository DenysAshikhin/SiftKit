import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';

import { LOCAL_OWNER_ID } from '../src/assistant/storage/schema.ts';
import { z } from '../src/lib/zod.ts';
import { CURRENT_SCHEMA_VERSION, closeAllRuntimeDatabases, getRuntimeDatabase, getSchemaVersion } from '../src/state/runtime-db.ts';
import { withRuntimeDatabaseConnection } from './helpers/runtime-database-probe.ts';
import { createManagedTempDir } from './helpers/temp-dirs.ts';

const LEGACY_TYPES = ['conversation_ingestion', 'candidate_consolidation', 'projection_maintenance', 'question_answer_ingestion',
  'question_planning', 'projection_summarization', 'image_extraction'];

/** A schema-86 file whose job queue still holds every retired job type next to a kept retention job. */
function seedSchema86(): string {
  const dbPath = path.join(createManagedTempDir('siftkit-vault-jobs-'), 'runtime.sqlite');
  getRuntimeDatabase(dbPath);
  closeAllRuntimeDatabases();
  withRuntimeDatabaseConnection(dbPath, (database) => {
    const insert = database.prepare(`
      INSERT INTO assistant_jobs (id, owner_id, job_type, priority, payload_json, idempotency_key, status, attempts, max_attempts,
        available_at_utc, lease_owner, lease_expires_at_utc, last_error, created_at_utc, updated_at_utc)
      VALUES (?, ?, ?, 1, '{}', ?, 'queued', 0, 3, '2026-10-24T09:00:00.000Z', NULL, NULL, NULL, '2026-10-24T09:00:00.000Z', '2026-10-24T09:00:00.000Z')
    `);
    for (const [index, jobType] of [...LEGACY_TYPES, 'capture_retention'].entries()) insert.run(`job_${index}`, LOCAL_OWNER_ID, jobType, `key_${index}`);
    database.exec('UPDATE runtime_schema SET version = 86 WHERE id = 1');
  });
  return dbPath;
}

test('the 86 to 87 upgrade deletes jobs of the retired legacy types and keeps the rest', (t) => {
  t.after(closeAllRuntimeDatabases);
  const database = getRuntimeDatabase(seedSchema86());
  assert.equal(getSchemaVersion(database), CURRENT_SCHEMA_VERSION);
  const types = z.array(z.object({ job_type: z.string() })).parse(database.prepare('SELECT job_type FROM assistant_jobs').all());
  assert.deepEqual(types.map((row) => row.job_type), ['capture_retention']);
});
