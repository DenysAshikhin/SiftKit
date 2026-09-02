import assert from 'node:assert/strict';
import test from 'node:test';

import { startStubStatusServer } from './_runtime-helpers.js';
import { DashboardTestServer } from './helpers/dashboard-server-fixture.js';
import { requestJson } from './helpers/dashboard-http.js';

test('restart reports failure instead of success when managed backend startup is disabled', async () => {
  const server = await DashboardTestServer.start('siftkit-restart-disabled-');
  try {
    const response = await requestJson(`${server.baseUrl}/status/restart`, { method: 'POST' });

    assert.equal(response.statusCode, 400);
    assert.equal(response.body.ok, false);
    assert.equal(response.body.restarted, false);
    assert.match(String(response.body.error), /restart is disabled/iu);
  } finally {
    await server.close();
  }
});

test('restart refuses an external inference server instead of claiming it restarted', async () => {
  const stub = await startStubStatusServer({});
  const server = await DashboardTestServer.start(
    'siftkit-restart-external-',
    { baseUrl: `http://127.0.0.1:${stub.port}`, model: 'stub-model' },
    { managedEngineStartup: true },
  );
  try {
    const response = await requestJson(`${server.baseUrl}/status/restart`, { method: 'POST' });

    assert.equal(response.statusCode, 400);
    assert.equal(response.body.ok, false);
    assert.equal(response.body.restarted, false);
    assert.match(String(response.body.error), /external inference server/iu);
  } finally {
    await server.close();
    await stub.close();
  }
});
