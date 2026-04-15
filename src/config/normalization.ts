import { normalizeWindowsPath } from '../lib/paths.js';
import {
  RUNTIME_OWNED_LLAMA_CPP_KEYS,
  SIFT_BROKEN_DEFAULT_LLAMA_STARTUP_SCRIPT,
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
import type { NormalizationInfo, RuntimeLlamaCppConfig, SiftConfig } from './types.js';

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
  const compatLlamaCpp: RuntimeLlamaCppConfig = {
    ...defaults.LlamaCpp,
    ...config.LlamaCpp,
    ...runtimeLlamaCpp,
  };

  return {
    ...config,
    Model: runtime.Model ?? config.Model ?? defaults.Runtime?.Model ?? null,
    PromptPrefix: config.PromptPrefix ?? SIFT_DEFAULT_PROMPT_PREFIX,
    LlamaCpp: compatLlamaCpp,
  };
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
        StartupScript: config.Server?.LlamaCpp?.StartupScript ?? null,
        ShutdownScript: config.Server?.LlamaCpp?.ShutdownScript ?? null,
        StartupTimeoutMs: config.Server?.LlamaCpp?.StartupTimeoutMs ?? null,
        HealthcheckTimeoutMs: config.Server?.LlamaCpp?.HealthcheckTimeoutMs ?? null,
        HealthcheckIntervalMs: config.Server?.LlamaCpp?.HealthcheckIntervalMs ?? null,
        VerboseLogging: config.Server?.LlamaCpp?.VerboseLogging ?? null,
        VerboseArgs: Array.isArray(config.Server?.LlamaCpp?.VerboseArgs)
          ? config.Server.LlamaCpp.VerboseArgs.map((value) => String(value))
          : null,
      },
    },
  };
}

export function normalizeConfig(config: SiftConfig): { config: SiftConfig; info: NormalizationInfo } {
  const updated = JSON.parse(JSON.stringify(config)) as SiftConfig;
  const defaults = getDefaultConfigObject();
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
  if (!Object.prototype.hasOwnProperty.call(updated.Server.LlamaCpp, 'StartupScript')) {
    updated.Server.LlamaCpp.StartupScript = defaults.Server?.LlamaCpp?.StartupScript ?? null;
    changed = true;
  }
  if (isLegacyManagedStartupScriptPath(updated.Server.LlamaCpp.StartupScript)) {
    updated.Server.LlamaCpp.StartupScript = defaults.Server?.LlamaCpp?.StartupScript ?? null;
    changed = true;
  }
  if (!Object.prototype.hasOwnProperty.call(updated.Server.LlamaCpp, 'ShutdownScript')) {
    updated.Server.LlamaCpp.ShutdownScript = defaults.Server?.LlamaCpp?.ShutdownScript ?? null;
    changed = true;
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
  const serverLlama = updated.Server.LlamaCpp;
  if (!Object.prototype.hasOwnProperty.call(serverLlama, 'VerboseLogging')) {
    serverLlama.VerboseLogging = defaults.Server?.LlamaCpp?.VerboseLogging ?? false;
    changed = true;
  }
  if (!Object.prototype.hasOwnProperty.call(serverLlama, 'VerboseArgs')) {
    serverLlama.VerboseArgs = Array.isArray(defaults.Server?.LlamaCpp?.VerboseArgs)
      ? [...defaults.Server.LlamaCpp.VerboseArgs]
      : [];
    changed = true;
  }
  if (typeof serverLlama.VerboseLogging !== 'boolean') {
    serverLlama.VerboseLogging = Boolean(serverLlama.VerboseLogging);
    changed = true;
  }
  const normalizedVerboseArgs = Array.isArray(serverLlama.VerboseArgs)
    ? serverLlama.VerboseArgs
      .filter((value) => typeof value === 'string' && value.trim().length > 0)
      .map((value) => value.trim())
    : [];
  const currentVerboseArgs = Array.isArray(serverLlama.VerboseArgs) ? serverLlama.VerboseArgs : [];
  if (
    !Array.isArray(serverLlama.VerboseArgs)
    || normalizedVerboseArgs.length !== currentVerboseArgs.length
    || normalizedVerboseArgs.some((value, index) => value !== currentVerboseArgs[index])
  ) {
    serverLlama.VerboseArgs = normalizedVerboseArgs;
    changed = true;
  }

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
