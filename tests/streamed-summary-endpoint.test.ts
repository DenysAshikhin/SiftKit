import test from 'node:test';
import assert from 'node:assert/strict';
import { SummaryResultSchema } from '../src/summary/types.js';
import { requestSse } from './helpers/sse-http.js';
import { startHarness } from './helpers/streamed-op-harness.js';

test('summary streams progress frames before a schema-valid result frame', async () => {
  const harness = await startHarness('siftkit-streamed-summary-');
  try {
    const response = await requestSse(`${harness.baseUrl}/summary`, {
      body: { question: 'what is in the text?', inputText: 'alpha beta gamma', backend: 'mock' },
    });
    assert.equal(response.statusCode, 200);
    assert.equal(response.errorMessage, null);
    assert.ok(response.result, response.rawBody);
    const firstResultIndex = response.frames.findIndex((frame) => frame.event === 'result');
    const firstProgressIndex = response.frames.findIndex((frame) => frame.event === 'progress');
    assert.ok(firstProgressIndex >= 0, 'expected at least one progress frame');
    assert.ok(firstProgressIndex < firstResultIndex, 'progress must precede result');
    assert.equal(SummaryResultSchema.parse(response.result).WasSummarized, true);
  } finally {
    await harness.close();
  }
});

test('malformed body gets a plain HTTP 400 before SSE opens', async () => {
  const harness = await startHarness('siftkit-streamed-summary-400-');
  try {
    const response = await requestSse(`${harness.baseUrl}/summary`, { body: { inputText: 'no question' } });
    assert.equal(response.statusCode, 400);
    assert.equal(response.frames.length, 0);
    assert.match(response.rawBody, /Expected question and inputText/u);
  } finally {
    await harness.close();
  }
});

test('engine failure surfaces as an error frame, not an HTTP error', async () => {
  const harness = await startHarness('siftkit-streamed-summary-err-');
  const previousBehavior = process.env.SIFTKIT_TEST_PROVIDER_BEHAVIOR;
  process.env.SIFTKIT_TEST_PROVIDER_BEHAVIOR = 'throw';
  try {
    const response = await requestSse(`${harness.baseUrl}/summary`, {
      body: { question: 'q', inputText: 'engine failure input', backend: 'mock' },
    });
    assert.equal(response.statusCode, 200);
    assert.equal(response.result, null);
    assert.match(String(response.errorMessage), /mock provider failure/u);
  } finally {
    if (previousBehavior === undefined) {
      delete process.env.SIFTKIT_TEST_PROVIDER_BEHAVIOR;
    } else {
      process.env.SIFTKIT_TEST_PROVIDER_BEHAVIOR = previousBehavior;
    }
    await harness.close();
  }
});

test('concurrent summary streams both complete successfully', async () => {
  const harness = await startHarness('siftkit-streamed-summary-lock-');
  try {
    const [first, second] = await Promise.all([
      requestSse(`${harness.baseUrl}/summary`, {
        body: { question: 'q1', inputText: `slow ${'y'.repeat(50)}`, backend: 'mock' },
      }),
      requestSse(`${harness.baseUrl}/summary`, {
        body: { question: 'q2', inputText: 'z text', backend: 'mock' },
      }),
    ]);
    assert.ok(first.result);
    assert.ok(second.result);
    for (const event of second.progress.filter((progress) => progress.kind === 'lock_wait')) {
      assert.equal(typeof event.queueLength, 'number');
    }
  } finally {
    await harness.close();
  }
});
