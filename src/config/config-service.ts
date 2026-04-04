import { requestJson } from '../lib/http.js';
import { addEffectiveConfigProperties } from './effective.js';
import {
  applyRuntimeCompatibilityView,
  normalizeConfig,
  toPersistedConfigObject,
  updateRuntimePaths,
} from './normalization.js';
import {
  deriveServiceUrl,
  getStatusBackendUrl,
  toStatusServerUnavailableError,
} from './status-backend.js';
import type { SiftConfig } from './types.js';

export function getConfigServiceUrl(): string {
  const configuredUrl = process.env.SIFTKIT_CONFIG_SERVICE_URL;
  if (configuredUrl && configuredUrl.trim()) {
    return configuredUrl.trim();
  }

  return deriveServiceUrl(getStatusBackendUrl(), '/config');
}

async function getConfigFromService(): Promise<SiftConfig> {
  try {
    return await requestJson<SiftConfig>({
      url: getConfigServiceUrl(),
      method: 'GET',
      timeoutMs: 130_000,
    });
  } catch {
    throw toStatusServerUnavailableError();
  }
}

async function setConfigInService(config: SiftConfig): Promise<SiftConfig> {
  try {
    return await requestJson<SiftConfig>({
      url: getConfigServiceUrl(),
      method: 'PUT',
      timeoutMs: 2000,
      body: JSON.stringify(toPersistedConfigObject(config)),
    });
  } catch {
    throw toStatusServerUnavailableError();
  }
}

export async function saveConfig(config: SiftConfig): Promise<SiftConfig> {
  return setConfigInService(config);
}

export async function loadConfig(options?: { ensure?: boolean }): Promise<SiftConfig> {
  void options;
  const config = await getConfigFromService();

  const update = normalizeConfig(config);
  if (update.info.changed) {
    await saveConfig(update.config);
  }

  const runtimeBackfilled = applyRuntimeCompatibilityView(update.config);
  return addEffectiveConfigProperties(updateRuntimePaths(runtimeBackfilled), update.info);
}

export async function setTopLevelConfigKey(key: string, value: unknown): Promise<SiftConfig> {
  const config = await loadConfig({ ensure: true });
  if (!Object.prototype.hasOwnProperty.call(config, key)) {
    throw new Error(`Unknown top-level config key: ${key}`);
  }

  (config as Record<string, unknown>)[key] = value;
  await saveConfig(config);
  return loadConfig({ ensure: true });
}
