import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';

import { summarizeRequest } from '../src/summary.js';
import { readConfig, writeConfig } from '../src/status-server/config-store.js';
import { readStatusText } from '../src/status-server/status-file.js';
import type { SiftConfig } from '../src/config/types.js';

import {
  applyManagedScriptConfig,
  getConfigPath,
  getDefaultConfig,
  getFreePort,
  requestJson,
  sleep,
  startStatusServerProcess,
  waitForAsyncExpectation,
  withRealStatusServer,
  withStubServer,
  withTempEnv,
  writeManagedLlamaScripts,
  type RuntimeStatusResponse,
  type HealthCheckResponse,
  type LlamaModelsResponse,
} from './_runtime-helpers.js';
import { getAddressInfo } from './helpers/dashboard-http.js';

test('summary status notification failures do not abort provider work', async () => {
  await withTempEnv(async () => {
    await withStubServer(async (server) => {
      const result = await summarizeRequest({
        question: 'summarize this',
        inputText: 'A'.repeat(5000),
        format: 'text',
        policyProfile: 'general',
        backend: 'mock',
        model: 'mock-model',
      });

      assert.equal(result.WasSummarized, true);
      assert.match(result.Summary, /mock summary/u);
    }, {
      failStatusPosts: true,
    });
  });
});

test('real status server clears stale true status once during startup', async () => {
  await withTempEnv(async (tempRoot) => {
    const statusPath = path.join(tempRoot, 'status', 'inference.txt');
    const configPath = path.join(tempRoot, 'config.json');
    const config = getDefaultConfig();
    fs.mkdirSync(path.dirname(statusPath), { recursive: true });
    fs.writeFileSync(statusPath, 'true', 'utf8');
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8');

    await withRealStatusServer(async ({ statusUrl }) => {
      const status = await requestJson<RuntimeStatusResponse>(statusUrl);
      assert.equal(status.running, false);
      assert.equal(status.status, 'false');
      await sleep(50);
      const laterStatus = await requestJson<RuntimeStatusResponse>(statusUrl);
      assert.equal(laterStatus.running, false);
      assert.equal(laterStatus.status, 'false');
    }, {
      statusPath,
      configPath,
      disableManagedLlamaStartup: true,
    });
  });
});

test('real status server initializes a missing status file to false', async () => {
  await withTempEnv(async (tempRoot) => {
    const statusPath = path.join(tempRoot, 'status', 'inference.txt');
    const configPath = path.join(tempRoot, 'config.json');
    const config = getDefaultConfig();
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8');

    await withRealStatusServer(async ({ statusUrl }) => {
      const status = await requestJson<RuntimeStatusResponse>(statusUrl);
      assert.equal(status.running, false);
      assert.equal(status.status, 'false');
    }, {
      statusPath,
      configPath,
      disableManagedLlamaStartup: true,
    });
  });
});

test('real status server health reports disableManagedLlamaStartup mode when flagged', async () => {
  await withTempEnv(async (tempRoot) => {
    const statusPath = path.join(tempRoot, 'status', 'inference.txt');
    const configPath = path.join(tempRoot, 'config.json');
    const config = getDefaultConfig();
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8');

    await withRealStatusServer(async ({ healthUrl }) => {
      const health = await requestJson<HealthCheckResponse>(healthUrl);
      assert.equal(health.ok, true);
      assert.equal(health.disableManagedLlamaStartup, true);
    }, {
      statusPath,
      configPath,
      disableManagedLlamaStartup: true,
    });
  });
});

