import assert from 'node:assert/strict';
import test from 'node:test';

import { buildChatSessionWithAppendedTurn } from '../src/status-server/chat.js';
import type { ChatSession } from '../src/state/chat-sessions.js';
import { mockModelPreset } from './helpers/mock-config.js';

function createSession(): ChatSession {
  return {
    id: 'persist-parity',
    title: 'parity',
    modelPresetId: 'default',
    modelPreset: mockModelPreset({ id: 'default' }),
    planRepoRoot: 'C:/repo',
    createdAtUtc: '2026-09-04T00:00:00.000Z',
    updatedAtUtc: '2026-09-04T00:00:00.000Z',
    messages: [],
  };
}

const turnRecords = [
  {
    turn: 1, promptTokens: 500, thinkingTokens: 120, outputTokens: 0, toolTokens: 340,
    generatedChars: 480, thinkingTokensEstimated: false, outputTokensEstimated: false,
  },
  {
    turn: 2, promptTokens: 900, thinkingTokens: 95, outputTokens: 60, toolTokens: 210,
    generatedChars: 620, thinkingTokensEstimated: false, outputTokensEstimated: false,
  },
];

test('the answer row never carries aggregate thinking; step rows own it', () => {
  const session = buildChatSessionWithAppendedTurn(
    createSession(), 'question', 'answer', {}, {
      turns: [
        { thinkingText: 'first reasoning', toolMessages: [], thinkingTokens: 120 },
        { thinkingText: 'second reasoning', toolMessages: [], thinkingTokens: 95 },
      ],
      turnRecords,
    },
  );
  const answer = session.messages.find((message) => message.kind === 'assistant_answer');
  assert.ok(answer);
  assert.equal(answer.thinkingTokens, 0);

  const thinkingRows = session.messages.filter((message) => message.kind === 'assistant_thinking');
  assert.deepEqual(thinkingRows.map((row) => row.thinkingTokens), [120, 95]);
});

test('the turn total equals the sum of the rows, with no denormalized accumulator', () => {
  const session = buildChatSessionWithAppendedTurn(
    createSession(), 'question', 'answer', {}, {
      turns: [{ thinkingText: 'reasoning', toolMessages: [], thinkingTokens: 120 }],
      turnRecords: [turnRecords[0]],
    },
  );
  const assistantRows = session.messages.filter((message) => message.role === 'assistant');
  const summed = assistantRows.reduce(
    (total, row) => total + row.thinkingTokens + row.outputTokensEstimate, 0,
  );
  assert.equal(summed, 120);
  for (const row of assistantRows) {
    assert.equal('associatedToolTokens' in row, false);
  }
});

test('turn records are what the answer row carries, folded across every turn', () => {
  const session = buildChatSessionWithAppendedTurn(
    createSession(), 'question', 'answer', {},
    { turns: [{ thinkingText: 'reasoning', toolMessages: [], thinkingTokens: 120 }], turnRecords },
  );
  const answer = session.messages.find((message) => message.kind === 'assistant_answer');
  assert.equal(answer?.outputTokensEstimate, 60);
  assert.equal(answer?.outputTokensEstimated, false);
});

test('an estimated turn record marks the answer row inexact', () => {
  const estimated = [{ ...turnRecords[0], outputTokens: 5, outputTokensEstimated: true }];
  const session = buildChatSessionWithAppendedTurn(
    createSession(), 'question', 'answer', {},
    { turns: [], turnRecords: estimated },
  );
  const answer = session.messages.find((message) => message.kind === 'assistant_answer');
  assert.equal(answer?.outputTokensEstimated, true);
});
