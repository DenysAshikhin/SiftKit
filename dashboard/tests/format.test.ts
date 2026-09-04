import test from 'node:test';
import assert from 'node:assert/strict';

import {
  formatLiveMessageTokenLabel,
  getLiveMessageTokenDisplay,
  getSessionTelemetryStats,
  getTurnTokenDisplay,
} from '../src/lib/format';
import type { ChatTurn } from '../src/lib/chatTurns';
import type { ChatMessage, ChatSession } from '../src/types';

function tokenMessage(overrides: Partial<ChatMessage>): ChatMessage {
  return {
    id: 'message',
    role: 'assistant',
    kind: 'assistant_answer',
    content: '',
    inputTokensEstimate: 0,
    outputTokensEstimate: 0,
    thinkingTokens: 0,
    inputTokensEstimated: false,
    outputTokensEstimated: false,
    thinkingTokensEstimated: false,
    createdAtUtc: '2026-04-16T12:00:00.000Z',
    sourceRunId: null,
    ...overrides,
  };
}

test('live bubble token labels surface the row token fields and image tokens without estimating text', () => {
  const user = tokenMessage({ role: 'user', kind: 'user_text', content: '12345678' });
  const thinking = tokenMessage({
    kind: 'assistant_thinking', content: '12345678', thinkingTokens: 2, thinkingTokensEstimated: true,
  });
  const tool = tokenMessage({
    kind: 'assistant_tool_call',
    content: 'run tool',
    toolCallCommand: 'run tool',
    outputTokensEstimate: 5,
    outputTokensEstimated: false,
  });
  const image = tokenMessage({
    role: 'user',
    kind: 'user_text',
    images: ['data:image/png;base64,AA=='],
    imageMeta: [{
      width: 32, height: 32, originalWidth: 32, originalHeight: 32, mime: 'image/png',
      byteLength: 20, tokenEstimate: 1_024, resized: false, caption: null,
    }],
  });

  assert.deepEqual(getLiveMessageTokenDisplay(user), { tokenCount: 0, exact: true, imageTokens: 0 });
  assert.equal(formatLiveMessageTokenLabel(user), '0 tokens');
  assert.equal(formatLiveMessageTokenLabel(thinking), '~2 tokens');
  assert.equal(formatLiveMessageTokenLabel(tool), '5 tokens');
  assert.equal(formatLiveMessageTokenLabel(image), '1,024 image tokens');
  assert.equal(formatLiveMessageTokenLabel(tokenMessage({})), '0 tokens');
});

test('settled turn tokens sum every row token field once and ignore the removed answer-row aggregate', () => {
  const messages = [
    tokenMessage({ id: 'thinking', kind: 'assistant_thinking', content: 'thinking', thinkingTokens: 10 }),
    tokenMessage({ id: 'narration', kind: 'assistant_narration', content: 'narration', outputTokensEstimate: 5 }),
    tokenMessage({
      id: 'tool', kind: 'assistant_tool_call', content: 'run tool', toolCallCommand: 'run tool',
      outputTokensEstimate: 20,
    }),
    tokenMessage({
      id: 'answer', content: 'answer', inputTokensEstimate: 99, outputTokensEstimate: 40, thinkingTokens: 10,
    }),
  ];
  const turn = {
    key: 'run:one', isLive: false, messages, steps: messages.slice(0, 3), liveThinking: [],
    recentActivities: [], showRecentActivity: false, main: messages[3] ?? null,
  } satisfies ChatTurn;

  assert.deepEqual(getTurnTokenDisplay(turn), { tokenCount: 184, exact: true });
});

test('live outer turn tokens sum each provisional bubble once', () => {
  const messages = [
    tokenMessage({ id: 'thinking', kind: 'assistant_thinking', content: 'thinking', thinkingTokens: 10, thinkingTokensEstimated: true }),
    tokenMessage({ id: 'answer', content: 'answer text', outputTokensEstimate: 3, outputTokensEstimated: true }),
  ];
  const turn = {
    key: 'live', isLive: true, messages, steps: [], liveThinking: [messages[0]],
    recentActivities: [], showRecentActivity: false, main: messages[1] ?? null,
  } satisfies ChatTurn;

  assert.deepEqual(getTurnTokenDisplay(turn), { tokenCount: 13, exact: false });
});

