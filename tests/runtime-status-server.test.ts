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
const { writeConfig } = require('../dist/status-server/config-store.js');
const { readStatusText } = require('../dist/status-server/status-file.js');
const { upsertRepoSearchRun } = require('../dist/status-server/dashboard-runs.js');
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

test('real status server normalizes legacy non-boolean status text to false', async () => {
  await withTempEnv(async (tempRoot) => {
    const statusPath = path.join(tempRoot, '.siftkit', 'status', 'inference.txt');
    const configPath = getConfigPath();
    const config = getDefaultConfig();
    config.Backend = 'noop';
    fs.mkdirSync(path.dirname(statusPath), { recursive: true });
    fs.writeFileSync(statusPath, 'foreign_lock', 'utf8');
    writeConfig(configPath, config);

    await withRealStatusServer(async ({ statusUrl }) => {
      await waitForAsyncExpectation(async () => {
        assert.equal(readStatusText(getConfigPath()), 'false');
      }, 2000);
      const status = await requestJson(statusUrl);
      assert.equal(status.running, false);
      assert.equal(status.status, 'false');
    }, {
      statusPath,
      configPath,
      executionLeaseStaleMs: FAST_LEASE_STALE_MS,
    });
  });
});

test('real status server rejects non-boolean statuses in POST /status payloads', async () => {
  await withTempEnv(async (tempRoot) => {
    const statusPath = path.join(tempRoot, 'status', 'inference.txt');
    const configPath = path.join(tempRoot, 'config.json');
    const config = getDefaultConfig();
    config.Backend = 'noop';
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8');

    await withRealStatusServer(async ({ statusUrl }) => {
      await assert.rejects(() => requestJson(statusUrl, {
        method: 'POST',
        body: JSON.stringify({ status: 'foreign_lock' }),
      }), /Expected running=true\|false or status=true\|false\./u);
    }, {
      statusPath,
      configPath,
    });
  });
});

test('real status server accepts boolean-like running payload variants', async () => {
  await withTempEnv(async (tempRoot) => {
    const statusPath = path.join(tempRoot, 'status', 'inference.txt');
    const configPath = path.join(tempRoot, 'config.json');
    const config = getDefaultConfig();
    config.Backend = 'noop';
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8');

    await withRealStatusServer(async ({ statusUrl }) => {
      const stopped = await requestJson(statusUrl, {
        method: 'POST',
        body: JSON.stringify({ status: false }),
      });
      assert.equal(stopped.running, false);
      assert.equal(stopped.status, 'false');
      assert.equal(fs.readFileSync(statusPath, 'utf8').trim(), 'false');

      const running = await requestJson(statusUrl, {
        method: 'POST',
        body: JSON.stringify({ running: 'true' }),
      });
      assert.equal(running.running, true);
      assert.equal(running.status, 'true');
      assert.equal(fs.readFileSync(statusPath, 'utf8').trim(), 'true');
    }, {
      statusPath,
      configPath,
    });
  });
});

test('real status server preserves true status while an active request is tracked', async () => {
  await withTempEnv(async (tempRoot) => {
    const statusPath = path.join(tempRoot, 'status', 'inference.txt');
    const configPath = path.join(tempRoot, 'config.json');
    const config = getDefaultConfig();
    config.Backend = 'noop';
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8');

    await withRealStatusServer(async ({ statusUrl, statusPath: liveStatusPath }) => {
      await requestJson(statusUrl, {
        method: 'POST',
        body: JSON.stringify({ running: true }),
      });

      assert.equal(fs.readFileSync(liveStatusPath, 'utf8').trim(), 'true');
      await sleep(FAST_LEASE_WAIT_MS);
      assert.equal(fs.readFileSync(liveStatusPath, 'utf8').trim(), 'true');
    }, {
      statusPath,
      configPath,
      executionLeaseStaleMs: FAST_LEASE_STALE_MS,
    });
  });
});

test('real status server persists aggregate metrics and exposes them from GET /status', async () => {
  await withTempEnv(async (tempRoot) => {
    const statusPath = path.join(tempRoot, 'status', 'inference.txt');
    const configPath = path.join(tempRoot, 'config.json');
    const metricsPath = path.join(tempRoot, 'metrics', 'compression.json');
    const config = getDefaultConfig();
    config.Backend = 'noop';
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8');

    await withRealStatusServer(async ({ statusUrl }) => {
      await requestJson(statusUrl, {
        method: 'POST',
        body: JSON.stringify({ running: true, rawInputCharacterCount: 400, taskKind: 'summary' }),
      });
      await requestJson(statusUrl, {
        method: 'POST',
        body: JSON.stringify({
          running: false,
          taskKind: 'summary',
          promptCharacterCount: 410,
          inputTokens: 100,
          outputCharacterCount: 120,
          outputTokens: 25,
          toolTokens: 7,
          speculativeAcceptedTokens: 9,
          speculativeGeneratedTokens: 12,
          requestDurationMs: 800,
        }),
      });

      const status = await requestJson(statusUrl);
      assert.equal(status.metrics.inputCharactersTotal, 410);
      assert.equal(status.metrics.outputCharactersTotal, 120);
      assert.equal(status.metrics.inputTokensTotal, 100);
      assert.equal(status.metrics.outputTokensTotal, 25);
      assert.equal(status.metrics.thinkingTokensTotal, 0);
      assert.equal(status.metrics.toolTokensTotal, 7);
      assert.equal(status.metrics.speculativeAcceptedTokensTotal, 9);
      assert.equal(status.metrics.speculativeGeneratedTokensTotal, 12);
      assert.equal(status.metrics.requestDurationMsTotal, 800);
      assert.ok(status.metrics.completedRequestCount >= 0);
      assert.equal(status.metrics.taskTotals.summary.inputTokensTotal, 100);
      assert.equal(status.metrics.taskTotals.summary.outputTokensTotal, 25);
      assert.equal(status.metrics.taskTotals.summary.toolTokensTotal, 7);
      assert.equal(status.metrics.taskTotals.summary.speculativeAcceptedTokensTotal, 9);
      assert.equal(status.metrics.taskTotals.summary.speculativeGeneratedTokensTotal, 12);
      assert.equal(status.metrics.taskTotals.plan.inputTokensTotal, 0);
      assert.equal(typeof status.metrics.updatedAtUtc, 'string');
      assert.equal(fs.existsSync(path.join(tempRoot, '.siftkit', 'runtime.sqlite')), true);
    }, {
      statusPath,
      configPath,
      disableManagedLlamaStartup: true,
    });

    await withRealStatusServer(async ({ statusUrl }) => {
      const status = await requestJson(statusUrl);
      assert.equal(status.metrics.inputCharactersTotal, 410);
      assert.equal(status.metrics.outputCharactersTotal, 120);
      assert.equal(status.metrics.inputTokensTotal, 100);
      assert.equal(status.metrics.outputTokensTotal, 25);
      assert.equal(status.metrics.thinkingTokensTotal, 0);
      assert.equal(status.metrics.toolTokensTotal, 7);
      assert.equal(status.metrics.speculativeAcceptedTokensTotal, 9);
      assert.equal(status.metrics.speculativeGeneratedTokensTotal, 12);
      assert.equal(status.metrics.taskTotals.summary.inputTokensTotal, 100);
      assert.equal(status.metrics.taskTotals.summary.outputTokensTotal, 25);
      assert.equal(status.metrics.taskTotals.summary.toolTokensTotal, 7);
      assert.equal(status.metrics.taskTotals.summary.speculativeAcceptedTokensTotal, 9);
      assert.equal(status.metrics.taskTotals.summary.speculativeGeneratedTokensTotal, 12);
      assert.equal(status.metrics.requestDurationMsTotal, 800);
      assert.ok(status.metrics.completedRequestCount >= 0);
    }, {
      statusPath,
      configPath,
      disableManagedLlamaStartup: true,
    });
  });
});

