import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import type { SiftConfig } from '../src/config/types.ts';
import { findPlanPathProblems, findTestPathsOutsideScope, ORCHESTRATOR_MAX_WRITE_PATHS, validateOrchestratorPlan } from '../src/orchestrator/plan.ts';
import { getDefaultServerConfig } from './helpers/mock-config.ts';
import { makeOrchestratorPlan, makeOrchestratorTask } from './helpers/orchestrator-plan.ts';
import { createManagedTempDir } from './helpers/temp-dirs.ts';

function createRepo(): string {
  const repoRoot = createManagedTempDir('siftkit-orchestrator-plan-');
  fs.writeFileSync(path.join(repoRoot, 'README.md'), '# Readme\n');
  fs.mkdirSync(path.join(repoRoot, 'src'));
  return repoRoot;
}

function configWithCustomWorkers(): SiftConfig {
  const config = getDefaultServerConfig();
  const repoAgent = config.Presets.find((preset) => preset.id === 'repo-agent');
  assert.ok(repoAgent);
  config.Presets.push(
    { ...repoAgent, id: 'careful-writer', label: 'Careful Writer', builtin: false, deletable: true },
    { ...repoAgent, id: 'read-only-agent', label: 'Read-only Agent', builtin: false, deletable: true, allowedTools: ['read', 'grep'] },
  );
  return config;
}

const WRITE_TASK = makeOrchestratorTask({ id: 'edit', title: 'Edit source', dependsOn: ['inspect'],
  workerPresetId: 'repo-agent', writePaths: ['src/feature.ts'] });

test('an acyclic two-task plan validates and normalizes path keys', () => {
  const repoRoot = createRepo();
  const plan = makeOrchestratorPlan([
    makeOrchestratorTask({ readPaths: ['.\\README.md'] }),
    WRITE_TASK,
  ]);
  const validated = validateOrchestratorPlan(plan, getDefaultServerConfig(), repoRoot);
  assert.deepEqual(validated.tasks[0]?.readPaths, ['README.md']);
  assert.deepEqual(validated.tasks[1]?.writePaths, ['src/feature.ts']);
});

test('a custom repo-agent worker preset that can change files is accepted', () => {
  const plan = makeOrchestratorPlan([makeOrchestratorTask({ workerPresetId: 'careful-writer' })]);
  assert.doesNotThrow(() => validateOrchestratorPlan(plan, configWithCustomWorkers(), createRepo()));
});

for (const [name, tasks, pattern] of [
  ['duplicate task ids', [makeOrchestratorTask(), makeOrchestratorTask()], /Duplicate task id 'inspect'/u],
  ['a missing dependency', [makeOrchestratorTask({ dependsOn: ['ghost'] })],
    /Task 'inspect' depends on missing task 'ghost': add 'ghost' in this same call, or remove it from dependsOn\./u],
  ['a self dependency', [makeOrchestratorTask({ dependsOn: ['inspect'] })], /Task 'inspect' depends on itself/u],
  ['a cycle', [makeOrchestratorTask({ id: 'a', dependsOn: ['b'] }), makeOrchestratorTask({ id: 'b', dependsOn: ['a'] })],
    /Plan tasks form a dependency cycle: a -> b -> a/u],
  ['an unknown worker preset', [makeOrchestratorTask({ workerPresetId: 'ghost' })], /Preset 'ghost' was not found/u],
  ['a recursive orchestrator worker', [makeOrchestratorTask({ workerPresetId: 'orchestrator' })],
    /Task 'inspect' selects preset 'orchestrator' \(orchestrator\); workers must be repo-agent presets that can change files/u],
  ['a repo-search worker', [makeOrchestratorTask({ workerPresetId: 'repo-search' })],
    /Task 'inspect' selects preset 'repo-search' \(repo-search\); workers must be repo-agent presets that can change files/u],
  ['a repo-agent worker that cannot change files', [makeOrchestratorTask({ workerPresetId: 'read-only-agent' })],
    /Task 'inspect' selects preset 'read-only-agent' \(repo-agent\); workers must be repo-agent presets that can change files/u],
  ['a task with no write paths', [makeOrchestratorTask({ writePaths: [] })],
    /Task 'inspect' lists no writePaths; name the files it is expected to change/u],
  ['a parent-relative escape', [makeOrchestratorTask({ readPaths: ['../outside.md'] })], /Task 'inspect' path '..\/outside.md' escapes the repository/u],
  ['an absolute path', [makeOrchestratorTask({ readPaths: [path.resolve('/elsewhere/file.md')] })], /escapes the repository/u],
] as const) {
  test(`plan validation rejects ${name}`, () => {
    assert.throws(() => validateOrchestratorPlan(makeOrchestratorPlan([...tasks]), configWithCustomWorkers(), createRepo()), pattern);
  });
}

