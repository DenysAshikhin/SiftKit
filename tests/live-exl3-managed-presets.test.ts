import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { z } from 'zod';
import {
  InferenceRuntimeDashboardStatusSchema, ModelLifecycleResponseSchema, ServerModelPresetsConfigSchema, type ModelRuntimePreset,
} from '@siftkit/contracts';
import { SIFT_DEFAULT_STATUS_PORT } from '../src/config/constants.ts';
import { parseJsonValueText } from '../src/lib/json.ts';
import type { JsonValue } from '../src/lib/json-types.ts';
import { SseFrameParser } from '../src/lib/sse-frame-parser.ts';

// Acceptance test for an EXL3 upgrade: drives every managed preset through the running status server.
const LIVE_ENABLED = process.env.SIFTKIT_TEST_LIVE_EXL3_PRESETS === '1';
const BASE_URL = `http://127.0.0.1:${SIFT_DEFAULT_STATUS_PORT}`;
const LONG_PROMPT_PATH = path.resolve('scripts', 'exl3-context-64k.txt');
const CACHE_RETENTION_FRACTION = 0.9;
const READY_TIMEOUT_MS = 1_200_000;
const REQUEST_TIMEOUT_MS = 1_200_000;

const ConfigSchema = z.object({ Server: z.object({ ModelPresets: ServerModelPresetsConfigSchema }) });
const UsageSchema = z.object({
  prompt_tokens: z.number().int(),
  completion_tokens: z.number().int(),
  prompt_tokens_details: z.object({ cached_tokens: z.number().int() }),
  completion_tokens_details: z.object({
    accepted_prediction_tokens: z.number().int(), rejected_prediction_tokens: z.number().int(),
  }),
});
type Usage = z.infer<typeof UsageSchema>;
const StreamChunkSchema = z.object({ usage: UsageSchema.nullish() });
const CompletionSchema = z.object({
  choices: z.array(z.object({ message: z.object({ content: z.string() }) })).length(1),
  usage: UsageSchema,
});
const CapitalSchema = z.object({ city: z.literal('Paris'), letters: z.literal(5) }).strict();

async function request(method: 'GET' | 'PUT' | 'POST', route: string, body?: JsonValue): Promise<Response> {
  const response = await fetch(`${BASE_URL}${route}`, {
    method,
    headers: { 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`${method} ${route} returned ${response.status}: ${await response.text()}`);
  return response;
}

async function requestJson(method: 'GET' | 'PUT' | 'POST', route: string, body?: JsonValue): Promise<JsonValue> {
  return parseJsonValueText(await (await request(method, route, body)).text());
}

async function waitReady(presetId: string): Promise<void> {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const status = InferenceRuntimeDashboardStatusSchema.parse(await requestJson('GET', '/runtime/inference'));
    if (status.error !== null) throw new Error(`${presetId} failed in ${status.errorPhase ?? 'runtime'}: ${status.error}`);
    if (status.activePresetId === presetId && status.processState === 'ready' && status.modelState === 'ready') return;
    await new Promise((resolve) => { setTimeout(resolve, 2000); });
  }
  throw new Error(`${presetId} was not ready within ${READY_TIMEOUT_MS} ms`);
}

async function activate(presetId: string): Promise<void> {
  await request('PUT', '/config', { Server: { ModelPresets: { ActivePresetId: presetId } } });
  await request('POST', '/status/restart', {});
  await waitReady(presetId);
}

async function lifecycle(action: 'load' | 'unload'): Promise<void> {
  const result = ModelLifecycleResponseSchema.parse(await requestJson('POST', `/runtime/model/${action}`, {}));
  assert.equal(result.ok, true, `model ${action} failed: ${JSON.stringify(result)}`);
}

/** Streams a completion and returns the final usage frame, which must arrive. */
async function streamUsage(prompt: string, maxTokens: number): Promise<Usage> {
  const response = await request('POST', '/v1/chat/completions', {
    messages: [{ role: 'user', content: prompt }],
    max_tokens: maxTokens, stream: true, stream_options: { include_usage: true },
  });
  if (!response.body) throw new Error('Streaming response has no body');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const parser = new SseFrameParser();
  let usage: Usage | null = null;
  for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) {
    for (const frame of parser.push(decoder.decode(chunk.value, { stream: true }))) {
      if (frame.data === '[DONE]') continue;
      usage = StreamChunkSchema.parse(parseJsonValueText(frame.data)).usage ?? usage;
    }
  }
  if (usage === null) throw new Error('Stream ended without a usage frame');
  return usage;
}