test('real status server starts managed llama.cpp during server startup before serving requests', async () => {
  await withTempEnv(async (tempRoot) => {
    const statusPath = path.join(tempRoot, 'status', 'inference.txt');
    const configPath = path.join(tempRoot, 'config.json');
    const llamaPort = await getFreePort();
    const managed = writeManagedLlamaScripts(tempRoot, llamaPort);
    const config = getDefaultConfig();
    setManagedLlamaBaseUrl(config, managed.baseUrl);
    config.Server = {
      LlamaCpp: {
        StartupScript: managed.startupScriptPath,
        ShutdownScript: managed.shutdownScriptPath,
        StartupTimeoutMs: 5000,
        HealthcheckTimeoutMs: 200,
        HealthcheckIntervalMs: 50,
      },
    };
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8');

    await withRealStatusServer(async ({ port, statusUrl }) => {
      assert.equal(fs.readFileSync(statusPath, 'utf8').trim(), 'true');
      await waitForAsyncExpectation(async () => {
        const models = await requestJson(`${managed.baseUrl}/v1/models`);
        assert.equal(models.data[0].id, 'managed-test-model');
      }, 5000);
      await waitForAsyncExpectation(async () => {
        const status = await requestJson(statusUrl);
        assert.equal(status.running, true);
        assert.equal(status.status, 'true');
        assert.equal(fs.readFileSync(statusPath, 'utf8').trim(), 'true');
      }, 5000);
      const latestStartupDumpPath = path.join(tempRoot, 'logs', 'managed-llama', 'latest-startup.log');
      assert.equal(fs.existsSync(latestStartupDumpPath), true);
      const latestStartupDumpText = fs.readFileSync(latestStartupDumpPath, 'utf8');
      assert.match(latestStartupDumpText, /Result: ready/u);
      assert.match(latestStartupDumpText, /startup_script_stdout/u);

      const previousConfigUrl = process.env.SIFTKIT_CONFIG_SERVICE_URL;
      const previousStatusUrl = process.env.SIFTKIT_STATUS_BACKEND_URL;
      process.env.SIFTKIT_CONFIG_SERVICE_URL = `http://127.0.0.1:${port}/config`;
      process.env.SIFTKIT_STATUS_BACKEND_URL = statusUrl;

      try {
        const loadedConfig = await loadConfig({ ensure: true });
        assert.equal(loadedConfig.LlamaCpp.BaseUrl, managed.baseUrl);
        assert.equal(loadedConfig.Server.LlamaCpp.StartupScript, managed.startupScriptPath);
      } finally {
        if (previousConfigUrl === undefined) {
          delete process.env.SIFTKIT_CONFIG_SERVICE_URL;
        } else {
          process.env.SIFTKIT_CONFIG_SERVICE_URL = previousConfigUrl;
        }
        if (previousStatusUrl === undefined) {
          delete process.env.SIFTKIT_STATUS_BACKEND_URL;
        } else {
          process.env.SIFTKIT_STATUS_BACKEND_URL = previousStatusUrl;
        }
      }

      assert.equal(fs.existsSync(managed.readyFilePath), true);
    }, {
      statusPath,
      configPath,
    });

    await waitForAsyncExpectation(
      async () => assert.rejects(() => requestJson(`${managed.baseUrl}/v1/models`)),
      5000
    );
    await waitForAsyncExpectation(async () => {
      assert.equal(fs.existsSync(managed.pidFilePath), false);
    }, 5000);
    await sleep(250);
  });
});

test('managed llama scripts no longer receive status-path coordination args or env vars', async () => {
  await withTempEnv(async (tempRoot) => {
    const statusPath = path.join(tempRoot, '.siftkit', 'status', 'inference.txt');
    const configPath = getConfigPath();
    const llamaPort = await getFreePort();
    const managed = writeManagedLlamaScripts(tempRoot, llamaPort, 'managed-test-model', {
      captureInvocation: true,
    });
    const config = getDefaultConfig();
    setManagedLlamaBaseUrl(config, managed.baseUrl);
    config.Server = {
      LlamaCpp: {
        StartupScript: managed.startupScriptPath,
        ShutdownScript: managed.shutdownScriptPath,
        StartupTimeoutMs: 5000,
        HealthcheckTimeoutMs: 200,
        HealthcheckIntervalMs: 50,
      },
    };
    writeConfig(configPath, config);

    await withRealStatusServer(async () => {
      await waitForAsyncExpectation(async () => {
        assert.equal(fs.existsSync(managed.invocationLogPath), true);
        const invocation = JSON.parse(fs.readFileSync(managed.invocationLogPath, 'utf8').replace(/^\uFEFF/u, ''));
        assert.equal(typeof invocation.ConfigPath, 'string');
        assert.equal(typeof invocation.ConfigUrl, 'string');
        assert.equal(typeof invocation.HealthUrl, 'string');
        assert.equal(typeof invocation.RuntimeRoot, 'string');
        assert.equal(invocation.StatusPath || '', '');
        assert.equal(invocation.StatusUrl || '', '');
        assert.equal(invocation.ServerConfigPathEnv, getConfigPath());
        assert.match(String(invocation.ServerConfigUrlEnv || ''), /\/config$/u);
        assert.equal(invocation.ServerStatusPathEnv || '', '');
        assert.equal(invocation.ServerStatusUrlEnv || '', '');
        assert.match(String(invocation.ServerHealthUrlEnv || ''), /\/health$/u);
      }, 5000);
    }, {
      statusPath,
      configPath,
    });
  });
});

test('real status server ignores legacy non-boolean status text when starting managed llama.cpp', async () => {
  await withTempEnv(async (tempRoot) => {
    const statusPath = path.join(tempRoot, '.siftkit', 'status', 'inference.txt');
    const configPath = getConfigPath();
    const llamaPort = await getFreePort();
    const managed = writeManagedLlamaScripts(tempRoot, llamaPort);
    const config = getDefaultConfig();
    setManagedLlamaBaseUrl(config, managed.baseUrl);
    config.Server = {
      LlamaCpp: {
        StartupScript: managed.startupScriptPath,
        ShutdownScript: managed.shutdownScriptPath,
        StartupTimeoutMs: 5000,
        HealthcheckTimeoutMs: 200,
        HealthcheckIntervalMs: 50,
      },
    };
    fs.mkdirSync(path.dirname(statusPath), { recursive: true });
    fs.writeFileSync(statusPath, 'foreign_lock', 'utf8');
    writeConfig(configPath, config);

    await withRealStatusServer(async ({ statusUrl }) => {
      await waitForAsyncExpectation(async () => {
        assert.equal(fs.existsSync(managed.readyFilePath), true);
        const status = await requestJson(statusUrl);
        assert.equal(status.running, true);
        assert.equal(status.status, 'true');
      }, 5000);
    }, {
      statusPath,
      configPath,
      awaitStartup: false,
    });
  });
});

