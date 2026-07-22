import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import Database from 'better-sqlite3';
import { z } from 'zod';

import { loadConfig, getConfigPath } from '../src/config/index.js';

const TextRowSchema = z.object({ text: z.string().nullish() }).optional();
const RequestJsonRowSchema = z.object({ request_json: z.string().nullish() }).optional();
const SpeculativeRowSchema = z
  .object({ speculative_accepted_tokens: z.number(), speculative_generated_tokens: z.number() })
  .optional();
import { startStatusServer } from '../src/status-server/index.js';
import { writeConfig } from '../src/status-server/config-store.js';
import { readStatusText } from '../src/status-server/status-file.js';
import { upsertRepoSearchRun } from '../src/status-server/dashboard-runs.js';
import type { SiftConfig } from '../src/config/types.js';

import {
  applyManagedScriptConfig,
  FAST_LEASE_WAIT_MS,
  getDefaultConfig,
  requestJson,
  sleep,
  withTempEnv,
  withRealStatusServer,
  startStatusServerProcess,
  captureStdout,
  readIdleSummarySnapshots,
  getFreePort,
  writeManagedLlamaScripts,
  waitForAsyncExpectation,
  postStatusTerminalMetadata,
  postStatusComplete,
  postCompletedStatus,
  type RuntimeStatusResponse,
  type LlamaModelsResponse,
  type HealthCheckResponse,
} from './_runtime-helpers.js';

interface StatusPostResponse {
  ok?: boolean;
  running?: boolean;
  status?: string;
  busy?: boolean;
}

