import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { getRepoAgentWorkerEntrypoint } from '../src/repo-agent/worker-launcher.js';

test('compiled test entrypoints are isolated wrappers over bundled module graphs', () => {
  const entrypoint = path.resolve('.test-build', 'tests', 'test-build-artifacts.test.js');
  const bundle = path.resolve('.test-build', 'tests', 'test-build-artifacts.test.bundle.js');

  assert.equal(fs.readFileSync(entrypoint, 'utf8').trim(), "import './test-build-artifacts.test.bundle.js';");
  assert.equal(fs.existsSync(bundle), true, bundle);
});

test('compiled test modules preserve sibling worker resolution', () => {
  const workerEntrypoint = getRepoAgentWorkerEntrypoint();

  assert.equal(path.basename(workerEntrypoint), 'worker-main.js');
  assert.equal(fs.existsSync(workerEntrypoint), true, workerEntrypoint);
});