test('real status server keeps published true status while managed llama stays ready', async () => {
  await withTempEnv(async (tempRoot) => {
    const statusPath = path.join(tempRoot, 'status', 'inference.txt');
    const configPath = path.join(tempRoot, 'config.json');
    const llamaPort = await getFreePort();
    const managed = writeManagedLlamaScripts(tempRoot, llamaPort);
    const config = getDefaultConfig();
    setManagedLlamaBaseUrl(config, managed.baseUrl);
    config.Server = {
      LlamaCpp: {
        StartupScript: managed.startupScriptPath,
        ShutdownScript: managed.shutdownScriptPath,
        StartupTimeoutMs: 5000,
        HealthcheckTimeoutMs: 200,
        HealthcheckIntervalMs: 50,
      },
    };
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8');

    await withRealStatusServer(async ({ statusUrl }) => {
      await waitForAsyncExpectation(async () => {
        const models = await requestJson(`${managed.baseUrl}/v1/models`);
        assert.equal(models.data[0].id, 'managed-test-model');
      }, 5000);

      assert.equal(fs.readFileSync(statusPath, 'utf8').trim(), 'true');
      await sleep(FAST_LEASE_WAIT_MS);

      const status = await requestJson(statusUrl);
      assert.equal(status.running, true);
      assert.equal(status.status, 'true');
      assert.equal(fs.readFileSync(statusPath, 'utf8').trim(), 'true');
    }, {
      statusPath,
      configPath,
      executionLeaseStaleMs: FAST_LEASE_STALE_MS,
    });
  });
});

test('real status server sync-only startup pass does not launch a second llama process', async () => {
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
    config.Server = {
      LlamaCpp: {
        StartupScript: managed.startupScriptPath,
        ShutdownScript: null,
        StartupTimeoutMs: 5000,
        HealthcheckTimeoutMs: 200,
        HealthcheckIntervalMs: 50,
      },
    };
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8');

    runPowerShellScript(managed.startupScriptPath);
    await waitForAsyncExpectation(async () => {
      const models = await requestJson(`${managed.baseUrl}/v1/models`);
      assert.equal(models.data[0].id, 'managed-test-model');
    }, 5000);
    fs.rmSync(managed.launchMarkerPath, { force: true });

    await withRealStatusServer(async () => {
      await waitForAsyncExpectation(async () => {
        assert.equal(fs.existsSync(managed.syncOnlyMarkerPath), true);
      }, 5000);
      assert.equal(fs.existsSync(managed.launchMarkerPath), false);
    }, {
      statusPath,
      configPath,
    });

    runPowerShellScript(managed.shutdownScriptPath);
    await waitForAsyncExpectation(async () => {
      await assert.rejects(() => requestJson(`${managed.baseUrl}/v1/models`));
    }, 5000);
  });
});

test('real status server fails closed during startup when managed llama logs contain warnings', async () => {
  await withTempEnv(async (tempRoot) => {
    const statusPath = path.join(tempRoot, 'status', 'inference.txt');
    const configPath = path.join(tempRoot, 'config.json');
    const llamaPort = await getFreePort();
    const managed = writeManagedLlamaScripts(tempRoot, llamaPort, 'managed-test-model', {
      llamaLogLine: 'warning: fake llama startup warning',
    });
    const config = getDefaultConfig();
    setManagedLlamaBaseUrl(config, managed.baseUrl);
    config.Server = {
      LlamaCpp: {
        StartupScript: managed.startupScriptPath,
        ShutdownScript: managed.shutdownScriptPath,
        StartupTimeoutMs: 5000,
        HealthcheckTimeoutMs: 200,
        HealthcheckIntervalMs: 50,
      },
    };
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8');

    await assert.rejects(
      () => startStatusServerProcess({
        statusPath,
        configPath,
      }),
      /startup logs contained warning\/error markers/i
    );

    const managedLogRoot = path.join(tempRoot, 'logs', 'managed-llama');
    const dumpFiles = fs.existsSync(managedLogRoot)
      ? fs.readdirSync(managedLogRoot, { recursive: true })
        .map((entry) => path.join(managedLogRoot, String(entry)))
        .filter((entryPath) => /startup-scan-failure\.log$/u.test(entryPath))
      : [];
    assert.ok(dumpFiles.length > 0);
    const dumpText = fs.readFileSync(dumpFiles[0], 'utf8');
    assert.match(dumpText, /warning: fake llama startup warning/u);
    const latestStartupDumpPath = path.join(tempRoot, 'logs', 'managed-llama', 'latest-startup.log');
    assert.equal(fs.existsSync(latestStartupDumpPath), true);
    assert.match(fs.readFileSync(latestStartupDumpPath, 'utf8'), /Result: failed/u);
  });
});

test('real status server ignores transient Loading model 503 startup log lines', async () => {
  await withTempEnv(async (tempRoot) => {
    const statusPath = path.join(tempRoot, 'status', 'inference.txt');
    const configPath = path.join(tempRoot, 'config.json');
    const llamaPort = await getFreePort();
    const managed = writeManagedLlamaScripts(tempRoot, llamaPort, 'managed-test-model', {
      llamaLogLine: 'srv  log_server_r: response: {"error":{"message":"Loading model","type":"unavailable_error","code":503}}',
    });
    const config = getDefaultConfig();
    setManagedLlamaBaseUrl(config, managed.baseUrl);
    config.Server = {
      LlamaCpp: {
        StartupScript: managed.startupScriptPath,
        ShutdownScript: managed.shutdownScriptPath,
        StartupTimeoutMs: 5000,
        HealthcheckTimeoutMs: 200,
        HealthcheckIntervalMs: 50,
      },
    };
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8');

    await withRealStatusServer(async ({ healthUrl }) => {
      const health = await requestJson(healthUrl);
      assert.equal(health.ok, true);
    }, {
      statusPath,
      configPath,
    });

    const latestStartupDumpPath = path.join(tempRoot, 'logs', 'managed-llama', 'latest-startup.log');
    assert.equal(fs.existsSync(latestStartupDumpPath), true);
    assert.match(fs.readFileSync(latestStartupDumpPath, 'utf8'), /Result: ready/u);
  });
});

test('real status server keeps running in degraded mode when managed llama startup is broken', async () => {
  await withTempEnv(async (tempRoot) => {
    const statusPath = path.join(tempRoot, 'status', 'inference.txt');
    const configPath = path.join(tempRoot, 'config.json');
    const llamaPort = await getFreePort();
    const managed = writeManagedLlamaScripts(tempRoot, llamaPort, 'managed-test-model', {
      launchHangingProcess: true,
    });
    const config = getDefaultConfig();
    setManagedLlamaBaseUrl(config, managed.baseUrl);
    config.Server = {
      LlamaCpp: {
        StartupScript: managed.startupScriptPath,
        ShutdownScript: managed.shutdownScriptPath,
        StartupTimeoutMs: 5_000,
        HealthcheckTimeoutMs: 200,
        HealthcheckIntervalMs: 50,
      },
    };
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8');

    const server = await startStatusServerProcess({
      statusPath,
      configPath,
    });
    try {
      const health = await requestJson(`${server.statusUrl.replace(/\/status$/u, '/health')}`);
      assert.equal(health.ok, true);
      assert.equal('managedLlamaReady' in health, false);
      assert.equal('managedLlamaStarting' in health, false);
      assert.equal('managedLlamaStartupWarning' in health, false);
    } finally {
      await server.close();
    }

    assert.equal(fs.existsSync(managed.pidFilePath), false);
  });
});

