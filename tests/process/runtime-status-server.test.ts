import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import {
  applyManagedScriptConfig,
  getDefaultConfig,
  requestJson,
  withTempEnv,
  startStatusServerProcess,
  acquireChildPortLease,
  writeManagedEngineLauncher,
  type HealthCheckResponse,
} from '../_runtime-helpers.js';

test('real status server reports a startup warning when the managed engine exits during startup', async () => {
  await withTempEnv(async (tempRoot) => {
    const statusPath = path.join(tempRoot, 'status', 'inference.txt');
    const configPath = path.join(tempRoot, 'config.json');
    await using enginePortLease = await acquireChildPortLease('runtime-status-server');
    const managed = writeManagedEngineLauncher(tempRoot, enginePortLease.port, 'managed-test-model', {
      engineLogLine: 'torch.cuda.OutOfMemoryError: CUDA out of memory.',
      exitAfterLog: true,
      exitCode: 7,
    });
    const config = getDefaultConfig();
    applyManagedScriptConfig(config, managed, { StartupTimeoutMs: 1_000 });
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8');

    const server = await startStatusServerProcess({
      statusPath,
      configPath,
      probeShimPath: managed.probeShimPath,
    });
    try {
      assert.match(String(server.startupWarning || ''), /TabbyAPI exited unexpectedly \(code=7/u);
      const health = await requestJson<HealthCheckResponse>(`http://127.0.0.1:${server.port}/health`);
      assert.equal(health.ok, true);
    } finally {
      await server.close();
    }
  });
});
