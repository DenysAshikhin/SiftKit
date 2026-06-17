import test from 'node:test';
import assert from 'node:assert/strict';

import { readStatusText } from '../src/status-server/status-file.js';
import {
  fs,
  http,
  path,
  Database,
  loadConfig,
  saveConfig,
  getConfigPath,
  getChunkThresholdCharacters,
  initializeRuntime,
  getDefaultConfig,
  setManagedLlamaBaseUrl,
  requestJson,
  withTempEnv,
  withStubServer,
  withRealStatusServer,
  getFreePort,
  writeManagedLlamaScripts,
  waitForAsyncExpectation,
} from './_runtime-helpers.js';

test('getConfigPath prefers a repo-local .siftkit runtime when running inside the siftkit repo', async () => {
  await withTempEnv(async (tempRoot) => {
    const previousCwd = process.cwd();
    fs.writeFileSync(
      path.join(tempRoot, 'package.json'),
      JSON.stringify({ name: 'siftkit', version: '0.1.0' }, null, 2),
      'utf8'
    );

    try {
      process.chdir(tempRoot);
      assert.equal(getConfigPath(), path.join(tempRoot, '.siftkit', 'runtime.sqlite'));
    } finally {
      process.chdir(previousCwd);
    }
  });
});

test('loadConfig uses the fixed bootstrap chars-per-token budget before observed telemetry exists', async () => {
  await withTempEnv(async () => {
    await withStubServer(async () => {
      const config = await loadConfig({ ensure: true });

      assert.equal(config.Effective.BudgetSource, 'ColdStartFixedCharsPerToken');
      assert.equal(config.Effective.InputCharactersPerContextToken, 2.5);
      assert.equal(config.Effective.ObservedTelemetrySeen, false);
      assert.equal(config.Effective.ObservedTelemetryUpdatedAtUtc, null);
      assert.equal(config.Effective.MaxInputCharacters, 320000);
      assert.equal(config.Effective.ChunkThresholdCharacters, 320000);
    }, {
      metrics: {
        inputCharactersTotal: 0,
        inputTokensTotal: 0,
        outputCharactersTotal: 0,
        outputTokensTotal: 0,
        thinkingTokensTotal: 0,
        completedRequestCount: 0,
        requestDurationMsTotal: 0,
      },
    });
  });
});

test('loadConfig stays on bootstrap fallback when only status totals appear without exact observations', async () => {
  await withTempEnv(async () => {
    await withStubServer(async () => {
      const coldStartConfig = await loadConfig({ ensure: true });
      assert.equal(coldStartConfig.Effective.BudgetSource, 'ColdStartFixedCharsPerToken');
      assert.equal(coldStartConfig.Effective.InputCharactersPerContextToken, 2.5);
    }, {
      metrics: {
        inputCharactersTotal: 0,
        inputTokensTotal: 0,
        outputCharactersTotal: 0,
        outputTokensTotal: 0,
        thinkingTokensTotal: 0,
        completedRequestCount: 0,
        requestDurationMsTotal: 0,
      },
    });

    await withStubServer(async () => {
      const config = await loadConfig({ ensure: true });
      assert.equal(config.Effective.BudgetSource, 'ColdStartFixedCharsPerToken');
      assert.equal(config.Effective.InputCharactersPerContextToken, 2.5);
      assert.equal(config.Effective.ObservedTelemetrySeen, false);
      assert.equal(config.Effective.MaxInputCharacters, 320000);
      assert.equal(config.Effective.ChunkThresholdCharacters, 320000);
    });
  });
});

test('loadConfig uses weighted observed-budget totals instead of status snapshot telemetry once exact observations exist', async () => {
  await withTempEnv(async (tempRoot) => {
    await withStubServer(async () => {
      initializeRuntime();
      await loadConfig({ ensure: true });
      const runtimeDbPath = path.join(tempRoot, '.siftkit', 'runtime.sqlite');
      const database = new Database(runtimeDbPath);
      try {
        database.prepare(`
          INSERT INTO observed_budget_state (
            id,
            observed_telemetry_seen,
            last_known_chars_per_token,
            observed_chars_total,
            observed_tokens_total,
            updated_at_utc
          ) VALUES (1, 1, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            observed_telemetry_seen = excluded.observed_telemetry_seen,
            last_known_chars_per_token = excluded.last_known_chars_per_token,
            observed_chars_total = excluded.observed_chars_total,
            observed_tokens_total = excluded.observed_tokens_total,
            updated_at_utc = excluded.updated_at_utc
        `).run(2.75, 2750, 1000, '2026-04-25T16:00:00.000Z');
      } finally {
        database.close();
      }

      const config = await loadConfig({ ensure: true });
      assert.equal(config.Effective.BudgetSource, 'ObservedCharsPerToken');
      assert.equal(config.Effective.InputCharactersPerContextToken, 2.75);
      assert.equal(config.Effective.ObservedTelemetrySeen, true);
    }, {
      metrics: {
        inputCharactersTotal: 10,
        inputTokensTotal: 5000,
        outputCharactersTotal: 0,
        outputTokensTotal: 0,
        thinkingTokensTotal: 0,
        completedRequestCount: 0,
        requestDurationMsTotal: 0,
      },
    });
  });
});

