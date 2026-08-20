import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import {
  assertCurrentTestBuild,
  createTestBuildStampContent,
  getTestBuildState,
  isTestsOnlyChange,
} from '../src/test-runner/test-build-state.js';
import { createManagedTempDir } from './helpers/temp-dirs.js';

const INPUT_FILES = [
  'src/input.ts',
  'scripts/input.ts',
  'bench/input.ts',
  'tests/input.test.ts',
  'dashboard/src/input.ts',
  'dashboard/tests/input.test.ts',
  'packages/contracts/src/input.ts',
  'package.json',
  'package-lock.json',
  'tsconfig.json',
  'tsconfig.scripts.json',
  'tsconfig.test.json',
  'tsconfig.test-build.json',
  'dashboard/tsconfig.json',
  'dashboard/tsconfig.test.json',
  'packages/contracts/package.json',
  'packages/contracts/tsconfig.json',
];

const REQUIRED_OUTPUT_FILES = [
  'dist/config/index.js',
  'dist/test-runner/run-tests.js',
  'dist/test-runner/test-targets.js',
  'dist/test-runner/live-instance-guard.js',
  '.test-build/package.json',
  '.test-build/npm-pack-dry-run.json',
  '.test-build/src/input.js',
  '.test-build/bench/input.js',
  '.test-build/tests/input.test.js',
  '.test-build/tests/input.test.bundle.js',
  '.test-build/dashboard/tests/input.test.js',
  '.test-build/dashboard/tests/input.test.bundle.js',
  '.test-build/tests/dashboard-api.test.js',
  '.test-build/tests/test-targets.test.js',
  '.test-build/tests/test-targets.test.bundle.js',
];

const INPUT_DIRECTORIES = [
  'src',
  'scripts',
  'bench',
  'tests',
  'dashboard/src',
  'dashboard/tests',
  'packages/contracts/src',
];

function writeRelative(root: string, relativePath: string, content = 'x'): string {
  const targetPath = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  fs.writeFileSync(targetPath, content, 'utf8');
  return targetPath;
}

function createCurrentBuildLayout(): { root: string; newestInputPath: string } {
  const root = createManagedTempDir('siftkit-test-build-state-');
  const oldTime = new Date('2026-01-01T00:00:00.000Z');
  const stampTime = new Date('2026-01-02T00:00:00.000Z');
  const inputPaths = INPUT_FILES.map((relativePath) => writeRelative(root, relativePath));
  for (const inputPath of inputPaths) {
    fs.utimesSync(inputPath, oldTime, oldTime);
  }
  for (const outputPath of REQUIRED_OUTPUT_FILES) {
    writeRelative(root, outputPath);
  }
  for (const inputDirectory of INPUT_DIRECTORIES) {
    const directoryPath = path.join(root, inputDirectory);
    fs.utimesSync(directoryPath, oldTime, oldTime);
  }
  const stampPath = writeRelative(root, '.test-build/.complete', createTestBuildStampContent(root));
  fs.utimesSync(stampPath, stampTime, stampTime);
  return { root, newestInputPath: inputPaths[0] };
}

test('test build state reports missing when the completion stamp is absent', () => {
  const root = createManagedTempDir('siftkit-test-build-state-missing-');

  assert.deepEqual(getTestBuildState(root), { kind: 'missing' });
  assert.throws(() => assertCurrentTestBuild(root), /npm run build:test/u);
});

test('test build state reports a malformed completion stamp', () => {
  const { root } = createCurrentBuildLayout();
  fs.writeFileSync(path.join(root, '.test-build', '.complete'), 'not-a-test-build\n', 'utf8');

  assert.deepEqual(getTestBuildState(root), {
    kind: 'malformed',
    stampPath: path.join(root, '.test-build', '.complete'),
  });
});

test('test build state reports incomplete when a required output is absent', () => {
  const { root } = createCurrentBuildLayout();
  const missingOutputPath = path.join(root, 'dist', 'config', 'index.js');
  fs.rmSync(missingOutputPath);

  assert.deepEqual(getTestBuildState(root), { kind: 'incomplete', missingOutputPath });
});

