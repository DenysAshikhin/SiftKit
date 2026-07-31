import { httpClient } from '../lib/http-client.js';
import { JsonObjectSchema } from '../lib/json-types.js';
import { getActiveModelPreset, getFinitePositiveNumber } from './getters.js';
import { normalizeConfigObject } from './normalization.js';
import { overlayActivePreset } from './overrides.js';
import type { ModelRuntimePreset, SiftConfig } from './types.js';

/**
 * In pass-through mode this SiftKit does not own the inference server — a remote
 * "host" SiftKit does. The local active preset is then only a guess and can
 * silently diverge from what the host actually launched, which makes
 * prompt-budget math wrong (an oversized prompt passes the preflight check and
 * the real server rejects it with HTTP 400), addresses a model the host has not
 * loaded, or sends samplers the host's preset does not use. This module fetches
 * the host SiftKit's config over HTTP and overlays its authoritative
 * request-shaping preset fields onto the local config.
 */

const HOST_CONFIG_TIMEOUT_MS = 10_000;
const HOST_SETTINGS_TTL_MS = 60_000;

/** The preset fields the host owns in pass-through mode; everything else stays local. */
type HostPresetSettings = Pick<ModelRuntimePreset,
  'Model' | 'NumCtx' | 'Reasoning' | 'ReasoningContent' | 'PreserveThinking' | 'MaintainPerStepThinking'
  | 'MaxTokens' | 'Temperature' | 'TopP' | 'TopK' | 'MinP' | 'PresencePenalty' | 'RepetitionPenalty'>;

// A host can swap presets while this process runs, so the snapshot expires
// instead of pinning the first answer for the process lifetime.
const hostSettingsCache = new Map<string, { fetchedAtMs: number; settings: HostPresetSettings }>();

function isPassThroughMode(config: SiftConfig): boolean {
  return getActiveModelPreset(config).ExternalServerEnabled;
}

function getHostBaseUrl(config: SiftConfig): string | null {
  const candidate = getActiveModelPreset(config).BaseUrl ?? config.Runtime.LlamaCpp.BaseUrl;
  if (typeof candidate !== 'string' || !candidate.trim()) {
    return null;
  }
  return candidate.trim().replace(/\/+$/u, '');
}

async function fetchHostPresetSettings(baseUrl: string): Promise<HostPresetSettings> {
  const cached = hostSettingsCache.get(baseUrl);
  if (cached && Date.now() - cached.fetchedAtMs < HOST_SETTINGS_TTL_MS) {
    return cached.settings;
  }
  // `skip_ready=1` lets the host return its config without booting managed llama.
  const hostConfig = normalizeConfigObject(await httpClient.requestJson({
    url: `${baseUrl}/config?skip_ready=1`,
    method: 'GET',
    timeoutMs: HOST_CONFIG_TIMEOUT_MS,
  }, JsonObjectSchema));
  const hostPreset = getActiveModelPreset(hostConfig);
  const hostLlama = hostConfig.Runtime.LlamaCpp;
  const hostModel = typeof hostPreset.Model === 'string' && hostPreset.Model.trim() ? hostPreset.Model.trim() : null;
  const settings: HostPresetSettings = {
    Model: hostModel,
    // A llama-backed host records the launched values on Runtime.LlamaCpp; an
    // exl3 host only has them on the preset.
    NumCtx: getFinitePositiveNumber(hostLlama.NumCtx) ?? hostPreset.NumCtx,
    Reasoning: hostLlama.Reasoning === 'on' || hostLlama.Reasoning === 'off' ? hostLlama.Reasoning : hostPreset.Reasoning,
    ReasoningContent: hostPreset.ReasoningContent,
    PreserveThinking: hostPreset.PreserveThinking,
    MaintainPerStepThinking: hostPreset.MaintainPerStepThinking,
    MaxTokens: hostPreset.MaxTokens,
    Temperature: hostPreset.Temperature,
    TopP: hostPreset.TopP,
    TopK: hostPreset.TopK,
    MinP: hostPreset.MinP,
    PresencePenalty: hostPreset.PresencePenalty,
    RepetitionPenalty: hostPreset.RepetitionPenalty,
  };
  hostSettingsCache.set(baseUrl, { fetchedAtMs: Date.now(), settings });
  return settings;
}

/** A host that reports no model has nothing to say about it, so the local model stands. */
function buildPresetOverlay(settings: HostPresetSettings): Partial<ModelRuntimePreset> {
  const { Model, ...requestFields } = settings;
  return Model === null ? requestFields : { ...requestFields, Model };
}

/**
 * Returns `config` unchanged when this SiftKit owns its inference server. In
 * pass-through mode, overlays the host SiftKit's request-shaping preset fields
 * so prompt-budget math, the requested model, and the samplers match the server
 * that actually serves the request. `NumCtx`/`Reasoning` are also written to
 * `Runtime.LlamaCpp` because that is where the llama-backend getters read them.
 * Falls back to the unchanged local config when the host is unreachable or is
 * not a SiftKit (e.g. `BaseUrl` points straight at a raw llama.cpp endpoint).
 */
export async function applyHostLlamaRuntimeSettings(config: SiftConfig): Promise<SiftConfig> {
  if (!isPassThroughMode(config)) {
    return config;
  }
  const baseUrl = getHostBaseUrl(config);
  if (!baseUrl) {
    return config;
  }

  let settings: HostPresetSettings;
  try {
    settings = await fetchHostPresetSettings(baseUrl);
  } catch {
    return config;
  }

  const overlaid = overlayActivePreset(config, buildPresetOverlay(settings));
  return {
    ...overlaid,
    Runtime: {
      ...overlaid.Runtime,
      LlamaCpp: { ...overlaid.Runtime.LlamaCpp, NumCtx: settings.NumCtx, Reasoning: settings.Reasoning },
    },
  };
}

/** Test-only: clears the in-process host-settings cache. */
export function resetHostLlamaSettingsCacheForTests(): void {
  hostSettingsCache.clear();
}
