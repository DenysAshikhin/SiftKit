import { test } from 'vitest';
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';

import { SIFT_DEFAULT_STATUS_PORT } from '../../src/config/constants.ts';

// The guard must already be loaded by the suite setup, so it is imported only after the checks.
test('the live-instance guard and hermetic sandbox run inside the dashboard suite', async () => {
  assert.equal(process.env.SIFTKIT_RUNTIME_DATABASE_STORAGE, 'memory');
  assert.throws(() => fetch(`http://127.0.0.1:${SIFT_DEFAULT_STATUS_PORT}/health`), /live SiftKit status server/u);
  assert.throws(() => childProcess.spawnSync(process.execPath, ['--version']), /forbidden in the default test suite/u);
  const { drainGuardViolations } = await import('../../src/test-runner/live-instance-guard.ts');
  assert.equal(drainGuardViolations().length, 2);
});
