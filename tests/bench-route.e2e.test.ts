import test from 'node:test';
import assert from 'node:assert/strict';

import { BENCH_GENERATION_HEADER, BENCH_RESIDENCY_HEADER, BenchIdentityResponseSchema } from '@siftkit/contracts';
import { getConfigPath } from '../src/config/index.ts';
import { readConfig, writeConfig } from '../src/status-server/config-store.ts';
import type { JsonValue } from '../src/lib/json-types.ts';
import {
  asArray,
  asObject,
  requestJson,
  requestJsonWithHeaders,
  requestRawText,
  type HeaderedJsonResponse,
} from './helpers/dashboard-http.ts';
import { PassthroughServer } from './helpers/status-server-fixture.ts';

const MODEL_ID = 'bench-route-model';
const BENCH_TIMEOUT_MS = 30_000;

function startBenchServer(): Promise<PassthroughServer> {
  return PassthroughServer.start({ tempPrefix: 'siftkit-bench-route-', modelId: MODEL_ID });
}

/** Adds a second saved preset that loads the same weights at a smaller context. */
function addAltPreset(): void {
  const config = readConfig(getConfigPath());
  const base = config.Server.ModelPresets.Presets.find((preset) => preset.id === 'default');
  assert.ok(base);
  config.Server.ModelPresets.Presets.push({ ...base, id: 'bench-alt', label: 'Bench alt', NumCtx: 16_000 });
  writeConfig(getConfigPath(), config);
}

function postBench(server: PassthroughServer, path: string, body: JsonValue): Promise<HeaderedJsonResponse> {
  return requestJsonWithHeaders(`${server.baseUrl}/bench/v1${path}`, {
    method: 'POST', body: JSON.stringify(body), timeoutMs: BENCH_TIMEOUT_MS,
  });
}

function chatBody(model: string, extra: Record<string, JsonValue> = {}): JsonValue {
  return { model, messages: [{ role: 'user', content: 'hi' }], max_tokens: 64, ...extra };
}

test('bench models lists every saved preset without starting another engine', async () => {
  await using server = await startBenchServer();
  addAltPreset();
  const launchesBefore = server.launcher.launches.length;

  const response = await requestJsonWithHeaders(`${server.baseUrl}/bench/v1/models`, { timeoutMs: BENCH_TIMEOUT_MS });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(asArray(response.body.data).map((entry) => asObject(entry).id), ['default', 'bench-alt']);
  assert.equal(server.launcher.launches.length, launchesBefore);
});

test('bench chat forwards caller sampling unchanged, without a token count or clamp', async () => {
  await using server = await startBenchServer();

  const response = await postBench(server, '/chat/completions', chatBody('default', {
    temperature: 0.11, top_p: 0.5, top_k: 7, min_p: 0.02, seed: 42, stop: ['END'],
    chat_template_kwargs: { enable_thinking: false },
  }));

  assert.equal(response.statusCode, 200, JSON.stringify(response.body));
  const forwarded = asObject(response.body.forwardedRequest);
  assert.equal(forwarded.model, MODEL_ID);
  assert.equal(forwarded.max_tokens, 64);
  assert.equal(forwarded.temperature, 0.11);
  assert.equal(forwarded.top_p, 0.5);
  assert.equal(forwarded.top_k, 7);
  assert.equal(forwarded.min_p, 0.02);
  assert.equal(forwarded.seed, 42);
  assert.deepEqual(forwarded.stop, ['END']);
  assert.deepEqual(forwarded.chat_template_kwargs, { enable_thinking: false });
  assert.deepEqual(server.launcher.encodeRequests, [], 'the bench route never counts prompt tokens');
  assert.match(String(response.headers[BENCH_RESIDENCY_HEADER]), /^[0-9a-f]{16}$/u);
  assert.match(String(response.headers[BENCH_GENERATION_HEADER]), /^\d+$/u);
});

