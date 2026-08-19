import './react-test-environment.js';

import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { ChatStatsBar } from '../src/components/ChatStatsBar';

const EMPTY_SESSION_STATS = {
  cacheHitRate: null,
  promptCacheTokens: 0,
  promptEvalTokens: 0,
  acceptanceRate: null,
  speculativeAcceptedTokens: 0,
  speculativeGeneratedTokens: 0,
  promptTokensPerSecond: null,
  generationTokensPerSecond: null,
};

const EMPTY_LAST_TURN = {
  promptTokensPerSecond: null,
  generationTokensPerSecond: null,
  ttftMs: null,
};

test('renders placeholders when no telemetry exists yet', () => {
  const markup = renderToStaticMarkup(
    <ChatStatsBar
      lastTurn={EMPTY_LAST_TURN}
      sessionStats={EMPTY_SESSION_STATS}
      contextUsage={null}
      streaming={false}
    />,
  );
  assert.match(markup, /class="chat-stats"/u);
  // Every chip value, and only the values, must read as unavailable. Tooltip prose also
  // contains em dashes, so count the value spans rather than raw dashes.
  assert.equal((markup.match(/<span class="chat-stat-value">—<\/span>/gu) ?? []).length, 6);
});

test('renders last-turn rates, session aggregates, and hover explanations', () => {
  const markup = renderToStaticMarkup(
    <ChatStatsBar
      lastTurn={{ promptTokensPerSecond: 1204, generationTokensPerSecond: 38.4, ttftMs: 210 }}
      sessionStats={{ ...EMPTY_SESSION_STATS, cacheHitRate: 0.87, acceptanceRate: 0.62, promptTokensPerSecond: 980 }}
      contextUsage={{
        contextWindowTokens: 40000,
        usedTokens: 14200,
        chatUsedTokens: 14200,
        thinkingUsedTokens: 0,
        toolUsedTokens: 0,
        imageUsedTokens: 0,
        totalUsedTokens: 14200,
        remainingTokens: 25800,
        warnThresholdTokens: 5000,
        shouldCondense: false,
        estimatedTokenFallbackTokens: 0,
        providerOverheadTokens: 0,
      }}
      streaming={false}
    />,
  );
  assert.match(markup, /1,204 t\/s/u);
  assert.match(markup, /38.4 t\/s/u);
  assert.match(markup, /210 ms/u);
  assert.match(markup, /87%/u);
  assert.match(markup, /62%/u);
  assert.match(markup, /14,200/u);
  assert.match(markup, /Session average: 980 t\/s/u);
  assert.match(markup, /Time to first token/u);
});

test('marks the strip as streaming while a turn is in flight', () => {
  const markup = renderToStaticMarkup(
    <ChatStatsBar
      lastTurn={EMPTY_LAST_TURN}
      sessionStats={EMPTY_SESSION_STATS}
      contextUsage={null}
      streaming
    />,
  );
  assert.match(markup, /class="chat-stats streaming"/u);
});
