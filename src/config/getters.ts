import { SIFT_DEFAULT_NUM_CTX } from './constants.js';
import type {
  InferenceBackendId,
  ModelRuntimePreset,
  RuntimeLlamaCppConfig,
  SiftConfig,
} from './types.js';

const EMPTY_RUNTIME_LLAMA_CPP_CONFIG: RuntimeLlamaCppConfig = {};

export function getDefaultNumCtx(): number {
  return SIFT_DEFAULT_NUM_CTX;
}

export function getRuntimeLlamaCpp(config: SiftConfig): RuntimeLlamaCppConfig {
  return config.Runtime.LlamaCpp ?? EMPTY_RUNTIME_LLAMA_CPP_CONFIG;
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

export function getFinitePositiveNumber(value?: number | string | null): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

export function getConfiguredModel(config: SiftConfig): string {
  const model = getActiveModelPreset(config).Model;
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
  const activePreset = getActiveModelPreset(config);
  const baseUrl = activePreset.Backend === 'exl3'
    ? activePreset.BaseUrl
    : getRuntimeLlamaCpp(config).BaseUrl ?? activePreset.BaseUrl;
  if (typeof baseUrl === 'string' && baseUrl.trim()) {
    return baseUrl.trim();
  }

  throw new Error('SiftKit runtime config is missing LlamaCpp.BaseUrl. Start a launcher script first.');
}

export function getConfiguredLlamaNumCtx(config: SiftConfig): number {
  const activePreset = getActiveModelPreset(config);
  const numCtx = getFinitePositiveNumber(
    activePreset.Backend === 'exl3'
      ? activePreset.NumCtx
      : getRuntimeLlamaCpp(config).NumCtx ?? activePreset.NumCtx,
  );
  if (numCtx !== null) {
    return numCtx;
  }

  throw new Error('SiftKit runtime config is missing LlamaCpp.NumCtx. Start a launcher script first.');
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
