import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { getConfigPath } from '../../src/config/index.js';
import type { Exl3EngineConfig } from '../../src/config/types.js';
import { closeAllRuntimeDatabases } from '../../src/state/runtime-db.js';
import { getDefaultConfig, writeConfig } from '../../src/status-server/config-store.js';
import type { ManagedEngineHost } from '../../src/status-server/engine-process.js';
import { startStatusServer } from '../../src/status-server/index.js';
import { waitForAsyncExpectation } from '../_runtime-helpers.js';
import { getAddressInfo, requestJson } from './dashboard-http.js';
import { readStatusModelRequests } from './model-request-status.js';
import { FixedGpuMemoryProbe } from './fixed-gpu-memory-probe.js';
import { requestSse } from './sse-http.js';

/** The fixture fields both the in-process and the child-process fake engines provide. */
export type ManagedEngineConfigFixture = {
  baseUrl: string;
  modelId: string;
  modelPath: string;
  engine: Exl3EngineConfig;
};

export function writeManagedEngineReadinessTestConfig(
  managed: ManagedEngineConfigFixture,
  startupTimeoutMs: number,
): void {
  const config = getDefaultConfig();
  const server = config.Server;
  server.ModelPresets.Presets = [{
    ...server.ModelPresets.Presets[0],
    id: 'default',
    label: 'Managed Test',
    Backend: 'exl3',
    Model: managed.modelId,
    ExternalServerEnabled: false,
    BaseUrl: managed.baseUrl,
    ModelPath: managed.modelPath,
    StartupTimeoutMs: startupTimeoutMs,
    HealthcheckTimeoutMs: 20,
    HealthcheckIntervalMs: 20,
  }];
  server.ModelPresets.ActivePresetId = 'default';
  // A short shutdown budget keeps the failed-launch cleanup path fast when taskkill is denied.
  server.Engines.Exl3 = { ...managed.engine, ShutdownTimeoutMs: 1_000 };
  writeConfig(getConfigPath(), config);
}

/**
 * A managed engine that never becomes ready: startup fails, then two queued requests each wait
 * through their own readiness attempt before the lock is granted, and both fail cleanly.
 */
export async function runManagedEngineReadinessScenario(
  tempRoot: string,
  managed: ManagedEngineConfigFixture,
  host: ManagedEngineHost,
): Promise<void> {
  const previousCwd = process.cwd();
  fs.writeFileSync(
    path.join(tempRoot, 'package.json'),
    JSON.stringify({ name: 'siftkit', version: '0.1.0' }, null, 2),
    'utf8',
  );
  process.chdir(tempRoot);
  const statusPath = path.join(tempRoot, '.siftkit', 'status', 'inference.txt');
  const configPath = path.join(tempRoot, '.siftkit', 'config.json');
  const envBackup: Record<string, string | undefined> = {
    sift_kit_status: process.env.sift_kit_status,
    SIFTKIT_STATUS_PATH: process.env.SIFTKIT_STATUS_PATH,
    SIFTKIT_CONFIG_PATH: process.env.SIFTKIT_CONFIG_PATH,
    SIFTKIT_STATUS_HOST: process.env.SIFTKIT_STATUS_HOST,
    SIFTKIT_STATUS_PORT: process.env.SIFTKIT_STATUS_PORT,
  };
  process.env.sift_kit_status = statusPath;
  process.env.SIFTKIT_STATUS_PATH = statusPath;
  process.env.SIFTKIT_CONFIG_PATH = configPath;
  process.env.SIFTKIT_STATUS_HOST = '127.0.0.1';
  process.env.SIFTKIT_STATUS_PORT = '0';
  writeManagedEngineReadinessTestConfig(managed, 500);

  const server = startStatusServer({ gpuMemoryProbe: new FixedGpuMemoryProbe(null), managedEngineHost: host });
  await server.startupPromise;
  const baseUrl = `http://127.0.0.1:${getAddressInfo(server).port}`;

  try {
    const backendStatus = await requestJson(`${baseUrl}/runtime/inference`, { timeoutMs: 1000 });
    assert.equal(backendStatus.body.processState, 'failed');
    const firstRequest = requestSse(`${baseUrl}/repo-search`, {
      timeoutMs: 15000,
      body: {
        prompt: 'hold readiness',
        repoRoot: process.cwd(),
        model: 'managed-test-model',
        maxTurns: 1,
      },
    });

    // Readiness runs before the lock is granted, so the selected request waits in the queue.
    await waitForAsyncExpectation(async () => {
      const modelRequests = await readStatusModelRequests(baseUrl);
      assert.equal(modelRequests.activeCount, 0);
      assert.equal(modelRequests.queueLength, 1);
    });
    const secondRequest = requestSse(`${baseUrl}/summary`, {
      timeoutMs: 15000,
      body: {
        repoRoot: process.cwd(),
        question: 'summarize',
        inputText: 'short text',
        backend: 'exl3',
        model: 'managed-test-model',
      },
    });
    await waitForAsyncExpectation(async () => {
      const modelRequests = await readStatusModelRequests(baseUrl);
      assert.equal(modelRequests.activeCount, 0);
      assert.equal(modelRequests.queueLength, 2);
    });
    const secondResponse = await secondRequest;
    const firstResponse = await firstRequest;

    assert.match(firstResponse.errorMessage || '', /failed|unavailable|timed out/iu);
    assert.match(secondResponse.errorMessage || '', /failed|unavailable|timed out/iu);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
    process.chdir(previousCwd);
    closeAllRuntimeDatabases();
    for (const [key, value] of Object.entries(envBackup)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}
