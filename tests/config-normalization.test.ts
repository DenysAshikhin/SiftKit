import assert from 'node:assert/strict';
import test from 'node:test';

import { getDefaultConfigObject } from '../src/config/defaults';
import { normalizeConfig } from '../src/config/normalization';
import type { SiftConfig } from '../src/config/types';

function createSpeculativeTypeConfig(speculativeType: string): SiftConfig {
  const config = getDefaultConfigObject();
  config.Server ??= { LlamaCpp: {} };
  config.Server.LlamaCpp ??= {};
  config.Server.LlamaCpp.SpeculativeType = speculativeType as SiftConfig['Server']['LlamaCpp']['SpeculativeType'];
  if (config.Server.LlamaCpp.Presets?.[0]) {
    config.Server.LlamaCpp.Presets[0].SpeculativeType = speculativeType as SiftConfig['Server']['LlamaCpp']['SpeculativeType'];
  }
  return config;
}

test('normalizeConfig accepts draft-mtp speculative decoding type', () => {
  const { config } = normalizeConfig(createSpeculativeTypeConfig('draft-mtp'));

  assert.equal(config.Server?.LlamaCpp?.SpeculativeType, 'draft-mtp');
  assert.equal(config.Server?.LlamaCpp?.Presets?.[0]?.SpeculativeType, 'draft-mtp');
});

test('normalizeConfig falls back unknown speculative decoding type to ngram-map-k', () => {
  const { config } = normalizeConfig(createSpeculativeTypeConfig('unknown-speculation'));

  assert.equal(config.Server?.LlamaCpp?.SpeculativeType, 'ngram-map-k');
  assert.equal(config.Server?.LlamaCpp?.Presets?.[0]?.SpeculativeType, 'ngram-map-k');
});

test('normalizeConfig defaults the MTP combination and ngram-mod fields when absent', () => {
  const config = getDefaultConfigObject();
  config.Server ??= { LlamaCpp: {} };
  config.Server.LlamaCpp ??= {};
  delete config.Server.LlamaCpp.SpeculativeMtpEnabled;
  if (config.Server.LlamaCpp.Presets?.[0]) {
    delete config.Server.LlamaCpp.Presets[0].SpeculativeMtpEnabled;
    delete config.Server.LlamaCpp.Presets[0].SpeculativeNgramModNMatch;
    delete config.Server.LlamaCpp.Presets[0].SpeculativeNgramModNMin;
    delete config.Server.LlamaCpp.Presets[0].SpeculativeNgramModNMax;
  }

  const { config: normalized } = normalizeConfig(config);
  const preset = normalized.Server?.LlamaCpp?.Presets?.[0];

  assert.equal(preset?.SpeculativeMtpEnabled, false);
  assert.equal(preset?.SpeculativeNgramModNMatch, 24);
  assert.equal(preset?.SpeculativeNgramModNMin, 4);
  assert.equal(preset?.SpeculativeNgramModNMax, 16);
});

test('normalizeConfig preserves an enabled MTP combination with ngram-mod parameters', () => {
  const config = getDefaultConfigObject();
  config.Server ??= { LlamaCpp: {} };
  config.Server.LlamaCpp ??= {};
  if (config.Server.LlamaCpp.Presets?.[0]) {
    config.Server.LlamaCpp.Presets[0].SpeculativeType = 'ngram-mod';
    config.Server.LlamaCpp.Presets[0].SpeculativeMtpEnabled = true;
    config.Server.LlamaCpp.Presets[0].SpeculativeNgramModNMatch = 24;
    config.Server.LlamaCpp.Presets[0].SpeculativeNgramModNMin = 12;
    config.Server.LlamaCpp.Presets[0].SpeculativeNgramModNMax = 48;
  }

  const { config: normalized } = normalizeConfig(config);
  const preset = normalized.Server?.LlamaCpp?.Presets?.[0];

  assert.equal(preset?.SpeculativeMtpEnabled, true);
  assert.equal(preset?.SpeculativeNgramModNMatch, 24);
  assert.equal(preset?.SpeculativeNgramModNMin, 12);
  assert.equal(preset?.SpeculativeNgramModNMax, 48);
});
