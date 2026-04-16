import { normalizeWindowsPath } from '../lib/paths.js';
import {
  RUNTIME_OWNED_LLAMA_CPP_KEYS,
  SIFT_BROKEN_DEFAULT_LLAMA_STARTUP_SCRIPT,
  SIFT_DEFAULT_LLAMA_STARTUP_SCRIPT,
  SIFT_DEFAULT_PROMPT_PREFIX,
  SIFT_FORMER_DEFAULT_LLAMA_STARTUP_SCRIPT,
  SIFT_LEGACY_DEFAULT_MAX_INPUT_CHARACTERS,
  SIFT_LEGACY_DEFAULT_NUM_CTX,
  SIFT_LEGACY_DERIVED_NUM_CTX,
  SIFT_PREVIOUS_DEFAULT_LLAMA_STARTUP_SCRIPT,
  SIFT_PREVIOUS_DEFAULT_MODEL,
  SIFT_PREVIOUS_DEFAULT_NUM_CTX,
} from './constants.js';
import { getDefaultConfigObject } from './defaults.js';
import { initializeRuntime } from './paths.js';
import type {
  NormalizationInfo,
  RuntimeLlamaCppConfig,
  ServerManagedLlamaCppConfig,
  ServerManagedLlamaPreset,
  SiftConfig,
} from './types.js';

const MANAGED_LLAMA_RUNTIME_KEYS: ReadonlyArray<keyof RuntimeLlamaCppConfig> = [
  'BaseUrl',
  'NumCtx',
  'ModelPath',
  'Temperature',
  'TopP',
  'TopK',
  'MinP',
  'PresencePenalty',
  'RepetitionPenalty',
  'MaxTokens',
  'GpuLayers',
  'Threads',
  'FlashAttention',
  'ParallelSlots',
  'Reasoning',
];

const MANAGED_LLAMA_DEFAULT_BACKFILL_KEYS: ReadonlyArray<keyof ServerManagedLlamaCppConfig> = [
  'BaseUrl',
  'BindHost',
  'Port',
  'NumCtx',
  'GpuLayers',
  'Threads',
  'FlashAttention',
  'ParallelSlots',
  'BatchSize',
  'UBatchSize',
  'CacheRam',
  'KvCacheQuantization',
  'MaxTokens',
  'Temperature',
  'TopP',
  'TopK',
  'MinP',
  'PresencePenalty',
  'RepetitionPenalty',
  'Reasoning',
  'ReasoningBudget',
  'StartupTimeoutMs',
  'HealthcheckTimeoutMs',
  'HealthcheckIntervalMs',
  'VerboseLogging',
];

const MANAGED_LLAMA_PRESET_KEYS: ReadonlyArray<Exclude<keyof ServerManagedLlamaCppConfig, 'Presets' | 'ActivePresetId'>> = [
  'ExecutablePath',
  'BaseUrl',
  'BindHost',
  'Port',
  'ModelPath',
  'NumCtx',
  'GpuLayers',
  'Threads',
  'FlashAttention',
  'ParallelSlots',
  'BatchSize',
  'UBatchSize',
  'CacheRam',
  'KvCacheQuantization',
  'MaxTokens',
  'Temperature',
  'TopP',
  'TopK',
  'MinP',
  'PresencePenalty',
  'RepetitionPenalty',
  'Reasoning',
  'ReasoningBudget',
  'StartupTimeoutMs',
  'HealthcheckTimeoutMs',
  'HealthcheckIntervalMs',
  'VerboseLogging',
];

function syncRuntimeLlamaFromManaged(
  runtimeLlamaCpp: RuntimeLlamaCppConfig,
  serverLlamaCpp: ServerManagedLlamaCppConfig,
): void {
  const runtimeRecord = runtimeLlamaCpp as Record<string, string | number | boolean | null | undefined>;
  const serverRecord = serverLlamaCpp as Record<string, string | number | boolean | null | undefined>;
  for (const key of MANAGED_LLAMA_RUNTIME_KEYS) {
    const value = serverRecord[key];
    if (value !== undefined) {
      runtimeRecord[key] = value;
    }
  }
}

