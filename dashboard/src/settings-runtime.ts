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
  config.Runtime.LlamaCpp.BaseUrl = config.Server.LlamaCpp.BaseUrl;
  config.Runtime.LlamaCpp.ModelPath = config.Server.LlamaCpp.ModelPath;
  config.Runtime.LlamaCpp.NumCtx = config.Server.LlamaCpp.NumCtx;
  config.Runtime.LlamaCpp.GpuLayers = config.Server.LlamaCpp.GpuLayers;
  config.Runtime.LlamaCpp.Threads = config.Server.LlamaCpp.Threads;
  config.Runtime.LlamaCpp.NcpuMoe = config.Server.LlamaCpp.NcpuMoe;
  config.Runtime.LlamaCpp.FlashAttention = config.Server.LlamaCpp.FlashAttention;
  config.Runtime.LlamaCpp.ParallelSlots = config.Server.LlamaCpp.ParallelSlots;
  config.Runtime.LlamaCpp.MaxTokens = config.Server.LlamaCpp.MaxTokens;
  config.Runtime.LlamaCpp.Temperature = config.Server.LlamaCpp.Temperature;
  config.Runtime.LlamaCpp.TopP = config.Server.LlamaCpp.TopP;
  config.Runtime.LlamaCpp.TopK = config.Server.LlamaCpp.TopK;
  config.Runtime.LlamaCpp.MinP = config.Server.LlamaCpp.MinP;
  config.Runtime.LlamaCpp.PresencePenalty = config.Server.LlamaCpp.PresencePenalty;
  config.Runtime.LlamaCpp.RepetitionPenalty = config.Server.LlamaCpp.RepetitionPenalty;
  config.Runtime.LlamaCpp.Reasoning = config.Server.LlamaCpp.Reasoning;
  config.LlamaCpp = { ...config.Runtime.LlamaCpp };

  const activePreset = config.Server.LlamaCpp.Presets.find(
    (preset) => preset.id === config.Server.LlamaCpp.ActivePresetId,
  );
  const runtimeModelId = String(
    deriveRuntimeModelId(config.Server.LlamaCpp.ModelPath)
    || activePreset?.Model
    || config.Server.LlamaCpp.Model,
  ).trim();
  config.Runtime.Model = runtimeModelId;
  config.Model = runtimeModelId;
  return config;
}
