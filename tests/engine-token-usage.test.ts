import test from 'node:test';
import assert from 'node:assert/strict';

import { TokenUsageTracker } from '../src/repo-search/engine/token-usage.js';

test('recordModelResponse accumulates usage fields and returns resolved counts', () => {
  const tracker = new TokenUsageTracker(undefined);
  const resolved = tracker.recordModelResponse({
    text: 'hello', thinkingText: 'thought',
    promptTokens: 100, completionTokens: 20, usageThinkingTokens: 7,
    promptCacheTokens: 50, promptEvalTokens: 60,
    promptEvalDurationMs: 11, generationDurationMs: 22,
  });
  assert.deepEqual(resolved, { completionTokens: 20, thinkingTokens: 7 });
  const snapshot = tracker.snapshot();
  assert.equal(snapshot.promptTokens, 100);
  assert.equal(snapshot.thinkingTokens, 7);
  assert.equal(snapshot.promptCacheTokens, 50);
  assert.equal(snapshot.promptEvalTokens, 60);
  assert.equal(snapshot.promptEvalDurationMs, 11);
  assert.equal(snapshot.generationDurationMs, 22);
  assert.equal(snapshot.outputTokens, 0); // caller decides when completion tokens count as output
});

test('recordModelResponse estimates completion/thinking tokens when usage is missing', () => {
  const tracker = new TokenUsageTracker(undefined);
  const resolved = tracker.recordModelResponse({ text: 'some response text', thinkingText: 'some thinking' });
  assert.ok(resolved.completionTokens > 0);
  assert.ok(resolved.thinkingTokens > 0);
  const empty = tracker.recordModelResponse({ text: '', thinkingText: '' });
  assert.deepEqual(empty, { completionTokens: 0, thinkingTokens: 0 });
});

test('negative or non-finite usage fields are ignored', () => {
  const tracker = new TokenUsageTracker(undefined);
  tracker.recordModelResponse({ text: '', promptTokens: -5, promptCacheTokens: Number.NaN });
  assert.equal(tracker.snapshot().promptTokens, 0);
  assert.equal(tracker.snapshot().promptCacheTokens, 0);
});

test('addOutputTokens and addToolTokens accumulate; tool tokens are ceiled and floored at zero', () => {
  const tracker = new TokenUsageTracker(undefined);
  tracker.addOutputTokens(15);
  tracker.addToolTokens(3.2);
  tracker.addToolTokens(-1);
  assert.equal(tracker.snapshot().outputTokens, 15);
  assert.equal(tracker.snapshot().toolTokens, 4);
});
