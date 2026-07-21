import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_SUMMARY_PROVIDER,
  SummaryProviderIdSchema,
  resolveSummaryProvider,
} from '../src/summary/types.js';
import { shouldRetryWithSmallerChunks } from '../src/summary/chunking.js';
import { isOversizedMockInput } from '../src/summary/request-runner.js';

test('the default summary provider is the real llama.cpp provider', () => {
  assert.equal(DEFAULT_SUMMARY_PROVIDER, 'llama.cpp');
  assert.equal(resolveSummaryProvider(undefined), 'llama.cpp');
  assert.equal(resolveSummaryProvider('mock'), 'mock');
});

test('the provider domain is exactly llama.cpp and mock', () => {
  assert.deepEqual(SummaryProviderIdSchema.options, ['llama.cpp', 'mock']);
  assert.throws(() => SummaryProviderIdSchema.parse('llama'));
  assert.throws(() => SummaryProviderIdSchema.parse('exl3'));
  assert.throws(() => SummaryProviderIdSchema.parse('noop'));
});

test('the default provider keeps the llama.cpp branch in downstream gates', () => {
  // Regression guard: if the default ever becomes 'llama'/'exl3', chunk retry silently dies.
  // The error text must match chunking.ts:202's /llama\.cpp generate failed with HTTP 400\b/iu.
  const retryableError = new Error('llama.cpp generate failed with HTTP 400 (bad request)');
  assert.equal(shouldRetryWithSmallerChunks({
    error: retryableError,
    backend: resolveSummaryProvider(undefined),
    inputText: 'x'.repeat(4096),
    chunkThreshold: 2048,
  }), true);
  // The engine-id regression is now unreachable: the gate takes SummaryProviderId, so
  // passing 'llama' is a compile error. @ts-expect-error fails loud if that ban regresses.
  assert.equal(shouldRetryWithSmallerChunks({
    error: retryableError,
    // @ts-expect-error engine ids are not summary providers
    backend: 'llama',
    inputText: 'x'.repeat(4096),
    chunkThreshold: 2048,
  }), false);
});

test('only the mock provider rejects oversized input', () => {
  assert.equal(isOversizedMockInput('mock', 100, 50), true);
  assert.equal(isOversizedMockInput('mock', 50, 50), false);
  assert.equal(isOversizedMockInput('mock', 10, 50), false);
  assert.equal(isOversizedMockInput('llama.cpp', 100, 50), false);
});
