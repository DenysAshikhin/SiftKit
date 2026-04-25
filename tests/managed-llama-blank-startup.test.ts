// @ts-nocheck
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { getConfigPath } = require('../dist/config/index.js');
const { getDefaultConfig } = require('../dist/status-server/config-store.js');
const { readStatusText } = require('../dist/status-server/status-file.js');
const {
  getFreePort,
  requestJson,
  withRealStatusServer,
  withTempEnv,
} = require('./_runtime-helpers.js');

test('default managed llama config leaves executable and model unset', () => {
  const config = getDefaultConfig();
  assert.equal(config.Server.LlamaCpp.ExecutablePath, null);
  assert.equal(config.Server.LlamaCpp.ModelPath, null);
});

test('real status server boots with blank managed llama configuration and waits for manual restart', async () => {
  await withTempEnv(async (tempRoot) => {
    const statusPath = path.join(tempRoot, '.siftkit', 'status', 'inference.txt');
    const configPath = getConfigPath();
    const unusedPort = await getFreePort();
    const config = getDefaultConfig();
    const unreachableBaseUrl = `http://127.0.0.1:${unusedPort}`;
    config.LlamaCpp.BaseUrl = unreachableBaseUrl;
    config.Runtime.LlamaCpp.BaseUrl = unreachableBaseUrl;
    config.Server.LlamaCpp.BaseUrl = unreachableBaseUrl;
    config.Server.LlamaCpp.BindHost = '127.0.0.1';
    config.Server.LlamaCpp.Port = unusedPort;
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');

    await withRealStatusServer(async ({ configUrl, statusUrl }) => {
      const loadedConfig = await requestJson(configUrl);
      assert.equal(loadedConfig.Server.LlamaCpp.ExecutablePath, null);
      assert.equal(loadedConfig.Server.LlamaCpp.ModelPath, null);

      const status = await requestJson(statusUrl);
      assert.equal(status.running, false);
      assert.equal(status.status, 'false');
      assert.equal(readStatusText(getConfigPath()), 'false');
    }, {
      statusPath,
      configPath,
      disableManagedLlamaStartup: true,
    });
  });
});
