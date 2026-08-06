import assert from 'node:assert/strict';
import test from 'node:test';

import { getDefaultConfig, normalizeConfig, normalizeWebSearchConfig } from '../src/status-server/config-store';
import { isReadExpansionEnabled } from '../src/config/index';
import { SIFT_DEFAULT_EXL3_RECURRENT_CACHE_RAM, SIFT_DEFAULT_LLAMA_CACHE_RAM } from '../src/config/constants';
import { JsonValueSchema, type JsonObject } from '../src/lib/json-types';
import type { SiftConfig, ModelRuntimePreset } from '../src/config/types';
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
function activePreset(config: SiftConfig): ModelRuntimePreset {
  return config.Server.ModelPresets.Presets[0];
}

// Mutable JSON view of the active preset, for tests that inject invalid values.
function activePresetObject(config: JsonObject): JsonObject {
  const modelPresets = asObject(asObject(config.Server).ModelPresets);
  return asObjectArray(modelPresets.Presets)[0];
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

test('normalization rejects removed global and backend-specific configuration shapes', () => {
  const defaults = defaultConfigObject();
  assert.throws(
    () => normalizeConfig(JsonValueSchema.parse({
      ...defaults,
      Inference: { SelectedBackend: 'exl3', Thinking: { Enabled: false, Preserve: false } },
    })),
    /Unsupported configuration field Inference\.SelectedBackend; select Backend on each model preset\./u,
  );
  assert.throws(
    () => normalizeConfig(JsonValueSchema.parse({
      ...defaults,
      Server: { ...asObject(defaults.Server), LlamaCpp: {} },
    })),
    /Unsupported configuration field Server\.LlamaCpp; use Server\.ModelPresets\./u,
  );
  assert.throws(
    () => normalizeConfig(JsonValueSchema.parse({
      ...defaults,
      Runtime: { ...asObject(defaults.Runtime), Model: 'legacy-model' },
    })),
    /Unsupported configuration field Runtime\.Model; use the active model preset/u,
  );
  assert.throws(
    () => normalizeConfig(JsonValueSchema.parse({
      ...defaults,
      Server: { ...asObject(defaults.Server), Exl3: {} },
    })),
    /Unsupported configuration field Server\.Exl3; use Server\.Engines\.Exl3\./u,
  );
  const withPenaltyRange = defaultConfigObject();
  activePresetObject(withPenaltyRange).PenaltyRange = 2_048;
  assert.throws(
    () => normalizeConfig(JsonValueSchema.parse(withPenaltyRange)),
    /Unsupported model preset field PenaltyRange; it is not part of ModelPresetFieldSchema\./u,
  );
});

test('new default config supplies the default preset backend and EXL3 engine', () => {
  const normalized = getDefaultConfig();
  const serialized = JSON.stringify(normalized);

  assert.match(serialized, /"Backend":"llama"/u);
  assert.match(serialized, /"WorkingDirectory":"C:\\\\Users\\\\denys\\\\Documents\\\\GitHub\\\\TabbyAPI"/u);
  assert.match(serialized, /"PythonPath":"C:\\\\envs\\\\rl313\\\\Scripts\\\\python\.exe"/u);
  assert.match(serialized, /"ModelRoot":"D:\\\\personal\\\\models\\\\elx3"/u);
  assert.equal(normalized.Server.Engines.Exl3.AdminApiKey, '');
});

test('normalizeConfig rejects a missing or legacy preset catalog at the Presets path', () => {
  assert.throws(
    () => normalizeConfig({}),
    /"Presets"/u,
  );

  const config = defaultConfigObject();
  const presets = asObjectArray(config.Presets);
  const removedField = ['execution', 'Family'].join('');
  presets[0] = { ...presets[0], [removedField]: 'summary' };
  config.Presets = presets;
  let errorMessage = '';
  try {
    normalizeConfig(JsonValueSchema.parse(config));
  } catch (error) {
    errorMessage = error instanceof Error ? error.message : String(error);
  }
  assert.match(errorMessage, new RegExp(removedField, 'u'));
  assert.match(errorMessage, /"Presets"/u);
});

test('normalizeConfig trims the EXL3 admin API key', () => {
  const config = defaultConfigObject();
  const server = asObject(config.Server);
  const engines = asObject(server.Engines);
  const exl3 = asObject(engines.Exl3);
  exl3.AdminApiKey = '  secret  ';

  assert.equal(normalizeConfig(JsonValueSchema.parse(config)).Server.Engines.Exl3.AdminApiKey, 'secret');
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

test('normalizeConfig keeps Server.ModelPresets as a presets-only shape', () => {
  const normalized = normalizeConfig(getDefaultConfig());
  const llama = normalized.Server.ModelPresets;

  assert.deepEqual(Object.keys(llama).sort(), ['ActivePresetId', 'Presets']);
  assert.ok(Array.isArray(llama.Presets));
  assert.ok(llama.Presets.length >= 1);
});

test('normalizeConfig falls back an unknown ActivePresetId to the first preset', () => {
  const config = defaultConfigObject();
  asObject(asObject(config.Server).ModelPresets).ActivePresetId = 'does-not-exist';

  const normalized = normalizeConfig(JsonValueSchema.parse(config));
  const llama = normalized.Server.ModelPresets;

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
  const defaults = defaultConfigObject();
  const summary = asObjectArray(defaults.Presets)[0];
  const normalized = normalizeConfig({
    ...defaults,
    OperationModeAllowedTools: {
      summary: ['find_text'],
      'read-only': ['grep'],
      full: [],
    },
    Presets: [
      ...asObjectArray(defaults.Presets),
      {
        ...summary,
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
        autoloadFiles: ['docs/policy.md'],
        repoRootRequired: false,
        maxTurns: 4,
      },
    ],
  });

  assert.equal(Object.hasOwn(normalized, 'IncludeAgentsMd'), false);
  assert.equal(Object.hasOwn(normalized, 'IncludeRepoFileListing'), false);
  assert.deepEqual(normalized.OperationModeAllowedTools.summary, ['find_text']);
  const customPreset = normalized.Presets.find((preset) => preset.id === 'custom');
  assert.ok(customPreset);
  assert.deepEqual(customPreset.autoloadFiles, ['docs/policy.md']);
});

test('default config exposes ExpandReads enabled and normalization preserves an explicit false', () => {
  const defaults = getDefaultConfig();
  assert.equal(defaults.ExpandReads, true);

  const disabled = normalizeConfig({ ...defaults, ExpandReads: false });
  assert.equal(disabled.ExpandReads, false);

  const reEnabled = normalizeConfig({ ...defaults, ExpandReads: true });
  assert.equal(reEnabled.ExpandReads, true);
});

test('isReadExpansionEnabled defaults on and honors an explicit false', () => {
  const enabled = getDefaultConfig();
  assert.equal(isReadExpansionEnabled(enabled), true);
  assert.equal(isReadExpansionEnabled({ ...enabled, ExpandReads: false }), false);
  assert.equal(isReadExpansionEnabled(undefined), true);
});

test('cache RAM fields preserve zero and reject negative, fractional, and invalid values', () => {
  const cases = [
    { value: 0, expected: 0 },
    { value: 4096, expected: 4096 },
    { value: -1, expected: SIFT_DEFAULT_LLAMA_CACHE_RAM },
    { value: 1.5, expected: SIFT_DEFAULT_LLAMA_CACHE_RAM },
    { value: 'invalid', expected: SIFT_DEFAULT_LLAMA_CACHE_RAM },
  ] as const;

  for (const { value, expected } of cases) {
    const config = defaultConfigObject();
    activePresetObject(config).CacheRam = value;
    const preset = activePreset(normalizeConfig(JsonValueSchema.parse(config)));
    assert.equal(preset.CacheRam, expected, `CacheRam=${JSON.stringify(value)} should normalize to ${expected}`);
  }

  const recurrentCases = [
    { value: 0, expected: 0 },
    { value: 4096, expected: 4096 },
    { value: -1, expected: SIFT_DEFAULT_EXL3_RECURRENT_CACHE_RAM },
    { value: 1.5, expected: SIFT_DEFAULT_EXL3_RECURRENT_CACHE_RAM },
    { value: 'invalid', expected: SIFT_DEFAULT_EXL3_RECURRENT_CACHE_RAM },
  ] as const;

  for (const { value, expected } of recurrentCases) {
    const config = defaultConfigObject();
    activePresetObject(config).CacheRecurrentRam = value;
    const preset = activePreset(normalizeConfig(JsonValueSchema.parse(config)));
    assert.equal(preset.CacheRecurrentRam, expected, `CacheRecurrentRam=${JSON.stringify(value)} should normalize to ${expected}`);
  }
});

test('VisionEnabled defaults to false and schema accepts true', () => {
  const normalized = normalizeConfig(getDefaultConfig());
  const preset = activePreset(normalized);

  assert.equal(preset.VisionEnabled, false);

  const config = defaultConfigObject();
  activePresetObject(config).VisionEnabled = true;
  const enabled = activePreset(normalizeConfig(JsonValueSchema.parse(config)));
  assert.equal(enabled.VisionEnabled, true);

  activePresetObject(config).VisionEnabled = 1;
  const truthy = activePreset(normalizeConfig(JsonValueSchema.parse(config)));
  assert.equal(truthy.VisionEnabled, true);
});
