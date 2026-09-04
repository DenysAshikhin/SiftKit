import test from 'node:test';
import assert from 'node:assert/strict';

import { resolveLiveContextUsage } from '../../src/lib/contextBar';
import { sumLiveTokenDisplays } from '../../src/lib/format';
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

test('resolveLiveContextUsage mirrors the persisted total while idle', () => {
  const result = resolveLiveContextUsage({
    contextUsage: USAGE,
    liveMessages: [liveMessage({ id: 'stale', content: '12345678' })],
    liveToolPromptStep: { promptTokens: 95, liveBaselineTokens: 0 },
    busy: false,
  });
  assert.deepEqual(result, { usedTokens: 20, contextWindowTokens: 100, ratio: 0.2, exact: true });
});

test('resolveLiveContextUsage adds the provisional live bubble tokens while streaming', () => {
  const result = resolveLiveContextUsage({
    contextUsage: USAGE,
    liveMessages: [
      liveMessage({ id: 'u', role: 'user', kind: 'user_text', content: '12345678' }),
      liveMessage({ id: 'a', content: '1234' }),
    ],
    liveToolPromptStep: null,
    busy: true,
  });
  assert.deepEqual(result, { usedTokens: 23, contextWindowTokens: 100, ratio: 0.23, exact: false });
});

test('resolveLiveContextUsage never drops below the backend prompt count of the latest tool step', () => {
  const result = resolveLiveContextUsage({
    contextUsage: USAGE,
    liveMessages: [liveMessage({ id: 'a', content: '1234' })],
    liveToolPromptStep: {
      promptTokens: 60,
      liveBaselineTokens: sumLiveTokenDisplays([liveMessage({ id: 'a', content: '1234' })]).tokenCount,
    },
    busy: true,
  });
  assert.deepEqual(result, { usedTokens: 60, contextWindowTokens: 100, ratio: 0.6, exact: true });
});

test('resolveLiveContextUsage grows past the tool-step prompt count while the next bubble streams', () => {
  const baseline = sumLiveTokenDisplays([liveMessage({ id: 'a', content: '1234' })]).tokenCount;
  const result = resolveLiveContextUsage({
    contextUsage: USAGE,
    liveMessages: [
      liveMessage({ id: 'a', content: '1234' }),
      liveMessage({ id: 'b', content: '12345678' }),
    ],
    liveToolPromptStep: { promptTokens: 60, liveBaselineTokens: baseline },
    busy: true,
  });
  assert.deepEqual(result, { usedTokens: 62, contextWindowTokens: 100, ratio: 0.62, exact: false });
});

test('resolveLiveContextUsage keeps streamed growth exact when every live bubble is exact', () => {
  const streamed = liveMessage({ id: 'b', content: 'done', outputTokensEstimate: 7, outputTokensEstimated: false });
  const result = resolveLiveContextUsage({
    contextUsage: USAGE,
    liveMessages: [streamed],
    liveToolPromptStep: { promptTokens: 60, liveBaselineTokens: 0 },
    busy: true,
  });
  assert.deepEqual(result, { usedTokens: 67, contextWindowTokens: 100, ratio: 0.67, exact: true });
});

test('resolveLiveContextUsage keeps exact counts exact and hides the bar without usage', () => {
  const exact = resolveLiveContextUsage({
    contextUsage: USAGE,
    liveMessages: [liveMessage({ id: 'a', content: 'done', outputTokensEstimate: 3, outputTokensEstimated: false })],
    liveToolPromptStep: null,
    busy: true,
  });
  assert.deepEqual(exact, { usedTokens: 23, contextWindowTokens: 100, ratio: 0.23, exact: true });
  assert.equal(resolveLiveContextUsage({
    contextUsage: null, liveMessages: [], liveToolPromptStep: { promptTokens: 50, liveBaselineTokens: 0 }, busy: true,
  }), null);
  assert.equal(resolveLiveContextUsage({
    contextUsage: { ...USAGE, contextWindowTokens: 0 },
    liveMessages: [],
    liveToolPromptStep: null,
    busy: false,
  }), null);
});

test('resolveLiveContextUsage clamps the ratio to 1 when usage exceeds the window', () => {
  const result = resolveLiveContextUsage({
    contextUsage: { ...USAGE, totalUsedTokens: 150 },
    liveMessages: [],
    liveToolPromptStep: null,
    busy: false,
  });
  assert.equal(result?.ratio, 1);
});

test('sumLiveTokenDisplays totals live bubbles and is exact only when every bubble is', () => {
  const provisional = sumLiveTokenDisplays([
    liveMessage({ id: 'u', role: 'user', kind: 'user_text', content: '12345678' }),
    liveMessage({ id: 'a', content: '1234' }),
  ]);
  assert.deepEqual(provisional, { tokenCount: 3, exact: false });
  const exact = sumLiveTokenDisplays([
    liveMessage({ id: 'a', content: 'done', outputTokensEstimate: 3, outputTokensEstimated: false }),
  ]);
  assert.deepEqual(exact, { tokenCount: 3, exact: true });
  assert.deepEqual(sumLiveTokenDisplays([]), { tokenCount: 0, exact: true });
});

test('resolveLiveContextUsage holds at the step count when a replaced progress row shrinks the live sum', () => {
  const result = resolveLiveContextUsage({
    contextUsage: USAGE,
    liveMessages: [liveMessage({ id: 'a', content: '1234' })],
    liveToolPromptStep: { promptTokens: 60, liveBaselineTokens: 900 },
    busy: true,
  });
  assert.deepEqual(result, { usedTokens: 60, contextWindowTokens: 100, ratio: 0.6, exact: true });
});
