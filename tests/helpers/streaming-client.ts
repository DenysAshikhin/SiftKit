import type { ServerResponse } from 'node:http';
import type { FullJsonResponse, RequestJsonOptions, SseStreamOptions } from '../../src/lib/http-client.js';
import { isJsonObject, type JsonObject, type JsonSerializable } from '../../src/lib/json-types.js';
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

/**
 * Replays a full chat-completion body as SSE deltas so streamed callers see the
 * same content and usage a blocking body would have carried. All chat requests
 * stream, so every fake chat-completions endpoint must answer this way.
 */
export function sendChatCompletionSse(res: ServerResponse, body: JsonObject): void {
  const choices = Array.isArray(body.choices) ? body.choices : [];
  const firstChoice = isJsonObject(choices[0]) ? choices[0] : {};
  const message = isJsonObject(firstChoice.message) ? firstChoice.message : {};
  const reasoningContent = typeof message.reasoning_content === 'string' ? message.reasoning_content : '';
  const content = typeof message.content === 'string' ? message.content : '';
  const writePacket = (packet: JsonObject): void => { res.write(`data: ${JSON.stringify(packet)}\n\n`); };
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  if (reasoningContent) {
    writePacket({ choices: [{ index: 0, delta: { reasoning_content: reasoningContent } }] });
  }
  if (content) {
    writePacket({ choices: [{ index: 0, delta: { content } }] });
  }
  const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
  if (toolCalls.length > 0) {
    writePacket({
      choices: [{
        index: 0,
        delta: { tool_calls: toolCalls.map((call, index) => ({ index, ...(isJsonObject(call) ? call : {}) })) },
      }],
    });
  }
  writePacket({
    choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
    ...(body.usage === undefined ? {} : { usage: body.usage }),
  });
  res.write('data: [DONE]\n\n');
  res.end();
}
