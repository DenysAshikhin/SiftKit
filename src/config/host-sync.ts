import { requestJson } from '../lib/http.js';
import { getFinitePositiveNumber } from './getters.js';
import type { RuntimeLlamaCppConfig, SiftConfig } from './types.js';

/**
 * In pass-through mode this SiftKit does not own the llama.cpp server — a
 * remote "host" SiftKit does. The local config's `NumCtx`/`Reasoning` are then
 * only a guess and can silently diverge from what the host actually launched
 * llama.cpp with, which makes every prompt-budget calculation wrong (an
 * oversized prompt passes the preflight check and the real server rejects it
 * with HTTP 400). This module fetches the host SiftKit's config over HTTP and
 * overlays its authoritative llama runtime settings onto the local config.
 */

const HOST_CONFIG_TIMEOUT_MS = 10_000;

type HostLlamaSettings = {
  numCtx: number | null;
  reasoning: 'on' | 'off' | null;
};

// Host settings are stable for a server's lifetime, so cache per host base URL:
// only the first request of a process pays the round-trip.
const hostSettingsCache = new Map<string, HostLlamaSettings>();

function isPassThroughMode(config: SiftConfig): boolean {
  return config.Server?.LlamaCpp?.ExternalServerEnabled === true;
}

function getHostBaseUrl(config: SiftConfig): string | null {
  const candidate = config.Server?.LlamaCpp?.BaseUrl
    ?? config.Runtime?.LlamaCpp?.BaseUrl
    ?? config.LlamaCpp?.BaseUrl;
  if (typeof candidate !== 'string' || !candidate.trim()) {
    return null;
  }
  return candidate.trim().replace(/\/+$/u, '');
}

async function fetchHostLlamaSettings(baseUrl: string): Promise<HostLlamaSettings> {
  const cached = hostSettingsCache.get(baseUrl);
  if (cached) {
    return cached;
  }
  // `skip_ready=1` lets the host return its config without booting managed llama.
  const hostConfig = await requestJson<SiftConfig>({
    url: `${baseUrl}/config?skip_ready=1`,
    method: 'GET',
    timeoutMs: HOST_CONFIG_TIMEOUT_MS,
  });
  const hostLlama: RuntimeLlamaCppConfig = hostConfig.Runtime?.LlamaCpp ?? hostConfig.LlamaCpp ?? {};
  const settings: HostLlamaSettings = {
    numCtx: getFinitePositiveNumber(hostLlama.NumCtx),
    reasoning: hostLlama.Reasoning === 'on' || hostLlama.Reasoning === 'off' ? hostLlama.Reasoning : null,
  };
  hostSettingsCache.set(baseUrl, settings);
  return settings;
}

/**
 * Returns `config` unchanged when this SiftKit owns its llama.cpp server. In
 * pass-through mode, overlays the host SiftKit's `NumCtx`/`Reasoning` so
 * prompt-budget math matches the server that actually serves the request.
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

  let hostSettings: HostLlamaSettings;
  try {
    hostSettings = await fetchHostLlamaSettings(baseUrl);
  } catch {
    return config;
  }
  if (hostSettings.numCtx === null && hostSettings.reasoning === null) {
    return config;
  }

  const overlay: RuntimeLlamaCppConfig = {};
  if (hostSettings.numCtx !== null) {
    overlay.NumCtx = hostSettings.numCtx;
  }
  if (hostSettings.reasoning !== null) {
    overlay.Reasoning = hostSettings.reasoning;
  }
  return {
    ...config,
    LlamaCpp: { ...config.LlamaCpp, ...overlay },
    Runtime: {
      ...config.Runtime,
      LlamaCpp: { ...(config.Runtime?.LlamaCpp ?? config.LlamaCpp ?? {}), ...overlay },
    },
  };
}

/** Test-only: clears the in-process host-settings cache. */
export function resetHostLlamaSettingsCacheForTests(): void {
  hostSettingsCache.clear();
}
