import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import test from 'node:test';

import { JsonObjectSchema } from '../src/lib/json-types.ts';
import { z } from '../src/lib/zod.ts';
import { OrchestratorRunStore } from '../src/orchestrator/run-store.ts';
import { CURRENT_SCHEMA_VERSION, closeAllRuntimeDatabases, getRuntimeDatabase, getSchemaVersion } from '../src/state/runtime-db.ts';
import { withRuntimeDatabaseConnection } from './helpers/runtime-database-probe.ts';
import { createManagedTempDir } from './helpers/temp-dirs.ts';

const StateRowSchema = z.object({ state_json: z.string() });
const ColumnRowsSchema = z.array(z.object({ name: z.string() }));

/** A schema-82 file holding one run; `sessionId` undefined drops the request field and the session column as 82 had them. */
function seedSchema82(sessionId: string | undefined): { dbPath: string; runId: string } {
  const repoRoot = createManagedTempDir('siftkit-session-links-repo-');
  const dbPath = path.join(createManagedTempDir('siftkit-session-links-'), 'runtime.sqlite');
  const run = new OrchestratorRunStore(getRuntimeDatabase(dbPath)).create({
    submissionId: randomUUID(), sessionId: sessionId ?? null, repoRoot, presetId: 'orchestrator', approval: 'auto',
    task: 'Inspect the README.', planPath: null,
  });
  closeAllRuntimeDatabases();
  withRuntimeDatabaseConnection(dbPath, (database) => {
    if (sessionId === undefined) {
      const state = JsonObjectSchema.parse(JSON.parse(StateRowSchema.parse(
        database.prepare('SELECT state_json FROM orchestrator_runs WHERE run_id = ?').get(run.runId)).state_json));
      const { sessionId: _future, ...request } = JsonObjectSchema.parse(state.request);
      database.prepare('UPDATE orchestrator_runs SET state_json = ? WHERE run_id = ?').run(JSON.stringify({ ...state, request }), run.runId);
      database.exec('ALTER TABLE chat_sessions DROP COLUMN orchestrator_run_id');
      database.exec(`ALTER TABLE orchestrator_runs ADD COLUMN repo_key TEXT;
        CREATE INDEX idx_orchestrator_runs_repo_key ON orchestrator_runs (repo_key, created_at_utc);`);
    }
    database.exec('UPDATE runtime_schema SET version = 82 WHERE id = 1');
  });
  return { dbPath, runId: run.runId };
}

test('the 82 to 83 upgrade adds the session link, retires repo_key, and gives every stored run an explicit null session', (t) => {
  t.after(closeAllRuntimeDatabases);
  const { dbPath, runId } = seedSchema82(undefined);
  const database = getRuntimeDatabase(dbPath);
  assert.equal(getSchemaVersion(database), CURRENT_SCHEMA_VERSION);
  const columns = ColumnRowsSchema.parse(database.prepare("SELECT name FROM pragma_table_info('chat_sessions')").all());
  assert.ok(columns.some((column) => column.name === 'orchestrator_run_id'));
  const runColumns = ColumnRowsSchema.parse(database.prepare("SELECT name FROM pragma_table_info('orchestrator_runs')").all());
  assert.ok(!runColumns.some((column) => column.name === 'repo_key'), 'finding runs by repository is retired with its column');
  assert.equal(new OrchestratorRunStore(database).read(runId).request.sessionId, null);
});

test('the 82 to 83 upgrade is idempotent and keeps a session a stored run already names', (t) => {
  t.after(closeAllRuntimeDatabases);
  const sessionId = randomUUID();
  const { dbPath, runId } = seedSchema82(sessionId);
  const database = getRuntimeDatabase(dbPath);
  assert.equal(getSchemaVersion(database), CURRENT_SCHEMA_VERSION);
  assert.equal(new OrchestratorRunStore(database).read(runId).request.sessionId, sessionId);
});
