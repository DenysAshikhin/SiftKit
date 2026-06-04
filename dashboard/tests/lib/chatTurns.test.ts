import test from 'node:test';
import assert from 'node:assert/strict';

import { groupMessagesIntoTurns, normalizeMessageKind } from '../../src/lib/chatTurns';
import type { ChatMessage } from '../../src/types';

function message(overrides: Partial<ChatMessage>): ChatMessage {
  return {
    id: 'id',
    role: 'assistant',
    kind: 'assistant_answer',
    content: '',
    inputTokensEstimate: 0,
    outputTokensEstimate: 0,
    thinkingTokens: 0,
    associatedToolTokens: 0,
    createdAtUtc: '2026-06-04T00:00:00.000Z',
    sourceRunId: null,
    ...overrides,
  } as ChatMessage;
}

test('normalizeMessageKind falls back by role when kind is absent', () => {
  assert.equal(normalizeMessageKind(message({ kind: undefined, role: 'assistant' })), 'assistant_answer');
  assert.equal(normalizeMessageKind(message({ kind: undefined, role: 'user' })), 'user_text');
  assert.equal(normalizeMessageKind(message({ kind: 'assistant_thinking' })), 'assistant_thinking');
});

test('groups a settled run turn: steps are thinking+tool, main is the answer', () => {
  const messages = [
    message({ id: 't', kind: 'assistant_thinking', sourceRunId: 'run-1' }),
    message({ id: 'c', kind: 'assistant_tool_call', sourceRunId: 'run-1' }),
    message({ id: 'a', kind: 'assistant_answer', sourceRunId: 'run-1' }),
  ];
  const turns = groupMessagesIntoTurns(messages, new Set());
  assert.equal(turns.length, 1);
  assert.equal(turns[0].key, 'run:run-1');
  assert.equal(turns[0].isLive, false);
  assert.deepEqual(turns[0].steps.map((m) => m.id), ['t', 'c']);
  assert.equal(turns[0].main?.id, 'a');
});

test('a solo answer (null run) is its own turn with no steps', () => {
  const turns = groupMessagesIntoTurns([message({ id: 'a', kind: 'assistant_answer', sourceRunId: null })], new Set());
  assert.equal(turns.length, 1);
  assert.equal(turns[0].key, 'solo:a');
  assert.deepEqual(turns[0].steps, []);
  assert.equal(turns[0].main?.id, 'a');
});

test('a user message is its own turn keyed by id with no steps', () => {
  const turns = groupMessagesIntoTurns([message({ id: 'u', role: 'user', kind: 'user_text' })], new Set());
  assert.equal(turns[0].key, 'user:u');
  assert.deepEqual(turns[0].steps, []);
  assert.equal(turns[0].main?.id, 'u');
});

test('settled run turn with the answer deleted keeps main null and all steps in Internal Logic', () => {
  const messages = [
    message({ id: 't', kind: 'assistant_thinking', sourceRunId: 'run-1' }),
    message({ id: 'c', kind: 'assistant_tool_call', sourceRunId: 'run-1' }),
  ];
  const turns = groupMessagesIntoTurns(messages, new Set());
  assert.equal(turns.length, 1);
  assert.equal(turns[0].isLive, false);
  assert.equal(turns[0].main, null);
  assert.deepEqual(turns[0].steps.map((m) => m.id), ['t', 'c']);
});

test('no message in a run is dropped: a second answer renders as a step, not silently lost', () => {
  const messages = [
    message({ id: 't', kind: 'assistant_thinking', sourceRunId: 'run-1' }),
    message({ id: 'a', kind: 'assistant_answer', sourceRunId: 'run-1' }),
    message({ id: 'a2', kind: 'assistant_answer', sourceRunId: 'run-1' }),
  ];
  const turns = groupMessagesIntoTurns(messages, new Set());
  assert.equal(turns[0].main?.id, 'a');
  assert.deepEqual(turns[0].steps.map((m) => m.id), ['t', 'a2']);
});

test('all live messages collapse into one live turn; main is the latest, rest are steps', () => {
  const messages = [
    message({ id: 'lt', kind: 'assistant_thinking', sourceRunId: null }),
    message({ id: 'lc', kind: 'assistant_tool_call', sourceRunId: null, toolCallStatus: 'running' }),
  ];
  const turns = groupMessagesIntoTurns(messages, new Set(['lt', 'lc']));
  assert.equal(turns.length, 1);
  assert.equal(turns[0].key, 'live');
  assert.equal(turns[0].isLive, true);
  assert.deepEqual(turns[0].steps.map((m) => m.id), ['lt']);
  assert.equal(turns[0].main?.id, 'lc');
});

test('preserves order and separates user turn from following run turn', () => {
  const messages = [
    message({ id: 'u', role: 'user', kind: 'user_text' }),
    message({ id: 't', kind: 'assistant_thinking', sourceRunId: 'run-9' }),
    message({ id: 'a', kind: 'assistant_answer', sourceRunId: 'run-9' }),
  ];
  const turns = groupMessagesIntoTurns(messages, new Set());
  assert.deepEqual(turns.map((turn) => turn.key), ['user:u', 'run:run-9']);
});

test('blank/whitespace sourceRunId is treated as solo, not grouped', () => {
  const messages = [
    message({ id: 'a', kind: 'assistant_answer', sourceRunId: '  ' }),
    message({ id: 'b', kind: 'assistant_answer', sourceRunId: '' }),
  ];
  const turns = groupMessagesIntoTurns(messages, new Set());
  assert.deepEqual(turns.map((turn) => turn.key), ['solo:a', 'solo:b']);
});

test('empty input yields no turns', () => {
  assert.deepEqual(groupMessagesIntoTurns([], new Set()), []);
});
