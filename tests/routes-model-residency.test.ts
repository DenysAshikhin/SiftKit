import assert from 'node:assert/strict';
import test from 'node:test';

import { startStubStatusServer } from './_runtime-helpers.js';
import { DashboardTestServer } from './helpers/dashboard-server-fixture.js';
import { requestJson } from './helpers/dashboard-http.js';

async function startManagedEngineServer(name: string) {
  const stub = await startStubStatusServer({});
  const server = await DashboardTestServer.start(
    name,
    { baseUrl: `http://127.0.0.1:${stub.port}`, model: 'stub-model' },
    { managedEngineStartup: true },
  );
  return { server, stub };
}

test('removed residency routes offload and freeze are not served', async () => {
  const { server, stub } = await startManagedEngineServer('residency-old-route-');
  try {
    for (const route of ['offload', 'freeze']) {
      const response = await requestJson(`${server.baseUrl}/runtime/model/${route}`, { method: 'POST' });
      assert.equal(response.statusCode, 404, route);
    }
  } finally {
    await server.close();
    await stub.close();
  }
});

test('GET /runtime/inference reports the configured idle action', async () => {
  const { server, stub } = await startManagedEngineServer('residency-status-');
  try {
    const response = await requestJson(`${server.baseUrl}/runtime/inference`);
    assert.equal(response.statusCode, 200);
    assert.equal(response.body.idleAction, 'unload');
  } finally {
    await server.close();
    await stub.close();
  }
});
