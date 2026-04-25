// @ts-nocheck — Split from runtime.test.js. Full TS typing deferred.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const Database = require('better-sqlite3');

const { loadConfig, saveConfig, getConfigPath, getExecutionServerState, getChunkThresholdCharacters, getConfiguredLlamaNumCtx, getEffectiveInputCharactersPerContextToken, initializeRuntime, getStatusServerUnavailableMessage, SIFT_BROKEN_DEFAULT_LLAMA_STARTUP_SCRIPT, SIFT_DEFAULT_LLAMA_STARTUP_SCRIPT, SIFT_FORMER_DEFAULT_LLAMA_STARTUP_SCRIPT, SIFT_PREVIOUS_DEFAULT_LLAMA_STARTUP_SCRIPT } = require('../dist/config/index.js');
const { summarizeRequest, buildPrompt, getSummaryDecision, planTokenAwareLlamaCppChunks, getPlannerPromptBudget, buildPlannerToolDefinitions, UNSUPPORTED_INPUT_MESSAGE } = require('../dist/summary.js');
const { runCommand } = require('../dist/command.js');
const { runBenchmarkSuite } = require('../dist/benchmark/index.js');
const { readMatrixManifest, buildLaunchSignature, buildLauncherArgs, buildBenchmarkArgs, pruneOldLauncherLogs, runMatrix, runMatrixWithInterrupt } = require('../dist/benchmark-matrix/index.js');
const { countLlamaCppTokens, listLlamaCppModels, generateLlamaCppResponse } = require('../dist/providers/llama-cpp.js');
const { withExecutionLock } = require('../dist/execution-lock.js');
const { buildIdleMetricsLogMessage, buildStatusRequestLogMessage, formatElapsed, getIdleSummarySnapshotsPath, startStatusServer } = require('../dist/status-server/index.js');
const { readStatusText } = require('../dist/status-server/status-file.js');
const { runDebugRequest } = require('../dist/scripts/run-benchmark-fixture-debug.js');
const { runFixture60MalformedJsonRepro } = require('../dist/scripts/repro-fixture60-malformed-json.js');

const {
  TEST_USE_EXISTING_SERVER,
  EXISTING_SERVER_STATUS_URL,
  EXISTING_SERVER_CONFIG_URL,
  RUN_LIVE_LLAMA_TOKENIZE_TESTS,
  LIVE_LLAMA_BASE_URL,
  LIVE_CONFIG_SERVICE_URL,
  FAST_LEASE_STALE_MS,
  FAST_LEASE_WAIT_MS,
  deriveServiceUrl,
  getDefaultConfig,
  clone,
  getChatRequestText,
  setManagedLlamaBaseUrl,
  mergeConfig,
  extractPromptSection,
  buildOversizedTransitionsInput,
  buildOversizedRunnerStateHistoryInput,
  getRuntimeRootFromStatusPath,
  getPlannerLogsPath,
  getFailedLogsPath,
  getRequestLogsPath,
  buildStructuredStubDecision,
  resolveAssistantContent,
  readBody,
  resolveArtifactLogPathFromStatusPost,
  requestJson,
  sleep,
  removeDirectoryWithRetries,
  spawnProcess,
  waitForTextMatch,
  startStubStatusServer,
  withTempEnv,
  withStubServer,
  withSummaryTestServer,
  withRealStatusServer,
  startStatusServerProcess,
  stripAnsi,
  captureStdout,
  readIdleSummarySnapshots,
  getIdleSummaryBlock,
  getFreePort,
  toSingleQuotedPowerShellLiteral,
  writeManagedLlamaScripts,
  waitForAsyncExpectation,
  runPowerShellScript,
} = require('./_runtime-helpers.js');

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

