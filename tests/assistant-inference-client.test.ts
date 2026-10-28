import { emptyInferenceThroughput } from '../src/lib/inference-throughput.ts';
import test from 'node:test';
import assert from 'node:assert/strict';

import { DefaultAssistantInferenceClient } from '../src/assistant/inference/client.ts';
import type { AssistantChatBackend } from '../src/assistant/inference/client.ts';
import { getActiveModelPreset, getConfiguredContextTokens } from '../src/config/getters.ts';
import type { ModelRuntimePreset, SiftConfig } from '../src/config/types.ts';
import { AppliedModelPresetState } from '../src/status-server/applied-model-preset-state.ts';
import type { InferenceChatOptions } from '../src/llm-protocol/inference-client.ts';
import { CLEAN_STREAM_STOP, type InferenceContentPart, type NormalizedInferenceChatResponse } from '../src/llm-protocol/types.ts';
import { mockSiftConfig } from './helpers/mock-config.ts';

const PNG_DATA_URL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAf'
  + 'FcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

/** The default preset is text-only; image roles need a vision-capable preset. */
function presetConfig(overrides: Partial<ModelRuntimePreset>): SiftConfig {
  const base = mockSiftConfig({});
  const presets = base.Server.ModelPresets.Presets.map((preset) => (
    preset.id === base.Server.ModelPresets.ActivePresetId ? { ...preset, ...overrides } : preset
  ));
  return {
    ...base,
    Server: {
      ...base.Server,
      ModelPresets: { ...base.Server.ModelPresets, Presets: presets },
    },
  };
}

function visionConfig(): SiftConfig {
  return presetConfig({ Backend: 'exl3', VisionEnabled: true, VisionImageRetention: 1 });
}

/** Production supplies `AppliedModelPresetState`; a test starts it on the config's own preset. */
function buildClient(config: SiftConfig, backend: AssistantChatBackend): DefaultAssistantInferenceClient {
  return new DefaultAssistantInferenceClient(
    config, new AppliedModelPresetState(getActiveModelPreset(config)), backend,
  );
}

function contentParts(content: string | InferenceContentPart[] | null | undefined): InferenceContentPart[] {
  if (!Array.isArray(content)) throw new Error('expected multimodal content parts');
  return content;
}

class RecordingBackend implements AssistantChatBackend {
  readonly requests: InferenceChatOptions[] = [];

  private readonly responseText: string;

  constructor(responseText: string) {
    this.responseText = responseText;
  }

  async chat(options: InferenceChatOptions): Promise<NormalizedInferenceChatResponse> {
    this.requests.push(options);
    return {
      text: this.responseText,
      rawText: this.responseText,
      narrationText: this.responseText,
      classification: 'narration',
      reasoningText: '',
      toolCalls: [],
      usage: {
    throughput: emptyInferenceThroughput(), promptTokens: 1, completionTokens: 1, totalTokens: 2, outputTokens: 1, thinkingTokens: 0, promptCacheTokens: 0, promptEvalTokens: 0 },
      raw: {},
      stop: CLEAN_STREAM_STOP,
    };
  }
}

test('image admission follows the applied preset, not the config the client was built with', async () => {
  const textOnly = presetConfig({ Backend: 'exl3', VisionEnabled: false });
  const applied = new AppliedModelPresetState(getActiveModelPreset(textOnly));
  const backend = new RecordingBackend('');
  const client = new DefaultAssistantInferenceClient(textOnly, applied, backend);
  const request = {
    messages: [{ role: 'user', content: 'Describe the screenshot.' }], images: [PNG_DATA_URL], tools: [],
    abortSignal: new AbortController().signal,
  } as const;

  await assert.rejects(client.chat(request));
  assert.equal(backend.requests.length, 0);

  // The same switch the capability gate sees: applying a vision preset makes the runtime capable,
  // so the capture it then enqueues must not be refused by a stale config snapshot.
  applied.applyPreset(getActiveModelPreset(visionConfig()));
  await client.chat(request);
  assert.equal(backend.requests.length, 1);
});

const SEARCH_TOOL = { type: 'function', function: { name: 'search_notes', description: 'Search.', parameters: { type: 'object' } } } as const;

test('an agent turn sends the tools, no response format, reasoning off, and images on the first user message only', async () => {
  const backend = new RecordingBackend('');
  const config = visionConfig();
  const client = buildClient(config, backend);
  await client.chat({
    messages: [{ role: 'system', content: 'sys' }, { role: 'user', content: 'seed' }, { role: 'user', content: 'later' }],
    images: [PNG_DATA_URL], tools: [SEARCH_TOOL], abortSignal: new AbortController().signal,
  });
  const sent = backend.requests[0];
  assert.ok(sent);
  assert.deepEqual(sent.tools, [SEARCH_TOOL]);
  assert.deepEqual(sent.allowedToolNames, ['search_notes']);
  assert.equal(sent.reasoningOverride, 'off');
  assert.equal(sent.responseFormat, undefined);
  assert.equal(sent.messages[0]?.content, 'sys');
  const parts = contentParts(sent.messages[1]?.content);
  assert.deepEqual([parts[0]?.type, parts[0]?.text, parts[1]?.type], ['text', 'seed', 'image_url']);
  assert.equal(sent.messages[2]?.content, 'later');
  assert.equal(sent.throughputAudit.stage, 'agent_vault_writer');
  assert.equal(sent.throughputAudit.presetId, getActiveModelPreset(config).id);
});

test('an agent turn with images against a text-only preset never reaches the wire; text-only turns do', async () => {
  const backend = new RecordingBackend('');
  const client = buildClient(presetConfig({ Backend: 'exl3', VisionEnabled: false }), backend);
  const request = { messages: [{ role: 'user', content: 'seed' }], tools: [], abortSignal: new AbortController().signal } as const;
  await assert.rejects(client.chat({ ...request, images: [PNG_DATA_URL] }));
  assert.equal(backend.requests.length, 0);
  await client.chat({ ...request, images: [] });
  assert.equal(backend.requests[0]?.messages[0]?.content, 'seed');
});

test('an agent turn refuses an already aborted signal, and contextTokens reports the preset window', async () => {
  const backend = new RecordingBackend('');
  const config = mockSiftConfig({});
  const client = buildClient(config, backend);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(client.chat({ messages: [], images: [], tools: [], abortSignal: controller.signal }), /abort/i);
  assert.equal(backend.requests.length, 0);
  assert.equal(client.contextTokens(), getConfiguredContextTokens(config).totalContextTokens);
});
