import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { getAddressInfo } from './helpers/dashboard-http.js';
import { DEAD_BASE_URL } from './helpers/dead-endpoints.js';

import {
  applyHostEngineRuntimeSettings,
  getActiveModelPreset,
  getConfiguredEngineNumCtx,
  getConfiguredModel,
  getConfiguredReasoning,
  resetHostEngineSettingsCacheForTests,
  type ModelRuntimePreset,
  type SiftConfig,
} from '../src/config/index.js';
import { getPlannerPromptBudget } from '../src/summary.js';
import { PROMPT_COMPACTION_RESERVE_TOKENS } from '../src/lib/context-token-budget.js';
import { mockConfig } from './_runtime-helpers.js';
import type { JsonValue } from '../src/lib/json-types.js';

function makeClientConfig(options: {
  externalServer: boolean;
  baseUrl: string;
  localNumCtx: number;
  presetFields?: Partial<ModelRuntimePreset>;
}): SiftConfig {
  return mockConfig({
    PolicyMode: 'conservative',
    RawLogRetention: true,
    Thresholds: { MinCharactersForSummary: 500, MinLinesForSummary: 16 },
    Server: {
      ModelPresets: {
        ActivePresetId: 'default',
        Presets: [
          {
            id: 'default',
            label: 'Default',
            Model: 'mock-model',
            ExternalServerEnabled: options.externalServer,
            BaseUrl: options.baseUrl,
            NumCtx: options.localNumCtx,
            Reasoning: 'on',
            IdleAction: 'unload',
            ...options.presetFields,
          },
        ],
      },
    },
  });
}

function countConfigRequests(requestUrls: string[]): number {
  return requestUrls.filter((url) => url.startsWith('/config')).length;
}

type HostConfigServer = {
  baseUrl: string;
  requestUrls: string[];
  close: () => Promise<void>;
};

