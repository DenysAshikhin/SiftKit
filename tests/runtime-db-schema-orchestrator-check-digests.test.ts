import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import test from 'node:test';

import type { JsonValue } from '../src/lib/json-types.ts';
import { OrchestratorRunStore } from '../src/orchestrator/run-store.ts';
import { CURRENT_SCHEMA_VERSION, closeAllRuntimeDatabases, getRuntimeDatabase, getSchemaVersion } from '../src/state/runtime-db.ts';
import { writeConfig } from '../src/status-server/config-store.ts';
import { getDefaultServerConfig } from './helpers/mock-config.ts';
import { makeOrchestratorPlan, makeOrchestratorTask } from './helpers/orchestrator-plan.ts';
import { withRuntimeDatabaseConnection } from './helpers/runtime-database-probe.ts';
import { createManagedTempDir } from './helpers/temp-dirs.ts';

const CHECK = { kind: 'command', command: 'npm test', cwd: '.', expectedExitCode: 0 } as const;
const WRITE = makeOrchestratorTask({ id: 'greeting', workerPresetId: 'repo-agent', writePaths: ['src/greeting.ts'], verification: [CHECK] });
const STORED_CHECK = { check: CHECK, executed: true, exitCode: 1, timedOut: false, output: 'FAIL greeting.test.ts' };

/** A schema-89 file holding one settled attempt whose stored result has `checks`. */
function seedSchema89(checks: JsonValue): { dbPath: string; runId: string } {
  const dbPath = path.join(createManagedTempDir('siftkit-check-digests-'), 'runtime.sqlite');
  writeConfig(dbPath, getDefaultServerConfig());
  const store = new OrchestratorRunStore(getRuntimeDatabase(dbPath));
  const created = store.create({ submissionId: randomUUID(), sessionId: null, repoRoot: createManagedTempDir('siftkit-check-digests-repo-'),
    presetId: 'orchestrator', approval: 'off', task: 'Add greeting.', planPath: null });
  const state = store.savePlan(created.runId, created.revision, makeOrchestratorPlan([WRITE]), 'docs/plan.md', 'hash');
  const attempt = store.reserveAttempt(state.runId, state.revision, 'greeting',
    { kind: 'implementation', planPath: 'docs/plan.md', planHash: 'hash', task: WRITE, instruction: 'Write it.' });
  closeAllRuntimeDatabases();
  withRuntimeDatabaseConnection(dbPath, (database) => {
    database.prepare('UPDATE orchestrator_attempts SET attempt_json = ? WHERE child_run_id = ?').run(JSON.stringify({ ...attempt, status: 'settled', result: {
      taskId: 'greeting', purpose: 'implementation', attempt: 1, childRunId: attempt.childRunId, workerStatus: 'completed',
      workerOutput: 'done', report: null, outcome: 'checks_failed', submissions: 3, passed: false, checks,
      findings: ['Check `npm test` exited 1; expected 0.'], changedPaths: ['src/greeting.ts'], changeDigest: 'd',
    } }), attempt.childRunId);
    database.exec('UPDATE runtime_schema SET version = 89 WHERE id = 1');
  });
  return { dbPath, runId: state.runId };
}

test('the 89 to 90 upgrade gives every stored check result a null digest', (t) => {
  t.after(closeAllRuntimeDatabases);
  const { dbPath, runId } = seedSchema89([STORED_CHECK]);
  const database = getRuntimeDatabase(dbPath);
  assert.equal(CURRENT_SCHEMA_VERSION, 90);
  assert.equal(getSchemaVersion(database), CURRENT_SCHEMA_VERSION);
  assert.deepEqual(new OrchestratorRunStore(database).read(runId).attempts[0]?.result?.checks, [{ ...STORED_CHECK, digest: null }]);
});

test('the 89 to 90 upgrade fails loudly on an unreadable stored attempt, naming its run, and leaves the file at 89', (t) => {
  t.after(closeAllRuntimeDatabases);
  const { dbPath, runId } = seedSchema89('not a list of checks');
  assert.throws(() => getRuntimeDatabase(dbPath), new RegExp(`Orchestrator run ${runId} has an unreadable stored attempt`, 'u'));
  assert.equal(withRuntimeDatabaseConnection(dbPath, (database) => getSchemaVersion(database)), 89);
});
