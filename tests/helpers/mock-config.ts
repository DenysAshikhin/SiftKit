import { JsonValueSchema, isJsonObject, type JsonValue, type OptionalJsonValue } from '../../src/lib/json-types.js';
import { SiftConfigSchema } from '@siftkit/contracts';
import type { ModelRuntimePreset, SiftConfig } from '../../src/config/types.js';
import type { WebSearchConfig } from '../../src/web-search/types.js';
import { getDefaultConfigObject } from '../../src/config/defaults.js';
import { getActiveModelPreset } from '../../src/config/getters.js';
import { getDefaultConfig } from '../../src/status-server/config-store.js';
import { mergeConfig, normalizeConfigObject } from '../../src/config/normalization.js';
import { DEAD_BASE_URL } from './dead-endpoints.js';

// Partial fixture inputs are completed with defaults and validated at runtime.
type DeepPartial<T> = T extends (infer U)[]
  ? DeepPartial<U>[]
  : T extends object
    ? { [K in keyof T]?: DeepPartial<T[K]> }
    : T;

/** The default preset names no model; fixtures need one so `getConfiguredModel` resolves. */
export const MOCK_MODEL_ID = 'mock-model';

/**
 * Each entry of a partial `Server.ModelPresets.Presets` is merged over the default preset (plus
 * `MOCK_MODEL_ID`) instead of replacing the whole array, so a fixture can name only the fields
 * it exercises, e.g. `{ Server: { ModelPresets: { Presets: [{ BaseUrl }] } } }`.
 */
export function mockSiftConfig(partial: DeepPartial<SiftConfig> = {}): SiftConfig {
  const base = JsonValueSchema.parse(getDefaultConfigObject());
  const basePreset = JsonValueSchema.parse(mockModelPreset());
  const partialJson = JsonValueSchema.parse(partial);
  const presetPartials = readPresetPartials(partialJson);
  const presets = (presetPartials.length > 0 ? presetPartials : [{}])
    .map((entry) => mergeConfig(basePreset, entry));
  const withPresets = mergeConfig(partialJson, { Server: { ModelPresets: { Presets: presets } } });
  return normalizeConfigObject(mergeConfig(base, withPresets));
}

/**
 * The production default config for server fixtures: identical to `getDefaultConfig()` except the
 * active preset names `MOCK_MODEL_ID`, so chat sessions and inference resolve a model.
 */
export function getDefaultServerConfig(): SiftConfig {
  const config = getDefaultConfig();
  getActiveModelPreset(config).Model = MOCK_MODEL_ID;
  return config;
}

function readPresetPartials(partial: JsonValue): JsonValue[] {
  const server = isJsonObject(partial) ? partial.Server : undefined;
  const modelPresets = isJsonObject(server) ? server.ModelPresets : undefined;
  const presets = isJsonObject(modelPresets) ? modelPresets.Presets : undefined;
  return Array.isArray(presets) ? presets : [];
}

export function mockOfflineSiftConfig(): SiftConfig {
  return mockSiftConfig({ Server: { ModelPresets: { Presets: [{ BaseUrl: DEAD_BASE_URL }] } } });
}

// A fully-populated ModelRuntimePreset for fixtures that need a preset snapshot
// (chat sessions) rather than a whole config. Starts from the normalized default
// preset so every required field is present.
export function mockModelPreset(overrides: Partial<ModelRuntimePreset> = {}): ModelRuntimePreset {
  const preset = getDefaultConfigObject().Server.ModelPresets.Presets[0];
  if (!preset) {
    throw new Error('Default config has no model preset.');
  }
  return { ...preset, Model: MOCK_MODEL_ID, ...overrides };
}

// Validate an already-constructed runtime config object (e.g. a stub server's
// live config, or a clone with a few overridden fields) at one boundary.
export function asRuntimeSiftConfig(value: OptionalJsonValue): SiftConfig {
  return SiftConfigSchema.parse(value);
}

// The single copies of the WebSearch fixture shapes: enabled-but-providerless by
// default, and the tavily-usable variant web-exercising fixtures need to clear the
// web tool policy.
export function buildWebSearchConfig(overrides: Partial<WebSearchConfig> = {}): WebSearchConfig {
  return {
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
    ...overrides,
  };
}

export function usableWebSearchConfig(): WebSearchConfig {
  return buildWebSearchConfig({
    Providers: {
      tavily: { Enabled: true, ApiKey: 'test-key' },
      firecrawl: { Enabled: false, ApiKey: '' },
    },
  });
}
