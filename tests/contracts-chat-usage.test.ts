import assert from 'node:assert/strict';
import test from 'node:test';

import { ChatStreamUsageEventSchema } from '@siftkit/contracts';

const validFrame = {
  turn: 2,
  maxTurns: 20,
  record: {
    turn: 2,
    promptTokens: 800,
    thinkingTokens: 90,
    outputTokens: 30,
    toolTokens: 45,
    generatedChars: 480,
    thinkingTokensEstimated: false,
    outputTokensEstimated: false,
  },
  totals: {
    promptTokens: 1600,
    thinkingTokens: 180,
    outputTokens: 60,
    toolTokens: 90,
    thinkingTokensEstimatedCount: 0,
    outputTokensEstimatedCount: 0,
  },
  charsPerToken: 4.2,
};

test('the chat usage frame round-trips the full record and totals', () => {
  const parsed = ChatStreamUsageEventSchema.parse(validFrame);
  assert.equal(parsed.record.thinkingTokens, 90);
  assert.equal(parsed.totals.toolTokens, 90);
  assert.equal(parsed.charsPerToken, 4.2);
});

test('the chat usage frame rejects a missing totals block rather than defaulting it', () => {
  const { totals, ...withoutTotals } = validFrame;
  assert.equal(totals.promptTokens, 1600);
  assert.equal(ChatStreamUsageEventSchema.safeParse(withoutTotals).success, false);
});

test('the chat usage frame rejects a zero calibration ratio', () => {
  assert.equal(
    ChatStreamUsageEventSchema.safeParse({ ...validFrame, charsPerToken: 0 }).success,
    false,
  );
});