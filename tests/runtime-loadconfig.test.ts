import { getActiveModelPreset } from '../src/config/getters.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';

import type { SiftConfig } from '../src/config/index.js';
import {
  fs,
  path,
  Database,
  loadConfig,
  saveConfig,
  getConfigPath,
  getChunkThresholdCharacters,
  initializeRuntime,
  applyManagedScriptConfig,
  getDefaultConfig,
  requestJson,
  withTempEnv,
  withStubServer,
  withRealStatusServer,
  acquireChildPortLease,
  writeManagedEngineLauncher,
  waitForAsyncExpectation,
} from './_runtime-helpers.js';

const LaunchInvocationSchema = z.object({
  argv: z.array(z.string()),
  launchEnvironment: z.record(z.string(), z.string()),
});

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
      assert.ok(config.Effective);

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
      assert.ok(coldStartConfig.Effective);
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
      assert.ok(config.Effective);
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
      assert.ok(config.Effective);
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
      assert.ok(config.Effective);
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
      assert.ok(config.Effective);

      assert.equal(getActiveModelPreset(config).NumCtx, 128000);
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
      assert.ok(config.Effective);
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
      assert.ok(config.Effective);
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
      assert.ok(config.Effective);

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

test('saveConfig preserves explicit preset launch settings through the external server', async () => {
  await withTempEnv(async () => {
    await withStubServer(async (server) => {
      const config = await loadConfig({ ensure: true });
      assert.ok(config.Effective);
      getActiveModelPreset(config).ParallelSlots = 4;

      const saved = await saveConfig(config);
      const persisted = await requestJson<SiftConfig>(server.configUrl);

      assert.equal(getActiveModelPreset(saved).ParallelSlots, 4);
      assert.equal(getActiveModelPreset(persisted).ParallelSlots, 4);
    });
  });
});

test('real status server launches the managed engine with the active preset launch environment', async () => {
  await withTempEnv(async (tempRoot) => {
    const statusPath = path.join(tempRoot, 'status', 'inference.txt');
    const configPath = path.join(tempRoot, 'config.json');
    await using enginePortLease = await acquireChildPortLease('runtime-loadconfig');
    const managed = writeManagedEngineLauncher(tempRoot, enginePortLease.port);
    const config = getDefaultConfig();
    applyManagedScriptConfig(config, managed, { NumCtx: 32_768, UBatchSize: 1024, KvCacheQuantization: 'q8_0' });
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8');

    await withRealStatusServer(async () => {
      await waitForAsyncExpectation(() => {
        const invocation = LaunchInvocationSchema.parse(JSON.parse(fs.readFileSync(managed.invocationLogPath, 'utf8')));
        assert.deepEqual(invocation.argv, []);
        assert.equal(invocation.launchEnvironment.TABBY_MODEL_MODEL_DIR, managed.modelRoot);
        assert.equal(invocation.launchEnvironment.TABBY_MODEL_MODEL_NAME, 'managed-test-model');
        assert.equal(invocation.launchEnvironment.TABBY_MODEL_MAX_SEQ_LEN, '32768');
        assert.equal(invocation.launchEnvironment.TABBY_MODEL_CHUNK_SIZE, '1024');
        assert.equal(invocation.launchEnvironment.TABBY_MODEL_CACHE_MODE, '8,8');
      });
    }, {
      statusPath,
      configPath,
      probeShimPath: managed.probeShimPath,
    });
  });
});

test('real status server defaults new config to no preset ModelPath', async () => {
  await withTempEnv(async (tempRoot) => {
    const statusPath = path.join(tempRoot, 'status', 'inference.txt');
    const configPath = path.join(tempRoot, 'config.json');

    await withRealStatusServer(async ({ configUrl }) => {
      const loadedConfig = await requestJson<SiftConfig>(configUrl);

      assert.equal(loadedConfig.Server.ModelPresets.Presets[0].ModelPath, null);
    }, {
      statusPath,
      configPath,
      disableManagedEngineStartup: true,
    });
  });
});

test('real status server PUT /config persists the preset ModelPath as the dashboard sends it', async () => {
  await withTempEnv(async (tempRoot) => {
    const statusPath = path.join(tempRoot, 'status', 'inference.txt');
    const configPath = path.join(tempRoot, 'config.json');
    const dashboardModelPath = path.join(tempRoot, 'dashboard-model');
    fs.mkdirSync(dashboardModelPath, { recursive: true });

    await withRealStatusServer(async ({ configUrl }) => {
      const initial = await requestJson(configUrl);
      const dashboardPayload = JSON.parse(JSON.stringify(initial));
      dashboardPayload.Server.ModelPresets.Presets[0].ModelPath = dashboardModelPath;

      const putResponse = await requestJson<SiftConfig>(configUrl, {
        method: 'PUT',
        body: JSON.stringify(dashboardPayload),
      });
      assert.equal(putResponse.Server.ModelPresets.Presets[0].ModelPath, dashboardModelPath);

      const reloaded = await requestJson<SiftConfig>(configUrl);
      assert.ok(Array.isArray(reloaded.Server.ModelPresets.Presets));
      assert.equal(reloaded.Server.ModelPresets.Presets[0].ModelPath, dashboardModelPath);

      const runtimeDbPath = path.join(tempRoot, '.siftkit', 'runtime.sqlite');
      const database = new Database(runtimeDbPath);
      try {
        const row = z.object({ server_model_presets_json: z.string().nullish() })
          .parse(database.prepare('SELECT server_model_presets_json FROM app_config WHERE id = 1').get());
        const presets = JSON.parse(row.server_model_presets_json || '[]');
        assert.ok(Array.isArray(presets) && presets.length > 0, 'expected non-empty presets in row');
        assert.equal(presets[0].ModelPath, dashboardModelPath);
      } finally {
        database.close();
      }
    }, {
      statusPath,
      configPath,
      disableManagedEngineStartup: true,
    });
  });
});