test('loadConfig normalizes legacy defaults and keeps bootstrap effective budgets until exact observations exist', async () => {
  await withTempEnv(async () => {
    await withStubServer(async () => {
      const config = await loadConfig({ ensure: true });

      assert.equal(config.LlamaCpp.NumCtx, 128000);
      assert.equal(config.LlamaCpp.Threads, -1);
      assert.equal(config.Effective.BudgetSource, 'ColdStartFixedCharsPerToken');
      assert.equal(config.Effective.InputCharactersPerContextToken, 2.5);
      assert.equal(config.Effective.MaxInputCharacters, 320000);
      assert.equal(config.Effective.ChunkThresholdCharacters, 320000);
      assert.equal(config.Thresholds.MaxInputCharacters, undefined);
      assert.equal(config.Server.LlamaCpp.ExecutablePath, null);
      assert.equal(config.Server.LlamaCpp.BaseUrl, config.Runtime.LlamaCpp.BaseUrl);
      assert.equal(config.Server.LlamaCpp.ModelPath, config.Runtime.LlamaCpp.ModelPath);
      assert.equal(Object.prototype.hasOwnProperty.call(config.Server.LlamaCpp, 'StartupScript'), false);
      assert.equal(Object.prototype.hasOwnProperty.call(config.Server.LlamaCpp, 'ShutdownScript'), false);
      assert.equal(config.Server.LlamaCpp.VerboseLogging, false);
    }, {
      config: {
        LlamaCpp: null,
        Ollama: {
          NumCtx: 16384,
          NumPredict: 2048,
        },
        Thresholds: {
          MaxInputCharacters: 32000,
          ChunkThresholdRatio: 0.75,
        },
        Server: {
          LlamaCpp: {
            StartupScript: SIFT_PREVIOUS_DEFAULT_LLAMA_STARTUP_SCRIPT,
          },
        },
      },
    });
  });
});

test('default managed startup script points to the repo-owned 9b thinking launcher', () => {
  assert.match(
    SIFT_DEFAULT_LLAMA_STARTUP_SCRIPT,
    /scripts[\\/]+start-qwen35-9b-q8-200k-thinking-managed\.ps1$/iu,
  );
  assert.equal(fs.existsSync(SIFT_DEFAULT_LLAMA_STARTUP_SCRIPT), true);
});

test('loadConfig ignores legacy startup script after ExecutablePath cutover', async () => {
  await withTempEnv(async () => {
    await withStubServer(async () => {
      const config = await loadConfig({ ensure: true });

      assert.equal(config.Server.LlamaCpp.ExecutablePath, null);
    }, {
      config: {
        Server: {
          LlamaCpp: {
            StartupScript: SIFT_FORMER_DEFAULT_LLAMA_STARTUP_SCRIPT,
          },
        },
      },
    });
  });
});

test('loadConfig ignores broken legacy startup script after ExecutablePath cutover', async () => {
  await withTempEnv(async () => {
    await withStubServer(async () => {
      const config = await loadConfig({ ensure: true });

      assert.equal(config.Server.LlamaCpp.ExecutablePath, null);
    }, {
      config: {
        Server: {
          LlamaCpp: {
            StartupScript: SIFT_BROKEN_DEFAULT_LLAMA_STARTUP_SCRIPT,
          },
        },
      },
    });
  });
});

test('loadConfig ignores legacy startup script path regardless of Windows path casing after cutover', async () => {
  await withTempEnv(async () => {
    await withStubServer(async () => {
      const config = await loadConfig({ ensure: true });

      assert.equal(config.Server.LlamaCpp.ExecutablePath, null);
    }, {
      config: {
        Server: {
          LlamaCpp: {
            StartupScript: String(SIFT_PREVIOUS_DEFAULT_LLAMA_STARTUP_SCRIPT).toLowerCase(),
          },
        },
      },
    });
  });
});

