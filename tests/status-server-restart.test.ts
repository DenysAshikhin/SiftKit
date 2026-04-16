// @ts-nocheck
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { writeConfig } = require('../dist/status-server/config-store.js');

const {
  getDefaultConfig,
  getFreePort,
  requestJson,
  setManagedLlamaBaseUrl,
  waitForAsyncExpectation,
  withRealStatusServer,
  withTempEnv,
  writeManagedLlamaLauncher,
} = require('./_runtime-helpers.js');

test('real status server backend restart endpoint restarts managed llama.cpp and returns the live config', async () => {
  await withTempEnv(async (tempRoot) => {
    const runtimeDbPath = path.join(tempRoot, '.siftkit', 'runtime.sqlite');
    const llamaPort = await getFreePort();
    const managed = writeManagedLlamaLauncher(tempRoot, llamaPort);
    const config = getDefaultConfig();

    setManagedLlamaBaseUrl(config, managed.baseUrl);
    config.Server = {
      LlamaCpp: {
        ExecutablePath: managed.executablePath,
        BaseUrl: managed.baseUrl,
        BindHost: '127.0.0.1',
        Port: llamaPort,
        ModelPath: managed.modelPath,
        NumCtx: 32000,
        GpuLayers: 999,
        Threads: 2,
        FlashAttention: true,
        ParallelSlots: 1,
        BatchSize: 512,
        UBatchSize: 512,
        CacheRam: 8192,
        MaxTokens: 15000,
        Temperature: 0.6,
        TopP: 0.95,
        TopK: 20,
        MinP: 0,
        PresencePenalty: 0,
        RepetitionPenalty: 1,
        Reasoning: 'on',
        ReasoningBudget: 10000,
        StartupTimeoutMs: 5000,
        HealthcheckTimeoutMs: 200,
        HealthcheckIntervalMs: 50,
        VerboseLogging: false,
      },
    };
    writeConfig(runtimeDbPath, config);

    await withRealStatusServer(async ({ statusUrl }) => {
      await waitForAsyncExpectation(async () => {
        const models = await requestJson(`${managed.baseUrl}/v1/models`);
        assert.equal(models.data[0].id, 'managed-test-model');
      }, 5000);

      const initialPid = fs.readFileSync(managed.readyFilePath, 'utf8').trim();
      assert.match(initialPid, /^\d+$/u);

      const restartResponse = await requestJson(new URL('/status/restart', statusUrl).toString(), {
        method: 'POST',
      });

      assert.equal(restartResponse.ok, true);
      assert.equal(restartResponse.restarted, true);
      assert.equal(restartResponse.config.Server.LlamaCpp.BaseUrl, managed.baseUrl);
      assert.equal(restartResponse.config.Server.LlamaCpp.ExecutablePath, managed.executablePath);

      await waitForAsyncExpectation(async () => {
        const nextPid = fs.readFileSync(managed.readyFilePath, 'utf8').trim();
        assert.match(nextPid, /^\d+$/u);
        assert.notEqual(nextPid, initialPid);
        const models = await requestJson(`${managed.baseUrl}/v1/models`);
        assert.equal(models.data[0].id, 'managed-test-model');
      }, 5000);
    }, {
      statusPath: runtimeDbPath,
      configPath: runtimeDbPath,
    });
  });
});
