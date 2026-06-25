import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runMockProvider } from '../src/summary/providers/mock-provider.js';
import { parseJsonValueText } from '../src/lib/json.js';
import { asObject } from './helpers/dashboard-http.js';

function baseOptions(overrides: Partial<Parameters<typeof runMockProvider>[0]> = {}) {
  return {
    backend: 'mock',
    model: 'mock-model',
    prompt: 'Input:\nhello world',
    question: 'summarize this',
    phase: 'leaf' as const,
    promptCharacterCount: 11,
    promptTokenCount: 3,
    rawInputCharacterCount: 11,
    chunkInputCharacterCount: 11,
    statusRunningMs: 0,
    startedAt: Date.now(),
    chunkLabel: 'none',
    timingRecorder: null,
    ...overrides,
  };
}

test('runMockProvider returns a decision string and mock metrics for the default behavior', async () => {
  const prev = process.env.SIFTKIT_TEST_PROVIDER_BEHAVIOR;
  delete process.env.SIFTKIT_TEST_PROVIDER_BEHAVIOR;
  try {
    const result = await runMockProvider(baseOptions());
    assert.equal(typeof result.text, 'string');
    const decision = asObject(parseJsonValueText(result.text));
    assert.equal(decision.classification, 'summary');
    assert.equal(result.metrics.outputCharacterCount, result.text.length);
    assert.equal(result.metrics.inputTokens, null);
    assert.equal(result.metrics.statusRunningMs, 0);
  } finally {
    if (prev === undefined) delete process.env.SIFTKIT_TEST_PROVIDER_BEHAVIOR;
    else process.env.SIFTKIT_TEST_PROVIDER_BEHAVIOR = prev;
  }
});

test('runMockProvider honors SIFTKIT_TEST_PROVIDER_BEHAVIOR=throw', async () => {
  const prev = process.env.SIFTKIT_TEST_PROVIDER_BEHAVIOR;
  process.env.SIFTKIT_TEST_PROVIDER_BEHAVIOR = 'throw';
  try {
    await assert.rejects(() => runMockProvider(baseOptions()), /mock provider failure/u);
  } finally {
    if (prev === undefined) delete process.env.SIFTKIT_TEST_PROVIDER_BEHAVIOR;
    else process.env.SIFTKIT_TEST_PROVIDER_BEHAVIOR = prev;
  }
});

test('runMockProvider honors SIFTKIT_TEST_PROVIDER_BEHAVIOR=recursive-merge', async () => {
  const prev = process.env.SIFTKIT_TEST_PROVIDER_BEHAVIOR;
  process.env.SIFTKIT_TEST_PROVIDER_BEHAVIOR = 'recursive-merge';
  try {
    const result = await runMockProvider(baseOptions());
    const decision = asObject(parseJsonValueText(result.text));
    assert.equal(decision.output, 'merge summary');
  } finally {
    if (prev === undefined) delete process.env.SIFTKIT_TEST_PROVIDER_BEHAVIOR;
    else process.env.SIFTKIT_TEST_PROVIDER_BEHAVIOR = prev;
  }
});