test('test build state reports an arbitrary missing test bundle as incomplete', () => {
  const { root } = createCurrentBuildLayout();
  const missingOutputPath = path.join(root, '.test-build', 'tests', 'input.test.bundle.js');
  fs.rmSync(missingOutputPath);

  assert.deepEqual(getTestBuildState(root), { kind: 'incomplete', missingOutputPath });
});

test('test build state names a changed input when artifacts are stale', () => {
  const { root, newestInputPath } = createCurrentBuildLayout();
  fs.writeFileSync(newestInputPath, 'changed', 'utf8');

  assert.deepEqual(getTestBuildState(root), {
    kind: 'stale',
    newestInputPath,
    changedInputPaths: ['src/input.ts'],
  });
  assert.throws(() => assertCurrentTestBuild(root), /npm run build:test/u);
});

test('test build state detects changed input content when its mtime is restored', () => {
  const { root, newestInputPath } = createCurrentBuildLayout();
  const originalTimes = fs.statSync(newestInputPath);
  fs.writeFileSync(newestInputPath, 'changed-with-restored-mtime', 'utf8');
  fs.utimesSync(newestInputPath, originalTimes.atime, originalTimes.mtime);

  assert.deepEqual(getTestBuildState(root), {
    kind: 'stale',
    newestInputPath,
    changedInputPaths: ['src/input.ts'],
  });
});

test('test build state accepts a complete artifact tree newer than every input', () => {
  const { root } = createCurrentBuildLayout();

  assert.deepEqual(getTestBuildState(root), { kind: 'current' });
  assert.doesNotThrow(() => assertCurrentTestBuild(root));
});

test('test build state ignores generated scratch beneath the tests directory', () => {
  const { root } = createCurrentBuildLayout();
  writeRelative(root, 'tests/.tmp/runtime-output.txt');

  assert.deepEqual(getTestBuildState(root), { kind: 'current' });
});

test('test build state rejects artifacts after a source input is deleted', () => {
  const { root } = createCurrentBuildLayout();
  const deletedInputPath = path.join(root, 'src', 'input.ts');
  fs.rmSync(deletedInputPath);

  assert.deepEqual(getTestBuildState(root), {
    kind: 'stale',
    newestInputPath: deletedInputPath,
    changedInputPaths: ['src/input.ts'],
  });
});

test('test build state lists every changed input for the fast-path decision', () => {
  const { root } = createCurrentBuildLayout();
  fs.writeFileSync(path.join(root, 'tests', 'input.test.ts'), 'changed', 'utf8');
  fs.writeFileSync(path.join(root, 'dashboard', 'tests', 'input.test.ts'), 'changed', 'utf8');

  const state = getTestBuildState(root);
  assert.equal(state.kind, 'stale');
  assert.deepEqual(
    state.kind === 'stale' ? state.changedInputPaths : [],
    ['dashboard/tests/input.test.ts', 'tests/input.test.ts'],
  );
});

test('a change confined to test directories qualifies for the tests-only fast path', () => {
  const { root } = createCurrentBuildLayout();
  fs.writeFileSync(path.join(root, 'tests', 'input.test.ts'), 'changed', 'utf8');
  fs.writeFileSync(path.join(root, 'dashboard', 'tests', 'input.test.ts'), 'changed', 'utf8');

  assert.equal(isTestsOnlyChange(getTestBuildState(root)), true);
});

test('a source change alongside a test change disqualifies the fast path', () => {
  const { root } = createCurrentBuildLayout();
  fs.writeFileSync(path.join(root, 'tests', 'input.test.ts'), 'changed', 'utf8');
  fs.writeFileSync(path.join(root, 'src', 'input.ts'), 'changed', 'utf8');

  assert.equal(isTestsOnlyChange(getTestBuildState(root)), false);
});

test('non-stale states never qualify for the fast path', () => {
  const { root } = createCurrentBuildLayout();

  assert.equal(isTestsOnlyChange(getTestBuildState(root)), false);
  assert.equal(isTestsOnlyChange({ kind: 'missing' }), false);
  // An inconsistent stamp reports stale with no changed inputs; that must rebuild fully.
  assert.equal(
    isTestsOnlyChange({ kind: 'stale', newestInputPath: root, changedInputPaths: [] }),
    false,
  );
});
