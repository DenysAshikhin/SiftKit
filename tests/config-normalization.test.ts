import assert from 'node:assert/strict';
import test from 'node:test';

import { getDefaultConfig, normalizeConfig, normalizeWebSearchConfig } from '../src/status-server/config-store';
import { JsonValueSchema, type JsonObject } from '../src/lib/json-types';
import type { SiftConfig, ServerManagedLlamaPreset } from '../src/config/types';
import { asObject, asObjectArray } from './helpers/dashboard-http';

test('normalizeWebSearchConfig produces provider defaults and clamps ResultCount to 20', () => {
  const normalized = normalizeWebSearchConfig({ ResultCount: 999, Providers: { tavily: { Enabled: true, ApiKey: '  abc  ' } } });
  assert.deepEqual(normalized.ProviderOrder, ['tavily', 'firecrawl']);
  assert.equal(normalized.ResultCount, 20);
  assert.deepEqual(normalized.Providers, {
    tavily: { Enabled: true, ApiKey: 'abc' },
    firecrawl: { Enabled: false, ApiKey: '' },
  });
});

test('normalizeWebSearchConfig defaults empty provider records', () => {
  const normalized = normalizeWebSearchConfig({});
  assert.deepEqual(normalized.Providers, {
    tavily: { Enabled: false, ApiKey: '' },
    firecrawl: { Enabled: false, ApiKey: '' },
  });
});

function defaultConfigObject(): JsonObject {
  return asObject(JsonValueSchema.parse(getDefaultConfig()));
}

// Typed active preset for reading normalized output.
function activePreset(config: SiftConfig): ServerManagedLlamaPreset {
  return config.Server.LlamaCpp.Presets[0];
}

// Mutable JSON view of the active preset, for tests that inject invalid values.
function activePresetObject(config: JsonObject): JsonObject {
  const llama = asObject(asObject(config.Server).LlamaCpp);
  return asObjectArray(llama.Presets)[0];
}

function configWithSpeculativeType(speculativeType: string): JsonObject {
  const config = defaultConfigObject();
  activePresetObject(config).SpeculativeType = speculativeType;
  return config;
}

test('normalizeConfig produces default WebSearch config', () => {
  const normalized = normalizeConfig(getDefaultConfig());
  assert.deepEqual(normalized.WebSearch, {
    EnabledDefault: true,
    Providers: {
      tavily: { Enabled: false, ApiKey: '' },
      firecrawl: { Enabled: false, ApiKey: '' },
    },
    ProviderOrder: ['tavily', 'firecrawl'],
    ResultCount: 5,
    FetchMaxPages: 3,
    TimeoutMs: 15000,
    FetchMaxCharacters: 12000,
  });
});

test('normalizeConfig clamps WebSearch bounds, trims keys, and repairs ProviderOrder', () => {
  const config = defaultConfigObject();
  config.WebSearch = {
    EnabledDefault: true,
    Providers: {
      tavily: { Enabled: true, ApiKey: '  t-key  ' },
      firecrawl: { Enabled: 'yes', ApiKey: 42 },
    },
    ProviderOrder: ['firecrawl', 'bing', 'firecrawl'],
    ResultCount: 99,
    FetchMaxPages: 0,
    TimeoutMs: 10,
    FetchMaxCharacters: 999999,
  };
  const normalized = normalizeConfig(JsonValueSchema.parse(config));
  assert.deepEqual(normalized.WebSearch, {
    EnabledDefault: true,
    Providers: {
      tavily: { Enabled: true, ApiKey: 't-key' },
      firecrawl: { Enabled: false, ApiKey: '' },
    },
    ProviderOrder: ['firecrawl', 'tavily'],
    ResultCount: 20,
    FetchMaxPages: 1,
    TimeoutMs: 1000,
    FetchMaxCharacters: 50000,
  });
});

