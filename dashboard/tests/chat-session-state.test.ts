import test from 'node:test';
import assert from 'node:assert/strict';
import { deriveSessionIndicator } from '../src/lib/chat-session-state';
import type { ChatMessage, ChatSession } from '../src/types';

function msg(overrides: Partial<ChatMessage>): ChatMessage {
  return {
    id: 'm1', role: 'assistant', content: '',
    inputTokensEstimate: 0, outputTokensEstimate: 0, thinkingTokens: 0,
    createdAtUtc: '2026-07-19T00:00:00Z', sourceRunId: null,
    ...overrides,
  };
}

function session(messages: ChatMessage[]): ChatSession {
  return {
    id: 's1', title: 'S', model: null, contextWindowTokens: 32000,
    condensedSummary: '', createdAtUtc: '2026-07-19T00:00:00Z', updatedAtUtc: '2026-07-19T00:00:00Z',
    messages,
  };
}

test('active session with a running tool live message → tool', () => {
  const indicator = deriveSessionIndicator(session([]), {
    isActive: true, chatBusy: true,
    liveMessages: [msg({ kind: 'assistant_tool_call', toolCallStatus: 'running' })],
  });
  assert.equal(indicator, 'tool');
});

test('active streaming assistant with no running tool → streaming', () => {
  const indicator = deriveSessionIndicator(session([]), {
    isActive: true, chatBusy: true,
    liveMessages: [msg({ kind: 'assistant_answer', content: 'partial' })],
  });
  assert.equal(indicator, 'streaming');
});

test('last turn errored (non-zero tool exit) → failed', () => {
  const indicator = deriveSessionIndicator(
    session([msg({ kind: 'assistant_tool_call', toolCallStatus: 'done', toolCallExitCode: 1 })]),
    { isActive: false, chatBusy: false, liveMessages: [] },
  );
  assert.equal(indicator, 'failed');
});

test('otherwise → completed', () => {
  const indicator = deriveSessionIndicator(
    session([msg({ kind: 'assistant_answer', content: 'done' })]),
    { isActive: false, chatBusy: false, liveMessages: [] },
  );
  assert.equal(indicator, 'completed');
});
