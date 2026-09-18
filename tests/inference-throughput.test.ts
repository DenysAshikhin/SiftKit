import test from 'node:test';
import assert from 'node:assert/strict';

import {
  calculateTabbyReferenceRate,
  calculateThroughputRate,
  compareThroughputRate,
  emptyInferenceThroughput,
  mergeInferenceThroughput,
  observeTabbyThroughput,
  readTabbyThroughput,
} from '../src/lib/inference-throughput.js';
import type { JsonObject, JsonValue } from '../src/lib/json-types.js';

function usageBody(usage: JsonObject): JsonObject {
  return { usage };
}

/** One request: 3365 processed prompt tokens, 754 emitted tokens, distinct backend rates. */
function referenceBody(): JsonObject {
  return usageBody({
    prompt_tokens: 3365,
    prompt_tokens_details: { cached_tokens: 0 },
    prompt_time: 3.88,
    prompt_tokens_per_sec: 867.27,
    completion_tokens: 754,
    completion_time: 35.07,
    completion_tokens_per_sec: 21.5,
  });
}

test('readTabbyThroughput keeps the raw emitted count and the processed prompt count', () => {
  const throughput = readTabbyThroughput(usageBody({
    prompt_tokens: 3365,
    prompt_tokens_details: { cached_tokens: 1000 },
    prompt_time: 3.88,
    prompt_tokens_per_sec: 867.27,
    completion_tokens: 754,
    completion_time: 35.07,
    completion_tokens_per_sec: 21.5,
    completion_tokens_details: { reasoning_tokens: 500, accepted_prediction_tokens: 90 },
  }));

  assert.equal(throughput.decode.tokenCount, 754);
  assert.equal(throughput.decode.durationMs, 35_070);
  assert.equal(throughput.pp.tokenCount, 2365);
  assert.equal(throughput.pp.durationMs, 3880);
  assert.equal(throughput.decode.requestCount, 1);
  assert.equal(throughput.decode.missingInternalRequests, 0);
  assert.equal(throughput.decode.missingTabbyRequests, 0);
});

test('readTabbyThroughput treats reasoning and tool-control tokens as already emitted', () => {
  // A tool-only turn: narration is empty, so any visible-text recount would report ~0 tokens.
  const throughput = readTabbyThroughput(usageBody({
    prompt_tokens: 100,
    prompt_tokens_details: { cached_tokens: 100 },
    prompt_time: 0.5,
    prompt_tokens_per_sec: 200,
    completion_tokens: 640,
    completion_time: 32,
    completion_tokens_per_sec: 20,
    completion_tokens_details: { reasoning_tokens: 600 },
  }));

  assert.equal(throughput.decode.tokenCount, 640);
  assert.equal(calculateThroughputRate(throughput.decode), 20);
  assert.equal(calculateTabbyReferenceRate(throughput.decode), 20);
  assert.equal(throughput.pp.tokenCount, 0);
  assert.equal(calculateThroughputRate(throughput.pp), 0);
});

test('readTabbyThroughput records a missing or malformed usage as unmeasured, never as zero', () => {
  const bodies: JsonValue[] = [{}, { usage: null }, { usage: { prompt_tokens: 'x' } }, 'not-an-object'];
  for (const body of bodies) {
    const throughput = readTabbyThroughput(body);
    assert.equal(throughput.decode.tokenCount, null);
    assert.equal(throughput.decode.tabbyWeightedTokens, null);
    assert.equal(throughput.decode.requestCount, 1);
    assert.equal(throughput.decode.missingInternalRequests, 1);
    assert.equal(throughput.decode.missingTabbyRequests, 1);
    assert.equal(calculateThroughputRate(throughput.decode), null);
    assert.equal(calculateTabbyReferenceRate(throughput.decode), null);
    assert.equal(compareThroughputRate(null, null).kind, 'unverifiable');
  }
});

test('readTabbyThroughput rejects non-finite and negative backend values as unmeasured', () => {
  const throughput = readTabbyThroughput(usageBody({
    prompt_tokens: Number.NaN,
    prompt_time: -1,
    prompt_tokens_per_sec: Number.POSITIVE_INFINITY,
    completion_tokens: -5,
    completion_time: Number.NaN,
    completion_tokens_per_sec: 20,
  }));

  assert.equal(throughput.pp.tokenCount, null);
  assert.equal(throughput.pp.tabbyWeightedTokens, null);
  assert.equal(throughput.decode.tokenCount, null);
  assert.equal(throughput.decode.durationMs, null);
  assert.equal(throughput.decode.missingTabbyRequests, 1);
});