test('real status server clears a stale managed llama process during startup before serving requests', async () => {
  await withTempEnv(async (tempRoot) => {
    const statusPath = path.join(tempRoot, 'status', 'inference.txt');
    const configPath = path.join(tempRoot, 'config.json');
    const llamaPort = await getFreePort();
    const managed = writeManagedLlamaScripts(tempRoot, llamaPort);
    const config = getDefaultConfig();
    setManagedLlamaBaseUrl(config, managed.baseUrl);
    config.Server = {
      LlamaCpp: {
        StartupScript: managed.startupScriptPath,
        ShutdownScript: managed.shutdownScriptPath,
        StartupTimeoutMs: 5000,
        HealthcheckTimeoutMs: 200,
        HealthcheckIntervalMs: 50,
      },
    };
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8');

    runPowerShellScript(managed.startupScriptPath);
    await waitForAsyncExpectation(async () => {
      const models = await requestJson(`${managed.baseUrl}/v1/models`);
      assert.equal(models.data[0].id, 'managed-test-model');
    }, 5000);

    await withRealStatusServer(async ({ port }) => {
      const previousConfigUrl = process.env.SIFTKIT_CONFIG_SERVICE_URL;
      const previousStatusUrl = process.env.SIFTKIT_STATUS_BACKEND_URL;
      process.env.SIFTKIT_CONFIG_SERVICE_URL = `http://127.0.0.1:${port}/config`;
      process.env.SIFTKIT_STATUS_BACKEND_URL = `http://127.0.0.1:${port}/status`;
      try {
        const loadedConfig = await loadConfig({ ensure: true });
        assert.equal(loadedConfig.LlamaCpp.BaseUrl, managed.baseUrl);
        await waitForAsyncExpectation(async () => {
          const models = await requestJson(`${managed.baseUrl}/v1/models`);
          assert.equal(models.data[0].id, 'managed-test-model');
        }, 5000);
      } finally {
        if (previousConfigUrl === undefined) {
          delete process.env.SIFTKIT_CONFIG_SERVICE_URL;
        } else {
          process.env.SIFTKIT_CONFIG_SERVICE_URL = previousConfigUrl;
        }
        if (previousStatusUrl === undefined) {
          delete process.env.SIFTKIT_STATUS_BACKEND_URL;
        } else {
          process.env.SIFTKIT_STATUS_BACKEND_URL = previousStatusUrl;
        }
      }
    }, {
      statusPath,
      configPath,
    });
  });
});

test('real status server falls back to zeroed metrics when the metrics cache is invalid', async () => {
  await withTempEnv(async (tempRoot) => {
    const statusPath = path.join(tempRoot, 'status', 'inference.txt');
    const configPath = path.join(tempRoot, 'config.json');
    const metricsPath = path.join(tempRoot, 'metrics', 'compression.json');

    fs.mkdirSync(path.dirname(metricsPath), { recursive: true });
    fs.writeFileSync(metricsPath, '{invalid-json', 'utf8');

    await withRealStatusServer(async ({ statusUrl }) => {
      const status = await requestJson(statusUrl);
      assert.equal(status.metrics.inputCharactersTotal, 0);
      assert.equal(status.metrics.outputCharactersTotal, 0);
      assert.equal(status.metrics.inputTokensTotal, 0);
      assert.equal(status.metrics.outputTokensTotal, 0);
      assert.equal(status.metrics.thinkingTokensTotal, 0);
      assert.equal(status.metrics.requestDurationMsTotal, 0);
      assert.equal(status.metrics.completedRequestCount, 0);
      assert.equal(status.metrics.updatedAtUtc, null);
    }, {
      statusPath,
      configPath,
    });
  });
});

