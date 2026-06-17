import test from 'node:test';
import assert from 'node:assert/strict';

import {
  getExecutionServerState,
  withExecutionLock,
  withTempEnv,
  withStubServer,
} from './_runtime-helpers.js';

test('withExecutionLock acquires and releases execution control through the server', async () => {
  await withTempEnv(async () => {
    await withStubServer(async () => {
      const result = await withExecutionLock(async () => 'ok');
      const state = await getExecutionServerState();

      assert.equal(result, 'ok');
      assert.equal(state.busy, false);
    });
  });
});

test('withExecutionLock waits for the server to release execution control before starting', async () => {
  await withTempEnv(async () => {
    await withStubServer(async (server) => {
      server.state.executionLeaseToken = 'lease-busy';
      const startedAt = Date.now();
      setTimeout(() => {
        server.state.executionLeaseToken = null;
      }, 300);

      const result = await withExecutionLock(async () => Date.now() - startedAt);

      assert.equal(typeof result, 'number');
      assert.ok(result >= 250);
      assert.equal(server.state.executionLeaseToken, null);
    });
  });
});

