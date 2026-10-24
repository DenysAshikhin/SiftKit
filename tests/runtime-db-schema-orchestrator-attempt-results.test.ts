import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import test from 'node:test';

import { OrchestratorRunStore } from '../src/orchestrator/run-store.ts';
import { CURRENT_SCHEMA_VERSION, closeAllRuntimeDatabases, getRuntimeDatabase, getSchemaVersion } from '../src/state/runtime-db.ts';
import { makeOrchestratorPlan, makeOrchestratorTask } from './helpers/orchestrator-plan.ts';
import { withRuntimeDatabaseConnection } from './helpers/runtime-database-probe.ts';
import { createManagedTempDir } from './helpers/temp-dirs.ts';

const TASK = makeOrchestratorTask({ id: 'greeting', workerPresetId: 'repo-agent', writePaths: ['src/greeting.ts'] });
const OTHER = makeOrchestratorTask({ id: 'farewell', workerPresetId: 'repo-agent', writePaths: ['src/farewell.ts'] });

function legacyReport(criterion: 'met' | 'not_met', deviations: string[], discoveredNeeds: string[]) {
  return { kind: 'agent', understood: 'Add it.', steps: [{ index: 0, status: 'done', note: '' }], changes: [], tests: [], commands: [],
    criteria: [{ index: 0, status: criterion, evidence: [] }], deviations, discoveredNeeds, risks: ['Concurrent saves.'] };
}

/** A schema-84 file whose settled attempts carry write-scope violations and the long agent account. */
function seedSchema84(): { dbPath: string; runId: string } {
  const dbPath = path.join(createManagedTempDir('siftkit-attempt-results-'), 'runtime.sqlite');
  const store = new OrchestratorRunStore(getRuntimeDatabase(dbPath));
  const created = store.create({ submissionId: randomUUID(), sessionId: null, repoRoot: createManagedTempDir('siftkit-attempt-results-repo-'),
    presetId: 'orchestrator', approval: 'off', task: 'Add greeting.', planPath: null });
  const state = store.savePlan(created.runId, created.revision, makeOrchestratorPlan([TASK, OTHER]), 'docs/plan.md', 'hash');
  const blocked = store.reserveAttempt(state.runId, state.revision, 'greeting',
    { kind: 'implementation', planPath: 'docs/plan.md', planHash: 'hash', task: TASK, instruction: 'Implement it.' });
  const failed = store.reserveAttempt(state.runId, store.read(state.runId).revision, 'farewell',
    { kind: 'implementation', planPath: 'docs/plan.md', planHash: 'hash', task: OTHER, instruction: 'Implement it.' });
  closeAllRuntimeDatabases();
  withRuntimeDatabaseConnection(dbPath, (database) => {
    const settle = database.prepare('UPDATE orchestrator_attempts SET attempt_json = ? WHERE child_run_id = ?');
    const seeded = [
      [blocked, 'scope_blocked', legacyReport('met', ['Kept the old export.'], ['The CLI needs it.'])],
      [failed, 'checks_failed', legacyReport('not_met', [], [])],
    ] as const;
    for (const [attempt, outcome, report] of seeded) {
      settle.run(JSON.stringify({ ...attempt, status: 'settled', result: {
        taskId: attempt.taskId, purpose: 'implementation', attempt: 1, childRunId: attempt.childRunId, workerStatus: 'completed',
        workerOutput: 'done', report, outcome, submissions: 1, passed: false, checks: [],
        findings: ['Changed docs/x.md, which is outside the task\'s write scope.'],
        changedPaths: [...attempt.work.task.writePaths, 'docs/x.md'], scopeViolations: ['docs/x.md'], changeDigest: 'd',
      } }), attempt.childRunId);
    }
    database.exec('UPDATE runtime_schema SET version = 84 WHERE id = 1');
  });
  return { dbPath, runId: state.runId };
}

test('the 84 to 85 upgrade drops write scope and reduces agent reports to a status and deviations', (t) => {
  t.after(closeAllRuntimeDatabases);
  const { dbPath, runId } = seedSchema84();
  const database = getRuntimeDatabase(dbPath);
  assert.equal(getSchemaVersion(database), CURRENT_SCHEMA_VERSION);
  const [greeting, farewell] = new OrchestratorRunStore(database).read(runId).attempts.map((attempt) => attempt.result);
  assert.deepEqual([greeting?.outcome, greeting?.passed, greeting?.findings], ['passed', true, []], 'scope was its only failure');
  assert.deepEqual([farewell?.outcome, farewell?.passed, farewell?.findings], ['checks_failed', false, []]);
  assert.deepEqual(greeting?.changedPaths, ['src/greeting.ts', 'docs/x.md']);
  assert.equal(greeting !== null && greeting !== undefined && 'scopeViolations' in greeting, false);
  assert.deepEqual(greeting?.report, { kind: 'agent', status: 'completed', deviations: [
    { what: 'Kept the old export.', why: 'Stated with the deviation in a schema-84 report.' },
    { what: 'The CLI needs it.', why: 'Work the child found for another task.' },
  ] });
  assert.deepEqual(farewell?.report, { kind: 'agent', status: 'incomplete', deviations: [] });
});
