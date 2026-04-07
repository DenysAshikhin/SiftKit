import { requestJson } from '../lib/http.js';
import { sleep } from '../lib/time.js';
import type { ConfigRecord } from './types.js';

export async function invokeConfigGet(configUrl: string): Promise<ConfigRecord> {
  return requestJson<ConfigRecord>({
    url: configUrl,
    method: 'GET',
    timeoutMs: 10_000,
  });
}

export async function invokeConfigSet(configUrl: string, config: ConfigRecord): Promise<ConfigRecord> {
  return requestJson<ConfigRecord>({
    url: configUrl,
    method: 'PUT',
    timeoutMs: 10_000,
    body: JSON.stringify(config),
  });
}

export function getRuntimeLlamaCppConfigValue(config: ConfigRecord, key: string): unknown {
  const runtime = typeof config.Runtime === 'object' && config.Runtime !== null
    ? config.Runtime as Record<string, unknown>
    : null;
  const runtimeLlamaCpp = runtime && typeof runtime.LlamaCpp === 'object' && runtime.LlamaCpp !== null
    ? runtime.LlamaCpp as Record<string, unknown>
    : null;
  if (runtimeLlamaCpp && Object.prototype.hasOwnProperty.call(runtimeLlamaCpp, key)) {
    return runtimeLlamaCpp[key];
  }

  const llamaCpp = typeof config.LlamaCpp === 'object' && config.LlamaCpp !== null
    ? config.LlamaCpp as Record<string, unknown>
    : null;
  return llamaCpp?.[key];
}

export async function getLlamaModels(baseUrl: string): Promise<string[]> {
  const response = await requestJson<{ data?: Array<{ id?: string | null }> }>({
    url: `${baseUrl.replace(/\/$/u, '')}/v1/models`,
    method: 'GET',
    timeoutMs: 10_000,
  });

  return Array.isArray(response.data)
    ? response.data
      .map((item) => String(item?.id ?? '').trim())
      .filter(Boolean)
    : [];
}

export async function waitForLlamaReadiness(
  baseUrl: string,
  expectedModelId: string,
  timeoutSeconds = 180,
): Promise<string[]> {
  const deadline = Date.now() + (timeoutSeconds * 1000);
  let lastError = '';

  while (Date.now() < deadline) {
    try {
      const models = await getLlamaModels(baseUrl);
      if (models.includes(expectedModelId)) {
        return models;
      }

      lastError = `llama-server is reachable but expected model '${expectedModelId}' is not loaded. Available models: ${models.length > 0 ? models.join(', ') : '<none>'}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }

    await sleep(2_000);
  }

  throw new Error(`Timed out waiting for llama-server at ${baseUrl} to load model '${expectedModelId}'. Last error: ${lastError}`);
}