test('real status server normalizes legacy non-boolean status text to false', async () => {
  await withTempEnv(async (tempRoot) => {
    const statusPath = path.join(tempRoot, '.siftkit', 'status', 'inference.txt');
    const configPath = getConfigPath();
    const config = getDefaultConfig();
    fs.mkdirSync(path.dirname(statusPath), { recursive: true });
    fs.writeFileSync(statusPath, 'foreign_lock', 'utf8');
    writeConfig(configPath, config);

    await withRealStatusServer(async ({ statusUrl }) => {
      await waitForAsyncExpectation(async () => {
        assert.equal(readStatusText(getConfigPath()), 'false');
      }, 2000);
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

test('real status server normalizes non-boolean statuses in POST /status payloads', async () => {
  await withTempEnv(async (tempRoot) => {
    const statusPath = path.join(tempRoot, 'status', 'inference.txt');
    const configPath = path.join(tempRoot, 'config.json');
    const config = getDefaultConfig();
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8');

    await withRealStatusServer(async ({ statusUrl }) => {
      const status = await requestJson<StatusPostResponse>(statusUrl, {
        method: 'POST',
        body: JSON.stringify({ status: 'foreign_lock' }),
      });
      assert.equal(status.running, false);
      assert.equal(status.status, 'false');
    }, {
      statusPath,
      configPath,
      disableManagedLlamaStartup: true,
    });
  });
});

test('real status server accepts boolean-like running payload variants', async () => {
  await withTempEnv(async (tempRoot) => {
    const statusPath = path.join(tempRoot, 'status', 'inference.txt');
    const configPath = path.join(tempRoot, 'config.json');
    const config = getDefaultConfig();
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8');

    await withRealStatusServer(async ({ statusUrl }) => {
      const stopped = await requestJson<StatusPostResponse>(statusUrl, {
        method: 'POST',
        body: JSON.stringify({ status: false }),
      });
      assert.equal(stopped.running, false);
      assert.equal(stopped.status, 'false');
      assert.equal(readStatusText(getConfigPath()), 'false');

      const running = await requestJson<StatusPostResponse>(statusUrl, {
        method: 'POST',
        body: JSON.stringify({ running: 'true' }),
      });
      assert.equal(running.running, true);
      assert.equal(running.status, 'true');
      assert.equal(readStatusText(getConfigPath()), 'true');
    }, {
      statusPath,
      configPath,
      disableManagedLlamaStartup: true,
    });
  });
});

test('real status server preserves true status while an active request is tracked', async () => {
  await withTempEnv(async (tempRoot) => {
    const statusPath = path.join(tempRoot, 'status', 'inference.txt');
    const configPath = path.join(tempRoot, 'config.json');
    const config = getDefaultConfig();
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8');

    await withRealStatusServer(async ({ statusUrl }) => {
      await requestJson(statusUrl, {
        method: 'POST',
        body: JSON.stringify({ running: true }),
      });

      assert.equal(readStatusText(getConfigPath()), 'true');
      // Stability assertion (a non-event): the status must stay 'true' across the whole
      // lease window. This is a fixed wait by necessity — you cannot poll for the absence
      // of a change. Load only lengthens the window, which keeps the assertion valid.
      await sleep(FAST_LEASE_WAIT_MS);
      assert.equal(readStatusText(getConfigPath()), 'true');
    }, {
      statusPath,
      configPath,
      disableManagedLlamaStartup: true,
    });
  });
});

test('real status server persists aggregate metrics and exposes them from GET /status', async () => {
  await withTempEnv(async (tempRoot) => {
    const statusPath = path.join(tempRoot, 'status', 'inference.txt');
    const configPath = path.join(tempRoot, 'config.json');
    const metricsPath = path.join(tempRoot, 'metrics', 'compression.json');
    const config = getDefaultConfig();
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

      const status = await requestJson<RuntimeStatusResponse>(statusUrl);
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
      const status = await requestJson<RuntimeStatusResponse>(statusUrl);
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

test('real status server starts managed llama.cpp during server startup before serving requests and reports idle after ready', async () => {
  await withTempEnv(async (tempRoot) => {
    const statusPath = path.join(tempRoot, 'status', 'inference.txt');
    const configPath = path.join(tempRoot, 'config.json');
    const llamaPort = await getFreePort();
    const managed = writeManagedLlamaScripts(tempRoot, llamaPort);
    const config = getDefaultConfig();
    applyManagedScriptConfig(config, managed);
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8');

    await withRealStatusServer(async ({ port, statusUrl }) => {
      assert.equal(readStatusText(getConfigPath()), 'false');
      await waitForAsyncExpectation(async () => {
        const models = await requestJson<LlamaModelsResponse>(`${managed.baseUrl}/v1/models`);
        assert.equal(models.data[0].id, 'managed-test-model');
      }, 5000);
      await waitForAsyncExpectation(async () => {
        const status = await requestJson<RuntimeStatusResponse>(statusUrl);
        assert.equal(status.running, false);
        assert.equal(status.status, 'false');
        assert.equal(readStatusText(getConfigPath()), 'false');
      }, 5000);
      const latestStartupDumpPath = path.join(tempRoot, '.siftkit', 'logs', 'managed-llama', 'latest-startup.log');
      assert.equal(fs.existsSync(latestStartupDumpPath), true);
      const latestStartupDumpText = fs.readFileSync(latestStartupDumpPath, 'utf8');
      assert.match(latestStartupDumpText, /Result: ready/u);
      assert.match(latestStartupDumpText, /launcher_stdout/u);

      const previousConfigUrl = process.env.SIFTKIT_CONFIG_SERVICE_URL;
      const previousStatusUrl = process.env.SIFTKIT_STATUS_BACKEND_URL;
      process.env.SIFTKIT_CONFIG_SERVICE_URL = `http://127.0.0.1:${port}/config`;
      process.env.SIFTKIT_STATUS_BACKEND_URL = statusUrl;

      try {
        const loadedConfig = await loadConfig({ ensure: true });
        assert.equal(loadedConfig.Runtime.LlamaCpp.BaseUrl, managed.baseUrl);
        assert.equal(
          loadedConfig.Server.ModelPresets.Presets[0].ExecutablePath,
          managed.startupScriptPath,
        );
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
    await sleep(50);
  });
});

test('managed llama live stream logs flush after idle without model request release', async () => {
  await withTempEnv(async (tempRoot) => {
    const statusPath = path.join(tempRoot, 'status', 'inference.txt');
    const configPath = path.join(tempRoot, 'config.json');
    const runtimeDbPath = path.join(tempRoot, '.siftkit', 'runtime.sqlite');
    const llamaPort = await getFreePort();
    const deferredLogLine = 'deferred-live-stderr-log';
    const managed = writeManagedLlamaScripts(tempRoot, llamaPort, 'managed-test-model', { deferredLogLine });
    const config = getDefaultConfig();
    applyManagedScriptConfig(config, managed);
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8');

    await withRealStatusServer(async () => {
      const latestStartupDumpPath = path.join(tempRoot, '.siftkit', 'logs', 'managed-llama', 'latest-startup.log');
      await waitForAsyncExpectation(
        async () => assert.equal(fs.existsSync(latestStartupDumpPath), true),
        5000
      );

      fs.writeFileSync(managed.deferredLogMarkerPath, '1', 'utf8');

      await waitForAsyncExpectation(async () => {
        const database = new Database(runtimeDbPath, { readonly: true });
        try {
          const row = TextRowSchema.parse(database.prepare(`
            SELECT GROUP_CONCAT(chunk_text, '') AS text
            FROM inference_run_log_chunks
            WHERE stream_kind = 'launcher_stderr'
          `).get());
          assert.ok(String(row?.text || '').includes(deferredLogLine));
        } finally {
          database.close();
        }
      }, 5000);
    }, {
      statusPath,
      configPath,
      inferenceRunFlushIdleDelayMs: 50,
    });
  });
});

test('real status server abandons stale running request instead of returning busy', async () => {
  await withTempEnv(async (tempRoot) => {
    const statusPath = path.join(tempRoot, 'status', 'inference.txt');
    const configPath = path.join(tempRoot, 'config.json');
    await withRealStatusServer(async ({ statusUrl }) => {
      await requestJson(statusUrl, {
        method: 'POST',
        body: JSON.stringify({
          running: true,
          requestId: 'stale-running-request',
          rawInputCharacterCount: 100,
        }),
      });
      const response = await requestJson<StatusPostResponse>(statusUrl, {
        method: 'POST',
        body: JSON.stringify({
          running: true,
          requestId: 'fresh-running-request',
          rawInputCharacterCount: 200,
        }),
      });

      assert.equal(response.busy, undefined);
      assert.equal(response.ok, true);
    }, {
      statusPath,
      configPath,
      disableManagedLlamaStartup: true,
    });
  });
});

test('real status server accepts deferred summary artifacts on terminal posts and drains them after responding', async () => {
  await withTempEnv(async (tempRoot) => {
    const statusPath = path.join(tempRoot, 'status', 'inference.txt');
    const configPath = path.join(tempRoot, 'config.json');
    const runtimeDbPath = path.join(tempRoot, '.siftkit', 'runtime.sqlite');
    const requestId = 'deferred-summary-request';

    await withRealStatusServer(async ({ statusUrl }) => {
      await requestJson(statusUrl, {
        method: 'POST',
        body: JSON.stringify({
          running: true,
          requestId,
          taskKind: 'summary',
          rawInputCharacterCount: 400,
          promptCharacterCount: 410,
          promptTokenCount: 100,
        }),
      });

      const terminalResponse = await postStatusTerminalMetadata(statusUrl, {
        requestId,
        taskKind: 'summary',
        terminalState: 'completed',
        deferredMetadata: {
          rawInputCharacterCount: 400,
          promptCharacterCount: 410,
          inputTokens: 100,
          outputCharacterCount: 120,
          outputTokens: 25,
          requestDurationMs: 800,
        },
        deferredArtifacts: [
          {
            artifactType: 'summary_request',
            artifactRequestId: requestId,
            artifactPayload: {
              requestId,
              question: 'Summarize this short input.',
              inputText: 'Line one.\nLine two.',
              backend: 'mock',
              model: 'mock-model',
              classification: 'summary',
              summary: 'mock summary',
            },
          },
        ],
      });

      assert.equal(terminalResponse.ok, true);
      const immediateStatus = await requestJson<RuntimeStatusResponse>(statusUrl);
      assert.equal(immediateStatus.metrics.inputTokensTotal, 0);
      assert.equal(immediateStatus.metrics.outputTokensTotal, 0);

      const immediateDb = new Database(runtimeDbPath, { readonly: true });
      try {
        const immediateRow = RequestJsonRowSchema.parse(immediateDb.prepare(`
          SELECT request_json
          FROM run_logs
          WHERE request_id = ?
        `).get(requestId));
        assert.equal(immediateRow?.request_json ?? null, null);
      } finally {
        immediateDb.close();
      }

      const completeResponse = await postStatusComplete(statusUrl, {
        requestId,
        taskKind: 'summary',
        terminalState: 'completed',
      });
      assert.equal(completeResponse.ok, true);

      await waitForAsyncExpectation(async () => {
        const eventualStatus = await requestJson<RuntimeStatusResponse>(statusUrl);
        assert.equal(eventualStatus.metrics.inputTokensTotal, 100);
        assert.equal(eventualStatus.metrics.outputTokensTotal, 25);
        const verifyDb = new Database(runtimeDbPath, { readonly: true });
        try {
          const row = RequestJsonRowSchema.parse(verifyDb.prepare(`
            SELECT request_json
            FROM run_logs
            WHERE request_id = ?
          `).get(requestId));
          assert.equal(typeof row?.request_json, 'string');
          assert.match(String(row?.request_json || ''), /mock summary/u);
        } finally {
          verifyDb.close();
        }
      }, 2000);
    }, {
      statusPath,
      configPath,
      terminalMetadataIdleDelayMs: 50,
      disableManagedLlamaStartup: true,
    });
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
    applyManagedScriptConfig(config, managed);
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
        assert.equal(invocation.ServerConfigPathEnv || '', '');
        assert.equal(invocation.ServerConfigUrlEnv || '', '');
        assert.equal(invocation.ServerStatusPathEnv || '', '');
        assert.equal(invocation.ServerStatusUrlEnv || '', '');
        assert.equal(invocation.ServerHealthUrlEnv || '', '');
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
    applyManagedScriptConfig(config, managed);
    fs.mkdirSync(path.dirname(statusPath), { recursive: true });
    fs.writeFileSync(statusPath, 'foreign_lock', 'utf8');
    writeConfig(configPath, config);

    await withRealStatusServer(async ({ statusUrl }) => {
      await waitForAsyncExpectation(async () => {
        assert.equal(fs.existsSync(managed.readyFilePath), true);
        const status = await requestJson<RuntimeStatusResponse>(statusUrl);
        assert.equal(status.running, false);
        assert.equal(status.status, 'false');
      }, 5000);
    }, {
      statusPath,
      configPath,
      awaitStartup: false,
    });
  });
});

test('real status server reports idle false while managed llama stays ready', async () => {
  await withTempEnv(async (tempRoot) => {
    const statusPath = path.join(tempRoot, 'status', 'inference.txt');
    const configPath = path.join(tempRoot, 'config.json');
    const llamaPort = await getFreePort();
    const managed = writeManagedLlamaScripts(tempRoot, llamaPort);
    const config = getDefaultConfig();
    applyManagedScriptConfig(config, managed);
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8');

    await withRealStatusServer(async ({ statusUrl }) => {
      await waitForAsyncExpectation(async () => {
        const models = await requestJson<LlamaModelsResponse>(`${managed.baseUrl}/v1/models`);
        assert.equal(models.data[0].id, 'managed-test-model');
      }, 5000);

      assert.equal(readStatusText(getConfigPath()), 'false');
      // Stability assertion (a non-event): idle stays false and the status stays 'false'
      // across the lease window while managed llama remains ready. A fixed wait is required
      // because there is no positive event to poll for; load only lengthens it harmlessly.
      await sleep(FAST_LEASE_WAIT_MS);

      const status = await requestJson<RuntimeStatusResponse>(statusUrl);
      assert.equal(status.running, false);
      assert.equal(status.status, 'false');
      assert.equal(readStatusText(getConfigPath()), 'false');
    }, {
      statusPath,
      configPath,
    });
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
    applyManagedScriptConfig(config, managed);
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8');

    const server = await startStatusServerProcess({
        statusPath,
        configPath,
    });
    try {
      assert.match(String(server.startupWarning || ''), /startup logs contained warning\/error markers/i);
    } finally {
      await server.close();
    }

    const managedLogRoot = path.join(tempRoot, '.siftkit', 'logs', 'managed-llama');
    const dumpFiles = fs.existsSync(managedLogRoot)
      ? fs.readdirSync(managedLogRoot, { recursive: true })
        .map((entry) => path.join(managedLogRoot, String(entry)))
        .filter((entryPath) => /startup-scan-failure\.log$/u.test(entryPath))
      : [];
    assert.ok(dumpFiles.length > 0);
    const dumpText = fs.readFileSync(dumpFiles[0], 'utf8');
    assert.match(dumpText, /warning: fake llama startup warning/u);
    const latestStartupDumpPath = path.join(tempRoot, '.siftkit', 'logs', 'managed-llama', 'latest-startup.log');
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
    applyManagedScriptConfig(config, managed);
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8');

    await withRealStatusServer(async ({ healthUrl }) => {
      const health = await requestJson<HealthCheckResponse>(healthUrl);
      assert.equal(health.ok, true);
    }, {
      statusPath,
      configPath,
    });

    const latestStartupDumpPath = path.join(tempRoot, '.siftkit', 'logs', 'managed-llama', 'latest-startup.log');
    assert.equal(fs.existsSync(latestStartupDumpPath), true);
    assert.match(fs.readFileSync(latestStartupDumpPath, 'utf8'), /Result: ready/u);
  });
});

test('real status server keeps running in degraded mode when managed llama startup is broken', async () => {
  await withTempEnv(async (tempRoot) => {
    const statusPath = path.join(tempRoot, 'status', 'inference.txt');
    const configPath = path.join(tempRoot, 'config.json');
    const llamaPort = await getFreePort();
    const managed = writeManagedLlamaScripts(tempRoot, llamaPort);
    const config = getDefaultConfig();
    applyManagedScriptConfig(config, managed, {
      ExecutablePath: path.join(tempRoot, 'missing-start-llama.ps1'),
      StartupTimeoutMs: 1_000,
    });
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8');

    await withRealStatusServer(async ({ healthUrl }) => {
      const health = await requestJson<HealthCheckResponse>(healthUrl);
      assert.equal(health.ok, true);
      assert.equal('managedLlamaReady' in health, false);
      assert.equal('managedLlamaStarting' in health, false);
      assert.equal('managedLlamaStartupWarning' in health, false);
    }, {
      statusPath,
      configPath,
    });
  });
});

test('real status server clears a stale managed llama process during startup before serving requests', async () => {
  await withTempEnv(async (tempRoot) => {
    const statusPath = path.join(tempRoot, 'status', 'inference.txt');
    const configPath = path.join(tempRoot, 'config.json');
    const llamaPort = await getFreePort();
    const managed = writeManagedLlamaScripts(tempRoot, llamaPort);
    const config = getDefaultConfig();
    applyManagedScriptConfig(config, managed);
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8');

    const staleChild = spawn(process.execPath, [managed.fakeServerPath], {
      stdio: 'ignore',
      windowsHide: true,
    });
    fs.writeFileSync(managed.pidFilePath, String(staleChild.pid || ''), 'utf8');
    try {
      await waitForAsyncExpectation(async () => {
        const models = await requestJson<LlamaModelsResponse>(`${managed.baseUrl}/v1/models`);
        assert.equal(models.data[0].id, 'managed-test-model');
      }, 5000);

      await withRealStatusServer(async ({ port }) => {
        const previousConfigUrl = process.env.SIFTKIT_CONFIG_SERVICE_URL;
        const previousStatusUrl = process.env.SIFTKIT_STATUS_BACKEND_URL;
        process.env.SIFTKIT_CONFIG_SERVICE_URL = `http://127.0.0.1:${port}/config`;
        process.env.SIFTKIT_STATUS_BACKEND_URL = `http://127.0.0.1:${port}/status`;
        try {
          const loadedConfig = await loadConfig({ ensure: true });
          assert.equal(loadedConfig.Runtime.LlamaCpp.BaseUrl, managed.baseUrl);
          await waitForAsyncExpectation(async () => {
            const models = await requestJson<LlamaModelsResponse>(`${managed.baseUrl}/v1/models`);
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
    } finally {
      if (staleChild.exitCode === null && !staleChild.killed) {
        staleChild.kill('SIGTERM');
        await waitForAsyncExpectation(async () => {
          assert.notEqual(staleChild.exitCode, null);
        }, 1000).catch(() => undefined);
      }
    }
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
      const status = await requestJson<RuntimeStatusResponse>(statusUrl);
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

test('real status server resets metrics when metrics schema is outdated', async () => {
  await withTempEnv(async (tempRoot) => {
    const statusPath = path.join(tempRoot, 'status', 'inference.txt');
    const configPath = path.join(tempRoot, 'config.json');
    const metricsPath = path.join(tempRoot, 'metrics', 'compression.json');
    const idleSummaryDbPath = path.join(tempRoot, '.siftkit', 'runtime.sqlite');

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
      const status = await requestJson<RuntimeStatusResponse>(statusUrl);
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

    assert.equal(readIdleSummarySnapshots(idleSummaryDbPath).length, 1);
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
      await postCompletedStatus(statusUrl, {
        requestId,
        taskKind: 'summary',
        terminalState: 'completed',
        rawInputCharacterCount: 1000,
      });

      let status = await requestJson<RuntimeStatusResponse>(statusUrl);
      await waitForAsyncExpectation(async () => {
        status = await requestJson<RuntimeStatusResponse>(statusUrl);
        assert.equal(status.metrics.completedRequestCount, 1);
      }, 1000);
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
      terminalMetadataIdleDelayMs: 0,
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
      await postCompletedStatus(statusUrl, {
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
      });

      // Terminal metadata is drained asynchronously; poll until the metrics
      // aggregation lands rather than racing the first read.
      await waitForAsyncExpectation(async () => {
        const status = await requestJson<RuntimeStatusResponse>(statusUrl);
        assert.equal(status.metrics.outputTokensTotal, 12);
        assert.equal(status.metrics.toolTokensTotal, 9);
        assert.equal(status.metrics.taskTotals['repo-search'].outputTokensTotal, 12);
        assert.equal(status.metrics.taskTotals['repo-search'].toolTokensTotal, 9);
        assert.equal(status.metrics.toolStats['repo-search'].rg.calls, 2);
        assert.equal(status.metrics.toolStats['repo-search'].rg.outputCharsTotal, 210);
        assert.equal(status.metrics.toolStats['repo-search'].rg.outputTokensTotal, 44);
        assert.equal(status.metrics.toolStats['repo-search'].rg.outputTokensEstimatedCount, 1);
      }, 10000);
    }, {
      statusPath,
      configPath,
      terminalMetadataIdleDelayMs: 0,
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
          promptEvalDurationMs: null,
          generationDurationMs: null,
          speculativeAcceptedTokens: null,
          speculativeGeneratedTokens: null,
        });
      } finally {
        database.close();
      }

      await postCompletedStatus(statusUrl, {
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
      });

      await waitForAsyncExpectation(() => {
        const verifyDb = new Database(runtimeDbPath, { readonly: true });
        try {
          const row = SpeculativeRowSchema.parse(verifyDb.prepare(`
            SELECT speculative_accepted_tokens, speculative_generated_tokens
            FROM run_logs
            WHERE request_id = ?
          `).get(requestId));
          assert.equal(row?.speculative_accepted_tokens, 12);
          assert.equal(row?.speculative_generated_tokens, 18);
        } finally {
          verifyDb.close();
        }
      });
    }, {
      statusPath,
      configPath,
      terminalMetadataIdleDelayMs: 0,
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
        await postCompletedStatus(statusUrl, {
          requestId: 'single-step',
          taskKind: 'summary',
          terminalState: 'completed',
          rawInputCharacterCount: 426,
        });
        await waitForAsyncExpectation(async () => {
          const status = await requestJson<RuntimeStatusResponse>(statusUrl);
          assert.equal(status.metrics.completedRequestCount, 1);
        }, 1000);
      });

      const falseLines = lines.filter((line) => /st [\w-]{8}  done  .*output_tokens=130/u.test(line));
      assert.equal(falseLines.length, 1, lines.join('\n'));
      assert.match(falseLines[0], /st [\w-]{8}  done  (?:task=summary )?total_elapsed=0s output_tokens=130/u);
      assert.equal(falseLines.some((line) => /st [\w-]{8}  done  elapsed=/u.test(line)), false, lines.join('\n'));
    }, {
      statusPath,
      configPath,
      terminalMetadataIdleDelayMs: 0,
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

      const falseLines = lines.filter((line) => /st [\w-]{8}  done  elapsed=0s output_tokens=82/u.test(line));
      assert.equal(falseLines.length, 1, lines.join('\n'));
      assert.match(falseLines[0], /st [\w-]{8}  done  elapsed=0s output_tokens=82/u);
    }, {
      statusPath,
      configPath,
      terminalMetadataIdleDelayMs: 0,
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
        await postCompletedStatus(statusUrl, {
          requestId: 'failed-request',
          taskKind: 'summary',
          terminalState: 'failed',
          errorMessage: 'leaf chunk failed',
          rawInputCharacterCount: 3_322_607,
          promptCharacterCount: 342_395,
          promptTokenCount: 147_694,
          chunkIndex: 1,
          chunkTotal: 10,
          chunkPath: '1/10',
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
        await postCompletedStatus(statusUrl, {
          requestId: 'next-request',
          taskKind: 'summary',
          terminalState: 'completed',
          rawInputCharacterCount: 281_469,
        });
        await waitForAsyncExpectation(async () => {
          const status = await requestJson<RuntimeStatusResponse>(statusUrl);
          assert.equal(status.metrics.completedRequestCount, 1);
        }, 1000);
      });

      assert.ok(lines.some((line) => /st [\w-]{8}  failed  (?:task=summary )?raw_chars=3,322,607 prompt=342,395 \(147,694\) chunk 1\/10 elapsed=0s error=leaf chunk failed/u.test(line)), lines.join('\n'));
      assert.ok(lines.some((line) => /st [\w-]{8}  start  (?:task=summary )?raw_chars=281,469 prompt=283,752 \(99,240\)/u.test(line)), lines.join('\n'));
      assert.ok(lines.some((line) => /st [\w-]{8}  done  (?:task=summary )?total_elapsed=0s output_tokens=154/u.test(line)), lines.join('\n'));

      const status = await requestJson<RuntimeStatusResponse>(statusUrl);
      assert.equal(status.metrics.completedRequestCount, 1);
    }, {
      statusPath,
      configPath,
      terminalMetadataIdleDelayMs: 0,
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
        lines.some((line) => /st [\w-]{8}  failed  raw_chars=3,322,607 prompt=342,395 \(147,694\) chunk 1\/10 elapsed=0s error=Abandoned because a new request started before terminal status\./u.test(line)),
        lines.join('\n'),
      );
      assert.ok(lines.some((line) => /st [\w-]{8}  start  (?:task=summary )?raw_chars=281,469 prompt=283,752 \(99,240\)/u.test(line)), lines.join('\n'));
    }, {
      statusPath,
      configPath,
      disableManagedLlamaStartup: true,
    });
  });
});