test('real status server with disableManagedLlamaStartup skips managed llama bootstrap during server startup', async () => {
  await withTempEnv(async (tempRoot) => {
    const statusPath = path.join(tempRoot, '.siftkit', 'status', 'inference.txt');
    const configPath = getConfigPath();
    const llamaPort = await getFreePort();
    const managed = writeManagedLlamaScripts(tempRoot, llamaPort);
    const config = getDefaultConfig();
    applyManagedScriptConfig(config, managed);
    writeConfig(configPath, config);

    await withRealStatusServer(async ({ statusUrl }) => {
      await sleep(50);
      assert.equal(fs.existsSync(managed.readyFilePath), false);
      const status = await requestJson<RuntimeStatusResponse>(statusUrl);
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

test('real status server with disableManagedLlamaStartup does not trigger managed startup from GET /config', async () => {
  await withTempEnv(async (tempRoot) => {
    const statusPath = path.join(tempRoot, 'status', 'inference.txt');
    const configPath = path.join(tempRoot, 'config.json');
    const llamaPort = await getFreePort();
    const managed = writeManagedLlamaScripts(tempRoot, llamaPort);
    const config = getDefaultConfig();
    applyManagedScriptConfig(config, managed);
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8');

    await withRealStatusServer(async ({ configUrl }) => {
      const loadedConfig = await requestJson<SiftConfig>(configUrl);
      assert.equal(loadedConfig.Server.ModelPresets.Presets[0].BaseUrl, managed.baseUrl);
      await sleep(50);
      assert.equal(fs.existsSync(managed.readyFilePath), false);
    }, {
      statusPath,
      configPath,
      disableManagedLlamaStartup: true,
    });
  });
});

test('real status server accepts partial PUT /config updates and preserves unspecified fields', async () => {
  await withTempEnv(async (tempRoot) => {
    const statusPath = path.join(tempRoot, 'status', 'inference.txt');
    const configPath = path.join(tempRoot, 'config.json');
    const config = getDefaultConfig();
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8');

    await withRealStatusServer(async ({ configUrl }) => {
      const before = await requestJson<SiftConfig>(configUrl);
      const activePreset = before.Server.ModelPresets.Presets[0];
      if (!activePreset) throw new Error('Active model preset is missing');
      const updated = await requestJson<SiftConfig>(configUrl, {
        method: 'PUT',
        body: JSON.stringify({
          Backend: 'llama.cpp',
          Server: {
            ModelPresets: {
              ActivePresetId: activePreset.id,
              Presets: [{
                ...activePreset,
                BaseUrl: 'http://127.0.0.1:18097',
                NumCtx: 123456,
              }],
            },
          },
        }),
      });

      assert.equal(updated.Backend, 'llama.cpp');
      assert.equal(updated.Thresholds.MinCharactersForSummary, before.Thresholds.MinCharactersForSummary);
      assert.equal(updated.Interactive.IdleTimeoutMs, before.Interactive.IdleTimeoutMs);
      assert.equal(updated.Server.ModelPresets.Presets[0].HealthcheckTimeoutMs, before.Server.ModelPresets.Presets[0].HealthcheckTimeoutMs);
    }, {
      statusPath,
      configPath,
      disableManagedLlamaStartup: true,
    });
  });
});

test('real status server rejects removed config fields without leaving the request open', async () => {
  await withTempEnv(async (tempRoot) => {
    const statusPath = path.join(tempRoot, 'status', 'inference.txt');
    const configPath = path.join(tempRoot, 'config.json');
    fs.writeFileSync(configPath, JSON.stringify(getDefaultConfig(), null, 2), 'utf8');

    await withRealStatusServer(async ({ configUrl }) => {
      await assert.rejects(requestJson(configUrl, {
        method: 'PUT',
        body: JSON.stringify({ Server: { LlamaCpp: {} } }),
      }), /HTTP 400:.*Unsupported configuration field Server\.LlamaCpp/u);
    }, {
      statusPath,
      configPath,
      disableManagedLlamaStartup: true,
    });
  });
});

test('failed preset switch returns 503 and keeps the status server alive', async () => {
  await withTempEnv(async (tempRoot) => {
    let tabbyResident = false;
    const tabby = http.createServer((request, response) => {
      if (request.url === '/v1/models') {
        response.setHeader('content-type', 'application/json');
        response.end('{"data":[]}');
        return;
      }
      if (request.url === '/v1/model/load' && request.method === 'POST') {
        tabbyResident = true;
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        response.end('data: {"model_type":"model","module":1,"modules":1,"status":"finished"}\n\n');
        return;
      }
      if (request.url === '/v1/model' && request.method === 'GET') {
        response.statusCode = tabbyResident ? 200 : 503;
        response.setHeader('content-type', 'application/json');
        response.end(tabbyResident ? '{"id":"tabby-model"}' : '{}');
        return;
      }
      if (request.url === '/v1/model/unload' && request.method === 'POST') {
        tabbyResident = false;
        response.statusCode = 200;
        response.end();
        return;
      }
      response.statusCode = 404;
      response.end();
    });
    await new Promise<void>((resolve) => tabby.listen(0, '127.0.0.1', resolve));

    const configPath = getConfigPath();
    const statusPath = path.join(tempRoot, '.siftkit', 'status', 'inference.txt');
    const unreachableLlamaPort = await getFreePort();
    const config = getDefaultConfig();
    const basePreset = config.Server.ModelPresets.Presets[0];
    if (!basePreset) throw new Error('Default model preset is missing');
    const exl3Preset = {
      ...basePreset,
      id: 'exl3-main',
      Backend: 'exl3' as const,
      BaseUrl: `http://127.0.0.1:${getAddressInfo(tabby).port}`,
      Model: 'tabby-model',
      ModelPath: path.join(tempRoot, 'tabby-model'),
    };
    const llamaPreset = {
      ...basePreset,
      id: 'llama-main',
      Backend: 'llama' as const,
      ExternalServerEnabled: true,
      BaseUrl: `http://127.0.0.1:${unreachableLlamaPort}`,
      Model: 'llama-model',
      HealthcheckTimeoutMs: 50,
    };
    config.Server.Engines.Exl3 = {
      Managed: false,
      WorkingDirectory: tempRoot,
      PythonPath: process.execPath,
      Entrypoint: 'unused',
      ConfigPath: 'config.yml',
      ModelRoot: tempRoot,
      AdminApiKey: '',
      ShutdownTimeoutMs: 1_000,
    };
    config.Server.ModelPresets = {
      ActivePresetId: exl3Preset.id,
      Presets: [exl3Preset, llamaPreset],
    };
    writeConfig(configPath, config);
    const statusServer = await startStatusServerProcess({ statusPath, configPath, workingDirectory: tempRoot });

    try {
      await new Promise<void>((resolve) => tabby.close(() => resolve()));
      config.Server.ModelPresets.ActivePresetId = llamaPreset.id;
      const update = await fetch(statusServer.configUrl, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(config),
      });

      assert.equal(update.status, 503);
      assert.equal(readConfig(configPath).Server.ModelPresets.ActivePresetId, exl3Preset.id);
      assert.equal((await fetch(`http://127.0.0.1:${statusServer.port}/health`)).status, 200);
    } finally {
      if (tabby.listening) await new Promise<void>((resolve) => tabby.close(() => resolve()));
      await statusServer.close();
    }
  });
});

test('real status server with disableManagedLlamaStartup leaves an externally started llama running across boot and close', async () => {
  await withTempEnv(async (tempRoot) => {
    const statusPath = path.join(tempRoot, 'status', 'inference.txt');
    const configPath = path.join(tempRoot, 'config.json');
    const llamaPort = await getFreePort();
    const managed = writeManagedLlamaScripts(tempRoot, llamaPort);
    const config = getDefaultConfig();
    applyManagedScriptConfig(config, managed);
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8');

    const externalLlama = spawn(process.execPath, [managed.fakeServerPath], {
      stdio: 'ignore',
      windowsHide: true,
    });

    try {
      await waitForAsyncExpectation(async () => {
        const models = await requestJson<LlamaModelsResponse>(`${managed.baseUrl}/v1/models`);
        assert.equal(models.data[0].id, 'managed-test-model');
      }, 5000);

      await withRealStatusServer(async () => {
        await waitForAsyncExpectation(async () => {
          const models = await requestJson<LlamaModelsResponse>(`${managed.baseUrl}/v1/models`);
          assert.equal(models.data[0].id, 'managed-test-model');
        }, 1000);
      }, {
        statusPath,
        configPath,
        disableManagedLlamaStartup: true,
      });

      await waitForAsyncExpectation(async () => {
        const models = await requestJson<LlamaModelsResponse>(`${managed.baseUrl}/v1/models`);
        assert.equal(models.data[0].id, 'managed-test-model');
      }, 1000);
    } finally {
      externalLlama.kill('SIGTERM');
      await new Promise<void>((resolve) => externalLlama.once('close', () => resolve()));
    }
  });
});
