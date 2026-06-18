import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

import { writeConfig, getDefaultConfig } from '../src/status-server/config-store.js';
import {
  requestJson,
  withRealStatusServer,
  withTempEnv,
} from './_runtime-helpers.js';

interface MetricsTimeseriesResponse {
  days: unknown[];
  taskDays: unknown[];
  toolStats: Record<string, unknown>;
}

test('dashboard metrics timeseries loads when managed llama is unconfigured', async () => {
  await withTempEnv(async (tempRoot) => {
    const runtimeDbPath = path.join(tempRoot, '.siftkit', 'runtime.sqlite');
    const config = getDefaultConfig();
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
    writeConfig(runtimeDbPath, config);

    await withRealStatusServer(async ({ port }) => {
      const metricsResponse = await requestJson<MetricsTimeseriesResponse>(`http://127.0.0.1:${port}/dashboard/metrics/timeseries`);
      assert.equal(Array.isArray(metricsResponse.days), true);
      assert.equal(Array.isArray(metricsResponse.taskDays), true);
      assert.equal(typeof metricsResponse.toolStats, 'object');
    }, {
      statusPath: runtimeDbPath,
      configPath: runtimeDbPath,
    });
  });
});
