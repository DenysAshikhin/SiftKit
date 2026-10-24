import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import test from 'node:test';

import { OrchestratorRunStore } from '../src/orchestrator/run-store.ts';
import { CURRENT_SCHEMA_VERSION, closeAllRuntimeDatabases, getRuntimeDatabase, getSchemaVersion } from '../src/state/runtime-db.ts';
import { makeOrchestratorPlan, makeOrchestratorTask } from './helpers/orchestrator-plan.ts';
import { withRuntimeDatabaseConnection } from './helpers/runtime-database-probe.ts';
import { createManagedTempDir } from './helpers/temp-dirs.ts';

const TASK = makeOrchestratorTask({ id: 'greeting', title: 'Add greeting', workerPresetId: 'repo-agent', writePaths: ['src/greeting.ts'] });
const PLAN = makeOrchestratorPlan([TASK]);
const DRIFT_CHECK = { kind: 'command', command: 'npm test', cwd: '.', expectedExitCode: 0 };
const NOW = '2026-10-22T10:00:00.000Z';

function legacyResult(purpose: string, childRunId: string, passed: boolean) {
  return { taskId: 'greeting', purpose, attempt: 1, childRunId, workerStatus: 'completed', workerOutput: 'done', passed,
    checks: [], findings: passed ? [] : ['Check failed.'], changedPaths: ['src/greeting.ts'], scopeViolations: [], changeDigest: 'd' };
}

/** A schema-83 file holding one failed state-machine run: an implementation, a failed drift correction, and its events. */
function seedSchema83(): { dbPath: string; runId: string; parentRunId: string } {
  const repoRoot = createManagedTempDir('siftkit-single-parent-repo-');
  const dbPath = path.join(createManagedTempDir('siftkit-single-parent-'), 'runtime.sqlite');
  const run = new OrchestratorRunStore(getRuntimeDatabase(dbPath)).create({
    submissionId: randomUUID(), sessionId: null, repoRoot, presetId: 'orchestrator', approval: 'off', task: 'Add greeting.', planPath: null,
  });
  closeAllRuntimeDatabases();
  const parentRunId = randomUUID();
  const implementation = randomUUID();
  const drift = randomUUID();
  withRuntimeDatabaseConnection(dbPath, (database) => {
    const state = {
      runId: run.runId, request: run.request, revision: 9, phase: 'failed', planPath: '.siftkit/orchestrator/plan.md', planHash: 'hash',
      plan: PLAN, phaseRunIds: [parentRunId], approval: null, createdAtUtc: NOW, updatedAtUtc: NOW,
      tasks: [{ taskId: 'greeting', status: 'failed', driftReview: null, reviewedDigests: ['d'] }],
      failure: { code: 'drift_unresolved', message: 'Task greeting still has drift.', taskId: 'greeting', purpose: 'drift_fix', findingIds: ['D1'] },
    };
    database.prepare('UPDATE orchestrator_runs SET state_json = ?, phase = ? WHERE run_id = ?').run(JSON.stringify(state), 'failed', run.runId);
    database.exec(`DROP TABLE orchestrator_attempts;
      CREATE TABLE orchestrator_attempts (
        run_id TEXT NOT NULL REFERENCES orchestrator_runs(run_id) ON DELETE CASCADE, task_id TEXT NOT NULL,
        purpose TEXT NOT NULL CHECK (purpose IN ('implementation', 'drift_fix')), attempt INTEGER NOT NULL CHECK (attempt IN (1, 2)),
        child_run_id TEXT NOT NULL UNIQUE, attempt_json TEXT NOT NULL, PRIMARY KEY (run_id, task_id, purpose, attempt));`);
    const insert = database.prepare('INSERT INTO orchestrator_attempts VALUES (?, ?, ?, ?, ?, ?)');
    insert.run(run.runId, 'greeting', 'implementation', 1, implementation, JSON.stringify({
      taskId: 'greeting', purpose: 'implementation', attempt: 1, childRunId: implementation, status: 'settled', reservedAtUtc: NOW,
      work: { kind: 'implementation', planPath: state.planPath, planHash: 'hash', task: TASK }, result: legacyResult('implementation', implementation, true),
    }));
    insert.run(run.runId, 'greeting', 'drift_fix', 1, drift, JSON.stringify({
      taskId: 'greeting', purpose: 'drift_fix', attempt: 1, childRunId: drift, status: 'settled', reservedAtUtc: NOW,
      work: { kind: 'drift_fix', taskId: 'greeting', objective: 'Remove the shim.', changeDigest: 'd', allowedPaths: ['src/greeting.ts', 'tests/greeting.test.ts'],
        verification: [DRIFT_CHECK], findings: [{ id: 'D1', title: 'Legacy shim', fix: 'Delete legacyGreeting.' }] },
      result: legacyResult('drift_fix', drift, false),
    }));
    database.prepare('INSERT INTO orchestrator_events VALUES (?, ?, ?)').run(run.runId, 2, JSON.stringify({
      runId: run.runId, sequence: 2, atUtc: NOW, phase: 'validating_plan', message: 'Reserved drift_fix attempt 1.', taskId: 'greeting',
      purpose: 'drift_fix', attempt: 1, childRunId: drift,
    }));
    database.exec('UPDATE runtime_schema SET version = 83 WHERE id = 1');
  });
  return { dbPath, runId: run.runId, parentRunId };
}

test('the 83 to 84 upgrade turns a state-machine run into a readable single-orchestrator run', (t) => {
  t.after(closeAllRuntimeDatabases);
  const { dbPath, runId, parentRunId } = seedSchema83();
  const database = getRuntimeDatabase(dbPath);
  assert.equal(getSchemaVersion(database), CURRENT_SCHEMA_VERSION);
  const store = new OrchestratorRunStore(database);
  const state = store.read(runId);
  assert.deepEqual(state.parentRunIds, [parentRunId]);
  assert.deepEqual(state.tasks, [{ taskId: 'greeting', status: 'failed', review: null }]);
  assert.deepEqual(state.failure, { code: 'blocked', message: 'Task greeting still has drift.', taskId: 'greeting' });
  const [implementation, fix] = state.attempts;
  assert.equal(implementation?.result?.outcome, 'passed');
  assert.equal(fix?.purpose, 'fix');
  assert.equal(fix?.work.kind, 'fix');
  assert.deepEqual(fix?.work.task.writePaths, ['src/greeting.ts', 'tests/greeting.test.ts']);
  assert.deepEqual(fix?.work.task.verification, [DRIFT_CHECK]);
  assert.match(fix?.work.instruction ?? '', /Remove the shim\.\n- D1: Legacy shim \(fix: Delete legacyGreeting\.\)/u);
  assert.equal(fix?.result?.outcome, 'checks_failed');
  const event = store.readEvents(runId, 1).find((entry) => entry.sequence === 2);
  assert.equal(event?.purpose, 'fix');
  assert.equal(event?.phase, 'preparing_plan');
});

test('after the upgrade the attempts table refuses the retired purpose', (t) => {
  t.after(closeAllRuntimeDatabases);
  const { dbPath, runId } = seedSchema83();
  const database = getRuntimeDatabase(dbPath);
  assert.throws(() => database.prepare('INSERT INTO orchestrator_attempts VALUES (?, ?, ?, ?, ?, ?)')
    .run(runId, 'greeting', 'drift_fix', 2, randomUUID(), '{}'), /CHECK constraint/u);
});