function copyManagedLlamaPresetToServer(
  serverLlamaCpp: ServerManagedLlamaCppConfig,
  preset: ServerManagedLlamaPreset,
): void {
  const serverRecord = serverLlamaCpp as Record<string, unknown>;
  const presetRecord = preset as Record<string, unknown>;
  for (const key of MANAGED_LLAMA_PRESET_KEYS) {
    serverRecord[key] = presetRecord[key];
  }
}

function copyManagedLlamaServerToPreset(
  preset: ServerManagedLlamaPreset,
  serverLlamaCpp: ServerManagedLlamaCppConfig,
): void {
  const serverRecord = serverLlamaCpp as Record<string, unknown>;
  const presetRecord = preset as Record<string, unknown>;
  for (const key of MANAGED_LLAMA_PRESET_KEYS) {
    presetRecord[key] = serverRecord[key];
  }
}

function managedLlamaFieldsDiffer(
  serverLlamaCpp: ServerManagedLlamaCppConfig,
  preset: ServerManagedLlamaPreset,
): boolean {
  const serverRecord = serverLlamaCpp as Record<string, unknown>;
  const presetRecord = preset as Record<string, unknown>;
  return MANAGED_LLAMA_PRESET_KEYS.some((key) => serverRecord[key] !== presetRecord[key]);
}

function normalizeManagedLlamaPreset(
  preset: Partial<ServerManagedLlamaCppConfig> | null | undefined,
  fallback: ServerManagedLlamaCppConfig,
  fallbackId: string,
  fallbackLabel: string,
): ServerManagedLlamaPreset {
  const normalizedPreset = {
    ...fallback,
    ...(preset ?? {}),
  };
  delete (normalizedPreset as Partial<ServerManagedLlamaCppConfig>).Presets;
  delete (normalizedPreset as Partial<ServerManagedLlamaCppConfig>).ActivePresetId;
  return {
    ...normalizedPreset,
    id: typeof (preset as { id?: unknown } | null | undefined)?.id === 'string' && String((preset as { id?: string }).id).trim()
      ? String((preset as { id?: string }).id).trim()
      : fallbackId,
    label: typeof (preset as { label?: unknown } | null | undefined)?.label === 'string' && String((preset as { label?: string }).label).trim()
      ? String((preset as { label?: string }).label).trim()
      : fallbackLabel,
  } as ServerManagedLlamaPreset;
}

function applyActiveManagedLlamaPreset(
  serverLlamaCpp: ServerManagedLlamaCppConfig,
  fallback: ServerManagedLlamaCppConfig,
  preferPresetValues: boolean,
): void {
  const presets = Array.isArray(serverLlamaCpp.Presets) ? serverLlamaCpp.Presets : [];
  const normalizedPresets = presets.length > 0
    ? presets.map((preset, index) => normalizeManagedLlamaPreset(preset, fallback, `preset-${index + 1}`, `Preset ${index + 1}`))
    : [normalizeManagedLlamaPreset(serverLlamaCpp, fallback, 'default', 'Default')];
  const activePresetId = typeof serverLlamaCpp.ActivePresetId === 'string' && serverLlamaCpp.ActivePresetId.trim()
    ? serverLlamaCpp.ActivePresetId.trim()
    : normalizedPresets[0].id as string;
  const activePreset = normalizedPresets.find((preset) => preset.id === activePresetId) ?? normalizedPresets[0];
  serverLlamaCpp.Presets = normalizedPresets;
  serverLlamaCpp.ActivePresetId = activePreset.id as string;
  if (!preferPresetValues && managedLlamaFieldsDiffer(serverLlamaCpp, activePreset)) {
    copyManagedLlamaServerToPreset(activePreset, serverLlamaCpp);
    return;
  }
  copyManagedLlamaPresetToServer(serverLlamaCpp, activePreset);
}

