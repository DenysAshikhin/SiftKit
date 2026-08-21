import type { FullJsonResponse, RequestJsonOptions, SseStreamOptions } from '../../src/lib/http-client.js';
import type { JsonSerializable } from '../../src/lib/json-types.js';
import type { SseFrame } from '../../src/lib/sse-frame-parser.js';
import { getDefaultConfigObject } from '../../src/config/defaults.js';
import type { SiftConfig } from '../../src/config/types.js';

export const STREAM_TEST_BASE_URL = 'http://127.0.0.1:8097';

export function buildStreamingTestConfig(): SiftConfig {
  const config = getDefaultConfigObject();
  const preset = config.Server.ModelPresets.Presets[0];
  if (!preset) {
    throw new Error('default config must include a model preset');
  }
  preset.id = 'p1';
  preset.label = 'p1';
  preset.Model = 'local';
  preset.BaseUrl = STREAM_TEST_BASE_URL;
  preset.Reasoning = 'off';
  config.Server.ModelPresets.ActivePresetId = 'p1';
  config.Runtime.LlamaCpp = { ...config.Runtime.LlamaCpp, BaseUrl: STREAM_TEST_BASE_URL };
  return config;
}

/** A single content delta, serialized as the client expects it on the wire. */
export function contentFrame(text: string): string {
  return JSON.stringify({ choices: [{ delta: { content: text } }] });
}

/** Yields raw frame strings verbatim so tests can emit malformed JSON. */
export class RawFrameHttpClient {
  constructor(private readonly frames: string[]) {}

  async requestJsonFull<T>(options: RequestJsonOptions): Promise<FullJsonResponse<T>> {
    throw new Error(`requestJsonFull must not be called for chat completions (${options.url})`);
  }

  async *streamSse(_options: SseStreamOptions): AsyncGenerator<SseFrame> {
    for (const data of this.frames) {
      yield { event: 'message', data };
    }
  }
}

export class RecordingLogger {
  readonly events: Record<string, JsonSerializable>[] = [];

  write(event: Record<string, JsonSerializable>): void {
    this.events.push(event);
  }
}
