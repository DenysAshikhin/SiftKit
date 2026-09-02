import type { DashboardConfig } from './types.js';

export function deriveRuntimeModelId(modelPath: string | null): string {
  const normalizedPath = String(modelPath || '').trim();
  if (!normalizedPath) {
    return '';
  }
  const lastSeparatorIndex = Math.max(normalizedPath.lastIndexOf('\\'), normalizedPath.lastIndexOf('/'));
  return lastSeparatorIndex >= 0 ? normalizedPath.slice(lastSeparatorIndex + 1) : normalizedPath;
}

export function syncDerivedSettingsFields(config: DashboardConfig): DashboardConfig {
  const presets = config.Server.ModelPresets.Presets;
  const activePreset = presets.find((preset) => preset.id === config.Server.ModelPresets.ActivePresetId)
    ?? presets[0];
  if (!activePreset) {
    return config;
  }
  config.Runtime.Engine.BaseUrl = activePreset.BaseUrl;
  config.Runtime.Engine.ModelPath = activePreset.ModelPath;
  config.Runtime.Engine.NumCtx = activePreset.NumCtx;
  config.Runtime.Engine.ParallelSlots = activePreset.ParallelSlots;
  config.Runtime.Engine.MaxTokens = activePreset.MaxTokens;
  config.Runtime.Engine.Temperature = activePreset.Temperature;
  config.Runtime.Engine.TopP = activePreset.TopP;
  config.Runtime.Engine.TopK = activePreset.TopK;
  config.Runtime.Engine.MinP = activePreset.MinP;
  config.Runtime.Engine.PresencePenalty = activePreset.PresencePenalty;
  config.Runtime.Engine.RepetitionPenalty = activePreset.RepetitionPenalty;
  config.Runtime.Engine.Reasoning = activePreset.Reasoning;

  const runtimeModelId = String(
    activePreset.Model || deriveRuntimeModelId(activePreset.ModelPath),
  ).trim();
  activePreset.Model = runtimeModelId;
  return config;
}