export function isLegacyManagedStartupScriptPath(value: unknown): boolean {
  if (typeof value !== 'string' || !value.trim()) {
    return false;
  }
  const normalized = normalizeWindowsPath(value.trim());
  return normalized === normalizeWindowsPath(SIFT_PREVIOUS_DEFAULT_LLAMA_STARTUP_SCRIPT)
    || normalized === normalizeWindowsPath(SIFT_FORMER_DEFAULT_LLAMA_STARTUP_SCRIPT)
    || normalized === normalizeWindowsPath(SIFT_BROKEN_DEFAULT_LLAMA_STARTUP_SCRIPT);
}

export function applyRuntimeCompatibilityView(config: SiftConfig): SiftConfig {
  const defaults = getDefaultConfigObject();
  const runtime = config.Runtime ?? {};
  const runtimeLlamaCpp = runtime.LlamaCpp ?? {};
  const managedLlamaCpp = config.Server?.LlamaCpp ?? {};
  const compatLlamaCpp: RuntimeLlamaCppConfig = {
    ...defaults.LlamaCpp,
    ...config.LlamaCpp,
    ...managedLlamaCpp,
    ...runtimeLlamaCpp,
  };

  return {
    ...config,
    Model: runtime.Model ?? config.Model ?? defaults.Runtime?.Model ?? null,
    PromptPrefix: config.PromptPrefix ?? SIFT_DEFAULT_PROMPT_PREFIX,
    LlamaCpp: compatLlamaCpp,
  };
}

function isBlankManagedLlamaPlaceholder(serverLlama: ServerManagedLlamaCppConfig): boolean {
  return !serverLlama.ExecutablePath
    && !serverLlama.ModelPath
    && !serverLlama.BaseUrl
    && !serverLlama.BindHost
    && (!Number.isFinite(Number(serverLlama.Port)) || Number(serverLlama.Port) <= 0)
    && (!Number.isFinite(Number(serverLlama.NumCtx)) || Number(serverLlama.NumCtx) <= 0)
    && (!Number.isFinite(Number(serverLlama.BatchSize)) || Number(serverLlama.BatchSize) <= 0)
    && (!Number.isFinite(Number(serverLlama.UBatchSize)) || Number(serverLlama.UBatchSize) <= 0)
    && (!Number.isFinite(Number(serverLlama.CacheRam)) || Number(serverLlama.CacheRam) <= 0)
    && !serverLlama.KvCacheQuantization
    && (!Number.isFinite(Number(serverLlama.MaxTokens)) || Number(serverLlama.MaxTokens) <= 0)
    && (!Number.isFinite(Number(serverLlama.Temperature)) || Number(serverLlama.Temperature) <= 0)
    && (!Number.isFinite(Number(serverLlama.TopP)) || Number(serverLlama.TopP) <= 0)
    && (!Number.isFinite(Number(serverLlama.TopK)) || Number(serverLlama.TopK) <= 0)
    && !serverLlama.Reasoning;
}

export function updateRuntimePaths(config: SiftConfig): SiftConfig {
  return {
    ...config,
    Paths: initializeRuntime(),
  };
}

