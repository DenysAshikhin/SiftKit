import test, { before, after } from 'node:test';
import { IsolatedRuntime } from './helpers/isolated-runtime.js';

const isolatedRuntime = new IsolatedRuntime();
before(() => isolatedRuntime.start());
after(() => isolatedRuntime.close());
import assert from 'node:assert/strict';
import http from 'node:http';

import { TokenUsageTracker } from '../src/repo-search/engine/token-usage.js';
import {
  calculateThroughputRate,
  emptyInferenceThroughput,
  readTabbyThroughput,
} from '../src/lib/inference-throughput.js';
import { parseJsonValueText } from '../src/lib/json.js';
import { asObject } from './helpers/dashboard-http.js';
import { mockConfig } from './_runtime-helpers.js';

async function closeServer(server: http.Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

test('recordModelResponse counts output and thinking locally, ignoring provider counts', async () => {
  const tracker = new TokenUsageTracker(undefined);
  // 400 chars thinking, 80 chars text; estimate path (no config) = chars/4
  const resolved = await tracker.recordModelResponse({
    text: 'x'.repeat(80),
    thinkingText: 'y'.repeat(400),
    throughput: emptyInferenceThroughput(),
    promptCacheTokens: 50, promptEvalTokens: 60,
    promptEvalDurationMs: 11, generationDurationMs: 22,
    speculativeAcceptedTokens: 16, speculativeGeneratedTokens: 20,
  }, 123, 1);
  assert.equal(resolved.completionTokens, 20);
  assert.equal(resolved.thinkingTokens, 100);
  assert.equal(resolved.completionTokensEstimated, true);
  assert.equal(resolved.thinkingTokensEstimated, true);
  const snapshot = tracker.snapshot();
  assert.equal(snapshot.promptTokens, 123); // local preflight count, not provider usage
  assert.equal(snapshot.thinkingTokens, 100);
  assert.equal(snapshot.promptCacheTokens, 50);
  assert.equal(snapshot.promptEvalTokens, 60);
});

test('regression: provider-shaped usage fields cannot influence resolved counts', async () => {
  // exllamav3 requeue bug: provider reported 2102 tokens for an 8921-token response.
  const tracker = new TokenUsageTracker(undefined);
  // These provider fields no longer exist on ModelUsageResponse; passing a
  // variable (not a literal) keeps this compiling if someone re-adds them,
  // and the assertions below still protect us. No type assertions.
  const providerShaped = {
    text: 'z'.repeat(200),
    thinkingText: '',
    throughput: emptyInferenceThroughput(),
    completionTokens: 2, usageThinkingTokens: 3, promptTokens: 999999,
  };
  const withBogus = await tracker.recordModelResponse(providerShaped, 10, 1);
  assert.equal(withBogus.completionTokens, 50);
  assert.equal(tracker.snapshot().promptTokens, 10);
});

test('recordModelResponse estimates completion/thinking tokens when usage is missing', async () => {
  const tracker = new TokenUsageTracker(undefined);
  const resolved = await tracker.recordModelResponse({ text: 'some response text', thinkingText: 'some thinking', throughput: emptyInferenceThroughput() }, 0, 1);
  assert.ok(resolved.completionTokens > 0);
  assert.ok(resolved.thinkingTokens > 0);
  assert.equal(resolved.completionTokensEstimated, true);
  assert.equal(resolved.thinkingTokensEstimated, true);
  const empty = await tracker.recordModelResponse({ text: '', thinkingText: '', throughput: emptyInferenceThroughput() }, 0, 1);
  assert.deepEqual(empty, {
    completionTokens: 0,
    thinkingTokens: 0,
    completionTokensEstimated: false,
    thinkingTokensEstimated: false,
  });
  const absent = await tracker.recordModelResponse({ throughput: emptyInferenceThroughput() }, 0, 1);
  assert.deepEqual(absent, {
    completionTokens: 0,
    thinkingTokens: 0,
    completionTokensEstimated: false,
    thinkingTokensEstimated: false,
  });
});

test('recordModelResponse uses the server tokenizer for text and thinking', async () => {
  const server = http.createServer((req, res) => {
    if (req.method !== 'POST' || req.url !== '/v1/token/encode') {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'not found' }));
      return;
    }
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      const parsed = asObject(parseJsonValueText(body || '{}'));
      const content = String(parsed.text || '');
      const count = content === 'exact answer'
        ? 17
        : content === 'exact thinking'
          ? 23
          : null;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ count }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${Number(typeof address === 'object' && address ? address.port : 0)}`;

  try {
    const tracker = new TokenUsageTracker(mockConfig({
      Server: { ModelPresets: { Presets: [{ BaseUrl: baseUrl, NumCtx: 32000 }] } },
    }));
    const resolved = await tracker.recordModelResponse({
      text: 'exact answer',
      thinkingText: 'exact thinking',
      throughput: emptyInferenceThroughput(),
    }, 0, 1);

    assert.deepEqual(resolved, {
      completionTokens: 17,
      thinkingTokens: 23,
      completionTokensEstimated: false,
      thinkingTokensEstimated: false,
    });
    assert.equal(tracker.snapshot().thinkingTokens, 23);
    assert.equal(tracker.snapshot().thinkingTokensEstimatedCount, 0);
  } finally {
    await closeServer(server);
  }
});

test('negative or non-finite usage fields are ignored', async () => {
  const tracker = new TokenUsageTracker(undefined);
  const resolved = await tracker.recordModelResponse({
    text: '   ',
    thinkingText: '   ',
    throughput: emptyInferenceThroughput(),
    promptCacheTokens: Number.NaN,
    promptEvalTokens: -1,
    promptEvalDurationMs: -1,
    generationDurationMs: -1,
    speculativeAcceptedTokens: -3,
    speculativeGeneratedTokens: Number.NaN,
  }, -5, 1);
  assert.deepEqual(resolved, {
    completionTokens: 0,
    thinkingTokens: 0,
    completionTokensEstimated: false,
    thinkingTokensEstimated: false,
  });
  assert.deepEqual(tracker.snapshot(), {
    promptTokens: 0,
    outputTokens: 0,
    toolTokens: 0,
    thinkingTokens: 0,
    outputTokensEstimatedCount: 0,
    thinkingTokensEstimatedCount: 0,
    promptCacheTokens: 0,
    promptEvalTokens: 0,
    promptEvalDurationMs: 0,
    generationDurationMs: 0,
    speculativeAcceptedTokens: 0,
    speculativeGeneratedTokens: 0,
    throughput: emptyInferenceThroughput(),
  });
});

test('decode throughput comes from the backend emitted count, not from retokenized narration', async () => {
  const tracker = new TokenUsageTracker(undefined);
  // The investigated run: 28,036 emitted tokens (tool-call markup and reasoning included) over
  // 1,189.48 s, while the narration+thinking attribution stayed at 19,650 tokens.
  const observed = readTabbyThroughput({ usage: {
    prompt_tokens: 35_414, prompt_tokens_details: { cached_tokens: 251_392 },
    prompt_time: 48.73, prompt_tokens_per_sec: 726.739_175_046_2,
    completion_tokens: 28_036, completion_time: 1_189.48,
    completion_tokens_per_sec: 23.569_963_345_3,
  } });
  await tracker.recordModelResponse({ text: '', thinkingText: '', throughput: observed }, 0, 1);
  tracker.addOutputTokens(19_650, 1);

  const snapshot = tracker.snapshot();
  assert.equal(snapshot.outputTokens + snapshot.thinkingTokens, 19_650);
  assert.ok(Math.abs((calculateThroughputRate(snapshot.throughput.decode) ?? Number.NaN) - 23.569_963_345_3) < 1e-9);
  assert.ok(Math.abs((calculateThroughputRate(snapshot.throughput.pp) ?? Number.NaN) - 726.739_175_046_2) < 1e-9);
});

test('a tool-only answer still reports positive decode throughput', async () => {
  const tracker = new TokenUsageTracker(undefined);
  const observed = readTabbyThroughput({ usage: {
    prompt_tokens: 500, prompt_tokens_details: { cached_tokens: 500 },
    prompt_time: 0.2, prompt_tokens_per_sec: 0,
    completion_tokens: 420, completion_time: 21,
    completion_tokens_per_sec: 20,
  } });
  await tracker.recordModelResponse({ text: '', thinkingText: '', throughput: observed }, 0, 1);

  const snapshot = tracker.snapshot();
  assert.equal(snapshot.outputTokens, 0);
  assert.equal(snapshot.throughput.decode.tokenCount, 420);
  assert.equal(calculateThroughputRate(snapshot.throughput.decode), 20);
});

test('throughput accumulates once per recorded model response', async () => {
  const tracker = new TokenUsageTracker(undefined);
  const first = readTabbyThroughput({ usage: {
    completion_tokens: 10, completion_time: 1, completion_tokens_per_sec: 10,
  } });
  const second = readTabbyThroughput({ usage: {
    completion_tokens: 90, completion_time: 3, completion_tokens_per_sec: 30,
  } });
  await tracker.recordModelResponse({ text: 'a', thinkingText: '', throughput: first }, 0, 1);
  await tracker.recordModelResponse({ text: 'b', thinkingText: '', throughput: second }, 0, 2);

  const snapshot = tracker.snapshot();
  assert.equal(snapshot.throughput.decode.requestCount, 2);
  assert.equal(snapshot.throughput.decode.tokenCount, 100);
  assert.equal(calculateThroughputRate(snapshot.throughput.decode), 25);
  assert.equal(calculateThroughputRate(snapshot.throughput.pp), null);
});

test('addOutputTokens and addToolTokens accumulate; tool tokens are ceiled and floored at zero', () => {
  const tracker = new TokenUsageTracker(undefined);
  tracker.addOutputTokens(15, 1, true);
  tracker.addToolTokens(3.2, 1);
  tracker.addToolTokens(-1, 1);
  assert.equal(tracker.snapshot().outputTokens, 15);
  assert.equal(tracker.snapshot().outputTokensEstimatedCount, 1);
  assert.equal(tracker.snapshot().toolTokens, 4);
});
