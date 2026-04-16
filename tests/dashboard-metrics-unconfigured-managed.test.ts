// @ts-nocheck
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { writeConfig, getDefaultConfig } = require('../dist/status-server/config-store.js');
const {
  requestJson,
  withRealStatusServer,
  withTempEnv,
} = require('./_runtime-helpers.js');

test('dashboard metrics timeseries loads when managed llama is unconfigured', async () => {
  await withTempEnv(async (tempRoot) => {
    const runtimeDbPath = path.join(tempRoot, '.siftkit', 'runtime.sqlite');
    const config = getDefaultConfig();
    config.Runtime ??= {};
    config.Runtime.LlamaCpp ??= {};
    config.Runtime.LlamaCpp.BaseUrl = null;
    config.Runtime.LlamaCpp.NumCtx = 0;
    config.Runtime.LlamaCpp.ModelPath = null;
    config.Runtime.LlamaCpp.Temperature = 0;
    config.Runtime.LlamaCpp.TopP = 0;
    config.Runtime.LlamaCpp.TopK = 0;
    config.Runtime.LlamaCpp.MinP = 0;
    config.Runtime.LlamaCpp.PresencePenalty = 0;
    config.Runtime.LlamaCpp.RepetitionPenalty = 0;
    config.Runtime.LlamaCpp.MaxTokens = 0;
    config.Runtime.LlamaCpp.GpuLayers = 0;
    config.Runtime.LlamaCpp.Threads = 0;
    config.Runtime.LlamaCpp.FlashAttention = null;
    config.Runtime.LlamaCpp.ParallelSlots = 0;
    config.Runtime.LlamaCpp.Reasoning = null;
    config.Server ??= {};
    config.Server.LlamaCpp ??= {};
    config.Server.LlamaCpp.ExecutablePath = null;
    config.Server.LlamaCpp.BaseUrl = null;
    config.Server.LlamaCpp.BindHost = null;
    config.Server.LlamaCpp.Port = 0;
    config.Server.LlamaCpp.ModelPath = null;
    config.Server.LlamaCpp.NumCtx = 0;
    config.Server.LlamaCpp.GpuLayers = 0;
    config.Server.LlamaCpp.Threads = 0;
    config.Server.LlamaCpp.FlashAttention = null;
    config.Server.LlamaCpp.ParallelSlots = 0;
    config.Server.LlamaCpp.BatchSize = 0;
    config.Server.LlamaCpp.UBatchSize = 0;
    config.Server.LlamaCpp.CacheRam = 0;
    config.Server.LlamaCpp.MaxTokens = 0;
    config.Server.LlamaCpp.Temperature = 0;
    config.Server.LlamaCpp.TopP = 0;
    config.Server.LlamaCpp.TopK = 0;
    config.Server.LlamaCpp.MinP = 0;
    config.Server.LlamaCpp.PresencePenalty = 0;
    config.Server.LlamaCpp.RepetitionPenalty = 0;
    config.Server.LlamaCpp.Reasoning = null;
    config.Server.LlamaCpp.ReasoningBudget = 0;
    config.Server.LlamaCpp.VerboseLogging = true;
    writeConfig(runtimeDbPath, config);

    await withRealStatusServer(async ({ port }) => {
      const metricsResponse = await requestJson(`http://127.0.0.1:${port}/dashboard/metrics/timeseries`);
      assert.equal(Array.isArray(metricsResponse.days), true);
      assert.equal(Array.isArray(metricsResponse.taskDays), true);
      assert.equal(typeof metricsResponse.toolStats, 'object');
    }, {
      statusPath: runtimeDbPath,
      configPath: runtimeDbPath,
    });
  });
});
