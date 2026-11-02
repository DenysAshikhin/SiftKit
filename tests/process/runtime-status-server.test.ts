import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
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
} from '../_runtime-helpers.ts';

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

test('real status server runs at the High priority class', {
  skip: process.platform !== 'win32' ? 'priority classes are Windows-only' : false,
}, async () => {
  await withTempEnv(async (tempRoot) => {
    const configPath = path.join(tempRoot, 'config.json');
    fs.writeFileSync(configPath, JSON.stringify(getDefaultConfig(), null, 2), 'utf8');
    const server = await startStatusServerProcess({
      statusPath: path.join(tempRoot, 'status', 'inference.txt'),
      configPath,
      disableManagedEngineStartup: true,
    });
    try {
      if (server.pid === undefined) throw new Error('The status server did not expose a PID.');
      assert.equal(os.getPriority(server.pid), os.constants.priority.PRIORITY_HIGH);
    } finally {
      await server.close();
    }
  });
});
