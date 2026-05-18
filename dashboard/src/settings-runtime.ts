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
  const presets = config.Server.LlamaCpp.Presets;
  const activePreset = presets.find((preset) => preset.id === config.Server.LlamaCpp.ActivePresetId)
    ?? presets[0];
  if (!activePreset) {
    return config;
  }
  config.Runtime.LlamaCpp.BaseUrl = activePreset.BaseUrl;
  config.Runtime.LlamaCpp.ModelPath = activePreset.ModelPath;
  config.Runtime.LlamaCpp.NumCtx = activePreset.NumCtx;
  config.Runtime.LlamaCpp.GpuLayers = activePreset.GpuLayers;
  config.Runtime.LlamaCpp.Threads = activePreset.Threads;
  config.Runtime.LlamaCpp.NcpuMoe = activePreset.NcpuMoe;
  config.Runtime.LlamaCpp.FlashAttention = activePreset.FlashAttention;
  config.Runtime.LlamaCpp.ParallelSlots = activePreset.ParallelSlots;
  config.Runtime.LlamaCpp.MaxTokens = activePreset.MaxTokens;
  config.Runtime.LlamaCpp.Temperature = activePreset.Temperature;
  config.Runtime.LlamaCpp.TopP = activePreset.TopP;
  config.Runtime.LlamaCpp.TopK = activePreset.TopK;
  config.Runtime.LlamaCpp.MinP = activePreset.MinP;
  config.Runtime.LlamaCpp.PresencePenalty = activePreset.PresencePenalty;
  config.Runtime.LlamaCpp.RepetitionPenalty = activePreset.RepetitionPenalty;
  config.Runtime.LlamaCpp.Reasoning = activePreset.Reasoning;
  config.Runtime.LlamaCpp.ReasoningContent = activePreset.ReasoningContent;
  config.Runtime.LlamaCpp.PreserveThinking = activePreset.PreserveThinking;
  config.LlamaCpp = { ...config.Runtime.LlamaCpp };

  const runtimeModelId = String(
    activePreset.Model || deriveRuntimeModelId(activePreset.ModelPath),
  ).trim();
  config.Runtime.Model = runtimeModelId;
  config.Model = runtimeModelId;
  return config;
}
