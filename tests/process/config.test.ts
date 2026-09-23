import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  initializeRuntime,
} from '../../src/config/index.js';
import { createManagedTempDir } from '../helpers/temp-dirs.js';

test('initializeRuntime creates and returns the runtime paths of the current repo', () => {
  const prev = process.env.sift_kit_status;
  const previousCwd = process.cwd();
  process.env.sift_kit_status = path.join(os.tmpdir(), `siftkit-init-${Date.now()}`, 'status', 'inference.txt');
  // The runtime root follows the cwd, so this runs in a scratch directory rather than the repo.
  process.chdir(createManagedTempDir('siftkit-init-runtime-'));
  try {
    const paths = initializeRuntime();
    assert.equal(typeof paths.RuntimeRoot, 'string');
    assert.equal(typeof paths.Logs, 'string');
    assert.equal(typeof paths.EvalFixtures, 'string');
    assert.equal(typeof paths.EvalResults, 'string');
    assert.ok(fs.existsSync(paths.RuntimeRoot));
    assert.ok(fs.existsSync(paths.Logs));
  } finally {
    process.chdir(previousCwd);
    if (prev !== undefined) {
      process.env.sift_kit_status = prev;
    } else {
      delete process.env.sift_kit_status;
    }
  }
});
