import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';

import {
  bootstrapAssistantToken,
  getAssistantPolicies,
  getAssistantStatus,
  getCurrentAssistantQuestion,
  searchAssistantMemory,
} from '../dashboard/src/assistant-api.js';
import { getConfigPath } from '../src/config/index.js';
import { getDefaultConfig, writeConfig } from '../src/status-server/config-store.js';
import { startStatusServer } from '../src/status-server/index.js';
import { closeHttpServer, getAddressInfo } from './helpers/dashboard-http.js';
import {
  configureDashboardTestEnv,
  enterDashboardTestRepo,
  restoreDashboardTestRepo,
} from './helpers/dashboard-test-repo.js';
import { createManagedTempDir, removeDirectoryWithRetries } from './helpers/temp-dirs.js';

test('dashboard assistant API authenticates once and reads the live Gate C surface', { concurrency: false }, async () => {
  const tempRoot = createManagedTempDir('siftkit-assistant-dashboard-');
  const previousCwd = enterDashboardTestRepo(tempRoot);
  const statusPath = path.join(tempRoot, '.siftkit', 'status', 'inference.txt');
  const configPath = path.join(tempRoot, '.siftkit', 'config.json');
  const envBackup = configureDashboardTestEnv(tempRoot, statusPath, configPath);
  const config = getDefaultConfig();
  writeConfig(getConfigPath(), { ...config, Assistant: { ...config.Assistant, Enabled: true } });
  const server = startStatusServer({ disableManagedEngineStartup: true });
  await server.startupPromise;
  const address = getAddressInfo(server);
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const hostFetch = globalThis.fetch;
  Object.defineProperty(globalThis, 'fetch', {
    configurable: true,
    value: (input: RequestInfo | URL, init?: RequestInit) => {
      const target = typeof input === 'string' && input.startsWith('/')
        ? `${baseUrl}${input}`
        : input;
      return hostFetch(target, init);
    },
  });

  try {
    const token = await bootstrapAssistantToken();
    const [status, search, question, policies] = await Promise.all([
      getAssistantStatus(token),
      searchAssistantMemory(token, 'PowerShell'),
      getCurrentAssistantQuestion(token),
      getAssistantPolicies(token),
    ]);
    assert.equal(status.enabled, true);
    assert.deepEqual(search, { nodes: [], assertions: [], projections: [] });
    assert.equal(question, null);
    assert.deepEqual(policies, []);
    assert.doesNotMatch(JSON.stringify({ status, search, question, policies }), new RegExp(token, 'u'));
  } finally {
    Object.defineProperty(globalThis, 'fetch', { configurable: true, value: hostFetch });
    await closeHttpServer(server);
    restoreDashboardTestRepo(previousCwd);
    for (const [key, value] of Object.entries(envBackup)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await removeDirectoryWithRetries(tempRoot);
  }
});
