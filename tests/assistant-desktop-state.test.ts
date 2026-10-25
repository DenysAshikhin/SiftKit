import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';

import { DesktopStateDtoSchema } from '@siftkit/contracts';
import { getConfigPath } from '../src/config/index.ts';
import { getDefaultConfig, writeConfig } from '../src/status-server/config-store.ts';
import { startStatusServer } from '../src/status-server/index.ts';
import { closeAllRuntimeDatabases } from '../src/state/runtime-db.ts';
import { buildAssistantService } from './helpers/assistant-fixture.ts';
import { closeHttpServer, getAddressInfo, requestJson } from './helpers/dashboard-http.ts';
import {
  configureDashboardTestEnv, enterDashboardTestRepo, restoreDashboardTestRepo,
} from './helpers/dashboard-test-repo.ts';
import { createManagedTempDir, removeDirectoryWithRetries } from './helpers/temp-dirs.ts';
import { StubImageCapability, vaultCaptureDto } from './helpers/vault-capture-fixture.ts';

test('desktop state reports config, custody, capability and the vault captures still waiting', () => {
  try {
    const service = buildAssistantService({ imageCapability: new StubImageCapability(false), screenshotsEnabled: true });
    assert.equal(service.ingestCapture(vaultCaptureDto({ capturedAtUtc: '2026-08-05T08:59:30.000Z' })).kind, 'accepted');

    const state = DesktopStateDtoSchema.parse(service.desktopState());
    assert.deepEqual([state.assistantEnabled, state.captureEnabled, state.paused], [true, true, false]);
    assert.equal(state.custody.custody, 'file');
    assert.deepEqual(state.imageCapability, { capable: false, instanceId: null, queueDepth: 1 });
    assert.equal(state.pendingQuestion, null);
  } finally {
    closeAllRuntimeDatabases();
  }
});

test('the desktop state route serves the shell contract end to end', async () => {
  const tempRoot = createManagedTempDir('siftkit-desktop-state-route-');
  const previousCwd = enterDashboardTestRepo(tempRoot);
  const statusPath = path.join(tempRoot, '.siftkit', 'status', 'inference.txt');
  const configPath = path.join(tempRoot, '.siftkit', 'config.json');
  const envBackup = configureDashboardTestEnv(tempRoot, statusPath, configPath);
  const initial = getDefaultConfig();
  const enabled = {
    ...initial.Assistant,
    Enabled: true,
    Observation: { ...initial.Assistant.Observation, ScreenshotsEnabled: true },
  };
  writeConfig(getConfigPath(), { ...initial, Assistant: enabled });
  const server = startStatusServer({ disableManagedEngineStartup: true });
  await server.startupPromise;
  const baseUrl = `http://127.0.0.1:${getAddressInfo(server).port}`;

  try {
    assert.equal(
      (await requestJson(`${baseUrl}/assistant/desktop/state`)).statusCode, 401,
      'the state poll requires the bearer',
    );
    const bootstrap = await requestJson(`${baseUrl}/assistant/auth/bootstrap`);
    const token = typeof bootstrap.body.token === 'string' ? bootstrap.body.token : '';
    const headers = { Authorization: `Bearer ${token}` };
    const state = async () => DesktopStateDtoSchema.parse((await requestJson(`${baseUrl}/assistant/desktop/state`, { headers })).body);

    const first = await state();
    assert.deepEqual([first.assistantEnabled, first.captureEnabled, first.paused, first.pendingQuestion], [true, true, false, null]);

    assert.equal((await requestJson(`${baseUrl}/assistant/config`, {
      method: 'PATCH', headers, body: JSON.stringify({ assistant: { ...enabled, PrivateMode: { Active: true, ExpiresAtUtc: null } } }),
    })).statusCode, 200);
    assert.equal((await state()).paused, true);

    assert.equal((await requestJson(`${baseUrl}/assistant/config`, {
      method: 'PATCH', headers, body: JSON.stringify({ assistant: { ...enabled, Enabled: false } }),
    })).statusCode, 200);
    const disabled = await requestJson(`${baseUrl}/assistant/desktop/state`, { headers });
    assert.equal(disabled.statusCode, 200, 'the tray needs state even while the assistant is off');
    const disabledState = DesktopStateDtoSchema.parse(disabled.body);
    assert.deepEqual([disabledState.assistantEnabled, disabledState.captureEnabled], [false, false]);

    assert.equal((await requestJson(`${baseUrl}/assistant/questions/current`, { headers })).statusCode, 404, 'question routes are retired');
  } finally {
    await closeHttpServer(server);
    restoreDashboardTestRepo(previousCwd);
    for (const [key, value] of Object.entries(envBackup)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await removeDirectoryWithRetries(tempRoot);
  }
});
