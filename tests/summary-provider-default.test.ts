import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_SUMMARY_PROVIDER,
  SummaryProviderIdSchema,
  resolveSummaryProvider,
} from '../src/summary/types.js';
import { shouldRetryWithSmallerChunks } from '../src/summary/chunking.js';
import { isOversizedMockInput } from '../src/summary/request-runner.js';

test('the default summary provider is the real provider', () => {
  assert.equal(DEFAULT_SUMMARY_PROVIDER, 'real');
  assert.equal(resolveSummaryProvider(undefined), 'real');
});

test('the provider domain is exactly real and mock', () => {
  assert.deepEqual(SummaryProviderIdSchema.options, ['real', 'mock']);
});

test('the provider domain never reuses an engine name', () => {
  assert.equal(SummaryProviderIdSchema.safeParse('llama.cpp').success, false);
  assert.equal(SummaryProviderIdSchema.safeParse('exl3').success, false);
});

test('the default provider keeps the chunk-retry branch alive in downstream gates', () => {
  // Regression guard: if the default ever becomes 'llama'/'exl3', chunk retry silently dies.
  // The error text must match chunking.ts:202's /llama\.cpp generate failed with HTTP 400\b/iu.
  const retryableError = new Error('llama.cpp generate failed with HTTP 400 (bad request)');
  assert.equal(shouldRetryWithSmallerChunks({
    error: retryableError,
    provider: resolveSummaryProvider(undefined),
    inputText: 'x'.repeat(4096),
    chunkThreshold: 2048,
  }), true);
  // The engine-id regression is now unreachable: the gate takes SummaryProviderId, so
  // passing 'llama' is a compile error. @ts-expect-error fails loud if that ban regresses.
  assert.equal(shouldRetryWithSmallerChunks({
    error: retryableError,
    // @ts-expect-error engine ids are not summary providers
    provider: 'llama',
    inputText: 'x'.repeat(4096),
    chunkThreshold: 2048,
  }), false);
});

test('only the mock provider rejects oversized input', () => {
  assert.equal(isOversizedMockInput('mock', 100, 50), true);
  assert.equal(isOversizedMockInput('mock', 50, 50), false);
  assert.equal(isOversizedMockInput('mock', 10, 50), false);
  assert.equal(isOversizedMockInput('real', 100, 50), false);
});
