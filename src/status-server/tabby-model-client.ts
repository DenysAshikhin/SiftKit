import { z } from 'zod';

import {
  Exl3LoadRequestSchema,
  type Exl3LoadRequest,
} from '../inference-presets/exl3-preset-adapter.js';

const TabbyModelCardSchema = z.object({
  id: z.string(),
  /** TabbyAPI reports the parameters it actually applied; absent before a model finishes loading. */
  parameters: z.object({
    max_seq_len: z.number(),
    cache_size: z.number(),
    chunk_size: z.number(),
  }).nullish(),
});
export type TabbyModelCard = z.infer<typeof TabbyModelCardSchema>;
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

function buildHeaders(adminApiKey: string, json: boolean): Record<string, string> {
  const headers: Record<string, string> = {};
  if (json) headers['content-type'] = 'application/json';
  if (adminApiKey) headers.authorization = `Bearer ${adminApiKey}`;
  return headers;
}

async function readError(response: Response): Promise<string> {
  const text = (await response.text()).trim();
  return text ? `: ${text}` : '';
}

export class TabbyModelClient {
  constructor(private readonly adminApiKey: string) {}

  async isProcessReady(baseUrl: string, timeoutMs: number): Promise<boolean> {
    let response: Response;
    try {
      response = await fetch(buildEndpoint(baseUrl, '/v1/models'), {
        headers: buildHeaders(this.adminApiKey, false),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      return false;
    }
    if (!response.ok) {
      throw new Error(`Tabby process readiness probe failed with HTTP ${response.status}${await readError(response)}`);
    }
    return true;
  }

  async load(baseUrl: string, request: Exl3LoadRequest, timeoutMs: number): Promise<void> {
    Exl3LoadRequestSchema.parse(request);
    const response = await fetch(buildEndpoint(baseUrl, '/v1/model/load'), {
      method: 'POST',
      headers: buildHeaders(this.adminApiKey, true),
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
    await this.verifyResident(baseUrl, request, timeoutMs);
  }

  async unload(baseUrl: string, timeoutMs: number): Promise<void> {
    const response = await fetch(buildEndpoint(baseUrl, '/v1/model/unload'), {
      method: 'POST',
      headers: buildHeaders(this.adminApiKey, false),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) {
      throw new Error(`Tabby model unload failed with HTTP ${response.status}${await readError(response)}`);
    }
    const card = await this.getResidentModel(baseUrl, timeoutMs);
    if (card !== null) {
      throw new Error(`Tabby model unload completed but '${card.id}' is still resident.`);
    }
  }

  async getResidentModel(baseUrl: string, timeoutMs: number): Promise<TabbyModelCard | null> {
    const response = await fetch(buildEndpoint(baseUrl, '/v1/model'), {
      headers: buildHeaders(this.adminApiKey, false),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (response.status === 503) return null;
    if (!response.ok) {
      throw new Error(`Tabby current-model probe failed with HTTP ${response.status}${await readError(response)}`);
    }
    return TabbyModelCardSchema.parse(await response.json());
  }

  /** Proves the server is serving exactly what the preset asked for, not a clamped or stale variant. */
  async verifyResident(baseUrl: string, request: Exl3LoadRequest, timeoutMs: number): Promise<void> {
    const card = await this.getResidentModel(baseUrl, timeoutMs);
    if (card === null || card.id !== request.model_name) {
      throw new Error(
        `Tabby model '${request.model_name}' is not resident (resident=${card === null ? 'none' : card.id}).`,
      );
    }
    if (card.parameters === null || card.parameters === undefined) {
      throw new Error(`Tabby model '${card.id}' reports no applied parameters.`);
    }
    const divergences = [
      { field: 'max_seq_len', expected: request.max_seq_len, applied: card.parameters.max_seq_len },
      { field: 'cache_size', expected: request.cache_size, applied: card.parameters.cache_size },
      { field: 'chunk_size', expected: request.chunk_size, applied: card.parameters.chunk_size },
    ].filter((entry) => entry.expected !== entry.applied);
    if (divergences.length > 0) {
      throw new Error(`Tabby model '${card.id}' diverges from the preset: ${divergences
        .map((entry) => `${entry.field} expected ${entry.expected} but Tabby applied ${entry.applied}`)
        .join('; ')}.`);
    }
  }
}
