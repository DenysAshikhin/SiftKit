import { PROMPT_COMPACTION_RESERVE_TOKENS } from '../lib/context-token-budget.js';
import { SIFT_DEFAULT_NUM_CTX } from './constants.js';
import type {
  InferenceBackendId,
  ModelRuntimePreset,
  RuntimeEngineConfig,
  SiftConfig,
} from './types.js';

const EMPTY_RUNTIME_ENGINE_CONFIG: RuntimeEngineConfig = {};

// The window a caller with no preset falls back to. Deliberately far below the
// default preset's window: it is a floor for previews, not a real serving size.
const PRESETLESS_CONTEXT_TOKENS = 32_000;

export function getDefaultNumCtx(): number {
  return SIFT_DEFAULT_NUM_CTX;
}

export function getRuntimeEngine(config: SiftConfig): RuntimeEngineConfig {
  return config.Runtime.Engine ?? EMPTY_RUNTIME_ENGINE_CONFIG;
}

export function getActiveModelPreset(config: SiftConfig): ModelRuntimePreset {
  const presets = config.Server.ModelPresets.Presets;
  const preset = presets.find((entry) => entry.id === config.Server.ModelPresets.ActivePresetId) ?? presets[0];
  if (!preset) throw new Error('Model preset list is empty.');
  return preset;
}

export function getActiveInferenceBackend(config: SiftConfig): InferenceBackendId {
  return getActiveModelPreset(config).Backend;
}

/** True when SiftKit launches and owns the engine process for the active preset. */
export function managesManagedEngineLifecycle(config: SiftConfig): boolean {
  return config.Server.Engines.Exl3.Managed && !getActiveModelPreset(config).ExternalServerEnabled;
}

export function getFinitePositiveNumber(value?: number | string | null): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

export function getConfiguredModel(config: SiftConfig): string {
  const model = getActiveModelPreset(config).Model;
  if (typeof model === 'string' && model.trim()) {
    return model.trim();
  }

  throw new Error('SiftKit runtime config is missing Model. Select a model on the active preset first.');
}

export function getConfiguredPromptPrefix(config: SiftConfig): string | undefined {
  const promptPrefix = config.PromptPrefix;
  return typeof promptPrefix === 'string' && promptPrefix.trim() ? promptPrefix : undefined;
}

export function getConfiguredEngineBaseUrl(config: SiftConfig): string {
  const baseUrl = getActiveModelPreset(config).BaseUrl;
  if (typeof baseUrl === 'string' && baseUrl.trim()) {
    return baseUrl.trim();
  }

  throw new Error('SiftKit runtime config is missing Engine.BaseUrl. Set BaseUrl on the active preset first.');
}

export function getConfiguredEngineNumCtx(config: SiftConfig): number {
  const numCtx = getFinitePositiveNumber(getActiveModelPreset(config).NumCtx);
  if (numCtx !== null) {
    return numCtx;
  }

  throw new Error('SiftKit runtime config is missing Engine.NumCtx. Set NumCtx on the active preset first.');
}

export function getConfiguredCompactionReserveTokens(config: SiftConfig): number {
  return getActiveModelPreset(config).CompactionReserveTokens;
}

/**
 * The window and compaction reserve a turn budget is built from. Callers that run
 * without a preset at all (mock loops, guidance previews) get a stand-in window so
 * they still produce a budget of the right shape.
 */
export function getConfiguredContextTokens(config?: SiftConfig | null): {
  totalContextTokens: number;
  compactionReserveTokens: number;
} {
  if (!config) {
    return {
      totalContextTokens: PRESETLESS_CONTEXT_TOKENS,
      compactionReserveTokens: PROMPT_COMPACTION_RESERVE_TOKENS,
    };
  }
  return {
    totalContextTokens: getConfiguredEngineNumCtx(config),
    compactionReserveTokens: getConfiguredCompactionReserveTokens(config),
  };
}

export function getConfiguredReasoning(config: SiftConfig): ModelRuntimePreset['Reasoning'] {
  return getActiveModelPreset(config).Reasoning;
}

export function getMissingRuntimeFields(config: SiftConfig): string[] {
  const missing: string[] = [];
  try {
    getConfiguredModel(config);
  } catch {
    missing.push('Model');
  }

  try {
    getConfiguredEngineBaseUrl(config);
  } catch {
    missing.push('Engine.BaseUrl');
  }

  try {
    getConfiguredEngineNumCtx(config);
  } catch {
    missing.push('Engine.NumCtx');
  }

  return missing;
}

export function isReadExpansionEnabled(config: SiftConfig | undefined): boolean {
  return config?.ExpandReads !== false;
}
