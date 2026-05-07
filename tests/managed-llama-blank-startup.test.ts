// @ts-nocheck
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

const { getConfigPath } = require('../dist/config/index.js');
const { getDefaultConfig, writeConfig } = require('../dist/status-server/config-store.js');
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

test('external llama server mode uses reachable base url without executable or model path', async () => {
  await withTempEnv(async (tempRoot) => {
    const remotePort = await getFreePort();
    const remoteServer = http.createServer((request, response) => {
      if (request.url === '/v1/models') {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ data: [{ id: 'remote-model' }] }));
        return;
      }
      response.writeHead(404);
      response.end();
    });
    await new Promise((resolve) => remoteServer.listen(remotePort, '127.0.0.1', resolve));
    try {
      const statusPath = path.join(tempRoot, '.siftkit', 'status', 'inference.txt');
      const configPath = getConfigPath();
      const config = getDefaultConfig();
      config.Server.LlamaCpp.ExternalServerEnabled = true;
      config.Server.LlamaCpp.BaseUrl = `http://127.0.0.1:${remotePort}`;
      config.Server.LlamaCpp.ExecutablePath = null;
      config.Server.LlamaCpp.ModelPath = null;
      config.Server.LlamaCpp.Presets[0].ExternalServerEnabled = true;
      config.Server.LlamaCpp.Presets[0].BaseUrl = config.Server.LlamaCpp.BaseUrl;
      config.Server.LlamaCpp.Presets[0].ExecutablePath = null;
      config.Server.LlamaCpp.Presets[0].ModelPath = null;
      config.Runtime.LlamaCpp.BaseUrl = config.Server.LlamaCpp.BaseUrl;
      config.LlamaCpp.BaseUrl = config.Server.LlamaCpp.BaseUrl;
      fs.mkdirSync(path.dirname(configPath), { recursive: true });
      writeConfig(configPath, config);

      await withRealStatusServer(async ({ configUrl, statusUrl }) => {
        const loadedConfig = await requestJson(configUrl);
        assert.equal(loadedConfig.Server.LlamaCpp.ExternalServerEnabled, true);
        assert.equal(loadedConfig.Server.LlamaCpp.ExecutablePath, null);
        assert.equal(loadedConfig.Server.LlamaCpp.ModelPath, null);

        const status = await requestJson(statusUrl);
        assert.equal(status.running, false);
      }, {
        statusPath,
        configPath,
      });
    } finally {
      await new Promise((resolve) => remoteServer.close(resolve));
    }
  });
});

test('external llama server mode fails loud when remote base url is unreachable', async () => {
  await withTempEnv(async (tempRoot) => {
    const statusPath = path.join(tempRoot, '.siftkit', 'status', 'inference.txt');
    const configPath = getConfigPath();
    const unusedPort = await getFreePort();
    const config = getDefaultConfig();
    config.Server.LlamaCpp.ExternalServerEnabled = true;
    config.Server.LlamaCpp.BaseUrl = `http://127.0.0.1:${unusedPort}`;
    config.Server.LlamaCpp.ExecutablePath = null;
    config.Server.LlamaCpp.ModelPath = null;
    config.Server.LlamaCpp.Presets[0].ExternalServerEnabled = true;
    config.Server.LlamaCpp.Presets[0].BaseUrl = config.Server.LlamaCpp.BaseUrl;
    config.Server.LlamaCpp.Presets[0].ExecutablePath = null;
    config.Server.LlamaCpp.Presets[0].ModelPath = null;
    config.Runtime.LlamaCpp.BaseUrl = config.Server.LlamaCpp.BaseUrl;
    config.LlamaCpp.BaseUrl = config.Server.LlamaCpp.BaseUrl;
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    writeConfig(configPath, config);

    await assert.rejects(
      withRealStatusServer(async ({ configUrl }) => {
        await requestJson(configUrl);
      }, { statusPath, configPath }),
      /External llama\.cpp server is not reachable/u,
    );
  });
});

test('missing local llama files log degraded startup instead of crashing', async () => {
  await withTempEnv(async (tempRoot) => {
    const statusPath = path.join(tempRoot, '.siftkit', 'status', 'inference.txt');
    const configPath = getConfigPath();
    const unusedPort = await getFreePort();
    const config = getDefaultConfig();
    config.Server.LlamaCpp.ExternalServerEnabled = false;
    config.Server.LlamaCpp.BaseUrl = `http://127.0.0.1:${unusedPort}`;
    config.Server.LlamaCpp.ExecutablePath = null;
    config.Server.LlamaCpp.ModelPath = null;
    config.Server.LlamaCpp.Presets[0].ExternalServerEnabled = false;
    config.Server.LlamaCpp.Presets[0].BaseUrl = config.Server.LlamaCpp.BaseUrl;
    config.Server.LlamaCpp.Presets[0].ExecutablePath = null;
    config.Server.LlamaCpp.Presets[0].ModelPath = null;
    config.Runtime.LlamaCpp.BaseUrl = config.Server.LlamaCpp.BaseUrl;
    config.LlamaCpp.BaseUrl = config.Server.LlamaCpp.BaseUrl;
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    writeConfig(configPath, config);

    const stderrWrites = [];
    const originalWrite = process.stderr.write;
    process.stderr.write = (chunk, encoding, callback) => {
      stderrWrites.push(String(chunk));
      if (typeof encoding === 'function') {
        encoding();
      } else if (typeof callback === 'function') {
        callback();
      }
      return true;
    };
    try {
      await withRealStatusServer(async ({ configUrl, statusUrl }) => {
        const loadedConfig = await requestJson(configUrl);
        assert.equal(loadedConfig.Server.LlamaCpp.ExternalServerEnabled, false);
        const status = await requestJson(statusUrl);
        assert.equal(status.running, false);
      }, { statusPath, configPath });
    } finally {
      process.stderr.write = originalWrite;
    }

    assert.match(stderrWrites.join(''), /No local llama\.cpp files found/u);
  });
});