test('normalizeConfig keeps Server.LlamaCpp as a presets-only shape', () => {
  const normalized = normalizeConfig(getDefaultConfig());
  const llama = normalized.Server.LlamaCpp;

  assert.deepEqual(Object.keys(llama).sort(), ['ActivePresetId', 'Presets']);
  assert.ok(Array.isArray(llama.Presets));
  assert.ok(llama.Presets.length >= 1);
});

test('normalizeConfig falls back an unknown ActivePresetId to the first preset', () => {
  const config = defaultConfigObject();
  asObject(asObject(config.Server).LlamaCpp).ActivePresetId = 'does-not-exist';

  const normalized = normalizeConfig(JsonValueSchema.parse(config));
  const llama = normalized.Server.LlamaCpp;

  assert.equal(llama.ActivePresetId, llama.Presets[0].id);
});

test('normalizeConfig accepts draft-mtp speculative decoding type', () => {
  const normalized = normalizeConfig(JsonValueSchema.parse(configWithSpeculativeType('draft-mtp')));

  assert.equal(activePreset(normalized).SpeculativeType, 'draft-mtp');
});

test('normalizeConfig falls back unknown speculative decoding type to ngram-map-k', () => {
  const normalized = normalizeConfig(JsonValueSchema.parse(configWithSpeculativeType('unknown-speculation')));

  assert.equal(activePreset(normalized).SpeculativeType, 'ngram-map-k');
});

test('normalizeConfig defaults the MTP combination and ngram-mod fields when absent', () => {
  const config = defaultConfigObject();
  const preset = activePresetObject(config);
  delete preset.SpeculativeMtpEnabled;
  delete preset.SpeculativeNgramModNMatch;
  delete preset.SpeculativeNgramModNMin;
  delete preset.SpeculativeNgramModNMax;

  const preset2 = activePreset(normalizeConfig(JsonValueSchema.parse(config)));

  assert.equal(preset2.SpeculativeMtpEnabled, false);
  assert.equal(preset2.SpeculativeNgramModNMatch, 24);
  assert.equal(preset2.SpeculativeNgramModNMin, 4);
  assert.equal(preset2.SpeculativeNgramModNMax, 16);
});

test('normalizeConfig preserves an enabled MTP combination with ngram-mod parameters', () => {
  const config = defaultConfigObject();
  Object.assign(activePresetObject(config), {
    SpeculativeType: 'ngram-mod',
    SpeculativeMtpEnabled: true,
    SpeculativeNgramModNMatch: 24,
    SpeculativeNgramModNMin: 12,
    SpeculativeNgramModNMax: 48,
  });

  const preset = activePreset(normalizeConfig(JsonValueSchema.parse(config)));

  assert.equal(preset.SpeculativeMtpEnabled, true);
  assert.equal(preset.SpeculativeNgramModNMatch, 24);
  assert.equal(preset.SpeculativeNgramModNMin, 12);
  assert.equal(preset.SpeculativeNgramModNMax, 48);
});

test('normalizeConfig returns the typed live config fields used by server and dashboard', () => {
  const normalized = normalizeConfig({
    IncludeAgentsMd: false,
    IncludeRepoFileListing: false,
    OperationModeAllowedTools: {
      summary: ['find_text'],
      'read-only': ['repo_rg'],
      full: [],
    },
    Presets: [{
      id: 'custom',
      label: 'Custom',
      description: 'Custom preset',
      presetKind: 'chat',
      operationMode: 'summary',
      promptPrefix: 'prefix',
      allowedTools: ['find_text'],
      surfaces: ['web'],
      useForSummary: false,
      builtin: false,
      deletable: true,
      includeAgentsMd: false,
      includeRepoFileListing: false,
      repoRootRequired: false,
      maxTurns: 4,
    }],
  });

  assert.equal(normalized.IncludeAgentsMd, false);
  assert.equal(normalized.IncludeRepoFileListing, false);
  assert.deepEqual(normalized.OperationModeAllowedTools.summary, ['find_text']);
  assert.ok(normalized.Presets.some((preset) => preset.id === 'custom'));
});
