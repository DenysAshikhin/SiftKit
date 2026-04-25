// @ts-nocheck
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const { summarizeRequest } = require('../dist/summary.js');
const { getStatusServerUnavailableMessage } = require('../dist/config/index.js');
const { writeConfig } = require('../dist/status-server/config-store.js');
const { readStatusText } = require('../dist/status-server/status-file.js');

const {
  FAST_LEASE_STALE_MS,
  getConfigPath,
  getDefaultConfig,
  getFreePort,
  requestJson,
  setManagedLlamaBaseUrl,
  sleep,
  waitForAsyncExpectation,
  withRealStatusServer,
  withStubServer,
  withTempEnv,
  writeManagedLlamaScripts,
} = require('./_runtime-helpers.js');

function applyManagedScriptConfig(config, managed, overrides = {}) {
  setManagedLlamaBaseUrl(config, managed.baseUrl);
  config.Server = {
    LlamaCpp: {
      BaseUrl: managed.baseUrl,
      ModelPath: managed.modelPath,
      ExecutablePath: managed.startupScriptPath,
      StartupTimeoutMs: 5000,
      HealthcheckTimeoutMs: 100,
      HealthcheckIntervalMs: 10,
      ...overrides,
    },
  };
}

test('status notification failures fail closed with the canonical message', async () => {
  await withTempEnv(async () => {
    await withStubServer(async () => {
      await assert.rejects(
        () => summarizeRequest({
          question: 'summarize this',
          inputText: 'A'.repeat(5000),
          format: 'text',
          policyProfile: 'general',
          backend: 'mock',
          model: 'mock-model',
        }),
        new RegExp(getStatusServerUnavailableMessage().replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'u')
      );
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
    config.Backend = 'noop';
    fs.mkdirSync(path.dirname(statusPath), { recursive: true });
    fs.writeFileSync(statusPath, 'true', 'utf8');
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8');

    await withRealStatusServer(async ({ statusUrl }) => {
      const status = await requestJson(statusUrl);
      assert.equal(status.running, false);
      assert.equal(status.status, 'false');
      await sleep(50);
      const laterStatus = await requestJson(statusUrl);
      assert.equal(laterStatus.running, false);
      assert.equal(laterStatus.status, 'false');
    }, {
      statusPath,
      configPath,
    });
  });
});

test('real status server initializes a missing status file to false', async () => {
  await withTempEnv(async (tempRoot) => {
    const statusPath = path.join(tempRoot, 'status', 'inference.txt');
    const configPath = path.join(tempRoot, 'config.json');
    const config = getDefaultConfig();
    config.Backend = 'noop';
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8');

    await withRealStatusServer(async ({ statusUrl }) => {
      const status = await requestJson(statusUrl);
      assert.equal(status.running, false);
      assert.equal(status.status, 'false');
    }, {
      statusPath,
      configPath,
    });
  });
});

test('real status server health reports disableManagedLlamaStartup mode when flagged', async () => {
  await withTempEnv(async (tempRoot) => {
    const statusPath = path.join(tempRoot, 'status', 'inference.txt');
    const configPath = path.join(tempRoot, 'config.json');
    const config = getDefaultConfig();
    config.Backend = 'noop';
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8');

    await withRealStatusServer(async ({ healthUrl }) => {
      const health = await requestJson(healthUrl);
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
      const loadedConfig = await requestJson(configUrl);
      assert.equal(loadedConfig.Server.LlamaCpp.BaseUrl, managed.baseUrl);
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
    config.Backend = 'noop';
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8');

    await withRealStatusServer(async ({ configUrl }) => {
      const before = await requestJson(configUrl);
      const updated = await requestJson(configUrl, {
        method: 'PUT',
        body: JSON.stringify({
          Backend: 'llama.cpp',
          Server: {
            LlamaCpp: {
              BaseUrl: 'http://127.0.0.1:18097',
              NumCtx: 123456,
            },
          },
        }),
      });

      assert.equal(updated.Backend, 'llama.cpp');
      assert.equal(updated.Thresholds.MinCharactersForSummary, before.Thresholds.MinCharactersForSummary);
      assert.equal(updated.Interactive.IdleTimeoutMs, before.Interactive.IdleTimeoutMs);
      assert.equal(updated.Server.LlamaCpp.HealthcheckTimeoutMs, before.Server.LlamaCpp.HealthcheckTimeoutMs);
    }, {
      statusPath,
      configPath,
      disableManagedLlamaStartup: true,
    });
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
        const models = await requestJson(`${managed.baseUrl}/v1/models`);
        assert.equal(models.data[0].id, 'managed-test-model');
      }, 5000);

      await withRealStatusServer(async () => {
        await waitForAsyncExpectation(async () => {
          const models = await requestJson(`${managed.baseUrl}/v1/models`);
          assert.equal(models.data[0].id, 'managed-test-model');
        }, 1000);
      }, {
        statusPath,
        configPath,
        disableManagedLlamaStartup: true,
      });

      await waitForAsyncExpectation(async () => {
        const models = await requestJson(`${managed.baseUrl}/v1/models`);
        assert.equal(models.data[0].id, 'managed-test-model');
      }, 1000);
    } finally {
      externalLlama.kill('SIGTERM');
      await new Promise((resolve) => externalLlama.once('close', resolve));
    }
  });
});
