import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';

import { getConfigPath } from '../src/config/index.js';
import { getDefaultConfig, writeConfig } from '../src/status-server/config-store.js';
import { startStatusServer } from '../src/status-server/index.js';
import {
  closeHttpServer, getAddressInfo, requestJson,
} from './helpers/dashboard-http.js';
import {
  configureDashboardTestEnv, enterDashboardTestRepo, restoreDashboardTestRepo,
} from './helpers/dashboard-test-repo.js';
import { createManagedTempDir, removeDirectoryWithRetries } from './helpers/temp-dirs.js';

test('assistant HTTP surface bootstraps locally, enforces bearer auth, and serves Gate C routes', async () => {
  const tempRoot = createManagedTempDir('siftkit-assistant-routes-');
  const previousCwd = enterDashboardTestRepo(tempRoot);
  const statusPath = path.join(tempRoot, '.siftkit', 'status', 'inference.txt');
  const configPath = path.join(tempRoot, '.siftkit', 'config.json');
  const envBackup = configureDashboardTestEnv(tempRoot, statusPath, configPath);
  const initial = getDefaultConfig();
  writeConfig(getConfigPath(), {
    ...initial, Assistant: { ...initial.Assistant, Enabled: true },
  });
  const server = startStatusServer({ disableManagedLlamaStartup: true });
  await server.startupPromise;
  const address = getAddressInfo(server);
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    assert.equal((await requestJson(`${baseUrl}/assistant/status`)).statusCode, 401);
    assert.equal((await requestJson(`${baseUrl}/assistant/auth/bootstrap`, {
      headers: { Origin: 'https://evil.example' },
    })).statusCode, 403);
    const bootstrap = await requestJson(`${baseUrl}/assistant/auth/bootstrap`);
    assert.equal(bootstrap.statusCode, 200);
    const token = typeof bootstrap.body.token === 'string' ? bootstrap.body.token : '';
    assert.ok(token.length > 20);
    const headers = { Authorization: `Bearer ${token}` };
    assert.equal((await requestJson(`${baseUrl}/assistant/status`, {
      headers: { Authorization: 'Bearer wrong' },
    })).statusCode, 401);

    for (const route of [
      '/assistant/status', '/assistant/config', '/assistant/search?q=PowerShell',
      '/assistant/graph/nodes', '/assistant/graph/assertions', '/assistant/evidence',
      '/assistant/projections', '/assistant/questions/current', '/assistant/policies',
      '/assistant/validation', '/assistant/history', '/assistant/background-decisions',
    ]) {
      const response = await requestJson(`${baseUrl}${route}`, { headers });
      assert.equal(response.statusCode, 200, route);
    }
    assert.equal((await requestJson(`${baseUrl}/assistant/graph/assertions/missing`, {
      headers,
    })).statusCode, 404);
    assert.equal((await requestJson(`${baseUrl}/assistant/graph/assertions/missing/confirm`, {
      method: 'POST', headers, body: JSON.stringify({ reason: 'confirm' }),
    })).statusCode, 404);
    // The claim-owner route is registered and authenticated like every other mutation; an unknown
    // node is a 404 rather than a route miss, which is what proves the pattern matched.
    assert.equal((await requestJson(`${baseUrl}/assistant/graph/nodes/missing/claim-owner`, {
      method: 'POST', headers, body: JSON.stringify({ reason: 'this is me' }),
    })).statusCode, 404);
    assert.equal((await requestJson(`${baseUrl}/assistant/graph/nodes/missing/claim-owner`, {
      method: 'POST', body: JSON.stringify({ reason: 'this is me' }),
    })).statusCode, 401);
    for (const route of [
      '/assistant/capture/start', '/assistant/ingest/raw',
      '/assistant/export', '/assistant/backup', '/assistant/not-a-route',
    ]) {
      assert.equal((await requestJson(`${baseUrl}${route}`, { headers })).statusCode, 404);
    }

    const paused = {
      ...initial.Assistant,
      Enabled: false,
    };
    assert.equal((await requestJson(`${baseUrl}/assistant/config`, {
      method: 'PATCH', headers, body: JSON.stringify({ assistant: paused }),
    })).statusCode, 200);
    const status = await requestJson(`${baseUrl}/assistant/status`, { headers });
    assert.equal(status.body.enabled, false);
    assert.equal((await requestJson(`${baseUrl}/assistant/graph/nodes`, { headers })).statusCode, 409);
    assert.equal((await requestJson(`${baseUrl}/assistant/graph/nodes/missing/claim-owner`, {
      method: 'POST', headers, body: JSON.stringify({ reason: 'this is me' }),
    })).statusCode, 409);
    assert.equal((await requestJson(`${baseUrl}/assistant/config`, {
      method: 'PATCH', headers, body: '{',
    })).statusCode, 400);
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

test('GET /assistant/history responds 200 with items and completes the response', async () => {
  const tempRoot = createManagedTempDir('siftkit-assistant-history-');
  const previousCwd = enterDashboardTestRepo(tempRoot);
  const statusPath = path.join(tempRoot, '.siftkit', 'status', 'inference.txt');
  const configPath = path.join(tempRoot, '.siftkit', 'config.json');
  const envBackup = configureDashboardTestEnv(tempRoot, statusPath, configPath);
  const initial = getDefaultConfig();
  writeConfig(getConfigPath(), {
    ...initial, Assistant: { ...initial.Assistant, Enabled: true },
  });
  const server = startStatusServer({ disableManagedLlamaStartup: true });
  await server.startupPromise;
  const address = getAddressInfo(server);
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    const bootstrap = await requestJson(`${baseUrl}/assistant/auth/bootstrap`);
    const token = typeof bootstrap.body.token === 'string' ? bootstrap.body.token : '';
    const response = await requestJson(`${baseUrl}/assistant/history`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.equal(response.statusCode, 200);
    assert.ok(Array.isArray(response.body.items));
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

test('a known path with a wrong method responds 404, not a hang', async () => {
  const tempRoot = createManagedTempDir('siftkit-assistant-method-');
  const previousCwd = enterDashboardTestRepo(tempRoot);
  const statusPath = path.join(tempRoot, '.siftkit', 'status', 'inference.txt');
  const configPath = path.join(tempRoot, '.siftkit', 'config.json');
  const envBackup = configureDashboardTestEnv(tempRoot, statusPath, configPath);
  const initial = getDefaultConfig();
  writeConfig(getConfigPath(), {
    ...initial, Assistant: { ...initial.Assistant, Enabled: true },
  });
  const server = startStatusServer({ disableManagedLlamaStartup: true });
  await server.startupPromise;
  const address = getAddressInfo(server);
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    const bootstrap = await requestJson(`${baseUrl}/assistant/auth/bootstrap`);
    const token = typeof bootstrap.body.token === 'string' ? bootstrap.body.token : '';
    const response = await requestJson(`${baseUrl}/assistant/status`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.equal(response.statusCode, 404);
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
