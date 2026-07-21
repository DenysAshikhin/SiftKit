// Fixture60 chunking-config repro helper (typed port of runtime-benchmark-repro.js).
import { loadConfig, saveConfig } from '../_runtime-helpers.js';

export const STABLE_CHUNK_BUDGET_METRICS = {
  inputCharactersTotal: 2500,
  inputTokensTotal: 1000,
};

interface StubLlamaTarget {
  baseUrl: string;
  host: string;
  port: number;
}

function getStubLlamaBaseUrl(): StubLlamaTarget {
  const configuredUrl = process.env.SIFTKIT_CONFIG_SERVICE_URL || process.env.SIFTKIT_STATUS_BACKEND_URL;
  if (!configuredUrl || !configuredUrl.trim()) {
    throw new Error('Fixture60 repro tests require SIFTKIT_CONFIG_SERVICE_URL or SIFTKIT_STATUS_BACKEND_URL.');
  }

  const url = new URL(configuredUrl);
  return {
    baseUrl: `${url.protocol}//${url.host}`,
    host: url.hostname,
    port: Number(url.port),
  };
}

export async function saveFixture60ChunkingConfig(): Promise<void> {
  const config = await loadConfig({ ensure: true });
  const stubLlama = getStubLlamaBaseUrl();
  config.Runtime.LlamaCpp = {
    ...config.Runtime.LlamaCpp,
    BaseUrl: stubLlama.baseUrl,
    NumCtx: 12_000,
  };
  const basePreset = config.Server.ModelPresets.Presets[0];
  config.Server.ModelPresets.ActivePresetId = 'default';
  config.Server.ModelPresets.Presets = [{
    ...basePreset,
    id: 'default',
    label: 'Default',
    BaseUrl: stubLlama.baseUrl,
    BindHost: stubLlama.host,
    Port: stubLlama.port,
    NumCtx: 12_000,
  }];
  await saveConfig(config);
}