test('cumulative usage frames replace one another instead of accumulating', () => {
  let throughput = emptyInferenceThroughput();
  throughput = observeTabbyThroughput(throughput, usageBody({
    prompt_tokens: 1000, prompt_time: 1, prompt_tokens_per_sec: 1000,
  }));
  throughput = observeTabbyThroughput(throughput, usageBody({
    prompt_tokens: 1000, prompt_time: 1, prompt_tokens_per_sec: 1000,
    completion_tokens: 40, completion_time: 2, completion_tokens_per_sec: 20,
  }));
  throughput = observeTabbyThroughput(throughput, usageBody({
    prompt_tokens: 1000, prompt_time: 1, prompt_tokens_per_sec: 1000,
    completion_tokens: 40, completion_time: 2, completion_tokens_per_sec: 20,
  }));

  assert.equal(throughput.decode.requestCount, 1);
  assert.equal(throughput.decode.tokenCount, 40);
  assert.equal(throughput.decode.durationMs, 2000);
  assert.equal(throughput.pp.requestCount, 1);
  assert.equal(calculateThroughputRate(throughput.decode), 20);
});

test('cumulative observation keeps an earlier partial while a later frame omits it', () => {
  let throughput = observeTabbyThroughput(emptyInferenceThroughput(), usageBody({
    prompt_tokens: 1000, prompt_time: 1, prompt_tokens_per_sec: 1000,
  }));
  throughput = observeTabbyThroughput(throughput, usageBody({
    completion_tokens: 10, completion_time: 1, completion_tokens_per_sec: 10,
  }));

  assert.equal(throughput.pp.tokenCount, 1000);
  assert.equal(throughput.decode.tokenCount, 10);
  assert.equal(throughput.decode.requestCount, 1);
});

test('mergeInferenceThroughput sums counts and durations of distinct requests', () => {
  const first = readTabbyThroughput(usageBody({
    prompt_tokens: 100, prompt_time: 1, prompt_tokens_per_sec: 100,
    completion_tokens: 10, completion_time: 1, completion_tokens_per_sec: 10,
  }));
  const continuation = readTabbyThroughput(usageBody({
    prompt_tokens: 120, prompt_time: 1, prompt_tokens_per_sec: 120,
    completion_tokens: 90, completion_time: 3, completion_tokens_per_sec: 30,
  }));
  const merged = mergeInferenceThroughput([first, continuation]);

  assert.equal(merged.decode.requestCount, 2);
  assert.equal(merged.decode.tokenCount, 100);
  assert.equal(merged.decode.durationMs, 4000);
  assert.equal(calculateThroughputRate(merged.decode), 25);
  assert.equal(calculateTabbyReferenceRate(merged.decode), 25);
});

test('the backend reference is duration-weighted, never an arithmetic average of rates', () => {
  const slow = readTabbyThroughput(usageBody({ completion_tokens: 10, completion_time: 1, completion_tokens_per_sec: 10 }));
  const fast = readTabbyThroughput(usageBody({ completion_tokens: 90, completion_time: 3, completion_tokens_per_sec: 30 }));
  const merged = mergeInferenceThroughput([slow, fast]);

  assert.equal(calculateTabbyReferenceRate(merged.decode), 25);
  assert.notEqual(calculateTabbyReferenceRate(merged.decode), 20);
});

test('altering an internal duration leaves the independent reference untouched', () => {
  const observed = readTabbyThroughput(referenceBody());
  const internalRate = calculateThroughputRate(observed.decode);
  const referenceRate = calculateTabbyReferenceRate(observed.decode);
  assert.ok(internalRate !== null);
  assert.ok(referenceRate !== null);
  assert.ok(observed.decode.durationMs !== null);
  const corrupted = { ...observed, decode: { ...observed.decode, durationMs: observed.decode.durationMs * 2 } };

  assert.equal(calculateTabbyReferenceRate(corrupted.decode), referenceRate);
  assert.equal(calculateThroughputRate(corrupted.decode), internalRate / 2);
});

test('merging an incomplete cohort keeps the known subtotal and stays incomparable', () => {
  const measured = readTabbyThroughput(usageBody({
    completion_tokens: 30, completion_time: 3, completion_tokens_per_sec: 10,
  }));
  const cancelled = readTabbyThroughput({});
  const merged = mergeInferenceThroughput([measured, cancelled]);

  assert.equal(merged.decode.requestCount, 2);
  assert.equal(merged.decode.tokenCount, 30);
  assert.equal(merged.decode.durationMs, 3000);
  assert.equal(merged.decode.missingInternalRequests, 1);
  assert.equal(merged.decode.missingTabbyRequests, 1);
  // Neither side may publish a rate for only the measured subset of a whole-operation cohort.
  assert.equal(calculateThroughputRate(merged.decode), null);
  assert.equal(calculateTabbyReferenceRate(merged.decode), null);
});

