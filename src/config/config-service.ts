import { httpClient } from '../lib/http-client.js';
import { toError } from '../lib/errors.js';
import { addEffectiveConfigProperties } from './effective.js';
import {
  normalizeConfig,
  normalizeConfigObject,
  toPersistedConfigObject,
  updateRuntimePaths,
} from './normalization.js';
import {
  deriveServiceUrl,
  getStatusBackendUrl,
  toStatusServerUnavailableError,
} from './status-backend.js';
import type { SiftConfig } from './types.js';
import { JsonObjectSchema, JsonValueSchema, type JsonObject } from '../lib/json-types.js';

export function getConfigServiceUrl(): string {
  const configuredUrl = process.env.SIFTKIT_CONFIG_SERVICE_URL;
  if (configuredUrl && configuredUrl.trim()) {
    return configuredUrl.trim();
  }

  return deriveServiceUrl(getStatusBackendUrl(), '/config');
}

async function getConfigFromService(): Promise<JsonObject> {
  const serviceUrl = getConfigServiceUrl();
  try {
    return await httpClient.requestJson({
      url: serviceUrl,
      method: 'GET',
      timeoutMs: 130_000,
    }, JsonObjectSchema);
  } catch (error) {
    throw toStatusServerUnavailableError({
      cause: toError(error),
      operation: 'config:get',
      serviceUrl,
    });
  }
}

async function setConfigInService(config: SiftConfig): Promise<JsonObject> {
  const serviceUrl = getConfigServiceUrl();
  try {
    return await httpClient.requestJson({
      url: serviceUrl,
      method: 'PUT',
      timeoutMs: 2000,
      body: JSON.stringify(toPersistedConfigObject(config)),
    }, JsonObjectSchema);
  } catch (error) {
    throw toStatusServerUnavailableError({
      cause: toError(error),
      operation: 'config:set',
      serviceUrl,
    });
  }
}

export async function saveConfig(config: SiftConfig): Promise<SiftConfig> {
  return normalizeConfigObject(await setConfigInService(config));
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
  return addLoadedConfigProperties(normalizeConfigObject(config));
}

export async function setTopLevelConfigKey<TValue>(key: string, value: TValue): Promise<SiftConfig> {
  const config = await loadConfig({ ensure: true });
  if (!Object.prototype.hasOwnProperty.call(config, key)) {
    throw new Error(`Unknown top-level config key: ${key}`);
  }
  const parsedValue = JsonValueSchema.parse(value);

  await saveConfig(normalizeConfig({
    ...toPersistedConfigObject(config),
    [key]: parsedValue,
  }).config);
  return loadConfig({ ensure: true });
}
