import assert from 'node:assert/strict';
import test from 'node:test';

import { getDefaultConfig, normalizeConfig } from '../src/status-server/config-store';

type Dict = Record<string, unknown>;

function activePreset(config: unknown): Dict {
  const llama = ((config as Dict).Server as Dict).LlamaCpp as Dict;
  return (llama.Presets as Dict[])[0];
}

function configWithSpeculativeType(speculativeType: string): Dict {
  const config = getDefaultConfig() as Dict;
  activePreset(config).SpeculativeType = speculativeType;
  return config;
}

test('normalizeConfig produces default WebSearch config', () => {
  const normalized = normalizeConfig(getDefaultConfig());
  assert.deepEqual(normalized.WebSearch, {
    EnabledDefault: true,
    Provider: 'brave',
    BraveApiKey: '',
    ResultCount: 5,
    FetchMaxPages: 3,
    TimeoutMs: 15000,
    FetchMaxCharacters: 12000,
  });
});

test('normalizeConfig clamps WebSearch numeric bounds and forces provider', () => {
  const config = getDefaultConfig() as Dict;
  config.WebSearch = {
    EnabledDefault: true,
    Provider: 'other',
    BraveApiKey: '  lan-key  ',
    ResultCount: 99,
    FetchMaxPages: 0,
    TimeoutMs: 10,
    FetchMaxCharacters: 999999,
  };
  const normalized = normalizeConfig(config);
  assert.deepEqual(normalized.WebSearch, {
    EnabledDefault: true,
    Provider: 'brave',
    BraveApiKey: 'lan-key',
    ResultCount: 20,
    FetchMaxPages: 1,
    TimeoutMs: 1000,
    FetchMaxCharacters: 50000,
  });
});

test('normalizeConfig keeps Server.LlamaCpp as a presets-only shape', () => {
  const normalized = normalizeConfig(getDefaultConfig());
  const llama = (normalized.Server as Dict).LlamaCpp as Dict;

  assert.deepEqual(Object.keys(llama).sort(), ['ActivePresetId', 'Presets']);
  assert.ok(Array.isArray(llama.Presets));
  assert.ok((llama.Presets as Dict[]).length >= 1);
});

test('normalizeConfig falls back an unknown ActivePresetId to the first preset', () => {
  const config = getDefaultConfig() as Dict;
  ((config.Server as Dict).LlamaCpp as Dict).ActivePresetId = 'does-not-exist';

  const normalized = normalizeConfig(config);
  const llama = (normalized.Server as Dict).LlamaCpp as Dict;

  assert.equal(llama.ActivePresetId, (llama.Presets as Dict[])[0].id);
});

test('normalizeConfig accepts draft-mtp speculative decoding type', () => {
  const normalized = normalizeConfig(configWithSpeculativeType('draft-mtp'));

  assert.equal(activePreset(normalized).SpeculativeType, 'draft-mtp');
});

test('normalizeConfig falls back unknown speculative decoding type to ngram-map-k', () => {
  const normalized = normalizeConfig(configWithSpeculativeType('unknown-speculation'));

  assert.equal(activePreset(normalized).SpeculativeType, 'ngram-map-k');
});

test('normalizeConfig defaults the MTP combination and ngram-mod fields when absent', () => {
  const config = getDefaultConfig() as Dict;
  const preset = activePreset(config);
  delete preset.SpeculativeMtpEnabled;
  delete preset.SpeculativeNgramModNMatch;
  delete preset.SpeculativeNgramModNMin;
  delete preset.SpeculativeNgramModNMax;

  const preset2 = activePreset(normalizeConfig(config));

  assert.equal(preset2.SpeculativeMtpEnabled, false);
  assert.equal(preset2.SpeculativeNgramModNMatch, 24);
  assert.equal(preset2.SpeculativeNgramModNMin, 4);
  assert.equal(preset2.SpeculativeNgramModNMax, 16);
});

test('normalizeConfig preserves an enabled MTP combination with ngram-mod parameters', () => {
  const config = getDefaultConfig() as Dict;
  Object.assign(activePreset(config), {
    SpeculativeType: 'ngram-mod',
    SpeculativeMtpEnabled: true,
    SpeculativeNgramModNMatch: 24,
    SpeculativeNgramModNMin: 12,
    SpeculativeNgramModNMax: 48,
  });

  const preset = activePreset(normalizeConfig(config));

  assert.equal(preset.SpeculativeMtpEnabled, true);
  assert.equal(preset.SpeculativeNgramModNMatch, 24);
  assert.equal(preset.SpeculativeNgramModNMin, 12);
  assert.equal(preset.SpeculativeNgramModNMax, 48);
});
