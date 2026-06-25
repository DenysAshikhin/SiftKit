import test from 'node:test';
import assert from 'node:assert/strict';
import { parseChatStreamPacket, ChatStreamReader, type ChatStreamEvent } from '../src/lib/chat-stream-parser';
import type { ChatSessionResponse } from '../src/types';

test('parseChatStreamPacket contract: one single-line data: JSON frame per packet (multi-line data: not supported)', () => {
  const multiLine = 'event: thinking\ndata: {"thinking":\ndata: "ignored second line"}';
  assert.equal(parseChatStreamPacket(multiLine), null);
});

test('parseChatStreamPacket returns null for empty or data-less packets', () => {
  assert.equal(parseChatStreamPacket(''), null);
  assert.equal(parseChatStreamPacket('event: thinking'), null);
});

test('parseChatStreamPacket parses thinking events', () => {
  const event = parseChatStreamPacket('event: thinking\ndata: {"thinking":"hi"}');
  assert.deepEqual(event, { kind: 'thinking', text: 'hi' });
});

test('parseChatStreamPacket parses tool_start and tool_result with toolCallId', () => {
  const start = parseChatStreamPacket(
    'event: tool_start\ndata: {"toolCallId":"tc_0","turn":1,"maxTurns":5,"command":"rg foo","promptTokenCount":42}'
  );
  assert.deepEqual(start, {
    kind: 'tool',
    tool: {
      kind: 'tool_start',
      toolCallId: 'tc_0',
      turn: 1,
      maxTurns: 5,
      command: 'rg foo',
      promptTokenCount: 42,
    },
  });
  const result = parseChatStreamPacket(
    'event: tool_result\ndata: {"toolCallId":"tc_0","turn":1,"maxTurns":5,"command":"rg foo","exitCode":0,"outputSnippet":"hit","outputTokens":4915,"outputTokensEstimated":false,"promptTokenCount":42}'
  );
  assert.deepEqual(result, {
    kind: 'tool',
    tool: {
      kind: 'tool_result',
      toolCallId: 'tc_0',
      turn: 1,
      maxTurns: 5,
      command: 'rg foo',
      exitCode: 0,
      outputSnippet: 'hit',
      outputTokens: 4915,
      outputTokensEstimated: false,
      promptTokenCount: 42,
    },
  });
});

const SAMPLE_SESSION: ChatSessionResponse['session'] = {
  id: 's1',
  title: 't',
  model: null,
  contextWindowTokens: 0,
  condensedSummary: '',
  createdAtUtc: '2026-06-03T00:00:00.000Z',
  updatedAtUtc: '2026-06-03T00:00:00.000Z',
  messages: [],
};
const SAMPLE_CONTEXT_USAGE: ChatSessionResponse['contextUsage'] = {
  contextWindowTokens: 0,
  usedTokens: 0,
  chatUsedTokens: 0,
  thinkingUsedTokens: 0,
  toolUsedTokens: 0,
  totalUsedTokens: 0,
  remainingTokens: 0,
  warnThresholdTokens: 0,
  shouldCondense: false,
};
const SAMPLE_DONE: ChatSessionResponse = { session: SAMPLE_SESSION, contextUsage: SAMPLE_CONTEXT_USAGE };

test('parseChatStreamPacket parses answer, done, error', () => {
  assert.deepEqual(parseChatStreamPacket('event: answer\ndata: {"answer":"hello"}'), { kind: 'answer', text: 'hello' });
  const done = parseChatStreamPacket(`event: done\ndata: ${JSON.stringify(SAMPLE_DONE)}`);
  assert.ok(done?.kind === 'done');
  assert.deepEqual(done.payload, SAMPLE_DONE);
  assert.deepEqual(parseChatStreamPacket('event: error\ndata: {"error":"boom"}'), { kind: 'error', message: 'boom' });
});

test('parseChatStreamPacket returns null on malformed JSON', () => {
  assert.equal(parseChatStreamPacket('event: thinking\ndata: {not json'), null);
});

test('ChatStreamReader flushes a trailing packet that ends without a blank line', async () => {
  const encoder = new TextEncoder();
  const trailingFrame = `event: done\ndata: ${JSON.stringify(SAMPLE_DONE)}`;
  let consumed = false;
  const mockReader: ReadableStreamDefaultReader<Uint8Array> = {
    async read() {
      if (consumed) return { value: undefined, done: true };
      consumed = true;
      return { value: encoder.encode(trailingFrame), done: false };
    },
    async cancel() {},
    releaseLock() {},
    closed: Promise.resolve(undefined),
  };
  const events: ChatStreamEvent[] = [];
  for await (const event of new ChatStreamReader(mockReader).events()) {
    events.push(event);
  }
  assert.equal(events.length, 1);
  assert.equal(events[0].kind, 'done');
});

test('ChatStreamReader yields events split across chunks', async () => {
  const encoder = new TextEncoder();
  const doneFrame = `event: done\ndata: ${JSON.stringify(SAMPLE_DONE)}\n\n`;
  const chunks = [
    'event: thinking\ndata: {"thinking":"a"}\n\nevent: too',
    'l_start\ndata: {"toolCallId":"tc_0","turn":1,"maxTurns":1,"command":"x"}\n\n',
    doneFrame,
  ].map((chunk) => encoder.encode(chunk));
  let chunkIndex = 0;
  const mockReader: ReadableStreamDefaultReader<Uint8Array> = {
    async read() {
      if (chunkIndex >= chunks.length) return { value: undefined, done: true };
      const value = chunks[chunkIndex];
      chunkIndex += 1;
      return { value, done: false };
    },
    async cancel() {},
    releaseLock() {},
    closed: Promise.resolve(undefined),
  };
  const events: ChatStreamEvent[] = [];
  const reader = new ChatStreamReader(mockReader);
  for await (const event of reader.events()) {
    events.push(event);
  }
  assert.equal(events.length, 3);
  assert.equal(events[0].kind, 'thinking');
  assert.equal(events[1].kind, 'tool');
  assert.equal(events[2].kind, 'done');
});