test('a cohort missing only its backend reference keeps a comparable internal rate', () => {
  const reported = readTabbyThroughput(usageBody({ completion_tokens: 30, completion_time: 3, completion_tokens_per_sec: 10 }));
  const unreported = readTabbyThroughput(usageBody({ completion_tokens: 20, completion_time: 2 }));
  const merged = mergeInferenceThroughput([reported, unreported]);

  assert.equal(calculateThroughputRate(merged.decode), 10);
  assert.equal(calculateTabbyReferenceRate(merged.decode), null);
  assert.equal(compareThroughputRate(
    calculateThroughputRate(merged.decode),
    calculateTabbyReferenceRate(merged.decode),
  ).kind, 'unverifiable');
});

test('an empty fold publishes null rates', () => {
  const empty = mergeInferenceThroughput([]);
  assert.equal(empty.decode.requestCount, 0);
  assert.equal(calculateThroughputRate(empty.decode), null);
  assert.equal(calculateTabbyReferenceRate(empty.decode), null);
});

test('a zero duration is never used as a divisor', () => {
  const metric = readTabbyThroughput(usageBody({
    completion_tokens: 10, completion_time: 0, completion_tokens_per_sec: 0,
  })).decode;

  assert.equal(calculateThroughputRate(metric), null);
  assert.equal(calculateTabbyReferenceRate(metric), null);
});

test('compareThroughputRate allows exactly five percent in both directions', () => {
  assert.equal(compareThroughputRate(19, 20).kind, 'match');
  assert.equal(compareThroughputRate(21, 20).kind, 'match');
  assert.equal(compareThroughputRate(18.99, 20).kind, 'mismatch');
  assert.equal(compareThroughputRate(21.01, 20).kind, 'mismatch');
  assert.equal(compareThroughputRate(19, 20).deltaPct, -5);
  assert.equal(compareThroughputRate(21, 20).deltaPct, 5);
});

test('compareThroughputRate reports a signed percentage for both drift directions', () => {
  const under = compareThroughputRate(16.5198, 23.57);
  assert.equal(under.kind, 'mismatch');
  assert.ok((under.deltaPct ?? 0) < 0);
  const over = compareThroughputRate(30, 23.57);
  assert.equal(over.kind, 'mismatch');
  assert.ok((over.deltaPct ?? 0) > 0);
});

test('compareThroughputRate treats an unavailable reference as unverifiable', () => {
  const missingReference = compareThroughputRate(20, null);
assert.ok(missingReference.kind === 'unverifiable');
assert.equal(missingReference.reason, 'reference_unavailable');
  assert.equal(missingReference.deltaPct, null);
  const missingInternal = compareThroughputRate(null, 20);
assert.ok(missingInternal.kind === 'unverifiable');
assert.equal(missingInternal.reason, 'internal_unavailable');
  assert.equal(compareThroughputRate(null, null).kind, 'unverifiable');
});

test('an explicit zero reference agrees with zero and mismatches a positive internal rate', () => {
  assert.equal(compareThroughputRate(0, 0).kind, 'match');
  const mismatch = compareThroughputRate(12, 0);
assert.ok(mismatch.kind === 'mismatch');
assert.equal(mismatch.reason, 'zero_reference');
  assert.equal(mismatch.deltaPct, null);
});

test('boundary regression from the investigated request', () => {
  const metric = readTabbyThroughput({ usage: {
    prompt_tokens: 3365, prompt_tokens_details: { cached_tokens: 0 },
    prompt_time: 3.88, prompt_tokens_per_sec: 867.27,
    completion_tokens: 754, completion_time: 35.07,
    completion_tokens_per_sec: 21.5,
  } });
  assert.equal(metric.decode.tokenCount, 754);
  assert.equal(metric.pp.tokenCount, 3365);
  assert.equal(compareThroughputRate(398 / 35.07, 21.5).kind, 'mismatch');
});

test('the investigated run cohort resolves to the backend decode rate', () => {
  const durationMs = 1_189_480;
  const internal = 19_650 / (durationMs / 1000);
  const tabby = 28_036 / (durationMs / 1000);
  assert.ok(Math.abs(tabby - 23.569_963_345_3) < 1e-6);
  assert.ok(Math.abs(internal - 16.5198) < 1e-4);
  assert.equal(compareThroughputRate(internal, tabby).kind, 'mismatch');
});