test('plan validation rejects a path that escapes through a junction', () => {
  const repoRoot = createRepo();
  const outside = createManagedTempDir('siftkit-orchestrator-outside-');
  fs.symlinkSync(outside, path.join(repoRoot, 'linked'), 'junction');
  const plan = makeOrchestratorPlan([makeOrchestratorTask({ readPaths: ['linked/secret.md'] })]);
  assert.throws(() => validateOrchestratorPlan(plan, getDefaultServerConfig(), repoRoot), /path 'linked\/secret.md' escapes the repository/u);
});

test('verification commands and evidence paths are repository scoped too', () => {
  const repoRoot = createRepo();
  const plan = makeOrchestratorPlan([makeOrchestratorTask({
    verification: [{ kind: 'command', command: 'npm test', cwd: '../elsewhere', expectedExitCode: 0 }],
  })]);
  assert.throws(() => validateOrchestratorPlan(plan, getDefaultServerConfig(), repoRoot), /path '..\/elsewhere' escapes the repository/u);
});

test('a changed test file outside the writePaths of its task is out of scope; source files and in-scope tests are not', () => {
  const task = makeOrchestratorTask({ id: 'greeting', writePaths: ['src/greeting.ts', 'tests/greeting.test.ts', 'tests/fixtures'] });
  const changed = [
    'src/greeting.ts', 'src/other.ts', 'tests/greeting.test.ts', 'tests/fixtures/greeting.json',
    'tests/process/audit.test.ts', 'dashboard/tests/panel.test.tsx', 'src/lib/__tests__/helper.ts', 'src/widget.spec.ts', 'tests/helpers/harness.ts',
  ];
  assert.deepEqual(findTestPathsOutsideScope(task, changed),
    ['tests/process/audit.test.ts', 'dashboard/tests/panel.test.tsx', 'src/lib/__tests__/helper.ts', 'src/widget.spec.ts', 'tests/helpers/harness.ts']);
  assert.deepEqual(findTestPathsOutsideScope(makeOrchestratorTask({ id: 'root', writePaths: ['.'] }), changed), []);
});

const paths = (count: number) => Array.from({ length: count }, (_, index) => `src/f${index}.ts`);

// Real case (run e85529c8): the 11- and 13-path tasks compacted mid-task or stalled; the prompt's limit was never enforced.
test('a new or widened task over the write-path limit is refused; one the call leaves alone is not judged again', () => {
  const wide = makeOrchestratorTask({ id: 'wide', writePaths: paths(ORCHESTRATOR_MAX_WRITE_PATHS + 1) });
  assert.deepEqual(findPlanPathProblems(null, makeOrchestratorPlan([wide]), []), [
    `Task 'wide' lists ${ORCHESTRATOR_MAX_WRITE_PATHS + 1} writePaths; a task may change at most ${ORCHESTRATOR_MAX_WRITE_PATHS} paths.`
      + ' Split it into tasks that each finish within one worker context.',
  ]);
  const saved = makeOrchestratorPlan([wide]);
  assert.deepEqual(findPlanPathProblems(saved, saved, []), []);
  assert.deepEqual(findPlanPathProblems(null, makeOrchestratorPlan([makeOrchestratorTask({ writePaths: paths(ORCHESTRATOR_MAX_WRITE_PATHS) })]), []), []);
});

// Real case (run e85529c8): a planned hooks/use-orchestrator-run.test.tsx duplicated the existing test file of that name.
test('a task that creates a test file whose name exists elsewhere is refused; existing paths and source files are not', () => {
  const files = ['dashboard/tests/use-run.test.tsx', 'src/index.ts'];
  const task = makeOrchestratorTask({ id: 'hook',
    writePaths: ['dashboard/tests/hooks/use-run.test.tsx', 'src/lib/index.ts', 'dashboard/tests/use-run.test.tsx'] });
  assert.deepEqual(findPlanPathProblems(null, makeOrchestratorPlan([task]), files), [
    "Task 'hook' creates 'dashboard/tests/hooks/use-run.test.tsx', but 'dashboard/tests/use-run.test.tsx' already exists:"
      + ' name the existing test file, or give a new file a name that says how it differs.',
  ]);
});
