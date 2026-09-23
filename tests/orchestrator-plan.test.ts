import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import type { SiftConfig } from '../src/config/types.js';
import { validateOrchestratorPlan } from '../src/orchestrator/plan.js';
import { getDefaultServerConfig } from './helpers/mock-config.js';
import { makeOrchestratorPlan, makeOrchestratorTask } from './helpers/orchestrator-plan.js';
import { createManagedTempDir } from './helpers/temp-dirs.js';

function createRepo(): string {
  const repoRoot = createManagedTempDir('siftkit-orchestrator-plan-');
  fs.writeFileSync(path.join(repoRoot, 'README.md'), '# Readme\n');
  fs.mkdirSync(path.join(repoRoot, 'src'));
  return repoRoot;
}

function configWithCustomWorkers(): SiftConfig {
  const config = getDefaultServerConfig();
  const repoSearch = config.Presets.find((preset) => preset.id === 'repo-search');
  assert.ok(repoSearch);
  config.Presets.push(
    { ...repoSearch, id: 'deep-read', label: 'Deep Read', builtin: false, deletable: true },
    { ...repoSearch, id: 'sneaky-writer', label: 'Sneaky Writer', builtin: false, deletable: true,
      allowedTools: [...repoSearch.allowedTools, 'write'] },
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

test('a supported custom read-only worker preset is accepted', () => {
  const plan = makeOrchestratorPlan([makeOrchestratorTask({ workerPresetId: 'deep-read' })]);
  assert.doesNotThrow(() => validateOrchestratorPlan(plan, configWithCustomWorkers(), createRepo()));
});

for (const [name, tasks, pattern] of [
  ['duplicate task ids', [makeOrchestratorTask(), makeOrchestratorTask()], /Duplicate task id 'inspect'/u],
  ['a missing dependency', [makeOrchestratorTask({ dependsOn: ['ghost'] })], /Task 'inspect' depends on missing task 'ghost'/u],
  ['a self dependency', [makeOrchestratorTask({ dependsOn: ['inspect'] })], /Task 'inspect' depends on itself/u],
  ['a cycle', [makeOrchestratorTask({ id: 'a', dependsOn: ['b'] }), makeOrchestratorTask({ id: 'b', dependsOn: ['a'] })],
    /Plan tasks form a dependency cycle: a -> b -> a/u],
  ['an unknown worker preset', [makeOrchestratorTask({ workerPresetId: 'ghost' })], /Preset 'ghost' was not found/u],
  ['a recursive orchestrator worker', [makeOrchestratorTask({ workerPresetId: 'orchestrator' })],
    /Task 'inspect' selects preset 'orchestrator' of kind 'orchestrator'; workers must be repo-agent or repo-search presets/u],
  ['write paths on a read-only worker', [makeOrchestratorTask({ writePaths: ['src/a.ts'] })],
    /Task 'inspect' uses read-only worker 'repo-search' but declares write paths/u],
  ['a read-only worker granting mutating tools', [makeOrchestratorTask({ workerPresetId: 'sneaky-writer' })],
    /Read-only worker preset 'sneaky-writer' grants mutating tools: write/u],
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
