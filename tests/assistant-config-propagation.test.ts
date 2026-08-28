import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';

import { KeyMaterialDtoSchema } from '@siftkit/contracts';
import { getConfigPath } from '../src/config/index.js';
import { getDefaultConfig, readConfig, writeConfig } from '../src/status-server/config-store.js';
import { startStatusServer } from '../src/status-server/index.js';
import { z } from '../src/lib/zod.js';
import { closeHttpServer, getAddressInfo, requestJson } from './helpers/dashboard-http.js';
import {
  configureDashboardTestEnv, enterDashboardTestRepo, restoreDashboardTestRepo,
} from './helpers/dashboard-test-repo.js';
import { createManagedTempDir, removeDirectoryWithRetries } from './helpers/temp-dirs.js';

const AssistantViewSchema = z.object({
  assistant: z.object({ Enabled: z.boolean(), KeyCustody: z.string() }),
});

test('dashboard PUT /config enable reaches the live service and survives custody migration', async () => {
  const tempRoot = createManagedTempDir('siftkit-assistant-config-prop-');
  const previousCwd = enterDashboardTestRepo(tempRoot);
  const statusPath = path.join(tempRoot, '.siftkit', 'status', 'inference.txt');
  const configPath = path.join(tempRoot, '.siftkit', 'config.json');
  const envBackup = configureDashboardTestEnv(tempRoot, statusPath, configPath);
  writeConfig(getConfigPath(), getDefaultConfig());
  const server = startStatusServer({ disableManagedLlamaStartup: true });
  await server.startupPromise;
  const baseUrl = `http://127.0.0.1:${getAddressInfo(server).port}`;

  try {
    const bootstrap = await requestJson(`${baseUrl}/assistant/auth/bootstrap`);
    const token = typeof bootstrap.body.token === 'string' ? bootstrap.body.token : '';
    const headers = { Authorization: `Bearer ${token}` };

    const initialView = await requestJson(`${baseUrl}/assistant/config`, { headers });
    assert.equal(initialView.statusCode, 200);

    // The dashboard settings page persists through the general config endpoint, not the
    // assistant PATCH. The running service must still observe the change.
    const current = readConfig(getConfigPath());
    const saved = await requestJson(`${baseUrl}/config`, {
      method: 'PUT',
      body: JSON.stringify({ ...current, Assistant: { ...current.Assistant, Enabled: true } }),
    });
    assert.equal(saved.statusCode, 200);
    assert.equal(readConfig(getConfigPath()).Assistant.Enabled, true);

    const liveView = await requestJson(`${baseUrl}/assistant/config`, { headers });
    assert.equal(liveView.statusCode, 200);
    assert.equal(
      AssistantViewSchema.parse(liveView.body).assistant.Enabled,
      true,
      'PUT /config must refresh the running assistant service',
    );

    // First shell connect runs the one-time custody migration (export then import). The flip
    // must only touch KeyCustody: the enable persisted above has to survive it.
    const exported = await requestJson(`${baseUrl}/assistant/keys/export`, { method: 'POST', headers });
    assert.equal(exported.statusCode, 200);
    const material = KeyMaterialDtoSchema.parse(exported.body);
    const imported = await requestJson(`${baseUrl}/assistant/keys/import`, {
      method: 'POST', headers, body: JSON.stringify(material),
    });
    assert.equal(imported.statusCode, 200);

    const persisted = readConfig(getConfigPath()).Assistant;
    assert.equal(persisted.KeyCustody, 'desktop');
    assert.equal(persisted.Enabled, true, 'custody migration must not clobber the enabled flag');

    const afterMigration = await requestJson(`${baseUrl}/assistant/config`, { headers });
    const afterBlock = AssistantViewSchema.parse(afterMigration.body).assistant;
    assert.equal(afterBlock.Enabled, true);
    assert.equal(afterBlock.KeyCustody, 'desktop');
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
