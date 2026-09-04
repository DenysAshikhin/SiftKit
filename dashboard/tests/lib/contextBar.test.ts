import test from 'node:test';
import assert from 'node:assert/strict';

import { resolveLiveContextUsage } from '../../src/lib/contextBar';
import { sumLiveTokenDisplays } from '../../src/lib/format';
import type { ChatStreamUsageEvent } from '@siftkit/contracts';
import type { ChatMessage, ContextUsage } from '../../src/types';

const USAGE: ContextUsage = {
  contextWindowTokens: 100,
  usedTokens: 20,
  chatUsedTokens: 20,
  thinkingUsedTokens: 0,
  toolUsedTokens: 0,
  imageUsedTokens: 0,
  totalUsedTokens: 20,
  remainingTokens: 80,
  warnThresholdTokens: 80,
  shouldCondense: false,
  providerOverheadTokens: 5,
  estimatedTokenFallbackTokens: 0,
};

function liveMessage(overrides: {
  id: string;
  content: string;
  role?: 'user' | 'assistant';
  kind?: 'user_text' | 'assistant_answer';
  outputTokensEstimate?: number;
  outputTokensEstimated?: boolean;
}): ChatMessage {
  return {
    role: 'assistant',
    kind: 'assistant_answer',
    inputTokensEstimate: 0,
    outputTokensEstimate: 0,
    thinkingTokens: 0,
    createdAtUtc: '2026-09-03T00:00:00.000Z',
    sourceRunId: null,
    ...overrides,
  };
}

function usageFrame(promptTokens: number, charsPerToken = 4): ChatStreamUsageEvent {
  return {
    turn: 2,
    maxTurns: 20,
    record: {
      turn: 2, promptTokens, thinkingTokens: 100, outputTokens: 0, toolTokens: 0,
      generatedChars: 400, thinkingTokensEstimated: false, outputTokensEstimated: false,
    },
    totals: {
      promptTokens, thinkingTokens: 100, outputTokens: 0, toolTokens: 0,
      thinkingTokensEstimatedCount: 0, outputTokensEstimatedCount: 0,
    },
    charsPerToken,
  };
}

test('resolveLiveContextUsage mirrors the persisted total while idle', () => {
  const result = resolveLiveContextUsage({
    contextUsage: USAGE,
    latestUsage: usageFrame(95),
    streamedCharsSinceUsage: 40,
    busy: false,
  });
  assert.deepEqual(result, { usedTokens: 20, contextWindowTokens: 100, ratio: 0.2, exact: true });
});

test('resolveLiveContextUsage holds the persisted total while a turn streams before the first usage frame', () => {
  const result = resolveLiveContextUsage({
    contextUsage: USAGE,
    latestUsage: null,
    streamedCharsSinceUsage: 40,
    busy: true,
  });
  assert.deepEqual(result, { usedTokens: 20, contextWindowTokens: 100, ratio: 0.2, exact: true });
});

test('resolveLiveContextUsage adds the calibrated streaming tail to the frame prompt count', () => {
  const result = resolveLiveContextUsage({
    contextUsage: USAGE,
    latestUsage: usageFrame(60),
    streamedCharsSinceUsage: 8,
    busy: true,
  });
  assert.deepEqual(result, { usedTokens: 62, contextWindowTokens: 100, ratio: 0.62, exact: false });
});

test('the in-flight tail converges to the exact count at the turn boundary', () => {
  const usage = usageFrame(5000);
  const contextUsage: ContextUsage = { ...USAGE, contextWindowTokens: 155_000, totalUsedTokens: 4000 };
  const mid = resolveLiveContextUsage({
    contextUsage, latestUsage: usage, streamedCharsSinceUsage: 800, busy: true,
  });
  assert.equal(mid?.usedTokens, 5200);
  assert.equal(mid?.exact, false);

  const atBoundary = resolveLiveContextUsage({
    contextUsage, latestUsage: usage, streamedCharsSinceUsage: 0, busy: true,
  });
  assert.equal(atBoundary?.usedTokens, 5000);
  assert.equal(atBoundary?.exact, true);
});

test('resolveLiveContextUsage hides the bar without usage', () => {
  assert.equal(resolveLiveContextUsage({
    contextUsage: null, latestUsage: usageFrame(50), streamedCharsSinceUsage: 0, busy: true,
  }), null);
  assert.equal(resolveLiveContextUsage({
    contextUsage: { ...USAGE, contextWindowTokens: 0 },
    latestUsage: null,
    streamedCharsSinceUsage: 0,
    busy: false,
  }), null);
});

test('resolveLiveContextUsage clamps the ratio to 1 when usage exceeds the window', () => {
  const result = resolveLiveContextUsage({
    contextUsage: { ...USAGE, totalUsedTokens: 150 },
    latestUsage: null,
    streamedCharsSinceUsage: 0,
    busy: false,
  });
  assert.equal(result?.ratio, 1);
});

test('sumLiveTokenDisplays totals live bubbles and is exact only when every bubble is', () => {
  const provisional = sumLiveTokenDisplays([
    liveMessage({ id: 'u', role: 'user', kind: 'user_text', content: '12345678' }),
    liveMessage({ id: 'a', content: '1234' }),
  ]);
  assert.deepEqual(provisional, { tokenCount: 0, exact: true });
  const exact = sumLiveTokenDisplays([
    liveMessage({ id: 'a', content: 'done', outputTokensEstimate: 3, outputTokensEstimated: false }),
  ]);
  assert.deepEqual(exact, { tokenCount: 3, exact: true });
  assert.deepEqual(sumLiveTokenDisplays([]), { tokenCount: 0, exact: true });
});
