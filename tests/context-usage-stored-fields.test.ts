import assert from 'node:assert/strict';
import test from 'node:test';

import type { ChatTurnTokenRecord } from '@siftkit/contracts';
import { buildContextUsage } from '../src/status-server/chat.js';
import type { ChatSession } from '../src/state/chat-sessions.js';
import { mockModelPreset, mockSiftConfig } from './helpers/mock-config.js';

const MEASURED: ChatTurnTokenRecord = {
  turn: 2, promptTokens: 9_000, thinkingTokens: 400, outputTokens: 120, toolTokens: 0,
  generatedChars: 0, thinkingTokensEstimated: false, outputTokensEstimated: false,
};

function thinkingSession(thinkingTokens: number, thinkingEnabled = true): ChatSession {
  return {
    id: 'ctx', title: 'ctx', modelPresetId: 'default',
    modelPreset: mockModelPreset({ id: 'default' }),
    thinkingEnabled,
    planRepoRoot: 'C:/repo',
    createdAtUtc: '2026-09-04T00:00:00.000Z', updatedAtUtc: '2026-09-04T00:00:00.000Z',
    messages: [
      {
        id: 'm1', role: 'assistant', kind: 'assistant_thinking',
        // Deliberately short text with a large stored count: if the builder re-estimates
        // from text this assertion fails.
        content: 'hi',
        inputTokensEstimate: 0, outputTokensEstimate: 0, thinkingTokens,
        inputTokensEstimated: false, outputTokensEstimated: false, thinkingTokensEstimated: false,
        createdAtUtc: '2026-09-04T00:00:00.000Z', sourceRunId: 'run-1',
      },
    ],
  };
}

const NO_REASONING_REPLAY = mockSiftConfig({ Server: { ModelPresets: { Presets: [{ ReasoningContent: false }] } } });
const REASONING_REPLAY = mockSiftConfig({ Server: { ModelPresets: { Presets: [{ Reasoning: 'on', ReasoningContent: true }] } } });

test('context usage sums the stored token fields rather than re-estimating the text', () => {
  const usage = buildContextUsage(mockSiftConfig(), thinkingSession(5000), null);
  assert.ok(usage.thinkingUsedTokens >= 5000);
  assert.equal(usage.usedTokensMeasured, false);
});

test('context usage reports the measured next prompt instead of the summed rows', () => {
  const usage = buildContextUsage(NO_REASONING_REPLAY, thinkingSession(50_000), MEASURED);
  assert.equal(usage.totalUsedTokens, 9_120);
  assert.equal(usage.usedTokensMeasured, true);
  assert.equal(usage.remainingTokens, Math.max(usage.contextWindowTokens - 9_120, 0));
});

test('measured context includes the final reasoning only when reasoning content is replayed', () => {
  assert.equal(buildContextUsage(REASONING_REPLAY, thinkingSession(50_000), MEASURED).totalUsedTokens, 9_520);
  assert.equal(buildContextUsage(REASONING_REPLAY, thinkingSession(50_000, false), MEASURED).totalUsedTokens, 9_120);
});

test('the condense warning follows the measured context', () => {
  const window = buildContextUsage(NO_REASONING_REPLAY, thinkingSession(0), null).contextWindowTokens;
  const usage = buildContextUsage(NO_REASONING_REPLAY, thinkingSession(0), { ...MEASURED, promptTokens: window - 10, outputTokens: 0 });
  assert.equal(usage.remainingTokens, 10);
  assert.equal(usage.shouldCondense, true);
});

test('measured reasoning replay follows the session preset, not the live active one', () => {
  const pinned: ChatSession = {
    ...thinkingSession(0),
    modelPresetId: 'pinned',
    modelPreset: mockModelPreset({ id: 'pinned', Model: 'pinned-model', NumCtx: 64_000, Reasoning: 'on', ReasoningContent: true }),
  };
  assert.equal(buildContextUsage(NO_REASONING_REPLAY, pinned, MEASURED).totalUsedTokens, 9_520);
});
