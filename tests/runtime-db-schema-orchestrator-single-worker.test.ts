import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import test from 'node:test';

import { z } from '../src/lib/zod.ts';
import { JsonObjectSchema } from '../src/lib/json-types.ts';
import { OrchestratorRunStore } from '../src/orchestrator/run-store.ts';
import { CURRENT_SCHEMA_VERSION, closeAllRuntimeDatabases, getRuntimeDatabase, getSchemaVersion } from '../src/state/runtime-db.ts';
import { writeConfig } from '../src/status-server/config-store.ts';
import { getDefaultServerConfig } from './helpers/mock-config.ts';
import { makeOrchestratorPlan, makeOrchestratorTask } from './helpers/orchestrator-plan.ts';
import { withRuntimeDatabaseConnection } from './helpers/runtime-database-probe.ts';
import { createManagedTempDir } from './helpers/temp-dirs.ts';

const OLD_DESCRIPTION = 'Prepares an implementation plan, delegates bounded steps to repo-agent and repo-search workers, and verifies each one.';
const SURVEY = makeOrchestratorTask({ id: 'survey', workerPresetId: 'repo-search', writePaths: [] });
const WRITE = makeOrchestratorTask({ id: 'greeting', workerPresetId: 'repo-agent', writePaths: ['src/greeting.ts'] });
const PresetsRowSchema = z.object({ presets_json: z.string() });

/** A schema-88 file: a settled survey with a search report, a settled writer with a kinded report, and `description` stored. */
function seedSchema88(description: string, catalogIndent = 0): { dbPath: string; runId: string; catalogText: string } {
  const dbPath = path.join(createManagedTempDir('siftkit-single-worker-'), 'runtime.sqlite');
  writeConfig(dbPath, getDefaultServerConfig());
  const store = new OrchestratorRunStore(getRuntimeDatabase(dbPath));
  const created = store.create({ submissionId: randomUUID(), sessionId: null, repoRoot: createManagedTempDir('siftkit-single-worker-repo-'),
    presetId: 'orchestrator', approval: 'off', task: 'Add greeting.', planPath: null });
  const state = store.savePlan(created.runId, created.revision, makeOrchestratorPlan([SURVEY, WRITE]), 'docs/plan.md', 'hash');
  const survey = store.reserveAttempt(state.runId, state.revision, 'survey',
    { kind: 'implementation', planPath: 'docs/plan.md', planHash: 'hash', task: SURVEY, instruction: 'Find it.' });
  const write = store.reserveAttempt(state.runId, store.read(state.runId).revision, 'greeting',
    { kind: 'implementation', planPath: 'docs/plan.md', planHash: 'hash', task: WRITE, instruction: 'Write it.' });
  closeAllRuntimeDatabases();
  const catalogText = withRuntimeDatabaseConnection(dbPath, (database) => {
    const settle = database.prepare('UPDATE orchestrator_attempts SET attempt_json = ? WHERE child_run_id = ?');
    const seeded = [
      [survey, { kind: 'search', unknowns: [], findings: [{ claim: 'greet() at src/greeting.ts:1', evidence: [{ path: 'src/greeting.ts', line: 1 }] }] }],
      [write, { kind: 'agent', status: 'completed', deviations: [{ what: 'Kept the old export.', why: 'Callers use it.' }] }],
    ] as const;
    for (const [attempt, report] of seeded) {
      settle.run(JSON.stringify({ ...attempt, status: 'settled', result: {
        taskId: attempt.taskId, purpose: 'implementation', attempt: 1, childRunId: attempt.childRunId, workerStatus: 'completed',
        workerOutput: 'done', report, outcome: 'passed', submissions: 1, passed: true, checks: [], findings: [],
        changedPaths: attempt.work.task.writePaths, changeDigest: 'd',
      } }), attempt.childRunId);
    }
    const catalog = z.array(JsonObjectSchema).parse(JSON.parse(PresetsRowSchema.parse(
      database.prepare('SELECT presets_json FROM app_config WHERE id = 1').get()).presets_json));
    const stored = catalog.map((preset) => (preset.id === 'orchestrator' ? { ...preset, description } : preset));
    const text = JSON.stringify(stored, null, catalogIndent);
    database.prepare('UPDATE app_config SET presets_json = ? WHERE id = 1').run(text);
    database.exec('UPDATE runtime_schema SET version = 88 WHERE id = 1');
    return text;
  });
  return { dbPath, runId: state.runId, catalogText };
}

const StoredPresetSchema = z.object({ id: z.string(), description: z.string() }).passthrough();

function storedCatalogText(dbPath: string): string {
  return PresetsRowSchema.parse(getRuntimeDatabase(dbPath).prepare('SELECT presets_json FROM app_config WHERE id = 1').get()).presets_json;
}

function storedDescription(dbPath: string): string | undefined {
  return z.array(StoredPresetSchema).parse(JSON.parse(storedCatalogText(dbPath))).find((preset) => preset.id === 'orchestrator')?.description;
}

test('the 88 to 89 upgrade drops search reports, strips the report kind, and renews the stock orchestrator description', (t) => {
  t.after(closeAllRuntimeDatabases);
  const { dbPath, runId } = seedSchema88(OLD_DESCRIPTION);
  const database = getRuntimeDatabase(dbPath);
  assert.equal(getSchemaVersion(database), CURRENT_SCHEMA_VERSION);
  const [survey, write] = new OrchestratorRunStore(database).read(runId).attempts.map((attempt) => attempt.result?.report);
  assert.equal(survey, null, 'a survey report has no shape left; the attempt keeps its outcome');
  assert.deepEqual(write, { status: 'completed', deviations: [{ what: 'Kept the old export.', why: 'Callers use it.' }] });
  assert.equal(storedDescription(dbPath), getDefaultServerConfig().Presets.find((preset) => preset.id === 'orchestrator')?.description);
});

test('the 88 to 89 upgrade leaves a catalog whose orchestrator description the user edited byte for byte as stored', (t) => {
  t.after(closeAllRuntimeDatabases);
  const { dbPath, catalogText } = seedSchema88('My own orchestrator.', 2);
  assert.equal(storedCatalogText(dbPath), catalogText);
  assert.equal(storedDescription(dbPath), 'My own orchestrator.');
});
