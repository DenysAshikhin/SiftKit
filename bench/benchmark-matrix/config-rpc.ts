import { httpClient } from '../../src/lib/http-client.js';
import { isJsonObject, type OptionalJsonValue } from '../../src/lib/json-types.js';
import { sleep } from '../../src/lib/time.js';
import { LlamaCppClient } from '../../src/llm-protocol/llama-cpp-client.js';
import { ConfigRecordSchema, type ConfigRecord } from './types.js';

const llamaCppClient = new LlamaCppClient();

export async function invokeConfigGet(configUrl: string): Promise<ConfigRecord> {
  return httpClient.requestJson({
    url: configUrl,
    method: 'GET',
    timeoutMs: 10_000,
  }, ConfigRecordSchema);
}

export async function invokeConfigSet(configUrl: string, config: ConfigRecord): Promise<ConfigRecord> {
  return httpClient.requestJson({
    url: configUrl,
    method: 'PUT',
    timeoutMs: 10_000,
    body: JSON.stringify(config),
  }, ConfigRecordSchema);
}

export function getRuntimeLlamaCppConfigValue(config: ConfigRecord, key: string): OptionalJsonValue {
  const runtime = isJsonObject(config.Runtime) ? config.Runtime : null;
  const runtimeLlamaCpp = runtime && isJsonObject(runtime.LlamaCpp) ? runtime.LlamaCpp : null;
  if (runtimeLlamaCpp && Object.prototype.hasOwnProperty.call(runtimeLlamaCpp, key)) {
    return runtimeLlamaCpp[key];
  }

  const llamaCpp = isJsonObject(config.LlamaCpp) ? config.LlamaCpp : null;
  return llamaCpp?.[key];
}

export async function getLlamaModels(baseUrl: string): Promise<string[]> {
  return llamaCppClient.listModelsAtBaseUrl(baseUrl, 10_000);
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