test('loadConfig ignores legacy observed-budget rows without weighted totals and stays on bootstrap until an exact observation exists', async () => {
  await withTempEnv(async (tempRoot) => {
    await withStubServer(async () => {
      initializeRuntime();
      await loadConfig({ ensure: true });
      const runtimeDbPath = path.join(tempRoot, '.siftkit', 'runtime.sqlite');
      const database = new Database(runtimeDbPath);
      try {
        database.prepare(`
          INSERT INTO observed_budget_state (id, observed_telemetry_seen, last_known_chars_per_token, updated_at_utc)
          VALUES (1, 1, 0.07915126409690375, '2026-04-25T16:00:00.000Z')
          ON CONFLICT(id) DO UPDATE SET
            observed_telemetry_seen = excluded.observed_telemetry_seen,
            last_known_chars_per_token = excluded.last_known_chars_per_token,
            updated_at_utc = excluded.updated_at_utc
        `).run();
      } finally {
        database.close();
      }

      const config = await loadConfig({ ensure: true });
      assert.equal(config.Effective.BudgetSource, 'ColdStartFixedCharsPerToken');
      assert.equal(config.Effective.InputCharactersPerContextToken, 2.5);
      assert.equal(config.Effective.ObservedTelemetrySeen, false);
    }, {
      metrics: {
        inputCharactersTotal: 999999,
        inputTokensTotal: 1,
        outputCharactersTotal: 0,
        outputTokensTotal: 0,
        thinkingTokensTotal: 0,
        completedRequestCount: 0,
        requestDurationMsTotal: 0,
      },
    });
  });
});

test('loadConfig keeps bootstrap effective budgets until exact observations exist', async () => {
  await withTempEnv(async () => {
    await withStubServer(async () => {
      const config = await loadConfig({ ensure: true });

      assert.equal(config.Runtime.LlamaCpp.NumCtx, 128000);
      assert.equal(config.Runtime.LlamaCpp.Threads, -1);
      assert.equal(config.Effective.BudgetSource, 'ColdStartFixedCharsPerToken');
      assert.equal(config.Effective.InputCharactersPerContextToken, 2.5);
      assert.equal(config.Effective.MaxInputCharacters, 320000);
      assert.equal(config.Effective.ChunkThresholdCharacters, 320000);
    });
  });
});

test('loadConfig falls back to bootstrap when only a legacy observed-budget ratio exists and status metrics are unusable', async () => {
  await withTempEnv(async () => {
    await withStubServer(async () => {
      initializeRuntime();
      await loadConfig({ ensure: true });
      const database = new Database(path.join('.siftkit', 'runtime.sqlite'));
      try {
        database.prepare(`
          INSERT INTO observed_budget_state (id, observed_telemetry_seen, last_known_chars_per_token, updated_at_utc)
          VALUES (1, 1, 3.5, '2026-04-25T16:00:00.000Z')
          ON CONFLICT(id) DO UPDATE SET
            observed_telemetry_seen = excluded.observed_telemetry_seen,
            last_known_chars_per_token = excluded.last_known_chars_per_token,
            updated_at_utc = excluded.updated_at_utc
        `).run();
      } finally {
        database.close();
      }

      const config = await loadConfig({ ensure: true });
      assert.equal(config.Effective.BudgetSource, 'ColdStartFixedCharsPerToken');
      assert.equal(config.Effective.InputCharactersPerContextToken, 2.5);
    }, {
      metrics: {
        inputCharactersTotal: 0,
        inputTokensTotal: 0,
        outputCharactersTotal: 0,
        outputTokensTotal: 0,
        thinkingTokensTotal: 0,
        completedRequestCount: 0,
        requestDurationMsTotal: 0,
      },
    });
  });
});

