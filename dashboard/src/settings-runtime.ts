import type { DashboardConfig } from './types';

export function deriveRuntimeModelId(modelPath: string | null): string {
  const normalizedPath = String(modelPath || '').trim();
  if (!normalizedPath) {
    return '';
  }
  const lastSeparatorIndex = Math.max(normalizedPath.lastIndexOf('\\'), normalizedPath.lastIndexOf('/'));
  return lastSeparatorIndex >= 0 ? normalizedPath.slice(lastSeparatorIndex + 1) : normalizedPath;
}

export function syncDerivedSettingsFields(config: DashboardConfig): DashboardConfig {
  const runtimeModelId = deriveRuntimeModelId(config.Runtime.LlamaCpp.ModelPath);
  config.Runtime.Model = runtimeModelId;
  config.Model = runtimeModelId;
  return config;
}
