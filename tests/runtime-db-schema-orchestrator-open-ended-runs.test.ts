import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';

import { JsonObjectSchema, type JsonObject } from '../src/lib/json-types.ts';
import { z } from '../src/lib/zod.ts';
import { OrchestratorRunStore } from '../src/orchestrator/run-store.ts';
import { CURRENT_SCHEMA_VERSION, closeAllRuntimeDatabases, getRuntimeDatabase, getSchemaVersion } from '../src/state/runtime-db.ts';
import { writeConfig } from '../src/status-server/config-store.ts';
import { getDefaultServerConfig } from './helpers/mock-config.ts';
import { makeOrchestratorPlan, makeOrchestratorRequest, makeOrchestratorTask, savePlanned } from './helpers/orchestrator-plan.ts';
import { withRuntimeDatabaseConnection } from './helpers/runtime-database-probe.ts';
import { createManagedTempDir } from './helpers/temp-dirs.ts';

const StateRowSchema = z.object({ state_json: z.string() });
const TaskListSchema = z.array(JsonObjectSchema);

/** A schema-97 file holding one planned run that failed on the old finish limit; `damage` rewrites its stored state. */
function seedSchema97(damage: (state: JsonObject) => JsonObject): { dbPath: string; runId: string } {
  const dbPath = path.join(createManagedTempDir('siftkit-open-ended-'), 'runtime.sqlite');
  writeConfig(dbPath, getDefaultServerConfig());
  const store = new OrchestratorRunStore(getRuntimeDatabase(dbPath));
  const created = store.create(makeOrchestratorRequest({ repoRoot: createManagedTempDir('siftkit-open-ended-repo-') }));
  const { runId } = savePlanned(store, created, makeOrchestratorPlan([makeOrchestratorTask({ id: 'greeting' })]));
  closeAllRuntimeDatabases();
  withRuntimeDatabaseConnection(dbPath, (database) => {
    const stored = JsonObjectSchema.parse(JSON.parse(StateRowSchema.parse(
      database.prepare('SELECT state_json FROM orchestrator_runs WHERE run_id = ?').get(runId)).state_json));
    const { approaches: _approaches, retiredTasks: _retired, ...state } = stored;
    const { budget: _budget, ...request } = JsonObjectSchema.parse(state.request);
    const tasks = TaskListSchema.parse(state.tasks).map(({ approach: _approach, ...task }) => task);
    const legacy = { ...state, request, tasks, phase: 'failed',
      failure: { code: 'final_verification_failed', message: 'Final verification failed 3 times: boom', taskId: null } };
    database.prepare('UPDATE orchestrator_runs SET state_json = ?, phase = ? WHERE run_id = ?')
      .run(JSON.stringify(damage(legacy)), 'failed', runId);
    database.exec('UPDATE runtime_schema SET version = 97 WHERE id = 1');
  });
  return { dbPath, runId };
}

test('the 97 to 98 upgrade gives a stored run the default budget, approach 1, no retired tasks, and a spent-budget failure', (t) => {
  t.after(closeAllRuntimeDatabases);
  const { dbPath, runId } = seedSchema97((state) => state);
  const database = getRuntimeDatabase(dbPath);
  assert.equal(getSchemaVersion(database), CURRENT_SCHEMA_VERSION);
  const state = new OrchestratorRunStore(database).read(runId);
  assert.deepEqual(state.request.budget, { minutes: 720, dispatches: 80 });
  assert.deepEqual(state.approaches, [{ number: 1, title: 'Initial plan', startedAtUtc: state.createdAtUtc, outcome: null }]);
  assert.deepEqual(state.retiredTasks, []);
  assert.deepEqual(state.tasks.map((task) => [task.taskId, task.approach]), [['greeting', 1]]);
  assert.deepEqual(state.failure, { code: 'budget_exhausted', message: 'Final verification failed 3 times: boom', taskId: null });
});

test('the 97 to 98 upgrade gives a run that never saved a plan no approach', (t) => {
  t.after(closeAllRuntimeDatabases);
  const { dbPath, runId } = seedSchema97((state) => ({ ...state, plan: null, planPath: null, planHash: null, tasks: [] }));
  assert.deepEqual(new OrchestratorRunStore(getRuntimeDatabase(dbPath)).read(runId).approaches, []);
});

test('the 97 to 98 upgrade fails loudly on an unreadable stored run, naming it, and leaves the file at 97', (t) => {
  t.after(closeAllRuntimeDatabases);
  const { dbPath, runId } = seedSchema97((state) => ({ ...state, tasks: 'not a task list' }));
  assert.throws(() => getRuntimeDatabase(dbPath), new RegExp(`Orchestrator run ${runId} has an unreadable stored state`, 'u'));
  assert.equal(withRuntimeDatabaseConnection(dbPath, (database) => getSchemaVersion(database)), 97);
});
