import test from 'node:test';
import assert from 'node:assert/strict';

import { formatLiveContextTokens, resolveLiveContextUsage } from '../../src/lib/contextBar';
import { getLiveMessageTokenDisplay, sumLiveTokenDisplays } from '../../src/lib/format';
import type { ChatStreamPromptEvent } from '@siftkit/contracts';
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

function promptFrame(promptTokens: number, charsPerToken = 4): ChatStreamPromptEvent {
  return { turn: 2, maxTurns: 20, promptTokens, charsPerToken };
}

test('resolveLiveContextUsage mirrors the persisted total while idle', () => {
  const result = resolveLiveContextUsage({
    contextUsage: USAGE,
    liveTokenBase: promptFrame(95),
    streamedCharsSinceBase: 40,
    busy: false,
  });
  assert.deepEqual(result, { usedTokens: 20, contextWindowTokens: 100, ratio: 0.2, exact: true });
});

test('resolveLiveContextUsage grows from the measured prompt base as text streams', () => {
  const result = resolveLiveContextUsage({
    contextUsage: USAGE,
    liveTokenBase: promptFrame(60),
    streamedCharsSinceBase: 8,
    busy: true,
  });
  assert.deepEqual(result, { usedTokens: 62, contextWindowTokens: 100, ratio: 0.62, exact: false });
});

test('resolveLiveContextUsage holds the persisted total until the turn publishes its base', () => {
  const result = resolveLiveContextUsage({
    contextUsage: USAGE,
    liveTokenBase: null,
    streamedCharsSinceBase: 0,
    busy: true,
  });
  assert.deepEqual(result, { usedTokens: 20, contextWindowTokens: 100, ratio: 0.2, exact: true });
});

test('the measured base counts the submitted turn, so the bar never lags the prompt', () => {
  // The persisted total predates this turn; the frame the backend measured already includes
  // the user message and its images, which is why the base is taken from the frame.
  const result = resolveLiveContextUsage({
    contextUsage: USAGE,
    liveTokenBase: promptFrame(45),
    streamedCharsSinceBase: 0,
    busy: true,
  });
  assert.deepEqual(result, { usedTokens: 45, contextWindowTokens: 100, ratio: 0.45, exact: true });
});

test('the in-flight tail converges to the exact count at the turn boundary', () => {
  const base = promptFrame(5000);
  const contextUsage: ContextUsage = { ...USAGE, contextWindowTokens: 155_000, totalUsedTokens: 4000 };
  const mid = resolveLiveContextUsage({
    contextUsage, liveTokenBase: base, streamedCharsSinceBase: 800, busy: true,
  });
  assert.equal(mid?.usedTokens, 5200);
  assert.equal(mid?.exact, false);

  const atBoundary = resolveLiveContextUsage({
    contextUsage, liveTokenBase: base, streamedCharsSinceBase: 0, busy: true,
  });
  assert.equal(atBoundary?.usedTokens, 5000);
  assert.equal(atBoundary?.exact, true);
});

test('resolveLiveContextUsage hides the bar without usage', () => {
  assert.equal(resolveLiveContextUsage({
    contextUsage: null, liveTokenBase: promptFrame(50), streamedCharsSinceBase: 0, busy: true,
  }), null);
  assert.equal(resolveLiveContextUsage({
    contextUsage: { ...USAGE, contextWindowTokens: 0 },
    liveTokenBase: null,
    streamedCharsSinceBase: 0,
    busy: false,
  }), null);
});

test('resolveLiveContextUsage clamps the ratio to 1 when usage exceeds the window', () => {
  const result = resolveLiveContextUsage({
    contextUsage: { ...USAGE, totalUsedTokens: 150 },
    liveTokenBase: null,
    streamedCharsSinceBase: 0,
    busy: false,
  });
  assert.equal(result?.ratio, 1);
});

test('formatLiveContextTokens marks an estimated tail and leaves an exact count bare', () => {
  const live = { usedTokens: 1200, contextWindowTokens: 4000, ratio: 0.3, exact: false };
  assert.equal(formatLiveContextTokens(live, (tokens) => String(tokens)), '~1200');
  assert.equal(formatLiveContextTokens({ ...live, exact: true }, (tokens) => String(tokens)), '1200');
});

test('sumLiveTokenDisplays totals live bubbles and is exact only when every bubble is', () => {
  const provisional = sumLiveTokenDisplays([
    liveMessage({ id: 'u', role: 'user', kind: 'user_text', content: '12345678' }),
    liveMessage({ id: 'a', content: '1234' }),
  ].map(getLiveMessageTokenDisplay));
  assert.deepEqual(provisional, { tokenCount: 0, exact: true });
  const exact = sumLiveTokenDisplays([
    liveMessage({ id: 'a', content: 'done', outputTokensEstimate: 3, outputTokensEstimated: false }),
  ].map(getLiveMessageTokenDisplay));
  assert.deepEqual(exact, { tokenCount: 3, exact: true });
  assert.deepEqual(sumLiveTokenDisplays([]), { tokenCount: 0, exact: true });
});