async function startHostConfigServer(
  hostConfigBody: JsonValue,
  options: { status?: number } = {},
): Promise<HostConfigServer> {
  const requestUrls: string[] = [];
  const server = http.createServer((req, res) => {
    requestUrls.push(req.url || '');
    if ((req.url || '').startsWith('/config')) {
      res.writeHead(options.status ?? 200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(hostConfigBody));
      return;
    }
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end('{}');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = getAddressInfo(server).port;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    requestUrls,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

test('applyHostEngineRuntimeSettings leaves the config untouched when this SiftKit owns the engine', async () => {
  resetHostEngineSettingsCacheForTests();
  const config = makeClientConfig({
    externalServer: false,
    baseUrl: DEAD_BASE_URL,
    localNumCtx: 150_000,
  });

  const resolved = await applyHostEngineRuntimeSettings(config);

  assert.equal(resolved, config);
  assert.equal(getConfiguredEngineNumCtx(resolved), 150_000);
});

test('applyHostEngineRuntimeSettings overlays the host SiftKit NumCtx/Reasoning/Model in pass-through mode', async () => {
  resetHostEngineSettingsCacheForTests();
  const hostConfig = makeClientConfig({
    externalServer: false,
    baseUrl: DEAD_BASE_URL,
    localNumCtx: 75_008,
  });
  const hostPreset = hostConfig.Server.ModelPresets.Presets[0];
  if (!hostPreset) throw new Error('Host model preset is missing');
  hostPreset.Model = 'host-loaded-model.exl3';
  getActiveModelPreset(hostConfig).Reasoning = 'off';
  const host = await startHostConfigServer(hostConfig);
  try {
    const config = makeClientConfig({
      externalServer: true,
      baseUrl: host.baseUrl,
      localNumCtx: 150_000,
    });

    const resolved = await applyHostEngineRuntimeSettings(config);

    // The client's stale local NumCtx (150k) is replaced by the host's real 75008.
    assert.equal(getConfiguredEngineNumCtx(resolved), 75_008);
    // The client's stale local model ('mock-model') is replaced by the host's.
    assert.equal(getConfiguredModel(resolved), 'host-loaded-model.exl3');
    // The host config is read without booting the host's managed engine.
    assert.equal(host.requestUrls.some((url) => url.includes('skip_ready=1')), true);

    // Budget math now matches the server that actually serves the request: the shared
    // compaction reserve comes off the host's real NumCtx, not the stale local 150k.
    const budget = getPlannerPromptBudget(resolved);
    assert.equal(budget.numCtxTokens, 75_008);
    assert.equal(
      budget.compactionReserveTokens,
      PROMPT_COMPACTION_RESERVE_TOKENS,
    );
    assert.equal(budget.plannerStopLineTokens, 75_008 - PROMPT_COMPACTION_RESERVE_TOKENS);
  } finally {
    await host.close();
  }
});

test('applyHostEngineRuntimeSettings overlays the host preset request fields onto the local active preset', async () => {
  resetHostEngineSettingsCacheForTests();
  const hostConfig = makeClientConfig({
    externalServer: false,
    baseUrl: DEAD_BASE_URL,
    localNumCtx: 60_000,
    presetFields: {
      Temperature: 0.33,
      TopP: 0.77,
      TopK: 11,
      MinP: 0.02,
      PresencePenalty: 0.4,
      RepetitionPenalty: 1.2,
      // Normalization only keeps the thinking flags when Reasoning is on.
      Reasoning: 'on',
      ReasoningContent: true,
      PreserveThinking: true,
      MaintainPerStepThinking: true,
      ReasoningEffort: 'medium',
    },
  });
  const host = await startHostConfigServer(hostConfig);
  try {
    const config = makeClientConfig({
      externalServer: true,
      baseUrl: host.baseUrl,
      localNumCtx: 150_000,
      presetFields: {
        Temperature: 0.9,
        TopP: 0.1,
        TopK: 99,
        MinP: 0.5,
        PresencePenalty: 0,
        RepetitionPenalty: 1,
        Reasoning: 'off',
        ReasoningContent: false,
        PreserveThinking: false,
        MaintainPerStepThinking: false,
        ReasoningEffort: 'xhigh',
      },
    });

    const preset = getActiveModelPreset(await applyHostEngineRuntimeSettings(config));

    assert.equal(preset.Temperature, 0.33);
    assert.equal(preset.TopP, 0.77);
    assert.equal(preset.TopK, 11);
    assert.equal(preset.MinP, 0.02);
    assert.equal(preset.PresencePenalty, 0.4);
    assert.equal(preset.RepetitionPenalty, 1.2);
    assert.equal(preset.Reasoning, 'on');
    assert.equal(preset.ReasoningContent, true);
    assert.equal(preset.PreserveThinking, true);
    assert.equal(preset.MaintainPerStepThinking, true);
    assert.equal(preset.ReasoningEffort, 'medium');
    assert.equal(preset.NumCtx, 60_000);
    // Only request-shaping fields are host-owned; the client stays the pass-through client.
    assert.equal(preset.ExternalServerEnabled, true);
    assert.equal(preset.BaseUrl, host.baseUrl);
  } finally {
    await host.close();
  }
});

test('applyHostEngineRuntimeSettings makes host NumCtx/Reasoning visible to the exl3 getters', async () => {
  resetHostEngineSettingsCacheForTests();
  const hostConfig = makeClientConfig({
    externalServer: false,
    baseUrl: DEAD_BASE_URL,
    localNumCtx: 65_536,
  });
  getActiveModelPreset(hostConfig).Reasoning = 'on';
  const host = await startHostConfigServer(hostConfig);
  try {
    const config = makeClientConfig({
      externalServer: true,
      baseUrl: host.baseUrl,
      localNumCtx: 150_000,
      presetFields: { Backend: 'exl3', NumCtx: 8192, Reasoning: 'off' },
    });

    const resolved = await applyHostEngineRuntimeSettings(config);

    // The getters read the preset, so the host values must land there.
    assert.equal(getConfiguredEngineNumCtx(resolved), 65_536);
    assert.equal(getConfiguredReasoning(resolved), 'on');
  } finally {
    await host.close();
  }
});

test('applyHostEngineRuntimeSettings caches host settings and re-fetches after the TTL elapses', async () => {
  resetHostEngineSettingsCacheForTests();
  const hostConfig = makeClientConfig({
    externalServer: false,
    baseUrl: DEAD_BASE_URL,
    localNumCtx: 75_008,
  });
  const host = await startHostConfigServer(hostConfig);
  mock.timers.enable({ apis: ['Date'] });
  try {
    const config = makeClientConfig({
      externalServer: true,
      baseUrl: host.baseUrl,
      localNumCtx: 150_000,
    });

    await applyHostEngineRuntimeSettings(config);
    await applyHostEngineRuntimeSettings(config);
    assert.equal(countConfigRequests(host.requestUrls), 1);

    mock.timers.tick(61_000);
    await applyHostEngineRuntimeSettings(config);
    assert.equal(countConfigRequests(host.requestUrls), 2);
  } finally {
    mock.timers.reset();
    await host.close();
  }
});

test('applyHostEngineRuntimeSettings falls back to the local config when the host is not a SiftKit', async () => {
  resetHostEngineSettingsCacheForTests();
  const host = await startHostConfigServer({}, { status: 404 });
  try {
    const config = makeClientConfig({
      externalServer: true,
      baseUrl: host.baseUrl,
      localNumCtx: 150_000,
    });

    const resolved = await applyHostEngineRuntimeSettings(config);

    assert.equal(getConfiguredEngineNumCtx(resolved), 150_000);
    // With no host config to read, the local model is left untouched.
    assert.equal(getConfiguredModel(resolved), 'mock-model');
  } finally {
    await host.close();
  }
});
