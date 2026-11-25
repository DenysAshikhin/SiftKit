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
const AttemptRowSchema = z.object({ attempt_json: z.string() });
const TaskListSchema = z.array(JsonObjectSchema);

function withoutWhy(task: JsonObject): JsonObject {
  const { why: _why, ...rest } = task;
  return rest;
}

/** A schema-98 file with two runs: one planned and dispatched, one without a plan. `damage` rewrites the first run's state. */
function seedSchema98(damage: (state: JsonObject) => JsonObject): { dbPath: string; planned: string; unplanned: string } {
  const dbPath = path.join(createManagedTempDir('siftkit-task-purpose-'), 'runtime.sqlite');
  writeConfig(dbPath, getDefaultServerConfig());
  const store = new OrchestratorRunStore(getRuntimeDatabase(dbPath));
  const repoRoot = createManagedTempDir('siftkit-task-purpose-repo-');
  const task = makeOrchestratorTask({ id: 'greeting' });
  const state = savePlanned(store, store.create(makeOrchestratorRequest({ repoRoot })), makeOrchestratorPlan([task]));
  const attempt = store.reserveAttempt(state.runId, state.revision, 'greeting',
    { kind: 'implementation', planPath: 'docs/plan.md', planHash: 'hash', task, instruction: 'Do it.' }, 'The run is under way.');
  const unplanned = store.create(makeOrchestratorRequest({ repoRoot })).runId;
  closeAllRuntimeDatabases();
  withRuntimeDatabaseConnection(dbPath, (database) => {
    for (const runId of [state.runId, unplanned]) {
      const { statusLines: _lines, ...stored } = JsonObjectSchema.parse(JSON.parse(StateRowSchema.parse(
        database.prepare('SELECT state_json FROM orchestrator_runs WHERE run_id = ?').get(runId)).state_json));
      const plan = stored.plan === null ? null : JsonObjectSchema.parse(stored.plan);
      const legacy = { ...stored, plan: plan === null ? null : { ...plan, tasks: TaskListSchema.parse(plan.tasks).map(withoutWhy) } };
      database.prepare('UPDATE orchestrator_runs SET state_json = ? WHERE run_id = ?')
        .run(JSON.stringify(runId === state.runId ? damage(legacy) : legacy), runId);
    }
    const stored = JsonObjectSchema.parse(JSON.parse(AttemptRowSchema.parse(
      database.prepare('SELECT attempt_json FROM orchestrator_attempts WHERE child_run_id = ?').get(attempt.childRunId)).attempt_json));
    const work = JsonObjectSchema.parse(stored.work);
    database.prepare('UPDATE orchestrator_attempts SET attempt_json = ? WHERE child_run_id = ?')
      .run(JSON.stringify({ ...stored, work: { ...work, task: withoutWhy(JsonObjectSchema.parse(work.task)) } }), attempt.childRunId);
    database.exec('UPDATE runtime_schema SET version = 98 WHERE id = 1');
  });
  return { dbPath, planned: state.runId, unplanned };
}

test('the 98 to 99 upgrade gives every stored copy of a task a null why, and every run an empty list of lines', (t) => {
  t.after(closeAllRuntimeDatabases);
  const { dbPath, planned, unplanned } = seedSchema98((state) => state);
  const database = getRuntimeDatabase(dbPath);
  assert.equal(getSchemaVersion(database), CURRENT_SCHEMA_VERSION);
  // Reading parses the run and each of its attempts with the current schemas.
  const state = new OrchestratorRunStore(database).read(planned);
  assert.deepEqual(state.plan?.tasks.map((task) => task.why), [null]);
  assert.deepEqual(state.attempts.map((attempt) => attempt.work.task.why), [null]);
  assert.deepEqual(state.statusLines, []);
  assert.deepEqual(new OrchestratorRunStore(database).read(unplanned).statusLines, []);
});

test('the 98 to 99 upgrade fails loudly on an unreadable stored run, naming it, and leaves the file at 98', (t) => {
  t.after(closeAllRuntimeDatabases);
  const { dbPath, planned } = seedSchema98((state) => ({ ...state, plan: 'not a plan' }));
  assert.throws(() => getRuntimeDatabase(dbPath), new RegExp(`Orchestrator run ${planned} has an unreadable stored state`, 'u'));
  assert.equal(withRuntimeDatabaseConnection(dbPath, (database) => getSchemaVersion(database)), 98);
});
