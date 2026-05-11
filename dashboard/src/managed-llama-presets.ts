import type { DashboardConfig, DashboardManagedLlamaPreset } from './types';
import { deriveRuntimeModelId, syncDerivedSettingsFields } from './settings-runtime';

function createPresetIdFromLabel(label: string): string {
  const normalized = String(label || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/^-+|-+$/gu, '');
  return normalized || 'preset';
}

function buildPresetFromServer(config: DashboardConfig): DashboardManagedLlamaPreset {
  const model = deriveRuntimeModelId(config.Server.LlamaCpp.ModelPath) || config.Runtime.Model;
  return {
    id: 'default',
    label: 'Default',
    Model: model,
    ExternalServerEnabled: config.Server.LlamaCpp.ExternalServerEnabled,
    ExecutablePath: config.Server.LlamaCpp.ExecutablePath,
    BaseUrl: config.Server.LlamaCpp.BaseUrl,
    BindHost: config.Server.LlamaCpp.BindHost,
    Port: config.Server.LlamaCpp.Port,
    ModelPath: config.Server.LlamaCpp.ModelPath,
    NumCtx: config.Server.LlamaCpp.NumCtx,
    GpuLayers: config.Server.LlamaCpp.GpuLayers,
    Threads: config.Server.LlamaCpp.Threads,
    NcpuMoe: config.Server.LlamaCpp.NcpuMoe,
    FlashAttention: config.Server.LlamaCpp.FlashAttention,
    ParallelSlots: config.Server.LlamaCpp.ParallelSlots,
    BatchSize: config.Server.LlamaCpp.BatchSize,
    UBatchSize: config.Server.LlamaCpp.UBatchSize,
    CacheRam: config.Server.LlamaCpp.CacheRam,
    KvCacheQuantization: config.Server.LlamaCpp.KvCacheQuantization,
    MaxTokens: config.Server.LlamaCpp.MaxTokens,
    Temperature: config.Server.LlamaCpp.Temperature,
    TopP: config.Server.LlamaCpp.TopP,
    TopK: config.Server.LlamaCpp.TopK,
    MinP: config.Server.LlamaCpp.MinP,
    PresencePenalty: config.Server.LlamaCpp.PresencePenalty,
    RepetitionPenalty: config.Server.LlamaCpp.RepetitionPenalty,
    Reasoning: config.Server.LlamaCpp.Reasoning,
    ReasoningContent: config.Server.LlamaCpp.ReasoningContent,
    PreserveThinking: config.Server.LlamaCpp.PreserveThinking,
    SpeculativeEnabled: config.Server.LlamaCpp.SpeculativeEnabled,
    SpeculativeType: config.Server.LlamaCpp.SpeculativeType,
    SpeculativeNgramSizeN: config.Server.LlamaCpp.SpeculativeNgramSizeN,
    SpeculativeNgramSizeM: config.Server.LlamaCpp.SpeculativeNgramSizeM,
    SpeculativeNgramMinHits: config.Server.LlamaCpp.SpeculativeNgramMinHits,
    SpeculativeDraftMax: config.Server.LlamaCpp.SpeculativeDraftMax,
    SpeculativeDraftMin: config.Server.LlamaCpp.SpeculativeDraftMin,
    ReasoningBudget: config.Server.LlamaCpp.ReasoningBudget,
    ReasoningBudgetMessage: config.Server.LlamaCpp.ReasoningBudgetMessage,
    StartupTimeoutMs: config.Server.LlamaCpp.StartupTimeoutMs,
    HealthcheckTimeoutMs: config.Server.LlamaCpp.HealthcheckTimeoutMs,
    HealthcheckIntervalMs: config.Server.LlamaCpp.HealthcheckIntervalMs,
    SleepIdleSeconds: config.Server.LlamaCpp.SleepIdleSeconds,
    VerboseLogging: config.Server.LlamaCpp.VerboseLogging,
  };
}

function ensureManagedLlamaPresets(config: DashboardConfig): DashboardManagedLlamaPreset[] {
  if (config.Server.LlamaCpp.Presets.length > 0) {
    return config.Server.LlamaCpp.Presets;
  }
  const fallbackPreset = buildPresetFromServer(config);
  config.Server.LlamaCpp.Presets = [fallbackPreset];
  config.Server.LlamaCpp.ActivePresetId = fallbackPreset.id;
  return config.Server.LlamaCpp.Presets;
}

