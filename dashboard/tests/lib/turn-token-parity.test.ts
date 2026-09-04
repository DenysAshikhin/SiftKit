import test from 'node:test';
import assert from 'node:assert/strict';

import {
  reduceChatTranscript,
  type ChatStreamToolEvent,
  type ChatTranscriptEvent,
  type ChatTranscriptMetadata,
} from '@siftkit/contracts';

import { buildUsageFrame } from '../usage-frame';

import { getTurnTokenDisplay } from '../../src/lib/format';
import type { ChatMessage } from '../../src/types';
import type { ChatTurn } from '../../src/lib/chatTurns';

function thinkingMessage(id: string, tokens: number): ChatMessage {
  return {
    id, role: 'assistant', kind: 'assistant_thinking', content: 'reasoning text',
    inputTokensEstimate: 0, outputTokensEstimate: 0, thinkingTokens: tokens,
    inputTokensEstimated: false, outputTokensEstimated: false, thinkingTokensEstimated: false,
    createdAtUtc: '2026-09-04T00:00:00.000Z', sourceRunId: 'run-1',
  };
}

function toolMessage(id: string, outputTokens: number): ChatMessage {
  return {
    id, role: 'assistant', kind: 'assistant_tool_call', content: 'grep foo',
    toolCallCommand: 'grep foo', toolCallActivityKind: 'search',
    toolCallActivitySubject: { kind: 'none' }, toolCallTurn: 1, toolCallMaxTurns: 20,
    toolCallExitCode: 0, toolCallStatus: 'done',
    inputTokensEstimate: 0, outputTokensEstimate: outputTokens, thinkingTokens: 0,
    inputTokensEstimated: false, outputTokensEstimated: false, thinkingTokensEstimated: false,
    createdAtUtc: '2026-09-04T00:00:00.000Z', sourceRunId: 'run-1',
  };
}

function answerMessage(id: string, outputTokens: number): ChatMessage {
  return {
    id, role: 'assistant', kind: 'assistant_answer', content: 'the answer',
    inputTokensEstimate: 0, outputTokensEstimate: outputTokens, thinkingTokens: 0,
    inputTokensEstimated: false, outputTokensEstimated: false, thinkingTokensEstimated: false,
    createdAtUtc: '2026-09-04T00:00:00.000Z', sourceRunId: 'run-1',
  };
}

function toolResultEvent(toolCallId: string, turn: number, outputTokens: number): ChatStreamToolEvent {
  return {
    kind: 'tool_result', toolCallId, turn, maxTurns: 20,
    activityKind: 'search', activitySubject: { kind: 'none' },
    command: 'grep foo', promptTokenCount: 0,
    exitCode: 0, outputSnippet: 'output', outputTokens, outputTokensEstimated: false,
  };
}

test('the badge is identical across the live to settled transition', () => {
  const metadata: ChatTranscriptMetadata = {
    messageIdPrefix: 'live', sourceRunId: null, createdAtUtc: '2026-09-04T00:00:00.000Z',
  };
  const events: ChatTranscriptEvent[] = [
    { kind: 'thinking', delta: { turn: 1, offset: 0, text: 'first reasoning' } },
    // Narration streams too, and no usage frame ever snaps it. It must contribute nothing, or
    // the live badge outruns the settled one that has no narration row at all.
    { kind: 'narration', delta: { turn: 1, offset: 0, text: 'opening files' } },
    { kind: 'tool', tool: toolResultEvent('c1', 1, 340) },
    { kind: 'thinking', delta: { turn: 2, offset: 0, text: 'second reasoning' } },
    { kind: 'tool', tool: toolResultEvent('c2', 2, 210) },
    { kind: 'answer', delta: { turn: 2, offset: 0, text: 'the answer' } },
    // Turn 1 generated no answer text; turn 2 did, so only the run total it closes on carries
    // the 60 output tokens the answer row must end up with.
    { kind: 'usage', usage: buildUsageFrame({
      turn: 1,
      record: { promptTokens: 500, thinkingTokens: 120, generatedChars: 480 },
    }) },
    { kind: 'usage', usage: buildUsageFrame({
      turn: 2,
      record: { promptTokens: 500, thinkingTokens: 95, outputTokens: 60, generatedChars: 480 },
      totals: { promptTokens: 500, thinkingTokens: 95, outputTokens: 60 },
    }) },
  ];
  const liveMessages: ChatMessage[] = events.reduce<ChatMessage[]>(
    (messages, event) => reduceChatTranscript(messages, event, metadata),
    [],
  );
  const live: ChatTurn = {
    key: 'live', isLive: true, messages: liveMessages, main: null, liveThinking: [],
    steps: [], recentActivities: [], showRecentActivity: false,
  };

  // The rows the persist layer writes for the same run: per-step thinking rows carrying the
  // engine counts, tool rows carrying their output, and an answer row carrying the run output
  // with zero thinking.
  const settledMessages = [
    thinkingMessage('t1', 120), toolMessage('c1', 340),
    thinkingMessage('t2', 95), toolMessage('c2', 210),
    answerMessage('a1', 60),
  ];
  const settled: ChatTurn = {
    key: 'run:run-1', isLive: false, messages: settledMessages, main: settledMessages[4] ?? null,
    liveThinking: [], steps: [], recentActivities: [], showRecentActivity: false,
  };

  assert.equal(getTurnTokenDisplay(live).tokenCount, getTurnTokenDisplay(settled).tokenCount);
  assert.equal(getTurnTokenDisplay(settled).tokenCount, 120 + 340 + 95 + 210 + 60);
});

test('a settled turn counts every per-step thinking row, not just the answer row', () => {
  const messages = [thinkingMessage('t1', 120), thinkingMessage('t2', 95), answerMessage('a1', 60)];
  const settled: ChatTurn = {
    key: 'run:run-1', isLive: false, messages, main: messages[2] ?? null, liveThinking: [],
    steps: [], recentActivities: [], showRecentActivity: false,
  };
  assert.equal(getTurnTokenDisplay(settled).tokenCount, 275);
});

test('the display is inexact when any contributing row is estimated', () => {
  const estimated = { ...thinkingMessage('t1', 120), thinkingTokensEstimated: true };
  const settled: ChatTurn = {
    key: 'run:run-1', isLive: false, messages: [estimated], main: null, liveThinking: [],
    steps: [], recentActivities: [], showRecentActivity: false,
  };
  assert.equal(getTurnTokenDisplay(settled).exact, false);
});