import assert from 'node:assert/strict';
import test from 'node:test';

import {
  reduceChatTranscript,
  type ChatTranscriptMessage,
  type ChatStreamUsageEvent,
  type ChatTranscriptMetadata,
} from '@siftkit/contracts';

const metadata: ChatTranscriptMetadata = {
  messageIdPrefix: 'parity',
  sourceRunId: 'run-1',
  createdAtUtc: '2026-09-04T00:00:00.000Z',
};

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

/** The measured usage frame the engine publishes after each turn, folded across all turns so far. */
function usageFrame(turn: number): ChatStreamUsageEvent {
  const records = turnRecords.slice(0, turn);
  const record = records[turn - 1];
  if (!record) throw new Error(`No turn record for turn ${turn}.`);
  return {
    turn, maxTurns: 20, record, charsPerToken: 4,
    totals: {
      promptTokens: records.reduce((total, entry) => total + entry.promptTokens, 0),
      thinkingTokens: records.reduce((total, entry) => total + entry.thinkingTokens, 0),
      outputTokens: records.reduce((total, entry) => total + entry.outputTokens, 0),
      toolTokens: records.reduce((total, entry) => total + entry.toolTokens, 0),
      thinkingTokensEstimatedCount: records.filter(entry => entry.thinkingTokensEstimated).length,
      outputTokensEstimatedCount: records.filter(entry => entry.outputTokensEstimated).length,
    },
  };
}

function projectTwoTurnRun(): ChatTranscriptMessage[] {
  let messages: ChatTranscriptMessage[] = [];
  messages = reduceChatTranscript(messages, { kind: 'thinking', delta: { turn: 1, offset: 0, text: 'first reasoning' } }, metadata);
  messages = reduceChatTranscript(messages, { kind: 'usage', usage: usageFrame(1) }, metadata);
  messages = reduceChatTranscript(messages, { kind: 'thinking', delta: { turn: 2, offset: 0, text: 'second reasoning' } }, metadata);
  messages = reduceChatTranscript(messages, { kind: 'answer', delta: { turn: 2, offset: 0, text: 'answer' } }, metadata);
  return reduceChatTranscript(messages, { kind: 'usage', usage: usageFrame(2) }, metadata);
}

test('the answer row never carries aggregate thinking; step rows own it', () => {
  const messages = projectTwoTurnRun();
  const answer = messages.find((message) => message.kind === 'assistant_answer');
  assert.ok(answer);
  assert.equal(answer.thinkingTokens, 0);
  const thinkingRows = messages.filter((message) => message.kind === 'assistant_thinking');
  assert.deepEqual(thinkingRows.map((row) => row.thinkingTokens), [120, 95]);
});

test('the turn total equals the sum of the rows, with no denormalized accumulator', () => {
  const messages = projectTwoTurnRun();
  const assistantRows = messages.filter((message) => message.role === 'assistant');
  const summed = assistantRows.reduce((total, row) => total + row.thinkingTokens + row.outputTokensEstimate, 0);
  assert.equal(summed, 120 + 95 + 60);
  for (const row of assistantRows) {
    assert.equal('associatedToolTokens' in row, false);
  }
});

test('measured turn records are what the answer row carries', () => {
  const answer = projectTwoTurnRun().find((message) => message.kind === 'assistant_answer');
  assert.equal(answer?.outputTokensEstimate, 60);
  assert.equal(answer?.outputTokensEstimated, false);
});

test('an estimated turn record marks the answer row inexact', () => {
  const usage = usageFrame(2);
  usage.record = { ...usage.record, outputTokens: 5, outputTokensEstimated: true };
  usage.totals = { ...usage.totals, outputTokens: 5, outputTokensEstimatedCount: 1 };
  let messages: ChatTranscriptMessage[] = [];
  messages = reduceChatTranscript(messages, { kind: 'answer', delta: { turn: 2, offset: 0, text: 'answer' } }, metadata);
  messages = reduceChatTranscript(messages, { kind: 'usage', usage }, metadata);
  const answer = messages.find((message) => message.kind === 'assistant_answer');
  assert.equal(answer?.outputTokensEstimate, 5);
  assert.equal(answer?.outputTokensEstimated, true);
});
