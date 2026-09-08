import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { z } from 'zod';
import { JsonValueSchema, type JsonObject, type JsonValue } from '../src/lib/json-types.js';
import { rasterBuffer, toDataUrl } from './helpers/image-fixtures.js';

const UsageSchema = z.object({
  prompt_tokens: z.number().int().nonnegative(),
  completion_tokens: z.number().int().nonnegative(),
  total_tokens: z.number().int().nonnegative(),
  prompt_tokens_details: z.object({ cached_tokens: z.number().int().nonnegative() }),
  completion_tokens_details: z.object({
    accepted_prediction_tokens: z.number().int().nonnegative(),
    rejected_prediction_tokens: z.number().int().nonnegative(),
  }),
});
const CompletionSchema = z.object({
  choices: z.array(z.object({ message: z.object({ content: z.string().nullable() }) })).min(1),
  usage: UsageSchema,
});

async function request(url: string, body?: JsonObject): Promise<Response> {
  return fetch(url, {
    method: body ? 'POST' : 'GET',
    headers: { 'content-type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(300_000),
  });
}

async function json(url: string, body?: JsonObject): Promise<JsonValue> {
  const response = await request(url, body);
  assert.ok(response.ok, `${url}: HTTP ${response.status} ${response.ok ? '' : await response.text()}`);
  return JsonValueSchema.parse(await response.json());
}

// Run this bundle directly, with the opt-in flag, against a managed production runtime.
// It uses the configured model and ends with that same model loaded.
test('live upstream Tabby load, usage, vision, concurrency and reload', {
  skip: process.env.SIFTKIT_TEST_LIVE_TABBY_UPSTREAM !== '1', timeout: 900_000,
}, async () => {
  const options = z.object({ base: z.url(), status: z.url(), context: z.coerce.number().int().positive() }).parse({
    base: process.env.SIFTKIT_LIVE_TABBY_URL,
    status: process.env.SIFTKIT_LIVE_STATUS_URL,
    context: process.env.SIFTKIT_LIVE_TABBY_CONTEXT,
  });
  const models = z.object({ data: z.array(z.object({ id: z.string() })).min(1) }).parse(await json(`${options.base}/v1/models`));
  const model = models.data[0];
  assert.ok(model);
  const props = z.object({ total_slots: z.number(), default_generation_settings: z.object({ n_ctx: z.number() }) })
    .parse(await json(`${options.base}/props`));
  assert.equal(props.total_slots, 1);
  assert.equal(props.default_generation_settings.n_ctx, options.context);
  const chatUrl = `${options.base}/v1/chat/completions`;
  const body = {
    model: model.id, temperature: 0, max_tokens: 64, enable_thinking: false,
    stream_options: { include_usage: true },
    messages: [{ role: 'user', content: `Verification ${randomUUID()}. ${'Cache verification sentence. '.repeat(80)} Reply with verified, then explain in one sentence why repeated prompts can reuse cached tokens.` }],
  };
  const cold = CompletionSchema.parse(await json(chatUrl, body));
  const warm = CompletionSchema.parse(await json(chatUrl, body));
  assert.match(cold.choices[0]?.message.content ?? '', /verified/iu);
  assert.ok(warm.usage.prompt_tokens_details.cached_tokens > cold.usage.prompt_tokens_details.cached_tokens);
  assert.ok(warm.usage.completion_tokens_details.accepted_prediction_tokens > 0
    || warm.usage.completion_tokens_details.rejected_prediction_tokens > 0, 'MTP must report draft activity');
  console.log(JSON.stringify({ phase: 'cold-warm', cold: cold.usage, warm: warm.usage }));

  const streamResponse = await request(chatUrl, { ...body, stream: true, stream_options: { include_usage: true } });
  assert.ok(streamResponse.ok);
  const stream = await streamResponse.text();
  let streamUsage: z.infer<typeof UsageSchema> | null = null;
  let done = false;
  for (const frame of stream.split(/\r?\n\r?\n/u)) {
    const data = frame.split(/\r?\n/u).filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trim()).join('\n');
    if (!data) continue;
    if (data === '[DONE]') { done = true; continue; }
    const packet = z.object({ usage: UsageSchema.nullish() }).parse(JSON.parse(data));
    if (packet.usage) streamUsage = packet.usage;
  }
  assert.ok(done, 'stream must end with [DONE]');
  assert.ok(streamUsage, 'stream must include final usage');
  assert.ok(streamUsage.prompt_tokens_details.cached_tokens > 0);
  console.log(JSON.stringify({ phase: 'stream', usage: streamUsage }));

  const multiple = CompletionSchema.parse(await json(chatUrl, { ...body, n: 2 }));
  assert.equal(multiple.choices.length, 2);
  assert.equal(multiple.usage.total_tokens, multiple.usage.prompt_tokens + multiple.usage.completion_tokens);
  assert.equal(multiple.usage.prompt_tokens, cold.usage.prompt_tokens);
  console.log(JSON.stringify({ phase: 'multiple', usage: multiple.usage }));

  const [valid, invalid] = await Promise.all([
    json(chatUrl, { ...body, messages: [{ role: 'user', content: 'Count from one to ten.' }] }),
    request(chatUrl, { ...body, max_tokens: -1 }),
  ]);
  CompletionSchema.parse(valid);
  assert.ok(invalid.status >= 400 && invalid.status < 500, `Invalid request returned ${invalid.status}`);
  await invalid.text();
  CompletionSchema.parse(await json(chatUrl, body));
  console.log(JSON.stringify({ phase: 'request-error-recovery', rejectedStatus: invalid.status }));

  const vision = CompletionSchema.parse(await json(chatUrl, {
    ...body, messages: [{ role: 'user', content: [
      { type: 'text', text: 'Describe the dominant color in this image in one word.' },
      { type: 'image_url', image_url: { url: toDataUrl('image/png', rasterBuffer('png', 224, 224)) } },
    ] }],
  }));
  assert.match(vision.choices[0]?.message.content ?? '', /orange|brown|ochre|amber|gold|tan/iu);
  console.log(JSON.stringify({ phase: 'vision', response: vision.choices[0]?.message.content }));

  try {
    z.object({ ok: z.literal(true) }).parse(await json(`${options.status}/runtime/model/unload`, {}));
    const unloaded = z.object({ modelState: z.literal('unloaded') }).parse(await json(`${options.status}/runtime/inference`));
    console.log(JSON.stringify({ phase: 'unload', ...unloaded }));
  } finally {
    z.object({ ok: z.literal(true) }).parse(await json(`${options.status}/runtime/model/load`, {}));
  }
  const reloaded = CompletionSchema.parse(await json(chatUrl, body));
  assert.match(reloaded.choices[0]?.message.content ?? '', /verified/iu);
  console.log(JSON.stringify({ phase: 'reload', usage: reloaded.usage }));
});
