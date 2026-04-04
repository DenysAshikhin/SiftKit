import { SIFT_DEFAULT_NUM_CTX, type RuntimeOwnedLlamaCppKey } from './constants.js';
import type { RuntimeLlamaCppConfig, SiftConfig } from './types.js';

export function getDefaultNumCtx(): number {
  return SIFT_DEFAULT_NUM_CTX;
}

export function getCompatRuntimeLlamaCpp(config: SiftConfig): RuntimeLlamaCppConfig {
  return config.Runtime?.LlamaCpp ?? config.LlamaCpp ?? {};
}

export function getFinitePositiveNumber(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

export function getConfiguredModel(config: SiftConfig): string {
  const model = config.Runtime?.Model ?? config.Model;
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
  const baseUrl = getCompatRuntimeLlamaCpp(config).BaseUrl;
  if (typeof baseUrl === 'string' && baseUrl.trim()) {
    return baseUrl.trim();
  }

  throw new Error('SiftKit runtime config is missing LlamaCpp.BaseUrl. Start a launcher script first.');
}

export function getConfiguredLlamaNumCtx(config: SiftConfig): number {
  const numCtx = getFinitePositiveNumber(getCompatRuntimeLlamaCpp(config).NumCtx);
  if (numCtx !== null) {
    return numCtx;
  }

  throw new Error('SiftKit runtime config is missing LlamaCpp.NumCtx. Start a launcher script first.');
}

export function getConfiguredLlamaSetting<T>(
  config: SiftConfig,
  key: RuntimeOwnedLlamaCppKey
): T | undefined {
  const runtimeValue = getCompatRuntimeLlamaCpp(config)[key];
  return (runtimeValue === undefined || runtimeValue === null) ? undefined : runtimeValue as T;
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