async function assertSchemaOutput(): Promise<void> {
  const completion = CompletionSchema.parse(await requestJson('POST', '/v1/chat/completions', {
    messages: [{ role: 'user', content: 'Return the capital of France and the number of letters in its name.' }],
    max_tokens: 4096,
    response_format: { type: 'json_schema', json_schema: { name: 'capital', strict: true, schema: {
      type: 'object', additionalProperties: false, required: ['city', 'letters'],
      properties: { city: { type: 'string' }, letters: { type: 'integer' } },
    } } },
  }));
  const [choice] = completion.choices;
  if (!choice) throw new Error('Completion has no choice');
  CapitalSchema.parse(parseJsonValueText(choice.message.content));
}

async function assertLongPromptReused(longPrompt: string): Promise<void> {
  const cold = await streamUsage(longPrompt, 256);
  const warm = await streamUsage(longPrompt, 256);
  assert.ok(warm.prompt_tokens_details.cached_tokens >= cold.prompt_tokens * CACHE_RETENTION_FRACTION,
    `repeat reused ${warm.prompt_tokens_details.cached_tokens} of ${cold.prompt_tokens} prompt tokens`);
}

async function exercisePreset(preset: ModelRuntimePreset, longPrompt: string): Promise<void> {
  await activate(preset.id);
  const draft = await streamUsage('Write the integers from 1 to 150 separated by single spaces, nothing else.', 2048);
  assert.ok(draft.completion_tokens > 0, 'no completion tokens');
  if (preset.SpeculativeEnabled) {
    assert.ok(draft.completion_tokens_details.accepted_prediction_tokens > 0, 'MTP accepted no draft tokens');
  }
  await assertSchemaOutput();
  await assertLongPromptReused(longPrompt);
  await lifecycle('unload');
  await lifecycle('load');
  await waitReady(preset.id);
  assert.ok((await streamUsage('Say hello in five words.', 1024)).completion_tokens > 0, 'no completion after reload');
}

test('managed EXL3 presets stream, constrain, cache, reload, and restore disk-cached prompts across switches', {
  timeout: 3 * 3_600_000,
  skip: LIVE_ENABLED ? false : 'set SIFTKIT_TEST_LIVE_EXL3_PRESETS=1 with the managed status server running',
}, async (t) => {
  const longPrompt = `${readFileSync(LONG_PROMPT_PATH, 'utf8')}\n\nHow many distinct words appear above? Answer in one word.`;
  const modelPresets = ConfigSchema.parse(await requestJson('GET', '/config')).Server.ModelPresets;
  const presets = modelPresets.Presets.filter((preset) => preset.Backend === 'exl3' && !preset.ExternalServerEnabled);
  try {
    for (const preset of presets) {
      await t.test(preset.id, async () => { await exercisePreset(preset, longPrompt); });
    }
    // Each disk-cache preset ran the long prompt above, so after switching back it is restored from disk.
    const diskCached = presets.filter((preset) => preset.DiskCacheDir !== null);
    for (const preset of diskCached.length > 1 ? diskCached : []) {
      await t.test(`${preset.id} restores the long prompt from disk after a switch`, async () => {
        await activate(preset.id);
        const usage = await streamUsage(longPrompt, 256);
        assert.ok(usage.prompt_tokens_details.cached_tokens >= usage.prompt_tokens * CACHE_RETENTION_FRACTION,
          `restored ${usage.prompt_tokens_details.cached_tokens} of ${usage.prompt_tokens} prompt tokens`);
      });
    }
  } finally {
    await activate(modelPresets.ActivePresetId);
  }
});
