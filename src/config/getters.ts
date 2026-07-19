import { SIFT_DEFAULT_NUM_CTX, type RuntimeOwnedLlamaCppKey } from './constants.js';
import type {
  Exl3Profile,
  InferenceBackendId,
  RuntimeLlamaCppConfig,
  ServerManagedLlamaPreset,
  SiftConfig,
} from './types.js';

const EMPTY_RUNTIME_LLAMA_CPP_CONFIG: RuntimeLlamaCppConfig = {};

export function getDefaultNumCtx(): number {
  return SIFT_DEFAULT_NUM_CTX;
}

export function getSelectedBackend(config: SiftConfig): InferenceBackendId {
  return config.Inference.SelectedBackend;
}

export function getLlamaProfile(config: SiftConfig): ServerManagedLlamaPreset | undefined {
  return getActiveManagedLlamaPreset(config);
}

export function getExl3Profile(config: SiftConfig): Exl3Profile {
  return config.Server.Exl3;
}

export function getRuntimeLlamaCpp(config: SiftConfig): RuntimeLlamaCppConfig {
  return config.Runtime?.LlamaCpp ?? EMPTY_RUNTIME_LLAMA_CPP_CONFIG;
}

export function getActiveManagedLlamaPreset(config: SiftConfig): ServerManagedLlamaPreset | undefined {
  const serverLlama = config.Server?.LlamaCpp;
  const presets = Array.isArray(serverLlama?.Presets) ? serverLlama.Presets : [];
  return presets.find((preset) => preset.id === serverLlama?.ActivePresetId) ?? presets[0];
}

export function getFinitePositiveNumber(value?: number | string | null): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

export function getConfiguredModel(config: SiftConfig): string {
  const model = config.Runtime?.Model;
  if (typeof model === 'string' && model.trim()) {
    return model.trim();
  }

  throw new Error('SiftKit runtime config is missing Model. Start a launcher script first.');
}

export function getConfiguredPromptPrefix(config: SiftConfig): string | undefined {
  const promptPrefix = config.PromptPrefix;
  return typeof promptPrefix === 'string' && promptPrefix.trim() ? promptPrefix : undefined;
}

export function getConfiguredLlamaBaseUrl(config: SiftConfig): string {
  const baseUrl = getRuntimeLlamaCpp(config).BaseUrl;
  if (typeof baseUrl === 'string' && baseUrl.trim()) {
    return baseUrl.trim();
  }

  throw new Error('SiftKit runtime config is missing LlamaCpp.BaseUrl. Start a launcher script first.');
}

export function getConfiguredLlamaNumCtx(config: SiftConfig): number {
  const numCtx = getFinitePositiveNumber(getRuntimeLlamaCpp(config).NumCtx);
  if (numCtx !== null) {
    return numCtx;
  }

  throw new Error('SiftKit runtime config is missing LlamaCpp.NumCtx. Start a launcher script first.');
}

export function getConfiguredLlamaSetting<TValue>(
  config: SiftConfig | undefined,
  key: RuntimeOwnedLlamaCppKey
): TValue | undefined;
export function getConfiguredLlamaSetting(
  config: SiftConfig | undefined,
  key: RuntimeOwnedLlamaCppKey
): RuntimeLlamaCppConfig[RuntimeOwnedLlamaCppKey] | undefined {
  if (!config) {
    return undefined;
  }
  const runtimeValue = getRuntimeLlamaCpp(config)[key];
  return (runtimeValue === undefined || runtimeValue === null) ? undefined : runtimeValue;
}

export function getMissingRuntimeFields(config: SiftConfig): string[] {
  const missing: string[] = [];
  try {
    getConfiguredModel(config);
  } catch {
    missing.push('Model');
  }

  try {
    getConfiguredLlamaBaseUrl(config);
  } catch {
    missing.push('LlamaCpp.BaseUrl');
  }

  try {
    getConfiguredLlamaNumCtx(config);
  } catch {
    missing.push('LlamaCpp.NumCtx');
  }

  return missing;
}
