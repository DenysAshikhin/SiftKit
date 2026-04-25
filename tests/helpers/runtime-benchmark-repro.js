// @ts-nocheck

const { loadConfig, saveConfig } = require('../_runtime-helpers.ts');

const STABLE_CHUNK_BUDGET_METRICS = {
  inputCharactersTotal: 2500,
  inputTokensTotal: 1000,
};

function getStubLlamaBaseUrl() {
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

async function saveFixture60ChunkingConfig() {
  const config = await loadConfig({ ensure: true });
  const stubLlama = getStubLlamaBaseUrl();
  config.Backend = 'llama.cpp';
  config.LlamaCpp.BaseUrl = stubLlama.baseUrl;
  config.LlamaCpp.NumCtx = 12_000;
  config.Runtime ??= {};
  config.Runtime.LlamaCpp = {
    ...(config.Runtime.LlamaCpp || {}),
    BaseUrl: stubLlama.baseUrl,
    NumCtx: 12_000,
  };
  config.Server ??= {};
  config.Server.LlamaCpp ??= {};
  config.Server.LlamaCpp.BaseUrl = stubLlama.baseUrl;
  config.Server.LlamaCpp.BindHost = stubLlama.host;
  config.Server.LlamaCpp.Port = stubLlama.port;
  config.Server.LlamaCpp.NumCtx = 12_000;
  config.Server.LlamaCpp.ActivePresetId = 'default';
  config.Server.LlamaCpp.Presets = [{
    id: 'default',
    label: 'Default',
    BaseUrl: stubLlama.baseUrl,
    BindHost: stubLlama.host,
    Port: stubLlama.port,
    NumCtx: 12_000,
  }];
  await saveConfig(config);
}

module.exports = {
  STABLE_CHUNK_BUDGET_METRICS,
  saveFixture60ChunkingConfig,
};
