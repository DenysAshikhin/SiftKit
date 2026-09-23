import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import {
  captureWorkspace,
  changesNeedDriftReview,
  cleanupScratch,
  diffWorkspace,
  findScopeViolations,
  orchestratorScratchDir,
  removeOwnedTemporaryPath,
  renderWorkspaceDiff,
} from '../../src/orchestrator/workspace.js';
import { createManagedTempDir } from '../helpers/temp-dirs.js';

const RUN_ID = '00000000-0000-4000-8000-000000000001';
const SCRATCH = orchestratorScratchDir(RUN_ID);

function makeRepo(): string {
  const root = createManagedTempDir('siftkit-orchestrator-workspace-');
  execFileSync('git', ['init', '--quiet'], { cwd: root });
  execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: root });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: root });
  execFileSync('git', ['config', 'core.autocrlf', 'false'], { cwd: root });
  fs.mkdirSync(path.join(root, 'src'));
  fs.writeFileSync(path.join(root, 'src', 'a.ts'), 'export const a = 1;\n');
  fs.writeFileSync(path.join(root, 'README.md'), '# Repo\n');
  execFileSync('git', ['add', '.'], { cwd: root });
  execFileSync('git', ['commit', '--quiet', '-m', 'initial'], { cwd: root });
  return root;
}

test('changes are measured from the baseline, so an untouched pre-existing edit is not attributed', async () => {
  const root = makeRepo();
  fs.writeFileSync(path.join(root, 'README.md'), '# Repo\nuser edit\n');
  const baseline = await captureWorkspace(root);
  assert.deepEqual(await diffWorkspace(root, baseline), { paths: [], digest: null });

  fs.writeFileSync(path.join(root, 'src', 'a.ts'), 'export const a = 2;\n');
  fs.writeFileSync(path.join(root, 'src', 'b.ts'), 'export const b = 1;\n');
  fs.mkdirSync(path.join(root, SCRATCH), { recursive: true });
  fs.writeFileSync(path.join(root, SCRATCH, 'notes.txt'), 'scratch');
  const changes = await diffWorkspace(root, baseline);
  assert.deepEqual(changes.paths, ['src/a.ts', 'src/b.ts'], 'run artifacts and the untouched user edit are excluded');
  assert.ok(changes.digest);

  fs.writeFileSync(path.join(root, 'src', 'b.ts'), 'export const b = 2;\n');
  assert.notEqual((await diffWorkspace(root, baseline)).digest, changes.digest, 'the digest names exact content');

  const diff = await renderWorkspaceDiff({ repoRoot: root, baseline, paths: ['src/a.ts', 'src/b.ts'], scratchDir: SCRATCH });
  assert.match(diff, /-export const a = 1;/u);
  assert.match(diff, /\+export const a = 2;/u);
  assert.match(diff, /\+export const b = 2;/u);
  assert.equal(fs.existsSync(path.join(root, SCRATCH, '.diff-staging')), false);
});

test('a child edit to a pre-existing dirty file is attributed against the dirty baseline, not HEAD', async () => {
  const root = makeRepo();
  fs.writeFileSync(path.join(root, 'src', 'a.ts'), 'export const a = 1;\n// user\n');
  const baseline = await captureWorkspace(root);
  fs.writeFileSync(path.join(root, 'src', 'a.ts'), 'export const a = 1;\n// user\n// child\n');
  const changes = await diffWorkspace(root, baseline);
  assert.deepEqual(changes.paths, ['src/a.ts']);
  const diff = await renderWorkspaceDiff({ repoRoot: root, baseline, paths: changes.paths, scratchDir: SCRATCH });
  assert.match(diff, /\+\/\/ child/u);
  assert.doesNotMatch(diff, /\+\/\/ user/u);
});

test('scope violations and the drift trigger follow the declared write paths and the change kind', () => {
  assert.deepEqual(findScopeViolations(['src/a.ts', 'src/lib/b.ts', 'docs/x.md', `${SCRATCH}/t.txt`], ['src/a.ts', 'src/lib']), ['docs/x.md']);
  assert.deepEqual(findScopeViolations(['src/a.ts'], []), ['src/a.ts']);
  assert.equal(changesNeedDriftReview([]), false);
  assert.equal(changesNeedDriftReview(['README.md', 'logs/run.log', `${SCRATCH}/x.ts`]), false);
  for (const codePath of ['src/a.ts', 'tests/a.test.ts', 'scripts/build.ps1', 'package.json']) {
    assert.equal(changesNeedDriftReview(['README.md', codePath]), true, codePath);
  }
});

test('cleanup removes only owned scratch files and rejects escapes without deleting their targets', () => {
  const root = makeRepo();
  fs.writeFileSync(path.join(root, 'src', 'a.ts'), 'dirty user change\n');
  const scratch = path.join(root, SCRATCH);
  fs.mkdirSync(path.join(scratch, 'nested'), { recursive: true });
  fs.writeFileSync(path.join(scratch, 'nested', 'tmp.txt'), 'temp');
  const outside = createManagedTempDir('siftkit-orchestrator-outside-');
  fs.writeFileSync(path.join(outside, 'keep.txt'), 'keep');
  fs.symlinkSync(outside, path.join(scratch, 'link-out'), 'junction');
  fs.mkdirSync(`${scratch}-sibling`, { recursive: true });

  for (const candidate of [SCRATCH, `${SCRATCH}/../plan.md`, `${SCRATCH}-sibling`, 'src/a.ts', outside]) {
    assert.throws(() => removeOwnedTemporaryPath(root, SCRATCH, candidate), /not inside the run scratch directory/u, candidate);
  }
  assert.throws(() => removeOwnedTemporaryPath(root, SCRATCH, `${SCRATCH}/link-out/keep.txt`), /real location is outside/u);

  cleanupScratch(root, SCRATCH);
  assert.deepEqual(fs.readdirSync(scratch), []);
  assert.equal(fs.readFileSync(path.join(outside, 'keep.txt'), 'utf8'), 'keep', 'a linked target survives');
  assert.equal(fs.readFileSync(path.join(root, 'src', 'a.ts'), 'utf8'), 'dirty user change\n');
  assert.ok(fs.existsSync(`${scratch}-sibling`));
});
