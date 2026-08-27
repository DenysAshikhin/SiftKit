import test from 'node:test';
import assert from 'node:assert/strict';

import { groupMessagesIntoTurns, normalizeMessageKind, LIVE_THINKING_STACK_DEPTH } from '../../src/lib/chatTurns';
import { ChatMessageSchema, type ChatMessage } from '../../src/types';

function message(overrides: Partial<ChatMessage>): ChatMessage {
  const candidate = {
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
  };
  if (candidate.kind === 'assistant_tool_call') {
    return ChatMessageSchema.parse({
      toolCallCommand: 'run command="true"',
      toolCallActivityKind: 'command',
      toolCallTurn: 1,
      toolCallMaxTurns: 45,
      toolCallExitCode: null,
      toolCallStatus: 'done',
      ...candidate,
    });
  }
  return ChatMessageSchema.parse(candidate);
}

test('normalizeMessageKind returns the required message discriminant', () => {
  assert.equal(normalizeMessageKind(message({ kind: 'assistant_answer', role: 'assistant' })), 'assistant_answer');
  assert.equal(normalizeMessageKind(message({ kind: 'user_text', role: 'user' })), 'user_text');
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

test('streamed chat run groups all internal steps and answer by sourceRunId', () => {
  const messages = [
    message({ id: 'u1', role: 'user', kind: 'user_text', content: 'question' }),
    message({ id: 't1', role: 'assistant', kind: 'assistant_tool_call', content: 'web_search query="x"', sourceRunId: 'run-chat-1' }),
    message({ id: 't2', role: 'assistant', kind: 'assistant_tool_call', content: 'web_fetch url="https://example.test"', sourceRunId: 'run-chat-1' }),
    message({ id: 'a1', role: 'assistant', kind: 'assistant_answer', content: 'answer', sourceRunId: 'run-chat-1' }),
  ];

  const turns = groupMessagesIntoTurns(messages, new Set());

  assert.equal(turns.length, 2);
  assert.equal(turns[1]?.key, 'run:run-chat-1');
  assert.equal(turns[1]?.main?.id, 'a1');
  assert.deepEqual(turns[1]?.steps.map((step) => step.id), ['t1', 't2']);
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

test('all live messages collapse into one live turn with tools in the recent activity ring', () => {
  const messages = [
    message({ id: 'lt', kind: 'assistant_thinking', sourceRunId: null }),
    message({ id: 'lc', kind: 'assistant_tool_call', sourceRunId: null, toolCallStatus: 'running' }),
  ];
  const turns = groupMessagesIntoTurns(messages, new Set(['lt', 'lc']));
  assert.equal(turns.length, 1);
  assert.equal(turns[0].key, 'live');
  assert.equal(turns[0].isLive, true);
  assert.deepEqual(turns[0].steps, []);
  assert.deepEqual(turns[0].liveThinking.map((m) => m.id), ['lt']);
  assert.deepEqual(turns[0].recentTools.map((tool) => tool.id), ['lc']);
  assert.equal(turns[0].main, null);
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

test('a live turn keeps the newest thinking blocks and tools in separate live stacks', () => {
  const messages = [
    message({ id: 'th1', kind: 'assistant_thinking', sourceRunId: null }),
    message({ id: 'tc1', kind: 'assistant_tool_call', sourceRunId: null, toolCallStatus: 'done' }),
    message({ id: 'th2', kind: 'assistant_thinking', sourceRunId: null }),
    message({ id: 'tc2', kind: 'assistant_tool_call', sourceRunId: null, toolCallStatus: 'running' }),
  ];
  const turns = groupMessagesIntoTurns(messages, new Set(['th1', 'tc1', 'th2', 'tc2']));
  assert.equal(turns.length, 1);
  assert.equal(turns[0].isLive, true);
  assert.deepEqual(turns[0].liveThinking.map((m) => m.id), ['th1', 'th2']);
  assert.equal(turns[0].main, null);
  assert.deepEqual(turns[0].recentTools.map((tool) => tool.id), ['tc1', 'tc2']);
  assert.deepEqual(turns[0].steps, []);
});

test('a live tool ring exposes only the newest three tools and drops older tools from steps', () => {
  const ids = ['tc1', 'tc2', 'tc3', 'tc4'];
  const messages = ids.map((id, index) => message({
    id,
    kind: 'assistant_tool_call',
    sourceRunId: null,
    toolCallStatus: index === ids.length - 1 ? 'running' : 'done',
    toolCallTurn: index + 1,
    toolCallMaxTurns: 45,
  }));
  const turns = groupMessagesIntoTurns(messages, new Set(ids));
  assert.deepEqual(turns[0]?.recentTools.map((tool) => tool.id), ['tc2', 'tc3', 'tc4']);
  assert.deepEqual(turns[0]?.steps, []);
  assert.equal(turns[0]?.main, null);
});

test('liveThinking keeps only the newest LIVE_THINKING_STACK_DEPTH blocks; the overflow falls to steps', () => {
  const ids = ['th1', 'th2', 'th3', 'th4', 'th5'];
  const messages = ids.map((id) => message({ id, kind: 'assistant_thinking', sourceRunId: null }));
  const turns = groupMessagesIntoTurns(messages, new Set(ids));
  assert.equal(LIVE_THINKING_STACK_DEPTH, 3);
  assert.deepEqual(turns[0].liveThinking.map((m) => m.id), ['th3', 'th4', 'th5']);
  assert.deepEqual(turns[0].steps.map((m) => m.id), ['th1', 'th2']);
  assert.equal(turns[0].main, null);
});

test('a live turn that is only thinking has no main and an empty steps list', () => {
  const turns = groupMessagesIntoTurns(
    [message({ id: 'th1', kind: 'assistant_thinking', sourceRunId: null })],
    new Set(['th1']),
  );
  assert.deepEqual(turns[0].liveThinking.map((m) => m.id), ['th1']);
  assert.deepEqual(turns[0].steps, []);
  assert.equal(turns[0].main, null);
});

test('once the live answer arrives thinking and tools move into Internal Logic', () => {
  const messages = [
    message({ id: 'th1', kind: 'assistant_thinking', sourceRunId: null }),
    message({ id: 'tc1', kind: 'assistant_tool_call', sourceRunId: null }),
    message({ id: 'ans', kind: 'assistant_answer', sourceRunId: null }),
  ];
  const turns = groupMessagesIntoTurns(messages, new Set(['th1', 'tc1', 'ans']));
  assert.deepEqual(turns[0].liveThinking, []);
  assert.equal(turns[0].main?.id, 'ans');
  assert.deepEqual(turns[0].steps.map((m) => m.id), ['th1', 'tc1']);
  assert.deepEqual(turns[0].recentTools, []);
});

test('settled turns never populate liveThinking', () => {
  const messages = [
    message({ id: 'th1', kind: 'assistant_thinking', sourceRunId: 'run-1' }),
    message({ id: 'tc1', kind: 'assistant_tool_call', sourceRunId: 'run-1' }),
  ];
  const turns = groupMessagesIntoTurns(messages, new Set());
  assert.deepEqual(turns[0].liveThinking, []);
  assert.equal(turns[0].main, null);
  assert.deepEqual(turns[0].steps.map((m) => m.id), ['th1', 'tc1']);
});

test('the live user bubble keeps its own turn once the assistant answer streams', () => {
  const messages = [
    message({ id: 'live-user', role: 'user', kind: 'user_text', content: 'describe this' }),
    message({ id: 'live-answer', role: 'assistant', kind: 'assistant_answer', content: 'a chart' }),
  ];
  const turns = groupMessagesIntoTurns(messages, new Set(['live-user', 'live-answer']));

  assert.equal(turns.length, 2);
  assert.equal(turns[0]?.main?.id, 'live-user');
  assert.deepEqual(turns[0]?.steps, []);
  assert.equal(turns[1]?.main?.id, 'live-answer');
  assert.deepEqual(turns[1]?.steps.map((step) => step.id), []);
});

test('a live user bubble alone owns the main slot instead of Internal Logic', () => {
  const turns = groupMessagesIntoTurns(
    [message({ id: 'live-user', role: 'user', kind: 'user_text', content: 'describe this' })],
    new Set(['live-user']),
  );

  assert.equal(turns.length, 1);
  assert.equal(turns[0]?.main?.id, 'live-user');
  assert.deepEqual(turns[0]?.steps, []);
});

test('an assistant_progress message lands only in collapsed Internal Logic steps', () => {
  const liveIds = new Set(['t1', 't2', 't3', 'live-progress']);
  const messages = [
    message({ id: 't1', kind: 'assistant_thinking' }),
    message({ id: 't2', kind: 'assistant_thinking' }),
    message({ id: 't3', kind: 'assistant_thinking' }),
    message({ id: 'live-progress', kind: 'assistant_progress', content: 'GREEN wiring' }),
  ];

  const turns = groupMessagesIntoTurns(messages, liveIds);

  assert.equal(turns.length, 1);
  const turn = turns[0];
  assert.ok(turn);
  assert.equal(turn.isLive, true);
  assert.deepEqual(turn.liveThinking.map((m) => m.id), ['t1', 't2', 't3']);
  assert.deepEqual(turn.steps.map((message) => message.id), ['live-progress']);
  assert.equal('progress' in turn, false);
  assert.equal(turn.main, null);
});
