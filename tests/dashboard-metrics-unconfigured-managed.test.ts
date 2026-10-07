import { getActiveModelPreset } from '../src/config/getters.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

import { writeConfig, getDefaultConfig } from '../src/status-server/config-store.ts';
import {
  requestJson,
  withRealStatusServer,
  withTempEnv,
} from './_runtime-helpers.ts';
import type { JsonObject, JsonValue } from '../src/lib/json-types.ts';
import { DEAD_BASE_URL } from './helpers/dead-endpoints.ts';

interface MetricsTimeseriesResponse {
  days: JsonValue[];
  taskDays: JsonValue[];
  toolStats: JsonObject;
}

test('dashboard metrics timeseries loads when the managed engine is unconfigured', async () => {
  await withTempEnv(async (tempRoot) => {
    const runtimeDbPath = path.join(tempRoot, '.siftkit', 'runtime.sqlite');
    const config = getDefaultConfig();
    // Managed startup still probes the preset, and the default preset points at the
    // production engine port; a closed port keeps "unconfigured" local to this test.
    for (const preset of config.Server.ModelPresets.Presets) {
      preset.BaseUrl = DEAD_BASE_URL;
    }
    getActiveModelPreset(config).BaseUrl = null;
    getActiveModelPreset(config).NumCtx = 0;
    getActiveModelPreset(config).ModelPath = null;
    getActiveModelPreset(config).Temperature = 0;
    getActiveModelPreset(config).TopP = 0;
    getActiveModelPreset(config).TopK = 0;
    getActiveModelPreset(config).MinP = 0;
    getActiveModelPreset(config).PresencePenalty = 0;
    getActiveModelPreset(config).RepetitionPenalty = 0;
    getActiveModelPreset(config).ParallelSlots = 0;
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