test('bench chat requires an output budget and a known preset', async () => {
  await using server = await startBenchServer();

  const noBudget = await postBench(server, '/chat/completions', { model: 'default', messages: [{ role: 'user', content: 'hi' }] });
  assert.equal(noBudget.statusCode, 400);
  assert.match(String(noBudget.body.error), /max_tokens/u);

  const unknown = await postBench(server, '/chat/completions', chatBody('no-such-preset'));
  assert.equal(unknown.statusCode, 400);
  assert.match(String(unknown.body.error), /no-such-preset/u);

  const completionTokens = await postBench(server, '/chat/completions', {
    model: 'default', messages: [{ role: 'user', content: 'hi' }], max_completion_tokens: 32,
  });
  assert.equal(completionTokens.statusCode, 200);
  const forwarded = asObject(completionTokens.body.forwardedRequest);
  assert.equal(forwarded.max_tokens, 32);
  assert.equal('max_completion_tokens' in forwarded, false);
});

test('bench chat returns an engine error with its own status', async () => {
  await using server = await startBenchServer();

  const response = await postBench(server, '/chat/completions', chatBody('default', { fake_engine: { error_status: 400 } }));

  assert.equal(response.statusCode, 400);
  assert.equal(response.body.detail, 'fake engine rejected the request');
});

test('bench chat loads another preset transiently and a config read does not revert it', async () => {
  await using server = await startBenchServer();
  addAltPreset();

  const main = await postBench(server, '/chat/completions', chatBody('default'));
  const alt = await postBench(server, '/chat/completions', chatBody('bench-alt'));
  assert.equal(alt.statusCode, 200, JSON.stringify(alt.body));
  assert.notEqual(alt.headers[BENCH_RESIDENCY_HEADER], main.headers[BENCH_RESIDENCY_HEADER]);
  assert.equal(readConfig(getConfigPath()).Server.ModelPresets.ActivePresetId, 'default');
  const launchesAfterSwitch = server.launcher.launches.length;

  const configRead = await requestJsonWithHeaders(`${server.baseUrl}/config`, { timeoutMs: BENCH_TIMEOUT_MS });
  assert.equal(configRead.statusCode, 200);
  const altAgain = await postBench(server, '/chat/completions', chatBody('bench-alt'));

  assert.equal(altAgain.statusCode, 200);
  assert.equal(server.launcher.launches.length, launchesAfterSwitch, 'the config read did not switch the model back');
  assert.equal(altAgain.headers[BENCH_GENERATION_HEADER], alt.headers[BENCH_GENERATION_HEADER]);
});

test('bench route answers 404 for an unknown path and 405 for a wrong method', async () => {
  await using server = await startBenchServer();
  const launchesBefore = server.launcher.launches.length;

  const unknown = await requestJson(`${server.baseUrl}/bench/v1/no-such-endpoint`, { timeoutMs: BENCH_TIMEOUT_MS });
  assert.equal(unknown.statusCode, 404);
  assert.match(String(unknown.body.error), /Not found/u);

  const chatGet = await requestJson(`${server.baseUrl}/bench/v1/chat/completions`, { timeoutMs: BENCH_TIMEOUT_MS });
  assert.equal(chatGet.statusCode, 405);
  assert.match(String(chatGet.body.error), /Method not allowed/u);

  const modelsPost = await requestJson(`${server.baseUrl}/bench/v1/models`, { method: 'POST', timeoutMs: BENCH_TIMEOUT_MS });
  assert.equal(modelsPost.statusCode, 405);

  assert.equal(server.launcher.launches.length, launchesBefore, 'the unmatched requests did not launch an engine');
});