export function toPersistedConfigObject(config: SiftConfig): Omit<SiftConfig, 'Paths' | 'Effective'> {
  const compatConfig = applyRuntimeCompatibilityView(config);
  return {
    Version: config.Version,
    Backend: config.Backend,
    PolicyMode: config.PolicyMode,
    RawLogRetention: Boolean(config.RawLogRetention),
    PromptPrefix: config.PromptPrefix ?? SIFT_DEFAULT_PROMPT_PREFIX,
    LlamaCpp: {
      ...(compatConfig.LlamaCpp?.BaseUrl === undefined ? {} : { BaseUrl: compatConfig.LlamaCpp?.BaseUrl ?? null }),
      ...(compatConfig.LlamaCpp?.NumCtx === undefined ? {} : { NumCtx: compatConfig.LlamaCpp?.NumCtx ?? null }),
      ...(compatConfig.LlamaCpp?.ModelPath === undefined ? {} : { ModelPath: compatConfig.LlamaCpp?.ModelPath ?? null }),
      ...(compatConfig.LlamaCpp?.Temperature === undefined ? {} : { Temperature: compatConfig.LlamaCpp?.Temperature ?? null }),
      ...(compatConfig.LlamaCpp?.TopP === undefined ? {} : { TopP: compatConfig.LlamaCpp?.TopP ?? null }),
      ...(compatConfig.LlamaCpp?.TopK === undefined ? {} : { TopK: compatConfig.LlamaCpp?.TopK ?? null }),
      ...(compatConfig.LlamaCpp?.MinP === undefined ? {} : { MinP: compatConfig.LlamaCpp?.MinP ?? null }),
      ...(compatConfig.LlamaCpp?.PresencePenalty === undefined ? {} : { PresencePenalty: compatConfig.LlamaCpp?.PresencePenalty ?? null }),
      ...(compatConfig.LlamaCpp?.RepetitionPenalty === undefined ? {} : { RepetitionPenalty: compatConfig.LlamaCpp?.RepetitionPenalty ?? null }),
      ...(compatConfig.LlamaCpp?.MaxTokens === undefined ? {} : { MaxTokens: compatConfig.LlamaCpp?.MaxTokens ?? null }),
      ...(compatConfig.LlamaCpp?.Threads === undefined ? {} : { Threads: compatConfig.LlamaCpp?.Threads ?? null }),
      ...(compatConfig.LlamaCpp?.FlashAttention === undefined ? {} : { FlashAttention: compatConfig.LlamaCpp?.FlashAttention ?? null }),
      ...(compatConfig.LlamaCpp?.ParallelSlots === undefined ? {} : { ParallelSlots: compatConfig.LlamaCpp?.ParallelSlots ?? null }),
      ...(compatConfig.LlamaCpp?.Reasoning === undefined ? {} : { Reasoning: compatConfig.LlamaCpp?.Reasoning ?? null }),
    },
    Runtime: {
      ...(config.Runtime?.Model === undefined ? {} : { Model: config.Runtime?.Model ?? null }),
      LlamaCpp: {
        ...(config.Runtime?.LlamaCpp?.BaseUrl === undefined ? {} : { BaseUrl: config.Runtime?.LlamaCpp?.BaseUrl ?? null }),
        ...(config.Runtime?.LlamaCpp?.NumCtx === undefined ? {} : { NumCtx: config.Runtime?.LlamaCpp?.NumCtx ?? null }),
        ...(config.Runtime?.LlamaCpp?.ModelPath === undefined ? {} : { ModelPath: config.Runtime?.LlamaCpp?.ModelPath ?? null }),
        ...(config.Runtime?.LlamaCpp?.Temperature === undefined ? {} : { Temperature: config.Runtime?.LlamaCpp?.Temperature ?? null }),
        ...(config.Runtime?.LlamaCpp?.TopP === undefined ? {} : { TopP: config.Runtime?.LlamaCpp?.TopP ?? null }),
        ...(config.Runtime?.LlamaCpp?.TopK === undefined ? {} : { TopK: config.Runtime?.LlamaCpp?.TopK ?? null }),
        ...(config.Runtime?.LlamaCpp?.MinP === undefined ? {} : { MinP: config.Runtime?.LlamaCpp?.MinP ?? null }),
        ...(config.Runtime?.LlamaCpp?.PresencePenalty === undefined ? {} : { PresencePenalty: config.Runtime?.LlamaCpp?.PresencePenalty ?? null }),
        ...(config.Runtime?.LlamaCpp?.RepetitionPenalty === undefined ? {} : { RepetitionPenalty: config.Runtime?.LlamaCpp?.RepetitionPenalty ?? null }),
        ...(config.Runtime?.LlamaCpp?.MaxTokens === undefined ? {} : { MaxTokens: config.Runtime?.LlamaCpp?.MaxTokens ?? null }),
        ...(config.Runtime?.LlamaCpp?.Threads === undefined ? {} : { Threads: config.Runtime?.LlamaCpp?.Threads ?? null }),
        ...(config.Runtime?.LlamaCpp?.FlashAttention === undefined ? {} : { FlashAttention: config.Runtime?.LlamaCpp?.FlashAttention ?? null }),
        ...(config.Runtime?.LlamaCpp?.ParallelSlots === undefined ? {} : { ParallelSlots: config.Runtime?.LlamaCpp?.ParallelSlots ?? null }),
        ...(config.Runtime?.LlamaCpp?.Reasoning === undefined ? {} : { Reasoning: config.Runtime?.LlamaCpp?.Reasoning ?? null }),
      },
    },
    Thresholds: {
      MinCharactersForSummary: Number(config.Thresholds.MinCharactersForSummary),
      MinLinesForSummary: Number(config.Thresholds.MinLinesForSummary),
    },
    Interactive: {
      Enabled: Boolean(config.Interactive.Enabled),
      WrappedCommands: [...config.Interactive.WrappedCommands],
      IdleTimeoutMs: Number(config.Interactive.IdleTimeoutMs),
      MaxTranscriptCharacters: Number(config.Interactive.MaxTranscriptCharacters),
      TranscriptRetention: Boolean(config.Interactive.TranscriptRetention),
    },
    Server: {
      LlamaCpp: {
        ExecutablePath: config.Server?.LlamaCpp?.ExecutablePath ?? null,
        BaseUrl: config.Server?.LlamaCpp?.BaseUrl ?? null,
        BindHost: config.Server?.LlamaCpp?.BindHost ?? null,
        Port: config.Server?.LlamaCpp?.Port ?? null,
        ModelPath: config.Server?.LlamaCpp?.ModelPath ?? null,
        NumCtx: config.Server?.LlamaCpp?.NumCtx ?? null,
        GpuLayers: config.Server?.LlamaCpp?.GpuLayers ?? null,
        Threads: config.Server?.LlamaCpp?.Threads ?? null,
        FlashAttention: config.Server?.LlamaCpp?.FlashAttention ?? null,
        ParallelSlots: config.Server?.LlamaCpp?.ParallelSlots ?? null,
        BatchSize: config.Server?.LlamaCpp?.BatchSize ?? null,
        UBatchSize: config.Server?.LlamaCpp?.UBatchSize ?? null,
        CacheRam: config.Server?.LlamaCpp?.CacheRam ?? null,
        KvCacheQuantization: config.Server?.LlamaCpp?.KvCacheQuantization ?? null,
        MaxTokens: config.Server?.LlamaCpp?.MaxTokens ?? null,
        Temperature: config.Server?.LlamaCpp?.Temperature ?? null,
        TopP: config.Server?.LlamaCpp?.TopP ?? null,
        TopK: config.Server?.LlamaCpp?.TopK ?? null,
        MinP: config.Server?.LlamaCpp?.MinP ?? null,
        PresencePenalty: config.Server?.LlamaCpp?.PresencePenalty ?? null,
        RepetitionPenalty: config.Server?.LlamaCpp?.RepetitionPenalty ?? null,
        Reasoning: config.Server?.LlamaCpp?.Reasoning ?? null,
        ReasoningBudget: config.Server?.LlamaCpp?.ReasoningBudget ?? null,
        StartupTimeoutMs: config.Server?.LlamaCpp?.StartupTimeoutMs ?? null,
        HealthcheckTimeoutMs: config.Server?.LlamaCpp?.HealthcheckTimeoutMs ?? null,
        HealthcheckIntervalMs: config.Server?.LlamaCpp?.HealthcheckIntervalMs ?? null,
        VerboseLogging: config.Server?.LlamaCpp?.VerboseLogging ?? null,
        Presets: config.Server?.LlamaCpp?.Presets ?? null,
        ActivePresetId: config.Server?.LlamaCpp?.ActivePresetId ?? null,
      },
    },
  };
}

