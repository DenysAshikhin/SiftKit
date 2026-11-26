import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import test from 'node:test';

import { parseJsonObjectText } from '../src/lib/json.ts';
import { z } from '../src/lib/zod.ts';
import { OrchestratorRunStore } from '../src/orchestrator/run-store.ts';
import { CURRENT_SCHEMA_VERSION, closeAllRuntimeDatabases, getRuntimeDatabase, getSchemaVersion } from '../src/state/runtime-db.ts';
import { writeConfig } from '../src/status-server/config-store.ts';
import { getDefaultServerConfig } from './helpers/mock-config.ts';
import { makeOrchestratorRequest } from './helpers/orchestrator-plan.ts';
import { withRuntimeDatabaseConnection } from './helpers/runtime-database-probe.ts';
import { createManagedTempDir } from './helpers/temp-dirs.ts';

const AT = '2026-11-25T12:00:00.000Z';
const StateRowSchema = z.object({ state_json: z.string() });

type SeedRun = { phase: string; finalOutput: string | null };

/** A schema-100 file of runs without a summary; a run with a final output also has its parent's log. */
function seedSchema100(runs: readonly SeedRun[]): { dbPath: string; runIds: string[] } {
  const dbPath = path.join(createManagedTempDir('siftkit-run-summary-'), 'runtime.sqlite');
  writeConfig(dbPath, getDefaultServerConfig());
  const store = new OrchestratorRunStore(getRuntimeDatabase(dbPath));
  const repoRoot = createManagedTempDir('siftkit-run-summary-repo-');
  const seeded = runs.map((run) => ({ ...run, parentRunId: randomUUID(),
    runId: store.create(makeOrchestratorRequest({ repoRoot, submissionId: randomUUID() })).runId }));
  closeAllRuntimeDatabases();
  withRuntimeDatabaseConnection(dbPath, (database) => {
    for (const { phase, finalOutput, parentRunId, runId } of seeded) {
      const { summary: _summary, ...stored } = parseJsonObjectText(StateRowSchema.parse(
        database.prepare('SELECT state_json FROM orchestrator_runs WHERE run_id = ?').get(runId)).state_json);
      database.prepare('UPDATE orchestrator_runs SET phase = ?, state_json = ? WHERE run_id = ?')
        .run(phase, JSON.stringify({ ...stored, phase, parentRunIds: [parentRunId] }), runId);
      if (finalOutput === null) continue;
      database.prepare(`INSERT INTO run_logs (run_id, request_id, run_kind, run_group, terminal_state, title, flushed_at_utc, repo_search_json)
        VALUES (?, ?, 'repo_search', 'repo_search', 'completed', 'run', ?, ?)`)
        .run(parentRunId, parentRunId, AT, JSON.stringify({ scorecard: { tasks: [{ finalOutput }] } }));
    }
    database.exec('UPDATE runtime_schema SET version = 100 WHERE id = 1');
  });
  return { dbPath, runIds: seeded.map(({ runId }) => runId) };
}

test('the 100 to 101 upgrade gives a completed run the summary its log still holds, and every other run none', (t) => {
  t.after(closeAllRuntimeDatabases);
  const finish = JSON.stringify({ status: 'completed', summary: 'Found 34 flaws.' });
  const { dbPath, runIds } = seedSchema100([
    { phase: 'completed', finalOutput: finish },
    { phase: 'completed', finalOutput: `All tasks are complete.\n\n${finish}` },
    { phase: 'completed', finalOutput: null },
    { phase: 'completed', finalOutput: 'No finish here.' },
    { phase: 'failed', finalOutput: JSON.stringify({ status: 'blocked', reason: 'No access.' }) },
  ]);
  const database = getRuntimeDatabase(dbPath);
  assert.equal(getSchemaVersion(database), CURRENT_SCHEMA_VERSION);
  // Reading parses each run with the current schema.
  const store = new OrchestratorRunStore(database);
  assert.deepEqual(runIds.map((runId) => store.read(runId).summary), ['Found 34 flaws.', 'Found 34 flaws.', null, null, null]);
});

test('the 100 to 101 upgrade fails loudly on an unreadable stored run, naming it, and leaves the file at 100', (t) => {
  t.after(closeAllRuntimeDatabases);
  const { dbPath, runIds } = seedSchema100([{ phase: 'completed', finalOutput: null }]);
  withRuntimeDatabaseConnection(dbPath, (database) => {
    database.prepare('UPDATE orchestrator_runs SET state_json = ? WHERE run_id = ?').run('{"parentRunIds":"none"}', runIds[0]);
  });
  assert.throws(() => getRuntimeDatabase(dbPath), new RegExp(`Orchestrator run ${String(runIds[0])} has an unreadable stored state`, 'u'));
  assert.equal(withRuntimeDatabaseConnection(dbPath, (database) => getSchemaVersion(database)), 100);
});
