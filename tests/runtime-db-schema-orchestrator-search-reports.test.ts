import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import test from 'node:test';

import { OrchestratorRunStore } from '../src/orchestrator/run-store.ts';
import { CURRENT_SCHEMA_VERSION, closeAllRuntimeDatabases, getRuntimeDatabase, getSchemaVersion } from '../src/state/runtime-db.ts';
import { makeOrchestratorPlan, makeOrchestratorTask } from './helpers/orchestrator-plan.ts';
import { withRuntimeDatabaseConnection } from './helpers/runtime-database-probe.ts';
import { createManagedTempDir } from './helpers/temp-dirs.ts';

const SURVEY = makeOrchestratorTask({ id: 'survey', workerPresetId: 'repo-search', writePaths: [] });
const WRITE = makeOrchestratorTask({ id: 'greeting', workerPresetId: 'repo-agent', writePaths: ['src/greeting.ts'] });
const AGENT_REPORT = { kind: 'agent', status: 'completed', deviations: [] };

/** A schema-85 file with a settled survey whose report restates the question and grades each finding. */
function seedSchema85(): { dbPath: string; runId: string } {
  const dbPath = path.join(createManagedTempDir('siftkit-search-reports-'), 'runtime.sqlite');
  const store = new OrchestratorRunStore(getRuntimeDatabase(dbPath));
  const created = store.create({ submissionId: randomUUID(), sessionId: null, repoRoot: createManagedTempDir('siftkit-search-reports-repo-'),
    presetId: 'orchestrator', approval: 'off', task: 'Add greeting.', planPath: null });
  const state = store.savePlan(created.runId, created.revision, makeOrchestratorPlan([SURVEY, WRITE]), 'docs/plan.md', 'hash');
  const survey = store.reserveAttempt(state.runId, state.revision, 'survey',
    { kind: 'implementation', planPath: 'docs/plan.md', planHash: 'hash', task: SURVEY, instruction: 'Find it.' });
  const write = store.reserveAttempt(state.runId, store.read(state.runId).revision, 'greeting',
    { kind: 'implementation', planPath: 'docs/plan.md', planHash: 'hash', task: WRITE, instruction: 'Write it.' });
  closeAllRuntimeDatabases();
  withRuntimeDatabaseConnection(dbPath, (database) => {
    const settle = database.prepare('UPDATE orchestrator_attempts SET attempt_json = ? WHERE child_run_id = ?');
    const seeded = [
      [survey, { kind: 'search', understood: 'Where greetings live.', unknowns: ['Who calls it.'],
        findings: [{ claim: 'greet() at src/greeting.ts:1', evidence: [{ path: 'src/greeting.ts', line: 1 }], confidence: 'high' }] }],
      [write, AGENT_REPORT],
    ] as const;
    for (const [attempt, report] of seeded) {
      settle.run(JSON.stringify({ ...attempt, status: 'settled', result: {
        taskId: attempt.taskId, purpose: 'implementation', attempt: 1, childRunId: attempt.childRunId, workerStatus: 'completed',
        workerOutput: 'done', report, outcome: 'passed', submissions: 1, passed: true, checks: [], findings: [],
        changedPaths: attempt.work.task.writePaths, changeDigest: 'd',
      } }), attempt.childRunId);
    }
    database.exec('UPDATE runtime_schema SET version = 85 WHERE id = 1');
  });
  return { dbPath, runId: state.runId };
}

test('the 85 to 86 upgrade strips the restated question and confidence grades from search reports', (t) => {
  t.after(closeAllRuntimeDatabases);
  const { dbPath, runId } = seedSchema85();
  const database = getRuntimeDatabase(dbPath);
  assert.equal(getSchemaVersion(database), CURRENT_SCHEMA_VERSION);
  const [survey, write] = new OrchestratorRunStore(database).read(runId).attempts.map((attempt) => attempt.result?.report);
  assert.deepEqual(survey, { kind: 'search', unknowns: ['Who calls it.'],
    findings: [{ claim: 'greet() at src/greeting.ts:1', evidence: [{ path: 'src/greeting.ts', line: 1 }] }] });
  assert.deepEqual(write, AGENT_REPORT, 'agent reports are untouched');
});