export function normalizeConfig(config: SiftConfig): { config: SiftConfig; info: NormalizationInfo } {
  const updated = JSON.parse(JSON.stringify(config)) as SiftConfig;
  const defaults = getDefaultConfigObject();
  const preferManagedPresetValues = Boolean(
    config.Server?.LlamaCpp
    && (
      Object.prototype.hasOwnProperty.call(config.Server.LlamaCpp, 'Presets')
      || Object.prototype.hasOwnProperty.call(config.Server.LlamaCpp, 'ActivePresetId')
    )
  );
  let changed = false;
  let legacyMaxInputCharactersValue: number | null = null;
  let legacyMaxInputCharactersRemoved = false;

  updated.LlamaCpp ??= {};
  updated.Runtime ??= {
    Model: null,
    LlamaCpp: {},
  };
  updated.Runtime.LlamaCpp ??= {};
  updated.Thresholds ??= { ...defaults.Thresholds };
  updated.Interactive ??= { ...defaults.Interactive };
  updated.Server ??= {
    LlamaCpp: { ...defaults.Server?.LlamaCpp },
  };
  updated.Server.LlamaCpp ??= { ...defaults.Server?.LlamaCpp };

  const legacyOllama = (updated as SiftConfig & { Ollama?: Record<string, unknown> }).Ollama;
  if (legacyOllama) {
    updated.Runtime.LlamaCpp = {
      ...updated.Runtime.LlamaCpp,
      ...(legacyOllama.BaseUrl === undefined ? {} : { BaseUrl: String(legacyOllama.BaseUrl || '') || null }),
      ...(legacyOllama.NumCtx === undefined ? {} : { NumCtx: Number(legacyOllama.NumCtx || 0) || null }),
      ...(legacyOllama.ModelPath === undefined ? {} : { ModelPath: String(legacyOllama.ModelPath || '') || null }),
      ...(legacyOllama.Temperature === undefined ? {} : { Temperature: Number(legacyOllama.Temperature) }),
      ...(legacyOllama.TopP === undefined ? {} : { TopP: Number(legacyOllama.TopP) }),
      ...(legacyOllama.TopK === undefined ? {} : { TopK: Number(legacyOllama.TopK) }),
      ...(legacyOllama.MinP === undefined ? {} : { MinP: Number(legacyOllama.MinP) }),
      ...(legacyOllama.PresencePenalty === undefined ? {} : { PresencePenalty: Number(legacyOllama.PresencePenalty) }),
      ...(legacyOllama.RepetitionPenalty === undefined ? {} : { RepetitionPenalty: Number(legacyOllama.RepetitionPenalty) }),
      ...(legacyOllama.NumPredict === undefined ? {} : { MaxTokens: legacyOllama.NumPredict as number | null }),
    };
    changed = true;
  }
  delete (updated as SiftConfig & { Ollama?: Record<string, unknown> }).Ollama;

  if (updated.Backend === 'ollama') {
    updated.Backend = defaults.Backend;
    changed = true;
  }

  if (typeof updated.Model === 'string' && updated.Model.trim() && !updated.Runtime.Model) {
    updated.Runtime.Model = updated.Model;
    changed = true;
  }
  if (Object.prototype.hasOwnProperty.call(updated, 'Model')) {
    delete (updated as Partial<SiftConfig>).Model;
    changed = true;
  }
  const legacyRuntimePromptPrefix = (updated.Runtime as { PromptPrefix?: string | null } | undefined)?.PromptPrefix;
  if ((!updated.PromptPrefix || !String(updated.PromptPrefix).trim()) && typeof legacyRuntimePromptPrefix === 'string' && legacyRuntimePromptPrefix.trim()) {
    updated.PromptPrefix = legacyRuntimePromptPrefix;
    changed = true;
  }
  if (Object.prototype.hasOwnProperty.call(updated.Runtime ?? {}, 'PromptPrefix')) {
    delete (updated.Runtime as { PromptPrefix?: string | null }).PromptPrefix;
    changed = true;
  }
  if (!updated.PromptPrefix || !String(updated.PromptPrefix).trim()) {
    updated.PromptPrefix = defaults.PromptPrefix;
    changed = true;
  }

  for (const key of RUNTIME_OWNED_LLAMA_CPP_KEYS) {
    const value = updated.LlamaCpp[key];
    if (value !== undefined) {
      const runtimeLlamaCpp = updated.Runtime.LlamaCpp as Record<string, unknown>;
      if (runtimeLlamaCpp[key] === undefined) {
        runtimeLlamaCpp[key] = value;
      }
      delete updated.LlamaCpp[key];
      changed = true;
    }
  }
  if (!Object.prototype.hasOwnProperty.call(updated.Thresholds, 'MinCharactersForSummary')) {
    updated.Thresholds.MinCharactersForSummary = defaults.Thresholds.MinCharactersForSummary;
    changed = true;
  }
  if (!Object.prototype.hasOwnProperty.call(updated.Thresholds, 'MinLinesForSummary')) {
    updated.Thresholds.MinLinesForSummary = defaults.Thresholds.MinLinesForSummary;
    changed = true;
  }
  const hadExplicitMaxInputCharacters = Object.prototype.hasOwnProperty.call(updated.Thresholds, 'MaxInputCharacters');
  if (hadExplicitMaxInputCharacters) {
    legacyMaxInputCharactersValue = Number(updated.Thresholds.MaxInputCharacters ?? 0);
    delete updated.Thresholds.MaxInputCharacters;
    changed = true;
    if (legacyMaxInputCharactersValue > 0) {
      legacyMaxInputCharactersRemoved = true;
    } else {
      legacyMaxInputCharactersValue = null;
    }
  }
  if (Object.prototype.hasOwnProperty.call(updated.Thresholds, 'ChunkThresholdRatio')) {
    delete (updated.Thresholds as { ChunkThresholdRatio?: number }).ChunkThresholdRatio;
    changed = true;
  }

  if (!Object.prototype.hasOwnProperty.call(updated.Interactive, 'Enabled')) {
    updated.Interactive.Enabled = defaults.Interactive.Enabled;
    changed = true;
  }
  if (!Object.prototype.hasOwnProperty.call(updated.Interactive, 'WrappedCommands')) {
    updated.Interactive.WrappedCommands = [...defaults.Interactive.WrappedCommands];
    changed = true;
  }
  if (!Object.prototype.hasOwnProperty.call(updated.Interactive, 'IdleTimeoutMs')) {
    updated.Interactive.IdleTimeoutMs = defaults.Interactive.IdleTimeoutMs;
    changed = true;
  }
  if (!Object.prototype.hasOwnProperty.call(updated.Interactive, 'MaxTranscriptCharacters')) {
    updated.Interactive.MaxTranscriptCharacters = defaults.Interactive.MaxTranscriptCharacters;
    changed = true;
  }
  if (!Object.prototype.hasOwnProperty.call(updated.Interactive, 'TranscriptRetention')) {
    updated.Interactive.TranscriptRetention = defaults.Interactive.TranscriptRetention;
    changed = true;
  }
  const serverLlama = updated.Server.LlamaCpp;
  const legacyStartupScript = typeof (serverLlama as { StartupScript?: unknown }).StartupScript === 'string'
    && String((serverLlama as { StartupScript?: string }).StartupScript).trim()
    ? String((serverLlama as { StartupScript?: string }).StartupScript).trim()
    : null;
  if (!Object.prototype.hasOwnProperty.call(serverLlama, 'ExecutablePath')) {
    serverLlama.ExecutablePath = (
      legacyStartupScript
      && !isLegacyManagedStartupScriptPath(legacyStartupScript)
      && normalizeWindowsPath(legacyStartupScript) !== normalizeWindowsPath(SIFT_DEFAULT_LLAMA_STARTUP_SCRIPT)
    )
      ? legacyStartupScript
      : defaults.Server?.LlamaCpp?.ExecutablePath ?? null;
    changed = true;
  }
  for (const key of [
    'BaseUrl',
    'BindHost',
    'Port',
    'ModelPath',
    'NumCtx',
    'GpuLayers',
    'Threads',
    'FlashAttention',
    'ParallelSlots',
    'BatchSize',
    'UBatchSize',
    'CacheRam',
    'KvCacheQuantization',
    'MaxTokens',
    'Temperature',
    'TopP',
    'TopK',
    'MinP',
    'PresencePenalty',
    'RepetitionPenalty',
    'Reasoning',
    'ReasoningBudget',
  ] as const) {
    if (!Object.prototype.hasOwnProperty.call(serverLlama, key)) {
      (serverLlama as Record<string, unknown>)[key] = (defaults.Server?.LlamaCpp as Record<string, unknown> | undefined)?.[key] ?? null;
      changed = true;
    }
  }
  if (!Object.prototype.hasOwnProperty.call(updated.Server.LlamaCpp, 'StartupTimeoutMs')) {
    updated.Server.LlamaCpp.StartupTimeoutMs = defaults.Server?.LlamaCpp?.StartupTimeoutMs ?? 600_000;
    changed = true;
  }
  if (!Object.prototype.hasOwnProperty.call(updated.Server.LlamaCpp, 'HealthcheckTimeoutMs')) {
    updated.Server.LlamaCpp.HealthcheckTimeoutMs = defaults.Server?.LlamaCpp?.HealthcheckTimeoutMs ?? 2_000;
    changed = true;
  }
  if (!Object.prototype.hasOwnProperty.call(updated.Server.LlamaCpp, 'HealthcheckIntervalMs')) {
    updated.Server.LlamaCpp.HealthcheckIntervalMs = defaults.Server?.LlamaCpp?.HealthcheckIntervalMs ?? 1_000;
    changed = true;
  }
  if (!Object.prototype.hasOwnProperty.call(serverLlama, 'VerboseLogging')) {
    serverLlama.VerboseLogging = defaults.Server?.LlamaCpp?.VerboseLogging ?? false;
    changed = true;
  }
  if (isBlankManagedLlamaPlaceholder(serverLlama)) {
    const mutableServerLlama = serverLlama as Record<string, string | number | boolean | null | undefined>;
    const defaultManagedLlama = defaults.Server?.LlamaCpp as Record<string, string | number | boolean | null | undefined> | undefined;
    for (const key of MANAGED_LLAMA_DEFAULT_BACKFILL_KEYS) {
      mutableServerLlama[key] = defaultManagedLlama?.[key] ?? null;
    }
    changed = true;
  }
  applyActiveManagedLlamaPreset(serverLlama, defaults.Server?.LlamaCpp ?? serverLlama, preferManagedPresetValues);
  if (typeof serverLlama.VerboseLogging !== 'boolean') {
    serverLlama.VerboseLogging = Boolean(serverLlama.VerboseLogging);
    changed = true;
  }
  if (Object.prototype.hasOwnProperty.call(serverLlama, 'StartupScript')) {
    delete (serverLlama as { StartupScript?: string | null }).StartupScript;
    changed = true;
  }
  if (Object.prototype.hasOwnProperty.call(serverLlama, 'ShutdownScript')) {
    delete (serverLlama as { ShutdownScript?: string | null }).ShutdownScript;
    changed = true;
  }
  if (Object.prototype.hasOwnProperty.call(serverLlama, 'VerboseArgs')) {
    delete (serverLlama as { VerboseArgs?: string[] | null }).VerboseArgs;
    changed = true;
  }
  syncRuntimeLlamaFromManaged(updated.Runtime.LlamaCpp, serverLlama);

  if (updated.Runtime.Model === SIFT_PREVIOUS_DEFAULT_MODEL) {
    updated.Runtime.Model = null;
    changed = true;
  }

  const numCtx = Number(updated.Runtime.LlamaCpp.NumCtx);
  const isLegacyDefaultSettings = (
    numCtx === SIFT_LEGACY_DEFAULT_NUM_CTX
    && (!hadExplicitMaxInputCharacters || legacyMaxInputCharactersValue === SIFT_LEGACY_DEFAULT_MAX_INPUT_CHARACTERS)
  );
  const isLegacyDerivedSettings = (
    numCtx === SIFT_LEGACY_DERIVED_NUM_CTX
    && !hadExplicitMaxInputCharacters
  );
  const isPreviousDefaultSettings = (
    numCtx === SIFT_PREVIOUS_DEFAULT_NUM_CTX
    && !hadExplicitMaxInputCharacters
  );

  if (isLegacyDefaultSettings || isLegacyDerivedSettings || isPreviousDefaultSettings) {
    updated.Runtime.LlamaCpp = {
      ...(defaults.Runtime?.LlamaCpp ?? defaults.LlamaCpp),
    };
    delete updated.Thresholds.MaxInputCharacters;
    changed = true;
  }

  return {
    config: updated,
    info: {
      changed,
      legacyMaxInputCharactersRemoved,
      legacyMaxInputCharactersValue,
    },
  };
}