test('loadConfig falls back to bootstrap when only a legacy observed-budget ratio exists and the status backend is unavailable', async () => {
  await withTempEnv(async () => {
    await withStubServer(async () => {
      initializeRuntime();
      await loadConfig({ ensure: true });
      const database = new Database(path.join('.siftkit', 'runtime.sqlite'));
      try {
        database.prepare(`
          INSERT INTO observed_budget_state (id, observed_telemetry_seen, last_known_chars_per_token, updated_at_utc)
          VALUES (1, 1, 3.5, '2026-04-25T16:00:00.000Z')
          ON CONFLICT(id) DO UPDATE SET
            observed_telemetry_seen = excluded.observed_telemetry_seen,
            last_known_chars_per_token = excluded.last_known_chars_per_token,
            updated_at_utc = excluded.updated_at_utc
        `).run();
      } finally {
        database.close();
      }
    });

    await withStubServer(async (server) => {
      process.env.SIFTKIT_CONFIG_SERVICE_URL = server.configUrl;
      process.env.SIFTKIT_STATUS_BACKEND_URL = 'http://127.0.0.1:4779/status';
      const config = await loadConfig({ ensure: true });
      assert.equal(config.Effective.BudgetSource, 'ColdStartFixedCharsPerToken');
      assert.equal(config.Effective.InputCharactersPerContextToken, 2.5);
    }, {
      metrics: {
        inputCharactersTotal: 0,
        inputTokensTotal: 0,
        outputCharactersTotal: 0,
        outputTokensTotal: 0,
        thinkingTokensTotal: 0,
        completedRequestCount: 0,
        requestDurationMsTotal: 0,
      },
    });
  });
});

test('loadConfig ignores aggregate prompt character and token totals for chars-per-token calibration', async () => {
  await withTempEnv(async () => {
    await withStubServer(async () => {
      const config = await loadConfig({ ensure: true });

      assert.equal(config.Effective.BudgetSource, 'ColdStartFixedCharsPerToken');
      assert.equal(config.Effective.InputCharactersPerContextToken, 2.5);
      assert.equal(config.Effective.MaxInputCharacters, 320000);
      assert.equal(config.Effective.ChunkThresholdCharacters, 320000);
      assert.equal(getChunkThresholdCharacters(config), 320000);
    }, {
      metrics: {
        inputCharactersTotal: 3461904,
        inputTokensTotal: 1865267,
      },
    });
  });
});

test('saveConfig preserves explicit llama.cpp thread settings through the external server', async () => {
  await withTempEnv(async () => {
    await withStubServer(async (server) => {
      const config = await loadConfig({ ensure: true });
      config.Runtime.LlamaCpp.Threads = 8;

      const saved = await saveConfig(config);
      const persisted = await requestJson(server.configUrl);

      assert.equal(saved.Runtime.LlamaCpp.Threads, 8);
      assert.equal(persisted.Runtime.LlamaCpp.Threads, 8);
    });
  });
});

test('real status server passes managed startup env flag to startup scripts', async () => {
  await withTempEnv(async (tempRoot) => {
    const statusPath = path.join(tempRoot, 'status', 'inference.txt');
    const configPath = path.join(tempRoot, 'config.json');
    const llamaPort = await getFreePort();
    const managed = writeManagedLlamaScripts(tempRoot, llamaPort, 'managed-test-model', {
      emitManagedStartupFlag: true,
    });
    const config = getDefaultConfig();
    setManagedLlamaBaseUrl(config, managed.baseUrl);
    config.Server = {
      LlamaCpp: {
        ExecutablePath: managed.startupScriptPath,
        StartupTimeoutMs: 5000,
        HealthcheckTimeoutMs: 100,
        HealthcheckIntervalMs: 10,
      },
    };
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8');

    await withRealStatusServer(async () => {
      const startupDumpPath = path.join(tempRoot, '.siftkit', 'logs', 'managed-llama', 'latest-startup.log');
      await waitForAsyncExpectation(() => {
        const dump = fs.readFileSync(startupDumpPath, 'utf8');
        assert.match(dump, /managed_startup=/u);
      });
    }, {
      statusPath,
      configPath,
    });
  });
});

test('real status server passes managed verbose env settings to startup scripts', async () => {
  await withTempEnv(async (tempRoot) => {
    const statusPath = path.join(tempRoot, 'status', 'inference.txt');
    const configPath = path.join(tempRoot, 'config.json');
    const llamaPort = await getFreePort();
    const managed = writeManagedLlamaScripts(tempRoot, llamaPort, 'managed-test-model', {
      emitVerboseEnvFlags: true,
    });
    const config = getDefaultConfig();
    setManagedLlamaBaseUrl(config, managed.baseUrl);
    config.Server = {
      LlamaCpp: {
        ExecutablePath: managed.startupScriptPath,
        StartupTimeoutMs: 5000,
        HealthcheckTimeoutMs: 100,
        HealthcheckIntervalMs: 10,
        VerboseLogging: true,
      },
    };
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8');

    await withRealStatusServer(async () => {
      const startupDumpPath = path.join(tempRoot, '.siftkit', 'logs', 'managed-llama', 'latest-startup.log');
      await waitForAsyncExpectation(() => {
        const dump = fs.readFileSync(startupDumpPath, 'utf8');
        assert.match(dump, /verbose_logging_env=1/u);
        assert.match(dump, /verbose_args_env=/u);
      });
    }, {
      statusPath,
      configPath,
    });
  });
});