test('getSessionTelemetryStats computes cache hit rate and per-turn averaged acceptance and throughput stats', () => {
  const session = {
    id: 'session-1',
    title: 'Session',
    model: 'test-model',
    contextWindowTokens: 100,
    planRepoRoot: 'C:/repo',
    presetId: 'chat',
    mode: 'chat',
    createdAtUtc: '2026-04-16T11:00:00.000Z',
    updatedAtUtc: '2026-04-16T12:00:00.000Z',
    messages: [
      {
        id: 'assistant-1',
        role: 'assistant',
        content: 'Hello',
        inputTokensEstimate: 0,
        outputTokensEstimate: 80,
        thinkingTokens: 10,
        promptCacheTokens: 60,
        promptEvalTokens: 40,
        promptTokensPerSecond: 20,
        generationTokensPerSecond: 10,
        promptEvalDurationMs: 2000,
        generationDurationMs: 8000,
        requestDurationMs: 2000,
        requestStartedAtUtc: '2026-04-16T11:59:58.000Z',
        thinkingStartedAtUtc: '2026-04-16T12:00:00.000Z',
        thinkingEndedAtUtc: '2026-04-16T12:00:03.000Z',
        answerStartedAtUtc: '2026-04-16T12:00:04.000Z',
        answerEndedAtUtc: '2026-04-16T12:00:08.000Z',
        speculativeAcceptedTokens: 9,
        speculativeGeneratedTokens: 12,
        createdAtUtc: '2026-04-16T12:00:00.000Z',
        sourceRunId: null,
      },
      {
        id: 'assistant-2',
        role: 'assistant',
        content: 'World',
        inputTokensEstimate: 0,
        outputTokensEstimate: 40,
        thinkingTokens: 20,
        promptCacheTokens: 30,
        promptEvalTokens: 20,
        promptTokensPerSecond: 5,
        generationTokensPerSecond: 8,
        promptEvalDurationMs: 4000,
        generationDurationMs: 5000,
        requestDurationMs: 5000,
        requestStartedAtUtc: '2026-04-16T12:10:00.000Z',
        thinkingStartedAtUtc: '2026-04-16T12:10:01.000Z',
        thinkingEndedAtUtc: '2026-04-16T12:10:03.000Z',
        answerStartedAtUtc: '2026-04-16T12:10:04.000Z',
        answerEndedAtUtc: '2026-04-16T12:10:05.000Z',
        speculativeAcceptedTokens: 2,
        speculativeGeneratedTokens: 4,
        createdAtUtc: '2026-04-16T12:10:00.000Z',
        sourceRunId: null,
      },
    ],
  } satisfies ChatSession;

  assert.deepEqual(getSessionTelemetryStats(session), {
    promptCacheTokens: 90,
    promptEvalTokens: 60,
    cacheHitRate: 0.6,
    speculativeAcceptedTokens: 11,
    speculativeGeneratedTokens: 16,
    acceptanceRate: 0.6875,
    promptTokensPerSecond: 10,
    generationTokensPerSecond: 150 / 16.5,
  });
});

test('getSessionTelemetryStats uses thinking plus output tokens consistently across direct-rate and duration branches', () => {
  const session = {
    id: 'session-3',
    title: 'Session',
    model: 'test-model',
    contextWindowTokens: 100,
    planRepoRoot: 'C:/repo',
    presetId: 'chat',
    mode: 'chat',
    createdAtUtc: '2026-04-16T11:00:00.000Z',
    updatedAtUtc: '2026-04-16T12:00:00.000Z',
    messages: [
      {
        id: 'assistant-1',
        role: 'assistant',
        content: 'Hello',
        inputTokensEstimate: 0,
        outputTokensEstimate: 80,
        thinkingTokens: 20,
        promptCacheTokens: 0,
        promptEvalTokens: 0,
        promptTokensPerSecond: null,
        generationTokensPerSecond: 10,
        promptEvalDurationMs: null,
        generationDurationMs: 8_000,
        requestDurationMs: null,
        requestStartedAtUtc: null,
        thinkingStartedAtUtc: null,
        thinkingEndedAtUtc: null,
        answerStartedAtUtc: null,
        answerEndedAtUtc: null,
        speculativeAcceptedTokens: null,
        speculativeGeneratedTokens: null,
        createdAtUtc: '2026-04-16T12:00:00.000Z',
        sourceRunId: null,
      },
      {
        id: 'assistant-2',
        role: 'assistant',
        content: 'World',
        inputTokensEstimate: 0,
        outputTokensEstimate: 40,
        thinkingTokens: 20,
        promptCacheTokens: 0,
        promptEvalTokens: 0,
        promptTokensPerSecond: null,
        generationTokensPerSecond: null,
        promptEvalDurationMs: null,
        generationDurationMs: 4_000,
        requestDurationMs: null,
        requestStartedAtUtc: null,
        thinkingStartedAtUtc: null,
        thinkingEndedAtUtc: null,
        answerStartedAtUtc: null,
        answerEndedAtUtc: null,
        speculativeAcceptedTokens: null,
        speculativeGeneratedTokens: null,
        createdAtUtc: '2026-04-16T12:10:00.000Z',
        sourceRunId: null,
      },
    ],
  } satisfies ChatSession;

  assert.deepEqual(getSessionTelemetryStats(session), {
    promptCacheTokens: 0,
    promptEvalTokens: 0,
    cacheHitRate: null,
    speculativeAcceptedTokens: 0,
    speculativeGeneratedTokens: 0,
    acceptanceRate: null,
    promptTokensPerSecond: null,
    generationTokensPerSecond: 160 / 14,
  });
});

test('getSessionTelemetryStats returns null rates when the session has no timing or speculative totals', () => {
  const session = {
    id: 'session-2',
    title: 'Session',
    model: 'test-model',
    contextWindowTokens: 100,
    planRepoRoot: 'C:/repo',
    presetId: 'chat',
    mode: 'chat',
    createdAtUtc: '2026-04-16T11:00:00.000Z',
    updatedAtUtc: '2026-04-16T12:00:00.000Z',
    messages: [],
  } satisfies ChatSession;

  assert.deepEqual(getSessionTelemetryStats(session), {
    promptCacheTokens: 0,
    promptEvalTokens: 0,
    cacheHitRate: null,
    speculativeAcceptedTokens: 0,
    speculativeGeneratedTokens: 0,
    acceptanceRate: null,
    promptTokensPerSecond: null,
    generationTokensPerSecond: null,
  });
});
