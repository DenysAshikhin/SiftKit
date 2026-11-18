import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

import { EngineEventsResponseSchema } from '@siftkit/contracts';
import { startStatusServer } from '../src/status-server/index.ts';
import { insertEngineEvent } from '../src/state/engine-events.ts';
import { getRuntimeDatabase } from '../src/state/runtime-db.ts';
import { getAddressInfo, requestJson } from './helpers/dashboard-http.ts';
import { configureDashboardTestEnv, enterDashboardTestRepo, restoreDashboardTestRepo } from './helpers/dashboard-test-repo.ts';
import { createManagedTempDir, removeDirectoryWithRetries } from './helpers/temp-dirs.ts';

test('GET /dashboard/engine-events returns the newest events, clamps the limit, and parses as the contract', async () => {
  const tempRoot = createManagedTempDir('siftkit-engine-events-endpoint-');
  const previousCwd = enterDashboardTestRepo(tempRoot);
  const runtimeRoot = path.join(tempRoot, '.siftkit');
  const envBackup = configureDashboardTestEnv(tempRoot, path.join(runtimeRoot, 'status', 'inference.txt'), path.join(runtimeRoot, 'config.json'));
  const server = startStatusServer({ disableManagedEngineStartup: true });
  await server.startupPromise;
  const baseUrl = `http://127.0.0.1:${getAddressInfo(server).port}`;
  try {
    const database = getRuntimeDatabase(path.join(runtimeRoot, 'runtime.sqlite'));
    for (const turn of [1, 2, 3]) {
      insertEngineEvent(database, { kind: 'prompt_cache_break', inferenceRunId: null, runId: 'run-x', turn, summary: `t${turn}`, detail: '' });
    }

    const limited = await requestJson(`${baseUrl}/dashboard/engine-events?limit=2`);
    assert.equal(limited.statusCode, 200);
    assert.deepEqual(EngineEventsResponseSchema.parse(limited.body).events.map((event) => event.turn), [3, 2]);
    const clamped = await requestJson(`${baseUrl}/dashboard/engine-events?limit=0`);
    assert.equal(EngineEventsResponseSchema.parse(clamped.body).events.length, 1);
  } finally {
    await new Promise<void>((resolve, reject) => { server.close((error) => (error ? reject(error) : resolve())); });
    restoreDashboardTestRepo(previousCwd);
    for (const [key, value] of Object.entries(envBackup)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await removeDirectoryWithRetries(tempRoot);
  }
});