test('loadConfig removes legacy chunk threshold ratio from loaded and persisted config', async () => {
  await withTempEnv(async () => {
    await withStubServer(async (server) => {
      await loadConfig({ ensure: true });
      const config = await loadConfig({ ensure: true });
      const persisted = await requestJson(server.configUrl);

      assert.ok(!Object.prototype.hasOwnProperty.call(config.Thresholds, 'ChunkThresholdRatio'));
      assert.ok(!Object.prototype.hasOwnProperty.call(config.Effective, 'ChunkThresholdRatio'));
      assert.ok(!Object.prototype.hasOwnProperty.call(persisted.Thresholds, 'ChunkThresholdRatio'));
    }, {
      config: {
        Thresholds: {
          ChunkThresholdRatio: 0.75,
        },
      },
      metrics: {
        inputCharactersTotal: 3461904,
        inputTokensTotal: 1865267,
      },
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
      config.LlamaCpp.Threads = 8;
      config.Runtime.LlamaCpp.Threads = 8;

      const saved = await saveConfig(config);
      const persisted = await requestJson(server.configUrl);

      assert.equal(saved.LlamaCpp.Threads, 8);
      assert.equal(persisted.LlamaCpp.Threads, 8);
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
        StartupScript: managed.startupScriptPath,
        ShutdownScript: managed.shutdownScriptPath,
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
        StartupScript: managed.startupScriptPath,
        ShutdownScript: managed.shutdownScriptPath,
        StartupTimeoutMs: 5000,
        HealthcheckTimeoutMs: 100,
        HealthcheckIntervalMs: 10,
        VerboseLogging: true,
        VerboseArgs: ['--verbose'],
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

test('real status server preserves legacy default startup script as ExecutablePath during cutover', async () => {
  await withTempEnv(async (tempRoot) => {
    const statusPath = path.join(tempRoot, 'status', 'inference.txt');
    const configPath = path.join(tempRoot, 'config.json');
    const config = getDefaultConfig();
    config.Backend = 'noop';
    config.Server = {
      LlamaCpp: {
        StartupScript: SIFT_PREVIOUS_DEFAULT_LLAMA_STARTUP_SCRIPT,
      },
    };
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8');

    await withRealStatusServer(async ({ configUrl }) => {
      const loadedConfig = await requestJson(configUrl);

      assert.equal(loadedConfig.Server.LlamaCpp.ExecutablePath, SIFT_PREVIOUS_DEFAULT_LLAMA_STARTUP_SCRIPT);
    }, {
      statusPath,
      configPath,
      disableManagedLlamaStartup: true,
    });
  });
});

test('real status server preserves legacy startup script path casing as ExecutablePath during cutover', async () => {
  await withTempEnv(async (tempRoot) => {
    const statusPath = path.join(tempRoot, 'status', 'inference.txt');
    const configPath = path.join(tempRoot, 'config.json');
    const config = getDefaultConfig();
    config.Backend = 'noop';
    config.Server = {
      LlamaCpp: {
        StartupScript: String(SIFT_PREVIOUS_DEFAULT_LLAMA_STARTUP_SCRIPT).toLowerCase(),
      },
    };
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8');

    await withRealStatusServer(async ({ configUrl }) => {
      const loadedConfig = await requestJson(configUrl);

      assert.equal(loadedConfig.Server.LlamaCpp.ExecutablePath, String(SIFT_PREVIOUS_DEFAULT_LLAMA_STARTUP_SCRIPT).toLowerCase());
    }, {
      statusPath,
      configPath,
      disableManagedLlamaStartup: true,
    });
  });
});

test('real status server defaults new config to no managed ExecutablePath', async () => {
  await withTempEnv(async (tempRoot) => {
    const statusPath = path.join(tempRoot, 'status', 'inference.txt');
    const configPath = path.join(tempRoot, 'config.json');

    await withRealStatusServer(async ({ configUrl }) => {
      const loadedConfig = await requestJson(configUrl);

      assert.equal(loadedConfig.Server.LlamaCpp.ExecutablePath, null);
    }, {
      statusPath,
      configPath,
      disableManagedLlamaStartup: true,
    });
  });
});

test('real status server preserves former 9b non-thinking startup script as ExecutablePath during cutover', async () => {
  await withTempEnv(async (tempRoot) => {
    const statusPath = path.join(tempRoot, 'status', 'inference.txt');
    const configPath = path.join(tempRoot, 'config.json');
    const config = getDefaultConfig();
    config.Backend = 'noop';
    config.Server = {
      LlamaCpp: {
        StartupScript: SIFT_FORMER_DEFAULT_LLAMA_STARTUP_SCRIPT,
      },
    };
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8');

    await withRealStatusServer(async ({ configUrl }) => {
      const loadedConfig = await requestJson(configUrl);

      assert.equal(loadedConfig.Server.LlamaCpp.ExecutablePath, SIFT_FORMER_DEFAULT_LLAMA_STARTUP_SCRIPT);
    }, {
      statusPath,
      configPath,
      disableManagedLlamaStartup: true,
    });
  });
});

test('real status server preserves broken external 9b thinking startup script as ExecutablePath during cutover', async () => {
  await withTempEnv(async (tempRoot) => {
    const statusPath = path.join(tempRoot, 'status', 'inference.txt');
    const configPath = path.join(tempRoot, 'config.json');
    const config = getDefaultConfig();
    config.Backend = 'noop';
    config.Server = {
      LlamaCpp: {
        StartupScript: SIFT_BROKEN_DEFAULT_LLAMA_STARTUP_SCRIPT,
      },
    };
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8');

    await withRealStatusServer(async ({ configUrl }) => {
      const loadedConfig = await requestJson(configUrl);

      assert.equal(loadedConfig.Server.LlamaCpp.ExecutablePath, SIFT_BROKEN_DEFAULT_LLAMA_STARTUP_SCRIPT);
    }, {
      statusPath,
      configPath,
      disableManagedLlamaStartup: true,
    });
  });
});

test('real status server keeps startup status true when the startup script calls config before launch', async () => {
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
        StartupScript: managed.startupScriptPath,
        ShutdownScript: managed.shutdownScriptPath,
        StartupTimeoutMs: 5000,
        HealthcheckTimeoutMs: 100,
        HealthcheckIntervalMs: 10,
      },
    };
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8');

    await withRealStatusServer(async ({ statusUrl }) => {
      assert.equal(readStatusText(getConfigPath()), 'true');
      await waitForAsyncExpectation(async () => {
        const models = await requestJson(`${managed.baseUrl}/v1/models`);
        assert.equal(models.data[0].id, 'managed-test-model');
      }, 5000);

      const status = await requestJson(statusUrl);
      assert.equal(status.running, true);
      assert.equal(status.status, 'true');
      assert.equal(readStatusText(getConfigPath()), 'true');
    }, {
      statusPath,
      configPath,
    });
  });
});

test('real status server does not launch a second process when managed llama is already reachable', async () => {
  await withTempEnv(async (tempRoot) => {
    const statusPath = path.join(tempRoot, 'status', 'inference.txt');
    const configPath = path.join(tempRoot, 'config.json');
    const llamaPort = await getFreePort();
    const managed = writeManagedLlamaScripts(tempRoot, llamaPort, 'managed-test-model', {
      supportsSyncOnly: true,
      syncOnlyModel: 'script-model',
      writeLaunchMarker: true,
    });
    const config = getDefaultConfig();
    setManagedLlamaBaseUrl(config, managed.baseUrl);
    config.Runtime.Model = 'initial-model';
    config.Server = {
      LlamaCpp: {
        StartupScript: managed.startupScriptPath,
        ShutdownScript: null,
        StartupTimeoutMs: 5000,
        HealthcheckTimeoutMs: 100,
        HealthcheckIntervalMs: 10,
      },
    };
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8');

    const existingChild = spawn(process.execPath, [managed.fakeServerPath], {
      stdio: 'ignore',
      windowsHide: true,
    });
    fs.writeFileSync(managed.pidFilePath, String(existingChild.pid || ''), 'utf8');
    try {
      await waitForAsyncExpectation(async () => {
        const models = await requestJson(`${managed.baseUrl}/v1/models`);
        assert.equal(models.data[0].id, 'managed-test-model');
      }, 5000);
      fs.rmSync(managed.launchMarkerPath, { force: true });

      await withRealStatusServer(async ({ configUrl }) => {
        const loadedConfig = await requestJson(configUrl);
        assert.equal(loadedConfig.Runtime.Model, 'initial-model');
        assert.equal(fs.existsSync(managed.syncOnlyMarkerPath), false);
        assert.equal(fs.existsSync(managed.launchMarkerPath), false);
      }, {
        statusPath,
        configPath,
      });
    } finally {
      if (existingChild.exitCode === null && !existingChild.killed) {
        existingChild.kill('SIGTERM');
      }
      await waitForAsyncExpectation(async () => {
        await assert.rejects(() => requestJson(`${managed.baseUrl}/v1/models`));
      }, 5000).catch(() => undefined);
    }
  });
});