test('real status server resets metrics and idle summary store when metrics schema is outdated', async () => {
  await withTempEnv(async (tempRoot) => {
    const statusPath = path.join(tempRoot, 'status', 'inference.txt');
    const configPath = path.join(tempRoot, 'config.json');
    const metricsPath = path.join(tempRoot, 'metrics', 'compression.json');
    const idleSummaryDbPath = path.join(tempRoot, 'status', 'idle-summary.sqlite');

    fs.mkdirSync(path.dirname(metricsPath), { recursive: true });
    fs.writeFileSync(metricsPath, JSON.stringify({
      inputCharactersTotal: 99,
      inputTokensTotal: 22,
      outputTokensTotal: 11,
    }, null, 2), 'utf8');

    fs.mkdirSync(path.dirname(idleSummaryDbPath), { recursive: true });
    const database = new Database(idleSummaryDbPath);
    try {
      database.exec(`
        CREATE TABLE IF NOT EXISTS idle_summary_snapshots (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          emitted_at_utc TEXT NOT NULL,
          completed_request_count INTEGER NOT NULL,
          input_characters_total INTEGER NOT NULL,
          output_characters_total INTEGER NOT NULL,
          input_tokens_total INTEGER NOT NULL,
          output_tokens_total INTEGER NOT NULL,
          thinking_tokens_total INTEGER NOT NULL,
          saved_tokens INTEGER NOT NULL,
          saved_percent REAL,
          compression_ratio REAL,
          request_duration_ms_total INTEGER NOT NULL,
          avg_request_ms REAL,
          avg_tokens_per_second REAL
        );
      `);
      database.prepare(`
        INSERT INTO idle_summary_snapshots (
          emitted_at_utc,
          completed_request_count,
          input_characters_total,
          output_characters_total,
          input_tokens_total,
          output_tokens_total,
          thinking_tokens_total,
          saved_tokens,
          saved_percent,
          compression_ratio,
          request_duration_ms_total,
          avg_request_ms,
          avg_tokens_per_second
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        '2026-04-08T00:00:00.000Z',
        1,
        100,
        25,
        50,
        10,
        0,
        40,
        0.8,
        5.0,
        1000,
        1000,
        10.0,
      );
    } finally {
      database.close();
    }

    await withRealStatusServer(async ({ statusUrl }) => {
      const status = await requestJson(statusUrl);
      assert.equal(status.metrics.schemaVersion, 2);
      assert.equal(status.metrics.inputCharactersTotal, 0);
      assert.equal(status.metrics.inputTokensTotal, 0);
      assert.equal(status.metrics.outputTokensTotal, 0);
      assert.equal(status.metrics.toolTokensTotal, 0);
      assert.equal(status.metrics.completedRequestCount, 0);
    }, {
      statusPath,
      configPath,
      disableManagedLlamaStartup: true,
      idleSummaryDbPath,
    });

    assert.equal(fs.existsSync(idleSummaryDbPath), false);
  });
});

test('real status server accumulates provider payload totals across a chunked request while counting one completed request', async () => {
  await withTempEnv(async (tempRoot) => {
    const statusPath = path.join(tempRoot, 'status', 'inference.txt');
    const configPath = path.join(tempRoot, 'config.json');
    const requestId = 'chunked-request';

    await withRealStatusServer(async (server) => {
      const { statusUrl } = server;
      await requestJson(statusUrl, {
        method: 'POST',
        body: JSON.stringify({ running: true, requestId, rawInputCharacterCount: 1000, chunkIndex: 1, chunkTotal: 2 }),
      });
      await requestJson(statusUrl, {
        method: 'POST',
        body: JSON.stringify({ running: false, requestId, promptCharacterCount: 600, inputTokens: 10, outputCharacterCount: 120, outputTokens: 2, requestDurationMs: 100 }),
      });
      await requestJson(statusUrl, {
        method: 'POST',
        body: JSON.stringify({ running: true, requestId, rawInputCharacterCount: 1000, chunkIndex: 2, chunkTotal: 2 }),
      });
      await requestJson(statusUrl, {
        method: 'POST',
        body: JSON.stringify({ running: false, requestId, promptCharacterCount: 610, inputTokens: 11, outputCharacterCount: 130, outputTokens: 3, requestDurationMs: 110 }),
      });
      await requestJson(statusUrl, {
        method: 'POST',
        body: JSON.stringify({ running: true, requestId, rawInputCharacterCount: 1000 }),
      });
      await requestJson(statusUrl, {
        method: 'POST',
        body: JSON.stringify({ running: false, requestId, promptCharacterCount: 400, inputTokens: 5, outputCharacterCount: 60, outputTokens: 1, requestDurationMs: 50 }),
      });
      await requestJson(statusUrl, {
        method: 'POST',
        body: JSON.stringify({ running: false, requestId, terminalState: 'completed', rawInputCharacterCount: 1000 }),
      });

      const status = await requestJson(statusUrl);
      assert.equal(status.metrics.inputCharactersTotal, 1610);
      assert.equal(status.metrics.outputCharactersTotal, 310);
      assert.equal(status.metrics.inputTokensTotal, 26);
      assert.equal(status.metrics.outputTokensTotal, 6);
      assert.equal(status.metrics.thinkingTokensTotal, 0);
      assert.equal(status.metrics.requestDurationMsTotal, 260);
      assert.equal(status.metrics.completedRequestCount, 1);
    }, {
      statusPath,
      configPath,
      disableManagedLlamaStartup: true,
    });
  });
});

test('real status server aggregates task-scoped tool stats and tool tokens', async () => {
  await withTempEnv(async (tempRoot) => {
    const statusPath = path.join(tempRoot, 'status', 'inference.txt');
    const configPath = path.join(tempRoot, 'config.json');
    const requestId = 'tool-stats-request';

    await withRealStatusServer(async ({ statusUrl }) => {
      await requestJson(statusUrl, {
        method: 'POST',
        body: JSON.stringify({
          running: true,
          requestId,
          taskKind: 'repo-search',
          rawInputCharacterCount: 150,
          promptCharacterCount: 150,
          promptTokenCount: 30,
        }),
      });
      await requestJson(statusUrl, {
        method: 'POST',
        body: JSON.stringify({
          running: false,
          requestId,
          taskKind: 'repo-search',
          terminalState: 'completed',
          promptCharacterCount: 150,
          inputTokens: 30,
          outputCharacterCount: 80,
          outputTokens: 12,
          toolTokens: 9,
          requestDurationMs: 90,
          toolStats: {
            rg: {
              calls: 2,
              outputCharsTotal: 210,
              outputTokensTotal: 44,
              outputTokensEstimatedCount: 1,
            },
          },
        }),
      });

      const status = await requestJson(statusUrl);
      assert.equal(status.metrics.outputTokensTotal, 12);
      assert.equal(status.metrics.toolTokensTotal, 9);
      assert.equal(status.metrics.taskTotals['repo-search'].outputTokensTotal, 12);
      assert.equal(status.metrics.taskTotals['repo-search'].toolTokensTotal, 9);
      assert.equal(status.metrics.toolStats['repo-search'].rg.calls, 2);
      assert.equal(status.metrics.toolStats['repo-search'].rg.outputCharsTotal, 210);
      assert.equal(status.metrics.toolStats['repo-search'].rg.outputTokensTotal, 44);
      assert.equal(status.metrics.toolStats['repo-search'].rg.outputTokensEstimatedCount, 1);
    }, {
      statusPath,
      configPath,
      disableManagedLlamaStartup: true,
    });
  });
});

test('real status server patches speculative acceptance onto an existing repo-search run log row', async () => {
  await withTempEnv(async (tempRoot) => {
    const statusPath = path.join(tempRoot, 'status', 'inference.txt');
    const configPath = path.join(tempRoot, 'config.json');
    const runtimeDbPath = path.join(tempRoot, '.siftkit', 'runtime.sqlite');
    const requestId = 'repo-run-speculative';

    await withRealStatusServer(async ({ statusUrl }) => {
      const database = new Database(runtimeDbPath);
      try {
        upsertRepoSearchRun({
          database,
          requestId,
          taskKind: 'repo-search',
          prompt: 'find tool calls',
          repoRoot: tempRoot,
          model: 'mock-model',
          requestMaxTokens: 512,
          maxTurns: 2,
          transcriptText: '',
          artifactPayload: { requestId, prompt: 'find tool calls', repoRoot: tempRoot },
          terminalState: 'completed',
          startedAtUtc: '2026-04-20T11:49:38.706Z',
          finishedAtUtc: '2026-04-20T11:50:26.779Z',
          requestDurationMs: 48073,
          promptTokens: 10,
          outputTokens: 5,
          thinkingTokens: 2,
          toolTokens: 1,
          promptCacheTokens: 3,
          promptEvalTokens: 7,
          speculativeAcceptedTokens: null,
          speculativeGeneratedTokens: null,
        });
      } finally {
        database.close();
      }

      await requestJson(statusUrl, {
        method: 'POST',
        body: JSON.stringify({
          running: false,
          requestId,
          taskKind: 'repo-search',
          terminalState: 'completed',
          promptCharacterCount: 25,
          inputTokens: 7,
          outputCharacterCount: 12,
          outputTokens: 5,
          thinkingTokens: 2,
          promptCacheTokens: 3,
          promptEvalTokens: 7,
          speculativeAcceptedTokens: 12,
          speculativeGeneratedTokens: 18,
          requestDurationMs: 48073,
        }),
      });

      const verifyDb = new Database(runtimeDbPath, { readonly: true });
      try {
        const row = verifyDb.prepare(`
          SELECT speculative_accepted_tokens, speculative_generated_tokens
          FROM run_logs
          WHERE request_id = ?
        `).get(requestId);
        assert.equal(row.speculative_accepted_tokens, 12);
        assert.equal(row.speculative_generated_tokens, 18);
      } finally {
        verifyDb.close();
      }
    }, {
      statusPath,
      configPath,
      disableManagedLlamaStartup: true,
    });
  });
});

test('real status server suppresses intermediate false log for single-step completed requests', async () => {
  await withTempEnv(async (tempRoot) => {
    const statusPath = path.join(tempRoot, 'status', 'inference.txt');
    const configPath = path.join(tempRoot, 'config.json');
    await withRealStatusServer(async ({ statusUrl }) => {
      const lines = await captureStdout(async () => {
        await requestJson(statusUrl, {
          method: 'POST',
          body: JSON.stringify({
            running: true,
            requestId: 'single-step',
            rawInputCharacterCount: 426,
            promptCharacterCount: 468,
            promptTokenCount: 86,
          }),
        });
        await requestJson(statusUrl, {
          method: 'POST',
          body: JSON.stringify({
            running: false,
            requestId: 'single-step',
            promptCharacterCount: 468,
            outputTokens: 130,
            requestDurationMs: 1_000,
          }),
        });
        await requestJson(statusUrl, {
          method: 'POST',
          body: JSON.stringify({
            running: false,
            requestId: 'single-step',
            terminalState: 'completed',
            rawInputCharacterCount: 426,
          }),
        });
      });

      const falseLines = lines.filter((line) => /request false/u.test(line));
      assert.equal(falseLines.length, 1, lines.join('\n'));
      assert.match(falseLines[0], /request false total_elapsed=0s output_tokens=130/u);
      assert.equal(falseLines.some((line) => /request false elapsed=/u.test(line)), false, lines.join('\n'));
    }, {
      statusPath,
      configPath,
      disableManagedLlamaStartup: true,
    });
  });
});

test('real status server logs intermediate false line for first chunked leaf step', async () => {
  await withTempEnv(async (tempRoot) => {
    const statusPath = path.join(tempRoot, 'status', 'inference.txt');
    const configPath = path.join(tempRoot, 'config.json');
    await withRealStatusServer(async ({ statusUrl }) => {
      const lines = await captureStdout(async () => {
        await requestJson(statusUrl, {
          method: 'POST',
          body: JSON.stringify({
            running: true,
            requestId: 'chunked-step',
            rawInputCharacterCount: 1_000,
            chunkIndex: 1,
            chunkTotal: 2,
          }),
        });
        await requestJson(statusUrl, {
          method: 'POST',
          body: JSON.stringify({
            running: false,
            requestId: 'chunked-step',
            promptCharacterCount: 600,
            outputTokens: 82,
            requestDurationMs: 4_000,
          }),
        });
      });

      const falseLines = lines.filter((line) => /request false/u.test(line));
      assert.equal(falseLines.length, 1, lines.join('\n'));
      assert.match(falseLines[0], /request false elapsed=0s output_tokens=82/u);
    }, {
      statusPath,
      configPath,
      disableManagedLlamaStartup: true,
    });
  });
});

test('real status server logs explicit chunk failures and clears them before the next request', async () => {
  await withTempEnv(async (tempRoot) => {
    const statusPath = path.join(tempRoot, 'status', 'inference.txt');
    const configPath = path.join(tempRoot, 'config.json');
    await withRealStatusServer(async ({ statusUrl }) => {
      const lines = await captureStdout(async () => {
        await requestJson(statusUrl, {
          method: 'POST',
          body: JSON.stringify({
            running: true,
            requestId: 'failed-request',
            rawInputCharacterCount: 3_322_607,
            promptCharacterCount: 342_395,
            promptTokenCount: 147_694,
            chunkIndex: 1,
            chunkTotal: 10,
            chunkPath: '1/10',
          }),
        });
        await requestJson(statusUrl, {
          method: 'POST',
          body: JSON.stringify({
            running: false,
            requestId: 'failed-request',
            promptCharacterCount: 342_395,
            requestDurationMs: 91_000,
          }),
        });
        await requestJson(statusUrl, {
          method: 'POST',
          body: JSON.stringify({
            running: false,
            requestId: 'failed-request',
            terminalState: 'failed',
            errorMessage: 'leaf chunk failed',
            rawInputCharacterCount: 3_322_607,
            promptCharacterCount: 342_395,
            promptTokenCount: 147_694,
            chunkIndex: 1,
            chunkTotal: 10,
            chunkPath: '1/10',
          }),
        });
        await requestJson(statusUrl, {
          method: 'POST',
          body: JSON.stringify({
            running: true,
            requestId: 'next-request',
            rawInputCharacterCount: 281_469,
            promptCharacterCount: 283_752,
            promptTokenCount: 99_240,
          }),
        });
        await requestJson(statusUrl, {
          method: 'POST',
          body: JSON.stringify({
            running: false,
            requestId: 'next-request',
            promptCharacterCount: 283_752,
            outputTokens: 154,
            requestDurationMs: 18_000,
          }),
        });
        await requestJson(statusUrl, {
          method: 'POST',
          body: JSON.stringify({
            running: false,
            requestId: 'next-request',
            terminalState: 'completed',
            rawInputCharacterCount: 281_469,
          }),
        });
      });

      assert.ok(lines.some((line) => /request false raw_chars=3,322,607 prompt=342,395 \(147,694\) chunk 1\/10 failed elapsed=0s error=leaf chunk failed/u.test(line)), lines.join('\n'));
      assert.ok(lines.some((line) => /request true raw_chars=281,469 prompt=283,752 \(99,240\)/u.test(line)), lines.join('\n'));
      assert.ok(lines.some((line) => /request false total_elapsed=0s output_tokens=154/u.test(line)), lines.join('\n'));

      const status = await requestJson(statusUrl);
      assert.equal(status.metrics.completedRequestCount, 1);
    }, {
      statusPath,
      configPath,
      disableManagedLlamaStartup: true,
    });
  });
});

test('real status server marks a stale active request as abandoned when a new request id starts', async () => {
  await withTempEnv(async (tempRoot) => {
    const statusPath = path.join(tempRoot, 'status', 'inference.txt');
    const configPath = path.join(tempRoot, 'config.json');
    await withRealStatusServer(async ({ statusUrl }) => {
      const lines = await captureStdout(async () => {
        await requestJson(statusUrl, {
          method: 'POST',
          body: JSON.stringify({
            running: true,
            requestId: 'stale-request',
            rawInputCharacterCount: 3_322_607,
            promptCharacterCount: 342_395,
            promptTokenCount: 147_694,
            chunkIndex: 1,
            chunkTotal: 10,
            chunkPath: '1/10',
          }),
        });
        await requestJson(statusUrl, {
          method: 'POST',
          body: JSON.stringify({
            running: false,
            requestId: 'stale-request',
            promptCharacterCount: 342_395,
            requestDurationMs: 91_000,
          }),
        });
        await requestJson(statusUrl, {
          method: 'POST',
          body: JSON.stringify({
            running: true,
            requestId: 'fresh-request',
            rawInputCharacterCount: 281_469,
            promptCharacterCount: 283_752,
            promptTokenCount: 99_240,
          }),
        });
      });

      assert.ok(
        lines.some((line) => /request false raw_chars=3,322,607 prompt=342,395 \(147,694\) chunk 1\/10 failed elapsed=0s error=Abandoned because a new request started before terminal status\./u.test(line)),
        lines.join('\n'),
      );
      assert.ok(lines.some((line) => /request true raw_chars=281,469 prompt=283,752 \(99,240\)/u.test(line)), lines.join('\n'));
    }, {
      statusPath,
      configPath,
      disableManagedLlamaStartup: true,
    });
  });
});

test('real status server prints one idle metrics line only after the full idle delay', async () => {
  await withTempEnv(async (tempRoot) => {
    const statusPath = path.join(tempRoot, 'status', 'inference.txt');
    const configPath = path.join(tempRoot, 'config.json');
    const idleSummaryDbPath = path.join(tempRoot, 'status', 'idle-summary.sqlite');
    const server = await startStatusServerProcess({
      statusPath,
      configPath,
      idleSummaryDbPath,
      idleSummaryDelayMs: 80,
      disableManagedLlamaStartup: true,
    });

    try {
      await requestJson(server.statusUrl, {
        method: 'POST',
        body: JSON.stringify({
          running: true,
          rawInputCharacterCount: 200,
          promptCharacterCount: 200,
          promptTokenCount: 100,
          inputCharactersPerContextToken: 2,
          chunkThresholdCharacters: 320_000,
        }),
      });
      await server.waitForStdoutMatch(/request true raw_chars=200 prompt=200 \(100\)/u, 1000);
      await requestJson(server.statusUrl, {
        method: 'POST',
        body: JSON.stringify({ running: false, terminalState: 'completed', promptCharacterCount: 200, inputTokens: 100, outputCharacterCount: 80, outputTokens: 25, requestDurationMs: 800 }),
      });

      assert.equal(fs.readFileSync(statusPath, 'utf8').trim(), 'true');
      const pendingStatus = await requestJson(server.statusUrl);
      assert.equal(pendingStatus.running, true);
      assert.equal(pendingStatus.status, 'true');

      await sleep(30);
      assert.equal(server.stdoutLines.some((line) => /idle_metrics/u.test(line)), false);

      await server.waitForStdoutMatch(/requests=1/u, 1000);
      const block = getIdleSummaryBlock(server.stdoutLines, /requests=1/u);
      assert.match(block[0], /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} requests=1$/u);
      assert.equal(block[1], '  input:  chars=200 tokens=100');
      assert.equal(block[2], '  output: chars=80 tokens=25 avg_tokens_per_request=25.00');
      assert.equal(block[3], '  ratio:  input/output=4.00x');
      assert.equal(block[4], '  budget: chars_per_token=2.000 chunk_threshold_chars=320,000');
      assert.equal(block[5], '  timing: total=0s avg_request=0.80s gen_tokens_per_s=31.25');
      await waitForAsyncExpectation(async () => {
        assert.equal(fs.readFileSync(statusPath, 'utf8').trim(), 'true');
      }, 1000);
      const finalStatus = await requestJson(server.statusUrl);
      assert.equal(finalStatus.running, false);
      assert.equal(finalStatus.status, 'false');

      assert.equal(fs.existsSync(idleSummaryDbPath), true);
      const rows = readIdleSummarySnapshots(idleSummaryDbPath);
      assert.equal(rows.length, 1);
      assert.match(rows[0].emitted_at_utc, /^\d{4}-\d{2}-\d{2}T/u);
      assert.deepEqual({ ...rows[0], emitted_at_utc: '<iso>' }, {
        emitted_at_utc: '<iso>',
        completed_request_count: 1,
        input_characters_total: 200,
        output_characters_total: 80,
        input_tokens_total: 100,
        output_tokens_total: 25,
        thinking_tokens_total: 0,
        saved_tokens: 75,
        saved_percent: 0.75,
        compression_ratio: 4,
        request_duration_ms_total: 800,
        avg_request_ms: 800,
        avg_tokens_per_second: 31.25,
      });
    } finally {
      await server.close();
    }
  });
});

test('real status server shuts down managed llama.cpp after the idle summary block is emitted', async () => {
  await withTempEnv(async (tempRoot) => {
    const statusPath = path.join(tempRoot, 'status', 'inference.txt');
    const configPath = path.join(tempRoot, 'config.json');
    const idleSummaryDbPath = path.join(tempRoot, 'status', 'idle-summary.sqlite');
    const llamaPort = await getFreePort();
    const managed = writeManagedLlamaScripts(tempRoot, llamaPort);
    const config = getDefaultConfig();
    setManagedLlamaBaseUrl(config, managed.baseUrl);
    config.Server = {
      LlamaCpp: {
        StartupScript: managed.startupScriptPath,
        ShutdownScript: managed.shutdownScriptPath,
        StartupTimeoutMs: 5000,
        HealthcheckTimeoutMs: 200,
        HealthcheckIntervalMs: 50,
      },
    };
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8');

    const server = await startStatusServerProcess({
      statusPath,
      configPath,
      idleSummaryDbPath,
      idleSummaryDelayMs: 80,
    });

    try {
      await requestJson(server.configUrl);
      await waitForAsyncExpectation(async () => {
        const models = await requestJson(`${managed.baseUrl}/v1/models`);
        assert.equal(models.data[0].id, 'managed-test-model');
      }, 5000);

      await requestJson(server.statusUrl, {
        method: 'POST',
        body: JSON.stringify({ running: true, rawInputCharacterCount: 50 }),
      });
      await requestJson(server.statusUrl, {
        method: 'POST',
        body: JSON.stringify({ running: false, terminalState: 'completed', promptCharacterCount: 50, inputTokens: 10, outputCharacterCount: 5, outputTokens: 1, requestDurationMs: 20 }),
      });

      await server.waitForStdoutMatch(/requests=1/u, 1000);
      await waitForAsyncExpectation(
        async () => assert.rejects(() => requestJson(`${managed.baseUrl}/v1/models`)),
        5000
      );
      await waitForAsyncExpectation(async () => {
        assert.equal(fs.readFileSync(statusPath, 'utf8').trim(), 'false');
      }, 5000);
    } finally {
      await server.close();
    }
  });
});

test('real status server close() stops managed llama.cpp', async () => {
  await withTempEnv(async (tempRoot) => {
    const previous = {
      SIFTKIT_STATUS_HOST: process.env.SIFTKIT_STATUS_HOST,
      SIFTKIT_STATUS_PORT: process.env.SIFTKIT_STATUS_PORT,
      sift_kit_status: process.env.sift_kit_status,
      SIFTKIT_STATUS_PATH: process.env.SIFTKIT_STATUS_PATH,
      SIFTKIT_CONFIG_PATH: process.env.SIFTKIT_CONFIG_PATH,
      SIFTKIT_CONFIG_SERVICE_URL: process.env.SIFTKIT_CONFIG_SERVICE_URL,
      SIFTKIT_STATUS_BACKEND_URL: process.env.SIFTKIT_STATUS_BACKEND_URL,
    };
    const statusPath = path.join(tempRoot, 'status', 'inference.txt');
    const configPath = path.join(tempRoot, 'config.json');
    const llamaPort = await getFreePort();
    const managed = writeManagedLlamaScripts(tempRoot, llamaPort);
    const config = getDefaultConfig();
    setManagedLlamaBaseUrl(config, managed.baseUrl);
    config.Server = {
      LlamaCpp: {
        StartupScript: managed.startupScriptPath,
        ShutdownScript: managed.shutdownScriptPath,
        StartupTimeoutMs: 5000,
        HealthcheckTimeoutMs: 200,
        HealthcheckIntervalMs: 50,
      },
    };
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8');

    process.env.SIFTKIT_STATUS_HOST = '127.0.0.1';
    process.env.SIFTKIT_STATUS_PORT = '0';
    process.env.sift_kit_status = statusPath;
    process.env.SIFTKIT_STATUS_PATH = statusPath;
    process.env.SIFTKIT_CONFIG_PATH = configPath;

    const server = startStatusServer();
    try {
      const address = await new Promise((resolve) => {
        if (server.listening) {
          resolve(server.address());
          return;
        }

        server.once('listening', () => resolve(server.address()));
      });
      const port = typeof address === 'object' && address ? address.port : 0;
      if (server.startupPromise) {
        await server.startupPromise;
      }
      process.env.SIFTKIT_CONFIG_SERVICE_URL = `http://127.0.0.1:${port}/config`;
      process.env.SIFTKIT_STATUS_BACKEND_URL = `http://127.0.0.1:${port}/status`;

      const loadedConfig = await loadConfig({ ensure: true });
      assert.equal(loadedConfig.LlamaCpp.BaseUrl, managed.baseUrl);
      await waitForAsyncExpectation(async () => {
        const models = await requestJson(`${managed.baseUrl}/v1/models`);
        assert.equal(models.data[0].id, 'managed-test-model');
      }, 5000);
    } finally {
      await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      }
    }

    await waitForAsyncExpectation(
      async () => assert.rejects(() => requestJson(`${managed.baseUrl}/v1/models`)),
      5000
    );
    await waitForAsyncExpectation(async () => {
      assert.equal(fs.existsSync(managed.pidFilePath), false);
    }, 5000);
  });
});

