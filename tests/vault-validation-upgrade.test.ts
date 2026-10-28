import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';

import { z } from '../src/lib/zod.ts';
import { CURRENT_SCHEMA_VERSION, closeAllRuntimeDatabases, getRuntimeDatabase, getSchemaVersion } from '../src/state/runtime-db.ts';
import { withRuntimeDatabaseConnection } from './helpers/runtime-database-probe.ts';
import { createManagedTempDir } from './helpers/temp-dirs.ts';
import { downgradeVaultTo87 } from './helpers/vault-schema-87.ts';
import { LOCAL_OWNER_ID } from '../src/assistant/storage/schema.ts';

const NOTE_UPDATED = '2026-09-01T10:00:00.000Z';

function seedSchema87(): string {
  const dbPath = path.join(createManagedTempDir('siftkit-vault-88-'), 'runtime.sqlite');
  getRuntimeDatabase(dbPath);
  closeAllRuntimeDatabases();
  withRuntimeDatabaseConnection(dbPath, (database) => {
    downgradeVaultTo87(database);
    database.prepare(`
      INSERT INTO vault_notes (id, title, title_key, folder, kind, types_json, aliases_json, tags_json, body, revision, is_stub, created_at_utc, updated_at_utc)
      VALUES ('vnote_1', 'Neovim', 'neovim', 'Software', 'entity', '[]', '[]', '[]', ?, 1, 0, ?, ?)
    `).run('Editor.\n\n**Uses** [[Lua]] · plugins', NOTE_UPDATED, NOTE_UPDATED);
    database.exec('UPDATE runtime_schema SET version = 87 WHERE id = 1');
  });
  return dbPath;
}

test('the 87 to 88 upgrade adds the timestamp columns and backfills fact points from every note', (t) => {
  t.after(closeAllRuntimeDatabases);
  const database = getRuntimeDatabase(seedSchema87());
  assert.equal(getSchemaVersion(database), CURRENT_SCHEMA_VERSION);
  const rows = z.array(z.object({ value: z.string(), added_at_utc: z.string(), edited_at_utc: z.string(), last_accessed_at_utc: z.null(), validated_at_utc: z.null() }))
    .parse(database.prepare("SELECT value, added_at_utc, edited_at_utc, last_accessed_at_utc, validated_at_utc FROM vault_fact_points WHERE note_id = 'vnote_1' ORDER BY value_key").all());
  assert.deepEqual(rows.map((row) => [row.value, row.added_at_utc, row.edited_at_utc]), [['[[Lua]]', NOTE_UPDATED, NOTE_UPDATED], ['plugins', NOTE_UPDATED, NOTE_UPDATED]]);
  assert.deepEqual(
    z.object({ last_accessed_at_utc: z.null(), validated_at_utc: z.null() }).parse(database.prepare("SELECT last_accessed_at_utc, validated_at_utc FROM vault_notes WHERE id = 'vnote_1'").get()),
    { last_accessed_at_utc: null, validated_at_utc: null },
  );
});

test('the 87 to 88 upgrade converts live chat jobs, moves pending rollup days and drops the retired job types', (t) => {
  t.after(closeAllRuntimeDatabases);
  const dbPath = seedSchema87();
  const turn = { sessionId: 's1', sessionTitle: 'T', userMessageId: 'm1', capturedAtUtc: '2026-10-24T09:00:00.000Z', userText: 'u', assistantText: 'a' };
  withRuntimeDatabaseConnection(dbPath, (database) => {
    const insert = database.prepare(`
      INSERT INTO assistant_jobs (id, owner_id, job_type, priority, payload_json, idempotency_key, status, attempts, max_attempts,
        available_at_utc, lease_owner, lease_expires_at_utc, last_error, created_at_utc, updated_at_utc)
      VALUES (?, ?, ?, 1, ?, ?, ?, 0, 3, ?, NULL, NULL, NULL, ?, ?)
    `);
    const jobs: ReadonlyArray<readonly [string, string, object, string]> = [
      ['job_chat', 'chat_note', turn, 'queued'],
      ['job_chat_done', 'chat_note', { ...turn, userMessageId: 'm0' }, 'completed'],
      ['job_rollup', 'daily_rollup', { day: '2026-10-23' }, 'queued'],
      ['job_capture', 'capture_note', { attachmentId: 'a1' }, 'queued'],
      ['job_tidy', 'note_tidy', { noteId: 'vnote_1' }, 'paused'],
      ['job_retention', 'capture_retention', {}, 'running'],
    ];
    for (const [id, jobType, payload, status] of jobs) insert.run(id, LOCAL_OWNER_ID, jobType, JSON.stringify(payload), `${jobType}:${id}`, status, NOTE_UPDATED, NOTE_UPDATED, NOTE_UPDATED);
  });
  const database = getRuntimeDatabase(dbPath);
  const rows = z.array(z.object({ id: z.string(), job_type: z.string(), idempotency_key: z.string(), payload_json: z.string() }))
    .parse(database.prepare('SELECT id, job_type, idempotency_key, payload_json FROM assistant_jobs ORDER BY id').all());
  assert.deepEqual(rows.map((row) => [row.id, row.job_type, row.idempotency_key]), [['job_chat', 'vault_write', 'vault_write:chat:s1:m1']]);
  assert.deepEqual(JSON.parse(rows[0]?.payload_json ?? '{}'), { source: 'chat', turn });
  assert.deepEqual(z.array(z.object({ day: z.string() })).parse(database.prepare('SELECT day FROM vault_rollup_days').all()), [{ day: '2026-10-23' }]);
});