function copyPresetToServer(config: DashboardConfig, preset: DashboardManagedLlamaPreset): void {
  const model = deriveRuntimeModelId(preset.ModelPath) || preset.Model;
  preset.Model = model;
  config.Server.LlamaCpp.Model = model;
  config.Server.LlamaCpp.ExternalServerEnabled = preset.ExternalServerEnabled;
  config.Server.LlamaCpp.ExecutablePath = preset.ExecutablePath;
  config.Server.LlamaCpp.BaseUrl = preset.BaseUrl;
  config.Server.LlamaCpp.BindHost = preset.BindHost;
  config.Server.LlamaCpp.Port = preset.Port;
  config.Server.LlamaCpp.ModelPath = preset.ModelPath;
  config.Server.LlamaCpp.NumCtx = preset.NumCtx;
  config.Server.LlamaCpp.GpuLayers = preset.GpuLayers;
  config.Server.LlamaCpp.Threads = preset.Threads;
  config.Server.LlamaCpp.NcpuMoe = preset.NcpuMoe;
  config.Server.LlamaCpp.FlashAttention = preset.FlashAttention;
  config.Server.LlamaCpp.ParallelSlots = preset.ParallelSlots;
  config.Server.LlamaCpp.BatchSize = preset.BatchSize;
  config.Server.LlamaCpp.UBatchSize = preset.UBatchSize;
  config.Server.LlamaCpp.CacheRam = preset.CacheRam;
  config.Server.LlamaCpp.KvCacheQuantization = preset.KvCacheQuantization;
  config.Server.LlamaCpp.MaxTokens = preset.MaxTokens;
  config.Server.LlamaCpp.Temperature = preset.Temperature;
  config.Server.LlamaCpp.TopP = preset.TopP;
  config.Server.LlamaCpp.TopK = preset.TopK;
  config.Server.LlamaCpp.MinP = preset.MinP;
  config.Server.LlamaCpp.PresencePenalty = preset.PresencePenalty;
  config.Server.LlamaCpp.RepetitionPenalty = preset.RepetitionPenalty;
  config.Server.LlamaCpp.Reasoning = preset.Reasoning;
  config.Server.LlamaCpp.ReasoningContent = preset.ReasoningContent;
  config.Server.LlamaCpp.PreserveThinking = preset.PreserveThinking;
  config.Server.LlamaCpp.SpeculativeEnabled = preset.SpeculativeEnabled;
  config.Server.LlamaCpp.SpeculativeType = preset.SpeculativeType;
  config.Server.LlamaCpp.SpeculativeNgramSizeN = preset.SpeculativeNgramSizeN;
  config.Server.LlamaCpp.SpeculativeNgramSizeM = preset.SpeculativeNgramSizeM;
  config.Server.LlamaCpp.SpeculativeNgramMinHits = preset.SpeculativeNgramMinHits;
  config.Server.LlamaCpp.SpeculativeDraftMax = preset.SpeculativeDraftMax;
  config.Server.LlamaCpp.SpeculativeDraftMin = preset.SpeculativeDraftMin;
  config.Server.LlamaCpp.ReasoningBudget = preset.ReasoningBudget;
  config.Server.LlamaCpp.ReasoningBudgetMessage = preset.ReasoningBudgetMessage;
  config.Server.LlamaCpp.StartupTimeoutMs = preset.StartupTimeoutMs;
  config.Server.LlamaCpp.HealthcheckTimeoutMs = preset.HealthcheckTimeoutMs;
  config.Server.LlamaCpp.HealthcheckIntervalMs = preset.HealthcheckIntervalMs;
  config.Server.LlamaCpp.SleepIdleSeconds = preset.SleepIdleSeconds;
  config.Server.LlamaCpp.VerboseLogging = preset.VerboseLogging;
}

function getUniqueManagedLlamaPresetId(
  presets: DashboardManagedLlamaPreset[],
  label: string,
): string {
  const baseId = createPresetIdFromLabel(label);
  if (!presets.some((preset) => preset.id === baseId)) {
    return baseId;
  }
  let counter = 2;
  while (presets.some((preset) => preset.id === `${baseId}-${counter}`)) {
    counter += 1;
  }
  return `${baseId}-${counter}`;
}

export function getActiveManagedLlamaPreset(config: DashboardConfig): DashboardManagedLlamaPreset {
  const presets = ensureManagedLlamaPresets(config);
  const activePreset = presets.find((preset) => preset.id === config.Server.LlamaCpp.ActivePresetId) ?? presets[0];
  if (!activePreset) {
    throw new Error('Managed llama preset list is empty.');
  }
  config.Server.LlamaCpp.ActivePresetId = activePreset.id;
  copyPresetToServer(config, activePreset);
  syncDerivedSettingsFields(config);
  return activePreset;
}

export function applyManagedLlamaPresetSelection(config: DashboardConfig, presetId: string): void {
  const presets = ensureManagedLlamaPresets(config);
  const preset = presets.find((entry) => entry.id === presetId);
  if (!preset) {
    return;
  }
  config.Server.LlamaCpp.ActivePresetId = preset.id;
  copyPresetToServer(config, preset);
  syncDerivedSettingsFields(config);
}

export function updateActiveManagedLlamaPreset(
  config: DashboardConfig,
  updater: (preset: DashboardManagedLlamaPreset) => void,
): void {
  const preset = getActiveManagedLlamaPreset(config);
  updater(preset);
  copyPresetToServer(config, preset);
  syncDerivedSettingsFields(config);
}

export function addManagedLlamaPreset(config: DashboardConfig): string {
  const presets = ensureManagedLlamaPresets(config);
  const activePreset = getActiveManagedLlamaPreset(config);
  const nextId = getUniqueManagedLlamaPresetId(presets, activePreset.label);
  const nextPreset: DashboardManagedLlamaPreset = {
    ...activePreset,
    id: nextId,
    label: activePreset.label,
  };
  presets.push(nextPreset);
  config.Server.LlamaCpp.ActivePresetId = nextId;
  copyPresetToServer(config, nextPreset);
  syncDerivedSettingsFields(config);
  return nextId;
}

export function deleteManagedLlamaPreset(config: DashboardConfig, presetId: string): void {
  const presets = ensureManagedLlamaPresets(config);
  if (presets.length <= 1) {
    return;
  }
  config.Server.LlamaCpp.Presets = presets.filter((preset) => preset.id !== presetId);
  const remainingPresets = ensureManagedLlamaPresets(config);
  const nextPreset = remainingPresets.find((preset) => preset.id === config.Server.LlamaCpp.ActivePresetId)
    ?? remainingPresets[0];
  if (!nextPreset) {
    throw new Error('Managed llama preset list is empty.');
  }
  config.Server.LlamaCpp.ActivePresetId = nextPreset.id;
  copyPresetToServer(config, nextPreset);
  syncDerivedSettingsFields(config);
}

export type { DashboardManagedLlamaPreset };