test('real status server falls back to request-start prompt chars and elapsed time when completion payload is minimal', async () => {
  await withTempEnv(async (tempRoot) => {
    const statusPath = path.join(tempRoot, 'status', 'inference.txt');
    const configPath = path.join(tempRoot, 'config.json');

    await withRealStatusServer(async ({ statusUrl }) => {
      await requestJson(statusUrl, {
        method: 'POST',
        body: JSON.stringify({ running: true, rawInputCharacterCount: 300, promptCharacterCount: 420 }),
      });
      await sleep(20);
      await requestJson(statusUrl, {
        method: 'POST',
        body: JSON.stringify({ running: false }),
      });

      const status = await requestJson(statusUrl);
      assert.equal(status.metrics.inputCharactersTotal, 420);
      assert.equal(status.metrics.outputCharactersTotal, 0);
      assert.equal(status.metrics.inputTokensTotal, 0);
      assert.equal(status.metrics.outputTokensTotal, 0);
      assert.equal(status.metrics.thinkingTokensTotal, 0);
      assert.ok(status.metrics.completedRequestCount >= 0);
      assert.ok(status.metrics.requestDurationMsTotal >= 20);
    }, {
      statusPath,
      configPath,
      disableManagedLlamaStartup: true,
    });
  });
});

test('real status server restarts the idle countdown when a new request begins before the prior delay expires', async () => {
  await withTempEnv(async (tempRoot) => {
    const statusPath = path.join(tempRoot, 'status', 'inference.txt');
    const configPath = path.join(tempRoot, 'config.json');
    const idleSummaryDbPath = path.join(tempRoot, 'status', 'idle-summary.sqlite');
    const server = await startStatusServerProcess({
      statusPath,
      configPath,
      idleSummaryDbPath,
      idleSummaryDelayMs: 80,
      disableManagedLlamaStartup: true,
    });

    try {
      await requestJson(server.statusUrl, {
        method: 'POST',
        body: JSON.stringify({
          running: true,
          rawInputCharacterCount: 100,
          inputCharactersPerContextToken: 2,
          chunkThresholdCharacters: 100,
        }),
      });
      await requestJson(server.statusUrl, {
        method: 'POST',
        body: JSON.stringify({ running: false, terminalState: 'completed', promptCharacterCount: 100, inputTokens: 10, outputCharacterCount: 40, outputTokens: 5, requestDurationMs: 50 }),
      });

      await sleep(40);
      await requestJson(server.statusUrl, {
        method: 'POST',
        body: JSON.stringify({
          running: true,
          rawInputCharacterCount: 50,
          inputCharactersPerContextToken: 4,
          chunkThresholdCharacters: 200,
        }),
      });
      await sleep(60);
      assert.equal(server.stdoutLines.some((line) => /idle_metrics/u.test(line)), false);

      await requestJson(server.statusUrl, {
        method: 'POST',
        body: JSON.stringify({ running: false, terminalState: 'completed', promptCharacterCount: 50, inputTokens: 0, outputCharacterCount: 0, outputTokens: 0, requestDurationMs: 25 }),
      });

      await server.waitForStdoutMatch(/requests=2/u, 1000);
      const block = getIdleSummaryBlock(server.stdoutLines, /requests=2/u);
      assert.equal(block[1], '  input:  chars=150 tokens=10');
      assert.equal(block[2], '  output: chars=40 tokens=5 avg_tokens_per_request=2.50');
      assert.equal(block[3], '  ratio:  input/output=2.00x');
      assert.equal(block[4], '  budget: chars_per_token=4.000 chunk_threshold_chars=200');
      assert.equal(block[5], '  timing: total=0s avg_request=0.04s gen_tokens_per_s=66.67');
      assert.equal(readIdleSummarySnapshots(idleSummaryDbPath).length, 1);
    } finally {
      await server.close();
    }
  });
});