test('bench identity reports what is resident and what was verified, without loading anything', async () => {
  await using server = await startBenchServer();
  addAltPreset();
  await postBench(server, '/chat/completions', chatBody('default'));
  const launchesBefore = server.launcher.launches.length;

  const resident = BenchIdentityResponseSchema.parse((await postBench(server, '/identity', { model: 'default' })).body);
  const absent = BenchIdentityResponseSchema.parse((await postBench(server, '/identity', { model: 'bench-alt' })).body);

  assert.equal(server.launcher.launches.length, launchesBefore, 'identity never loads a model');
  assert.equal(resident.requested.presetId, 'default');
  assert.equal(resident.resident.matches, true);
  assert.ok(resident.resident.card);
  assert.equal(resident.resident.card.id, MODEL_ID);
  assert.equal(resident.resident.card.max_seq_len, resident.requested.settings.NumCtx);
  assert.equal(typeof resident.resident.card.cache_mode, 'string');
  assert.equal(resident.drafting.verified, resident.drafting.configured ? true : null);
  assert.equal(resident.engine.managed, true);
  assert.equal('AdminApiKey' in resident.engine, false);
  assert.equal(absent.resident.matches, false);
  assert.equal(absent.resident.card, null);
  assert.equal(absent.drafting.verified, null);
  assert.notEqual(absent.residency.keyHash, resident.residency.keyHash);

  const unknown = await postBench(server, '/identity', { model: 'no-such-preset' });
  assert.equal(unknown.statusCode, 400);
});

test('bench token encode counts with the named preset tokenizer', async () => {
  await using server = await startBenchServer();

  const plain = await postBench(server, '/token/encode', { model: 'default', text: 'abcdefgh' });
  const chat = await postBench(server, '/token/encode', {
    model: 'default', text: [{ role: 'user', content: 'abcdefgh' }], chat_template_kwargs: { enable_thinking: false },
  });

  assert.equal(plain.statusCode, 200, JSON.stringify(plain.body));
  assert.deepEqual(plain.body, { length: 2 });
  assert.equal(chat.statusCode, 200, JSON.stringify(chat.body));
  assert.equal(typeof chat.body.length, 'number');
  assert.equal(server.launcher.encodeRequests.length, 2);
});

test('a streamed bench chat passes the engine\'s frames through', async () => {
  await using server = await startBenchServer();

  const response = await requestRawText(
    `${server.baseUrl}/bench/v1/chat/completions`,
    chatBody('default', { stream: true, stream_options: { include_usage: true } }),
    { timeoutMs: BENCH_TIMEOUT_MS },
  );

  assert.equal(response.statusCode, 200);
  assert.ok(response.contentType.startsWith('text/event-stream'), response.contentType);
  // The frames exactly as the fake engine writes them, incl. its default usage (3 prompt, 1 completion).
  const frame = (payload: object): string => `data: ${JSON.stringify(payload)}\n\n`;
  assert.equal(response.text,
    frame({ choices: [{ delta: { content: 'ok' } }] })
    + frame({ choices: [{ delta: {}, finish_reason: 'stop' }] })
    + frame({ choices: [], usage: { prompt_tokens: 3, prompt_time: 0.1, prompt_tokens_per_sec: 30, completion_tokens: 1, completion_time: 1, completion_tokens_per_sec: 1, total_tokens: 4 } })
    + 'data: [DONE]\n\n');
});

test('bench token encode and identity reject bad requests before any load', async () => {
  await using server = await startBenchServer();
  const launchesBefore = server.launcher.launches.length;
  const encodeRequestsBefore = server.launcher.encodeRequests.length;

  const unknownPreset = await postBench(server, '/token/encode', { model: 'no-such-preset', text: 'abcdefgh' });
  assert.equal(unknownPreset.statusCode, 400);
  assert.match(String(unknownPreset.body.error), /no-such-preset/u);

  const missingText = await postBench(server, '/token/encode', { model: 'default' });
  assert.equal(missingText.statusCode, 400);

  const extraKey = await postBench(server, '/token/encode', { model: 'default', text: 'abcdefgh', bogus: 1 });
  assert.equal(extraKey.statusCode, 400);

  const emptyIdentity = await postBench(server, '/identity', {});
  assert.equal(emptyIdentity.statusCode, 400);

  const identityExtraKey = await postBench(server, '/identity', { model: 'default', bogus: 1 });
  assert.equal(identityExtraKey.statusCode, 400);

  assert.equal(server.launcher.launches.length, launchesBefore, 'the rejected requests did not launch an engine');
  assert.equal(server.launcher.encodeRequests.length, encodeRequestsBefore, 'the rejected requests did not reach the tokenizer');
});