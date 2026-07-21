import type http from 'node:http';

import { Exl3LoadRequestSchema } from '../../src/inference-presets/exl3-preset-adapter.js';

/**
 * Models TabbyAPI's `/v1/model` card: a loaded server reports the parameters it actually applied,
 * so a fake that echoes the load request proves the runtime verifies what it asked for.
 */
export class FakeTabbyModelState {
  private card: {
    id: string;
    parameters: { max_seq_len: number; cache_size: number; chunk_size: number };
  } | null = null;

  applyLoad(bodyText: string): void {
    const request = Exl3LoadRequestSchema.parse(JSON.parse(bodyText));
    this.card = {
      id: request.model_name,
      parameters: {
        max_seq_len: request.max_seq_len,
        cache_size: request.cache_size,
        chunk_size: request.chunk_size,
      },
    };
  }

  applyResidentModel(id: string, maxSeqLen: number, cacheSize: number, chunkSize: number): void {
    this.card = { id, parameters: { max_seq_len: maxSeqLen, cache_size: cacheSize, chunk_size: chunkSize } };
  }

  clear(): void {
    this.card = null;
  }

  get resident(): boolean {
    return this.card !== null;
  }

  respondCurrentModel(response: http.ServerResponse): void {
    if (this.card === null) {
      response.statusCode = 503;
      response.end('No models are currently loaded');
      return;
    }
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify(this.card));
  }
}
