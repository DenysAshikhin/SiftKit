import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_SUMMARY_PROVIDER,
  SummaryProviderIdSchema,
  resolveSummaryProvider,
} from '../src/summary/types.js';
import { shouldRetryWithSmallerChunks } from '../src/summary/chunking.js';
import { isOversizedMockInput } from '../src/summary/request-runner.js';
import { REMOVED_BACKEND_ID, REMOVED_BACKEND_PROVIDER_ID } from './helpers/legacy-backend-fixtures.js';

test('the default summary provider is the real provider', () => {
  assert.equal(DEFAULT_SUMMARY_PROVIDER, 'real');
  assert.equal(resolveSummaryProvider(undefined), 'real');
});

test('the provider domain is exactly real and mock', () => {
  assert.deepEqual(SummaryProviderIdSchema.options, ['real', 'mock']);
});

test('the provider domain never reuses an engine name', () => {
  assert.equal(SummaryProviderIdSchema.safeParse(REMOVED_BACKEND_PROVIDER_ID).success, false);
  assert.equal(SummaryProviderIdSchema.safeParse('exl3').success, false);
});

test('the default provider keeps the chunk-retry branch alive in downstream gates', () => {
  // Regression guard: an unsupported provider must not silently disable chunk retry.
  const retryableError = new Error('inference generate failed with HTTP 400 (bad request)');
  assert.equal(shouldRetryWithSmallerChunks({
    error: retryableError,
    provider: resolveSummaryProvider(undefined),
    inputText: 'x'.repeat(4096),
    chunkThreshold: 2048,
  }), true);
  // The engine-id regression is now unreachable: the gate takes SummaryProviderId, so
  // Passing a removed provider is a compile error. @ts-expect-error fails loud if that ban regresses.
  assert.equal(shouldRetryWithSmallerChunks({
    error: retryableError,
    // @ts-expect-error engine ids are not summary providers
    provider: REMOVED_BACKEND_ID,
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
