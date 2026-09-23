import test from 'node:test';

import { ChildProcessEngineLauncher } from '../../src/status-server/engine-process.js';
import { acquireChildPortLease } from '../_runtime-helpers.js';
import { writeManagedEngineLauncher } from '../helpers/managed-engine-fixtures.js';
import { runManagedEngineReadinessScenario } from '../helpers/managed-engine-readiness-scenario.js';
import { createFakeExl3PackageLocator } from '../helpers/tabby-fake.js';
import { createManagedTempDir, removeDirectoryWithRetries } from '../helpers/temp-dirs.js';

/**
 * Fixture for tests/process/run-tests-watchdog.test.ts: the readiness scenario against real
 * engine child processes that never become ready, each recording its pid for the reaping check.
 */
test('managed engine readiness launches real engine processes that never become ready', async () => {
  const tempRoot = createManagedTempDir('siftkit-readiness-processes-');
  await using enginePortLease = await acquireChildPortLease('managed-engine-readiness-processes');
  const managed = writeManagedEngineLauncher(tempRoot, enginePortLease.port, 'managed-test-model', {
    launchHangingProcess: true,
  });
  try {
    await runManagedEngineReadinessScenario(tempRoot, managed, {
      launcher: new ChildProcessEngineLauncher(),
      packageLocator: createFakeExl3PackageLocator(managed.pythonPath),
    });
  } finally {
    // Windows releases a terminated launcher's working directory asynchronously, so removal retries.
    await removeDirectoryWithRetries(tempRoot);
  }
});
