import assert from 'node:assert/strict';
import test from 'node:test';

import { TokenUsageTracker } from '../src/repo-search/engine/token-usage.js';
import { foldTurnTokenRecords } from '../src/repo-search/engine/turn-token-record.js';

test('tracker retains one record per turn and snapshot equals the fold of those records', async () => {
  const tracker = new TokenUsageTracker(undefined, true);
  await tracker.recordModelResponse({ text: 'abcd'.repeat(10), thinkingText: 'xy'.repeat(20) }, 500, 1);
  tracker.addToolTokens(30, 1);
  await tracker.recordModelResponse({ text: 'z'.repeat(8), thinkingText: '' }, 600, 2);

  const records = tracker.turnRecords();
  assert.equal(records.length, 2);
  assert.equal(records[0].turn, 1);
  assert.equal(records[0].toolTokens, 30);
  assert.equal(records[1].turn, 2);
  assert.equal(records[1].toolTokens, 0);

  const snapshot = tracker.snapshot();
  const folded = foldTurnTokenRecords(records);
  assert.equal(snapshot.promptTokens, folded.promptTokens);
  assert.equal(snapshot.thinkingTokens, folded.thinkingTokens);
  assert.equal(snapshot.toolTokens, folded.toolTokens);
  assert.equal(snapshot.thinkingTokensEstimatedCount, folded.thinkingTokensEstimatedCount);
});

test('tracker records the generated character count so the streaming tail can be calibrated', async () => {
  const tracker = new TokenUsageTracker(undefined, true);
  await tracker.recordModelResponse({ text: 'abcdefgh', thinkingText: 'ijkl' }, 100, 1);
  assert.equal(tracker.turnRecords()[0].generatedChars, 12);
});

test('tool tokens attach to the turn that produced them, not to the run', async () => {
  const tracker = new TokenUsageTracker(undefined, true);
  await tracker.recordModelResponse({ text: 'a', thinkingText: '' }, 10, 1);
  await tracker.recordModelResponse({ text: 'b', thinkingText: '' }, 10, 2);
  tracker.addToolTokens(7, 2);
  tracker.addToolTokens(5, 2);
  const records = tracker.turnRecords();
  assert.equal(records[0].toolTokens, 0);
  assert.equal(records[1].toolTokens, 12);
});