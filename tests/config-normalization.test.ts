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

test('normalizeConfig accepts mtp speculative decoding type', () => {
  const { config } = normalizeConfig(createSpeculativeTypeConfig('mtp'));

  assert.equal(config.Server?.LlamaCpp?.SpeculativeType, 'mtp');
  assert.equal(config.Server?.LlamaCpp?.Presets?.[0]?.SpeculativeType, 'mtp');
});

test('normalizeConfig falls back unknown speculative decoding type to ngram-map-k', () => {
  const { config } = normalizeConfig(createSpeculativeTypeConfig('unknown-speculation'));

  assert.equal(config.Server?.LlamaCpp?.SpeculativeType, 'ngram-map-k');
  assert.equal(config.Server?.LlamaCpp?.Presets?.[0]?.SpeculativeType, 'ngram-map-k');
});
