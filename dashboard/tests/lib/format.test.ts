import test from 'node:test';
import assert from 'node:assert/strict';

import { getLastTurnTelemetry } from '../../src/lib/format';
import type { ChatMessage, ChatSession } from '../../src/types';

const BASE_MESSAGE: ChatMessage = {
  id: 'm1',
  role: 'user',
  kind: 'user_text',
  content: 'look',
  inputTokensEstimate: 12,
  outputTokensEstimate: 0,
  thinkingTokens: 0,
  createdAtUtc: '2026-08-08T00:00:00.000Z',
  sourceRunId: null,
};

const SESSION_SHELL = {
  id: 's1',
  title: 'S',
  model: 'test-model',
  contextWindowTokens: 100,
  thinkingEnabled: true,
  presetId: 'chat-default',
  mode: 'chat',
  condensedSummary: '',
  createdAtUtc: '2026-08-08T00:00:00.000Z',
  updatedAtUtc: '2026-08-08T00:00:00.000Z',
};

function sessionWith(messages: ChatSession['messages']): ChatSession {
  return { ...SESSION_SHELL, messages };
}

const ASSISTANT_TURN: ChatMessage = {
  ...BASE_MESSAGE,
  id: 'a1',
  role: 'assistant',
  kind: 'assistant_answer',
  content: 'done',
  promptEvalDurationMs: 1000,
  promptTokensPerSecond: 2048,
  generationTokensPerSecond: 32,
};

test('getLastTurnTelemetry reads the newest assistant turn', () => {
  const stats = getLastTurnTelemetry(sessionWith([
    { ...ASSISTANT_TURN, id: 'old', promptTokensPerSecond: 100, generationTokensPerSecond: 10 },
    ASSISTANT_TURN,
  ]));
  assert.equal(stats.promptTokensPerSecond, 2048);
  assert.equal(stats.generationTokensPerSecond, 32);
  assert.equal(stats.ttftMs, 1000);
});

test('getLastTurnTelemetry skips assistant turns that carry no timings', () => {
  const stats = getLastTurnTelemetry(sessionWith([
    ASSISTANT_TURN,
    { ...BASE_MESSAGE, id: 'a2', role: 'assistant', kind: 'assistant_answer', content: 'later' },
  ]));
  assert.equal(stats.promptTokensPerSecond, 2048);
});

test('getLastTurnTelemetry returns nulls when nothing has timings', () => {
  assert.deepEqual(getLastTurnTelemetry(sessionWith([BASE_MESSAGE])), {
    promptTokensPerSecond: null,
    generationTokensPerSecond: null,
    ttftMs: null,
  });
});

test('getLastTurnTelemetry returns nulls for a missing session', () => {
  assert.deepEqual(getLastTurnTelemetry(null), {
    promptTokensPerSecond: null,
    generationTokensPerSecond: null,
    ttftMs: null,
  });
});
