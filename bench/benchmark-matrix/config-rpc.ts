import { httpClient } from '../../src/lib/http-client.js';
import { isJsonObject, type OptionalJsonValue } from '../../src/lib/json-types.js';
import { sleep } from '../../src/lib/time.js';
import { InferenceClient } from '../../src/llm-protocol/inference-client.js';
import { ConfigRecordSchema, type ConfigRecord } from './types.js';

const inferenceClient = new InferenceClient();

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

export function getActivePresetBaseUrl(config: ConfigRecord): OptionalJsonValue {
  const server = isJsonObject(config.Server) ? config.Server : null;
  const modelPresets = server && isJsonObject(server.ModelPresets) ? server.ModelPresets : null;
  if (!modelPresets || !Array.isArray(modelPresets.Presets)) {
    return undefined;
  }
  const presets = modelPresets.Presets.filter(isJsonObject);
  const active = presets.find((preset) => preset.id === modelPresets.ActivePresetId) ?? presets[0];
  return active?.BaseUrl;
}

export async function getInferenceModels(baseUrl: string): Promise<string[]> {
  return inferenceClient.listModelsAtBaseUrl(baseUrl, 10_000);
}

export async function waitForEngineReadiness(
  baseUrl: string,
  expectedModelId: string,
  timeoutSeconds = 180,
): Promise<string[]> {
  const deadline = Date.now() + (timeoutSeconds * 1000);
  let lastError = '';

  while (Date.now() < deadline) {
    try {
      const models = await getInferenceModels(baseUrl);
      if (models.includes(expectedModelId)) {
        return models;
      }

      lastError = `Inference engine is reachable but expected model '${expectedModelId}' is not loaded. Available models: ${models.length > 0 ? models.join(', ') : '<none>'}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }

    await sleep(2_000);
  }

  throw new Error(`Timed out waiting for the inference engine at ${baseUrl} to load model '${expectedModelId}'. Last error: ${lastError}`);
}