test('real status server defaults new config to no managed ExecutablePath', async () => {
  await withTempEnv(async (tempRoot) => {
    const statusPath = path.join(tempRoot, 'status', 'inference.txt');
    const configPath = path.join(tempRoot, 'config.json');

    await withRealStatusServer(async ({ configUrl }) => {
      const loadedConfig = await requestJson(configUrl);

      assert.equal(loadedConfig.Server.LlamaCpp.Presets[0].ExecutablePath, null);
    }, {
      statusPath,
      configPath,
      disableManagedLlamaStartup: true,
    });
  });
});

test('real status server PUT /config persists managed ExecutablePath/ModelPath as the dashboard sends them', async () => {
  await withTempEnv(async (tempRoot) => {
    const statusPath = path.join(tempRoot, 'status', 'inference.txt');
    const configPath = path.join(tempRoot, 'config.json');
    const dashboardExecutablePath = path.join(tempRoot, 'dashboard-exe.ps1');
    const dashboardModelPath = path.join(tempRoot, 'dashboard-model.gguf');
    fs.writeFileSync(dashboardExecutablePath, '# placeholder', 'utf8');
    fs.writeFileSync(dashboardModelPath, 'fake model', 'utf8');

    await withRealStatusServer(async ({ configUrl }) => {
      const initial = await requestJson(configUrl);
      const dashboardPayload = JSON.parse(JSON.stringify(initial));
      dashboardPayload.Server.LlamaCpp.Presets[0].ExecutablePath = dashboardExecutablePath;
      dashboardPayload.Server.LlamaCpp.Presets[0].ModelPath = dashboardModelPath;

      const putResponse = await requestJson(configUrl, {
        method: 'PUT',
        body: JSON.stringify(dashboardPayload),
      });
      assert.equal(putResponse.Server.LlamaCpp.Presets[0].ExecutablePath, dashboardExecutablePath);
      assert.equal(putResponse.Server.LlamaCpp.Presets[0].ModelPath, dashboardModelPath);

      const reloaded = await requestJson(configUrl);
      assert.ok(Array.isArray(reloaded.Server.LlamaCpp.Presets));
      assert.equal(reloaded.Server.LlamaCpp.Presets[0].ExecutablePath, dashboardExecutablePath);
      assert.equal(reloaded.Server.LlamaCpp.Presets[0].ModelPath, dashboardModelPath);

      const runtimeDbPath = path.join(tempRoot, '.siftkit', 'runtime.sqlite');
      const database = new Database(runtimeDbPath);
      try {
        const row = database.prepare('SELECT server_llama_presets_json FROM app_config WHERE id = 1').get();
        const presets = JSON.parse(row.server_llama_presets_json || '[]');
        assert.ok(Array.isArray(presets) && presets.length > 0, 'expected non-empty presets in row');
        assert.equal(presets[0].ExecutablePath, dashboardExecutablePath);
        assert.equal(presets[0].ModelPath, dashboardModelPath);
      } finally {
        database.close();
      }
    }, {
      statusPath,
      configPath,
      disableManagedLlamaStartup: true,
    });
  });
});

test('real status server allows startup scripts to call config before launch and reports idle after ready', async () => {
  await withTempEnv(async (tempRoot) => {
    const statusPath = path.join(tempRoot, 'status', 'inference.txt');
    const configPath = path.join(tempRoot, 'config.json');
    const llamaPort = await getFreePort();
    const managed = writeManagedLlamaScripts(tempRoot, llamaPort, 'managed-test-model', {
      preflightConfigGet: true,
    });
    const config = getDefaultConfig();
    setManagedLlamaBaseUrl(config, managed.baseUrl);
    config.Server = {
      LlamaCpp: {
        ExecutablePath: managed.startupScriptPath,
        StartupTimeoutMs: 5000,
        HealthcheckTimeoutMs: 100,
        HealthcheckIntervalMs: 10,
      },
    };
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8');

    await withRealStatusServer(async ({ statusUrl }) => {
      assert.equal(readStatusText(getConfigPath()), 'false');
      await waitForAsyncExpectation(async () => {
        const models = await requestJson(`${managed.baseUrl}/v1/models`);
        assert.equal(models.data[0].id, 'managed-test-model');
      }, 5000);

      const status = await requestJson(statusUrl);
      assert.equal(status.running, false);
      assert.equal(status.status, 'false');
      assert.equal(readStatusText(getConfigPath()), 'false');
    }, {
      statusPath,
      configPath,
    });
  });
});

