import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

import { getConfigPath } from '../src/config/index.js';
import { getDefaultConfig, writeConfig } from '../src/status-server/config-store.js';
import { readStatusText } from '../src/status-server/status-file.js';
import type { SiftConfig, ModelRuntimePreset } from '../src/config/types.js';
import {
  getFreePort,
  requestJson,
  withRealStatusServer,
  withTempEnv,
} from './_runtime-helpers.js';

interface StatusResponse {
  running: boolean;
  status: string;
}

function activePreset(config: SiftConfig): ModelRuntimePreset {
  const serverLlama = config.Server.ModelPresets;
  return serverLlama.Presets.find((preset) => preset.id === serverLlama.ActivePresetId)
    || serverLlama.Presets[0];
}

test('default managed llama config leaves executable and model unset', () => {
  const config = getDefaultConfig();
  const preset = activePreset(config);
  assert.equal(preset.ExecutablePath, null);
  assert.equal(preset.ModelPath, null);
});

test('real status server boots with blank managed llama configuration and waits for manual restart', async () => {
  await withTempEnv(async (tempRoot) => {
    const statusPath = path.join(tempRoot, '.siftkit', 'status', 'inference.txt');
    const configPath = getConfigPath();
    const unusedPort = await getFreePort();
    const config = getDefaultConfig();
    const unreachableBaseUrl = `http://127.0.0.1:${unusedPort}`;
    const preset = activePreset(config);
    preset.BaseUrl = unreachableBaseUrl;
    preset.BindHost = '127.0.0.1';
    preset.Port = unusedPort;
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');

    await withRealStatusServer(async ({ configUrl, statusUrl }) => {
      const loadedConfig = await requestJson<SiftConfig>(configUrl);
      const loadedPreset = activePreset(loadedConfig);
      assert.equal(loadedPreset.ExecutablePath, null);
      assert.equal(loadedPreset.ModelPath, null);

      const status = await requestJson<StatusResponse>(statusUrl);
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
    await new Promise<void>((resolve) => remoteServer.listen(remotePort, '127.0.0.1', resolve));
    try {
      const statusPath = path.join(tempRoot, '.siftkit', 'status', 'inference.txt');
      const configPath = getConfigPath();
      const config = getDefaultConfig();
      const preset = activePreset(config);
      preset.ExternalServerEnabled = true;
      preset.BaseUrl = `http://127.0.0.1:${remotePort}`;
      preset.ExecutablePath = null;
      preset.ModelPath = null;
      fs.mkdirSync(path.dirname(configPath), { recursive: true });
      writeConfig(configPath, config);

      await withRealStatusServer(async ({ configUrl, statusUrl }) => {
        const loadedConfig = await requestJson<SiftConfig>(configUrl);
        const loadedPreset = activePreset(loadedConfig);
        assert.equal(loadedPreset.ExternalServerEnabled, true);
        assert.equal(loadedPreset.ExecutablePath, null);
        assert.equal(loadedPreset.ModelPath, null);

        const status = await requestJson<StatusResponse>(statusUrl);
        assert.equal(status.running, false);
      }, {
        statusPath,
        configPath,
      });
    } finally {
      await new Promise<void>((resolve) => remoteServer.close(() => resolve()));
    }
  });
});

test('external llama server mode fails loud when remote base url is unreachable', async () => {
  await withTempEnv(async (tempRoot) => {
    const statusPath = path.join(tempRoot, '.siftkit', 'status', 'inference.txt');
    const configPath = getConfigPath();
    const unusedPort = await getFreePort();
    const config = getDefaultConfig();
    const preset = activePreset(config);
    preset.ExternalServerEnabled = true;
    preset.BaseUrl = `http://127.0.0.1:${unusedPort}`;
    preset.ExecutablePath = null;
    preset.ModelPath = null;
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
    const preset = activePreset(config);
    preset.ExternalServerEnabled = false;
    preset.BaseUrl = `http://127.0.0.1:${unusedPort}`;
    preset.ExecutablePath = null;
    preset.ModelPath = null;
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    writeConfig(configPath, config);

    const stderrWrites: string[] = [];
    const originalWrite = process.stderr.write;
    const patchedWrite = (
      chunk: string | Uint8Array,
      encoding?: BufferEncoding | ((error?: Error | null) => void),
      callback?: (error?: Error | null) => void,
    ): boolean => {
      stderrWrites.push(String(chunk));
      if (typeof encoding === 'function') {
        encoding();
      } else if (typeof callback === 'function') {
        callback();
      }
      return true;
    };
    process.stderr.write = patchedWrite;
    try {
      await withRealStatusServer(async ({ configUrl, statusUrl }) => {
        const loadedConfig = await requestJson<SiftConfig>(configUrl);
        assert.equal(activePreset(loadedConfig).ExternalServerEnabled, false);
        const status = await requestJson<StatusResponse>(statusUrl);
        assert.equal(status.running, false);
      }, { statusPath, configPath });
    } finally {
      process.stderr.write = originalWrite;
    }

    assert.match(stderrWrites.join(''), /Managed llama\.cpp is not configured/u);
  });
});
