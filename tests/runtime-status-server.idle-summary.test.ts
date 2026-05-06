// @ts-nocheck â€” Split from runtime-status-server.test.ts to reduce file-level serial bottlenecks.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { loadConfig, getConfigPath } = require('../dist/config/index.js');
const { startStatusServer } = require('../dist/status-server/index.js');
const { writeConfig } = require('../dist/status-server/config-store.js');
const { readStatusText } = require('../dist/status-server/status-file.js');

const {
  getDefaultConfig,
  setManagedLlamaBaseUrl,
  requestJson,
  sleep,
  withTempEnv,
  startStatusServerProcess,
  readIdleSummarySnapshots,
  getIdleSummaryBlock,
  getFreePort,
  writeManagedLlamaScripts,
  waitForAsyncExpectation,
  postCompletedStatus,
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

test('real status server prints one idle metrics line only after the full idle delay', async () => {
  await withTempEnv(async (tempRoot) => {
    const statusPath = path.join(tempRoot, 'status', 'inference.txt');
    const configPath = path.join(tempRoot, 'config.json');
    const idleSummaryDbPath = path.join(tempRoot, '.siftkit', 'runtime.sqlite');
    const requestId = 'idle-summary-metrics';
    const server = await startStatusServerProcess({
      statusPath,
      configPath,
      idleSummaryDbPath,
      idleSummaryDelayMs: 80,
      terminalMetadataIdleDelayMs: 0,
      disableManagedLlamaStartup: true,
    });

    try {
      await requestJson(server.statusUrl, {
        method: 'POST',
        body: JSON.stringify({
          running: true,
          requestId,
          rawInputCharacterCount: 200,
          promptCharacterCount: 200,
          promptTokenCount: 100,
          inputCharactersPerContextToken: 2,
          chunkThresholdCharacters: 320_000,
        }),
      });
      await server.waitForStdoutMatch(/request true raw_chars=200 prompt=200 \(100\)/u, 1000);
      await postCompletedStatus(server.statusUrl, {
        requestId,
        taskKind: 'summary',
        terminalState: 'completed',
        promptCharacterCount: 200,
        inputTokens: 100,
        outputCharacterCount: 80,
        outputTokens: 25,
        requestDurationMs: 800,
      });

      assert.equal(readStatusText(getConfigPath()), 'false');
      const pendingStatus = await requestJson(server.statusUrl);
      assert.equal(pendingStatus.running, false);
      assert.equal(pendingStatus.status, 'false');

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
    applyManagedScriptConfig(config, managed);
    writeConfig(getConfigPath(), config);
    const requestId = 'idle-summary-llama-shutdown';

    const server = await startStatusServerProcess({
      statusPath,
      configPath,
      idleSummaryDbPath,
      idleSummaryDelayMs: 80,
      terminalMetadataIdleDelayMs: 0,
    });

    try {
      await requestJson(server.configUrl);
      await waitForAsyncExpectation(async () => {
        const models = await requestJson(`${managed.baseUrl}/v1/models`);
        assert.equal(models.data[0].id, 'managed-test-model');
      }, 5000);

      await requestJson(server.statusUrl, {
        method: 'POST',
        body: JSON.stringify({ running: true, requestId, rawInputCharacterCount: 50 }),
      });
      await postCompletedStatus(server.statusUrl, {
        requestId,
        taskKind: 'summary',
        terminalState: 'completed',
        promptCharacterCount: 50,
        inputTokens: 10,
        outputCharacterCount: 5,
        outputTokens: 1,
        requestDurationMs: 20,
      });

      await server.waitForStdoutMatch(/requests=1/u, 1000);
      await waitForAsyncExpectation(
        async () => assert.rejects(() => requestJson(`${managed.baseUrl}/v1/models`)),
        5000,
      );
      await waitForAsyncExpectation(async () => {
        assert.equal(readStatusText(getConfigPath()), 'false');
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
    applyManagedScriptConfig(config, managed);
    writeConfig(getConfigPath(), config);

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
      5000,
    );
  });
});

test('real status server falls back to request-start prompt chars and elapsed time when completion payload is minimal', async () => {
  await withTempEnv(async (tempRoot) => {
    const statusPath = path.join(tempRoot, 'status', 'inference.txt');
    const configPath = path.join(tempRoot, 'config.json');

    const server = await startStatusServerProcess({
      statusPath,
      configPath,
      disableManagedLlamaStartup: true,
    });

    try {
      await requestJson(server.statusUrl, {
        method: 'POST',
        body: JSON.stringify({ running: true, rawInputCharacterCount: 300, promptCharacterCount: 420 }),
      });
      await sleep(20);
      await requestJson(server.statusUrl, {
        method: 'POST',
        body: JSON.stringify({ running: false }),
      });

      const status = await requestJson(server.statusUrl);
      assert.equal(status.metrics.inputCharactersTotal, 420);
      assert.equal(status.metrics.outputCharactersTotal, 0);
      assert.equal(status.metrics.inputTokensTotal, 0);
      assert.equal(status.metrics.outputTokensTotal, 0);
      assert.equal(status.metrics.thinkingTokensTotal, 0);
      assert.ok(status.metrics.completedRequestCount >= 0);
      assert.ok(status.metrics.requestDurationMsTotal >= 20);
    } finally {
      await server.close();
    }
  });
});

test('real status server restarts the idle countdown when a new request begins before the prior delay expires', async () => {
  await withTempEnv(async (tempRoot) => {
    const statusPath = path.join(tempRoot, 'status', 'inference.txt');
    const configPath = path.join(tempRoot, 'config.json');
    const idleSummaryDbPath = path.join(tempRoot, '.siftkit', 'runtime.sqlite');
    const firstRequestId = 'idle-summary-restart-first';
    const secondRequestId = 'idle-summary-restart-second';
    const server = await startStatusServerProcess({
      statusPath,
      configPath,
      idleSummaryDbPath,
      idleSummaryDelayMs: 80,
      terminalMetadataIdleDelayMs: 0,
      disableManagedLlamaStartup: true,
    });

    try {
      await requestJson(server.statusUrl, {
        method: 'POST',
        body: JSON.stringify({
          running: true,
          requestId: firstRequestId,
          rawInputCharacterCount: 100,
          inputCharactersPerContextToken: 2,
          chunkThresholdCharacters: 100,
        }),
      });
      await postCompletedStatus(server.statusUrl, {
        requestId: firstRequestId,
        taskKind: 'summary',
        terminalState: 'completed',
        promptCharacterCount: 100,
        inputTokens: 10,
        outputCharacterCount: 40,
        outputTokens: 5,
        requestDurationMs: 50,
      });

      await sleep(20);
      await requestJson(server.statusUrl, {
        method: 'POST',
        body: JSON.stringify({
          running: true,
          requestId: secondRequestId,
          rawInputCharacterCount: 50,
          inputCharactersPerContextToken: 4,
          chunkThresholdCharacters: 200,
        }),
      });
      await sleep(40);
      assert.equal(server.stdoutLines.some((line) => /idle_metrics/u.test(line)), false);

      await postCompletedStatus(server.statusUrl, {
        requestId: secondRequestId,
        taskKind: 'summary',
        terminalState: 'completed',
        promptCharacterCount: 50,
        inputTokens: 0,
        outputCharacterCount: 0,
        outputTokens: 0,
        requestDurationMs: 25,
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
    const idleSummaryDbPath = path.join(tempRoot, '.siftkit', 'runtime.sqlite');
    const requestId = 'idle-summary-lease';
    const server = await startStatusServerProcess({
      statusPath,
      configPath,
      idleSummaryDbPath,
      idleSummaryDelayMs: 80,
      terminalMetadataIdleDelayMs: 0,
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
        body: JSON.stringify({ running: true, requestId, rawInputCharacterCount: 10 }),
      });
      await postCompletedStatus(server.statusUrl, {
        requestId,
        taskKind: 'summary',
        terminalState: 'completed',
        promptCharacterCount: 10,
        inputTokens: 0,
        outputCharacterCount: 0,
        outputTokens: 0,
        requestDurationMs: 10,
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
