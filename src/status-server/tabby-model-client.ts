import { z } from 'zod';

import {
  Exl3LoadRequestSchema,
  type Exl3LoadRequest,
} from '../inference-presets/exl3-preset-adapter.js';

const TabbyModelCardSchema = z.object({ id: z.string() });
const TabbyLoadProgressSchema = z.object({
  model_type: z.string(),
  module: z.number().int().nonnegative(),
  modules: z.number().int().positive(),
  status: z.enum(['processing', 'finished']),
});

function buildEndpoint(baseUrl: string, pathname: string): string {
  const url = new URL(baseUrl);
  url.username = '';
  url.password = '';
  url.pathname = pathname;
  url.search = '';
  url.hash = '';
  return url.toString();
}

async function readError(response: Response): Promise<string> {
  const text = (await response.text()).trim();
  return text ? `: ${text}` : '';
}

export class TabbyModelClient {
  async load(baseUrl: string, request: Exl3LoadRequest, timeoutMs: number): Promise<void> {
    const expected = Exl3LoadRequestSchema.parse(request).model_name;
    const response = await fetch(buildEndpoint(baseUrl, '/v1/model/load'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(request),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) {
      throw new Error(`Tabby model load failed with HTTP ${response.status}${await readError(response)}`);
    }

    const packets = (await response.text())
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trim())
      .filter((line) => line !== '' && line !== '[DONE]')
      .map((line) => TabbyLoadProgressSchema.parse(JSON.parse(line)));
    if (!packets.some((packet) => packet.status === 'finished' && packet.module === packet.modules)) {
      throw new Error('Tabby model load ended without a terminal finished event.');
    }
    const models = await this.listModels(baseUrl, timeoutMs);
    if (!models.includes(expected)) {
      throw new Error(`Tabby reported load completion but model '${expected}' is not resident.`);
    }
  }

  async unload(baseUrl: string, timeoutMs: number): Promise<void> {
    const response = await fetch(buildEndpoint(baseUrl, '/v1/model/unload'), {
      method: 'POST',
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) {
      throw new Error(`Tabby model unload failed with HTTP ${response.status}${await readError(response)}`);
    }
    const models = await this.listModels(baseUrl, timeoutMs);
    if (models.length > 0) {
      throw new Error(`Tabby model unload completed but '${models[0]}' is still resident.`);
    }
  }

  async listModels(baseUrl: string, timeoutMs: number): Promise<string[]> {
    const response = await fetch(buildEndpoint(baseUrl, '/v1/model'), {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (response.status === 400 || response.status === 404 || response.status === 503) {
      return [];
    }
    if (!response.ok) {
      throw new Error(`Tabby current-model probe failed with HTTP ${response.status}${await readError(response)}`);
    }
    return [TabbyModelCardSchema.parse(await response.json()).id];
  }
}
