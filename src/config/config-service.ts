import { requestJson } from '../lib/http.js';
import { addEffectiveConfigProperties } from './effective.js';
import {
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
  const serviceUrl = getConfigServiceUrl();
  try {
    return await requestJson<SiftConfig>({
      url: serviceUrl,
      method: 'GET',
      timeoutMs: 130_000,
    });
  } catch (error) {
    throw toStatusServerUnavailableError({
      cause: error,
      operation: 'config:get',
      serviceUrl,
    });
  }
}

async function setConfigInService(config: SiftConfig): Promise<SiftConfig> {
  const serviceUrl = getConfigServiceUrl();
  try {
    return await requestJson<SiftConfig>({
      url: serviceUrl,
      method: 'PUT',
      timeoutMs: 2000,
      body: JSON.stringify(toPersistedConfigObject(config)),
    });
  } catch (error) {
    throw toStatusServerUnavailableError({
      cause: error,
      operation: 'config:set',
      serviceUrl,
    });
  }
}

export async function saveConfig(config: SiftConfig): Promise<SiftConfig> {
  return setConfigInService(config);
}

async function addLoadedConfigProperties(config: SiftConfig): Promise<SiftConfig> {
  return addEffectiveConfigProperties(updateRuntimePaths(config));
}

export async function normalizeLoadedConfig(config: SiftConfig): Promise<SiftConfig> {
  return addLoadedConfigProperties(normalizeConfig(config).config);
}

export async function loadConfig(options?: { ensure?: boolean }): Promise<SiftConfig> {
  void options;
  const config = await getConfigFromService();
  return addLoadedConfigProperties(normalizeConfig(config).config);
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
