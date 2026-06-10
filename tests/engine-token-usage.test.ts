import test from 'node:test';
import assert from 'node:assert/strict';
import * as http from 'node:http';

import type { SiftConfig } from '../src/config/index.js';
import { TokenUsageTracker } from '../src/repo-search/engine/token-usage.js';

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

test('recordModelResponse accumulates usage fields and returns resolved counts', async () => {
  const tracker = new TokenUsageTracker(undefined);
  const resolved = await tracker.recordModelResponse({
    text: 'hello', thinkingText: 'thought',
    promptTokens: 100, completionTokens: 20, usageThinkingTokens: 7,
    promptCacheTokens: 50, promptEvalTokens: 60,
    promptEvalDurationMs: 11, generationDurationMs: 22,
  });
  assert.deepEqual(resolved, {
    completionTokens: 20,
    thinkingTokens: 7,
    completionTokensEstimated: false,
    thinkingTokensEstimated: false,
  });
  const snapshot = tracker.snapshot();
  assert.equal(snapshot.promptTokens, 100);
  assert.equal(snapshot.thinkingTokens, 7);
  assert.equal(snapshot.promptCacheTokens, 50);
  assert.equal(snapshot.promptEvalTokens, 60);
  assert.equal(snapshot.promptEvalDurationMs, 11);
  assert.equal(snapshot.generationDurationMs, 22);
  assert.equal(snapshot.outputTokens, 0); // caller decides when completion tokens count as output
});

test('recordModelResponse estimates completion/thinking tokens when usage is missing', async () => {
  const tracker = new TokenUsageTracker(undefined);
  const resolved = await tracker.recordModelResponse({ text: 'some response text', thinkingText: 'some thinking' });
  assert.ok(resolved.completionTokens > 0);
  assert.ok(resolved.thinkingTokens > 0);
  assert.equal(resolved.completionTokensEstimated, true);
  assert.equal(resolved.thinkingTokensEstimated, true);
  const empty = await tracker.recordModelResponse({ text: '', thinkingText: '' });
  assert.deepEqual(empty, {
    completionTokens: 0,
    thinkingTokens: 0,
    completionTokensEstimated: false,
    thinkingTokensEstimated: false,
  });
  const absent = await tracker.recordModelResponse({});
  assert.deepEqual(absent, {
    completionTokens: 0,
    thinkingTokens: 0,
    completionTokensEstimated: false,
    thinkingTokensEstimated: false,
  });
});

test('recordModelResponse uses llama tokenizer for missing completion and thinking usage', async () => {
  const server = http.createServer((req, res) => {
    if (req.method !== 'POST' || req.url !== '/tokenize') {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'not found' }));
      return;
    }
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      const parsed = JSON.parse(body || '{}') as { content?: string };
      const content = String(parsed.content || '');
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
    const tracker = new TokenUsageTracker({
      Runtime: { Model: 'mock', LlamaCpp: { BaseUrl: baseUrl, NumCtx: 32000 } },
    } as SiftConfig);
    const resolved = await tracker.recordModelResponse({
      text: 'exact answer',
      thinkingText: 'exact thinking',
    });

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
    promptTokens: -5,
    completionTokens: -1,
    usageThinkingTokens: -1,
    promptCacheTokens: Number.NaN,
    promptEvalTokens: -1,
    promptEvalDurationMs: -1,
    generationDurationMs: -1,
  });
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
  });
});

test('addOutputTokens and addToolTokens accumulate; tool tokens are ceiled and floored at zero', () => {
  const tracker = new TokenUsageTracker(undefined);
  tracker.addOutputTokens(15, true);
  tracker.addToolTokens(3.2);
  tracker.addToolTokens(-1);
  assert.equal(tracker.snapshot().outputTokens, 15);
  assert.equal(tracker.snapshot().outputTokensEstimatedCount, 1);
  assert.equal(tracker.snapshot().toolTokens, 4);
});
