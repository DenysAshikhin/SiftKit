import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { getDefaultConfig, writeConfig } from '../src/status-server/config-store.js';
import { getConfigPath } from '../src/config/index.js';
import {
  withTempEnv,
  withRealStatusServer,
  requestJson,
} from './_runtime-helpers.js';

test('the status server exposes no execution-lease routes', async () => {
  await withTempEnv(async (tempRoot) => {
    const statusPath = path.join(tempRoot, 'status', 'inference.txt');
    const configPath = getConfigPath();
    const config = getDefaultConfig();
    fs.mkdirSync(path.dirname(statusPath), { recursive: true });
    writeConfig(configPath, config);

    await withRealStatusServer(async ({ statusUrl }) => {
      const base = statusUrl.replace(/\/status$/u, '');
      await assert.rejects(() => requestJson(`${base}/execution`));
      await assert.rejects(() => requestJson(`${base}/execution/acquire`, { method: 'POST', body: '{}' }));
      await assert.rejects(() => requestJson(`${base}/execution/release`, { method: 'POST', body: '{"token":"x"}' }));
    }, { statusPath, configPath, disableManagedLlamaStartup: true });
  });
});