test('real status server does not count idle delay while an execution lease remains active', async () => {
  await withTempEnv(async (tempRoot) => {
    const statusPath = path.join(tempRoot, 'status', 'inference.txt');
    const configPath = path.join(tempRoot, 'config.json');
    const idleSummaryDbPath = path.join(tempRoot, 'status', 'idle-summary.sqlite');
    const server = await startStatusServerProcess({
      statusPath,
      configPath,
      idleSummaryDbPath,
      idleSummaryDelayMs: 80,
      disableManagedLlamaStartup: true,
    });

    try {
      const lease = await requestJson(`${server.executionUrl}/acquire`, {
        method: 'POST',
        body: JSON.stringify({ pid: process.pid }),
      });
      assert.equal(lease.acquired, true);

      await requestJson(server.statusUrl, {
        method: 'POST',
        body: JSON.stringify({ running: true, rawInputCharacterCount: 10 }),
      });
      await requestJson(server.statusUrl, {
        method: 'POST',
        body: JSON.stringify({ running: false, terminalState: 'completed', promptCharacterCount: 10, inputTokens: 0, outputCharacterCount: 0, outputTokens: 0, requestDurationMs: 10 }),
      });

      await sleep(120);
      assert.equal(server.stdoutLines.some((line) => /idle_metrics/u.test(line)), false);

      await requestJson(`${server.executionUrl}/release`, {
        method: 'POST',
        body: JSON.stringify({ token: lease.token }),
      });

      await server.waitForStdoutMatch(/requests=1/u, 1000);
      const block = getIdleSummaryBlock(server.stdoutLines, /requests=1/u);
      assert.equal(block[1], '  input:  chars=10 tokens=0');
      assert.equal(block[2], '  output: chars=0 tokens=0 avg_tokens_per_request=0.00');
      assert.equal(block[3], '  ratio:  input/output=n/a');
      assert.equal(block[4], '  timing: total=0s avg_request=0.01s gen_tokens_per_s=n/a');
      assert.equal(readIdleSummarySnapshots(idleSummaryDbPath).length, 1);
    } finally {
      await server.close();
    }
  });
});

