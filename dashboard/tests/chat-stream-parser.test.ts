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

test('parses a thinking delta payload', () => {
  const packet = 'event: thinking\ndata: {"turn":2,"offset":5,"text":" more"}';
  assert.deepEqual(parseChatStreamPacket(packet), {
    kind: 'thinking',
    delta: { turn: 2, offset: 5, text: ' more' },
  });
});

test('parses a narration delta payload independently from answers', () => {
  const packet = 'event: narration\ndata: {"turn":2,"offset":5,"text":" more"}';
  assert.deepEqual(parseChatStreamPacket(packet), {
    kind: 'narration',
    delta: { turn: 2, offset: 5, text: ' more' },
  });
});

test('parses an answer delta payload', () => {
  const packet = 'event: answer\ndata: {"turn":3,"offset":0,"text":"Answer start"}';
  assert.deepEqual(parseChatStreamPacket(packet), {
    kind: 'answer',
    delta: { turn: 3, offset: 0, text: 'Answer start' },
  });
});

test('rejects a malformed thinking payload', () => {
  const packet = 'event: thinking\ndata: {"thinking":"legacy snapshot"}';
  assert.equal(parseChatStreamPacket(packet), null);
});

test('parseChatStreamPacket parses warning events', () => {
  assert.deepEqual(
    parseChatStreamPacket('event: warning\ndata: {"warning":"missing file"}\n\n'),
    { kind: 'warning', text: 'missing file' },
  );
});

test('parseChatStreamPacket validates approval events', () => {
  const approval = {
    runId: '4f9c1f9a-0000-4000-8000-000000000000',
    approvalId: '4f9c1f9a-0000-4000-8000-000000000001',
    toolName: 'bash',
    command: 'npm test',
    reviewPayload: null,
  };
  assert.deepEqual(
    parseChatStreamPacket(`event: approval\ndata: ${JSON.stringify(approval)}`),
    { kind: 'approval', approval },
  );
  assert.equal(
    parseChatStreamPacket('event: approval\ndata: {"runId":"not-a-uuid"}'),
    null,
  );
});

test('parseChatStreamPacket parses tool_start and tool_result with toolCallId', () => {
  const start = parseChatStreamPacket(
    'event: tool_start\ndata: {"toolCallId":"tc_0","turn":1,"maxTurns":5,"activityKind":"search","activitySubject":{"kind":"none"},"command":"rg foo","promptTokenCount":42}'
  );
  assert.deepEqual(start, {
    kind: 'tool',
    tool: {
      kind: 'tool_start',
      toolCallId: 'tc_0',
      turn: 1,
      maxTurns: 5,
      activityKind: 'search',
      activitySubject: { kind: 'none' },
      command: 'rg foo',
      promptTokenCount: 42,
    },
  });
  const result = parseChatStreamPacket(
    'event: tool_result\ndata: {"toolCallId":"tc_0","turn":1,"maxTurns":5,"activityKind":"search","activitySubject":{"kind":"none"},"command":"rg foo","exitCode":0,"outputSnippet":"hit","outputTokens":4915,"outputTokensEstimated":false,"promptTokenCount":42}'
  );
  assert.deepEqual(result, {
    kind: 'tool',
    tool: {
      kind: 'tool_result',
      toolCallId: 'tc_0',
      turn: 1,
      maxTurns: 5,
      activityKind: 'search',
      activitySubject: { kind: 'none' },
      command: 'rg foo',
      exitCode: 0,
      outputSnippet: 'hit',
      outputTokens: 4915,
      outputTokensEstimated: false,
      promptTokenCount: 42,
    },
  });
  // The cap crosses the wire only as maxTurns; a legacy toolCallLimit field is rejected, not coerced.
  assert.equal(
    parseChatStreamPacket(
      'event: tool_start\ndata: {"toolCallId":"tc_0","turn":1,"maxTurns":5,"toolCallLimit":5,"activityKind":"search","activitySubject":{"kind":"none"},"command":"rg foo","promptTokenCount":42}'
    ),
    null,
  );
});

test('parseChatStreamPacket rejects malformed tool events instead of coercing them', () => {
  const invalidBodies = [
    { turn: 1, maxTurns: 5, activityKind: 'search', command: 'rg foo', promptTokenCount: 42 },
    { toolCallId: 'tc_0', turn: '1', maxTurns: 5, activityKind: 'search', activitySubject: { kind: 'none' }, command: 'rg foo', promptTokenCount: 42 },
    { toolCallId: 'tc_0', turn: 0, maxTurns: 5, activityKind: 'search', activitySubject: { kind: 'none' }, command: 'rg foo', promptTokenCount: 42 },
    { toolCallId: 'tc_0', turn: 1, maxTurns: 0, activityKind: 'search', activitySubject: { kind: 'none' }, command: 'rg foo', promptTokenCount: 42 },
    { toolCallId: 'tc_0', turn: 1, maxTurns: 5, activityKind: 'search', activitySubject: { kind: 'none' }, command: '', promptTokenCount: 42 },
    { toolCallId: 'tc_0', turn: 1, maxTurns: 5, activitySubject: { kind: 'none' }, command: 'rg foo', promptTokenCount: 42 },
    { toolCallId: 'tc_0', turn: 1, maxTurns: 5, activityKind: 'invalid', activitySubject: { kind: 'none' }, command: 'rg foo', promptTokenCount: 42 },
  ];
  for (const body of invalidBodies) {
    assert.equal(parseChatStreamPacket(`event: tool_start\ndata: ${JSON.stringify(body)}`), null);
  }
});

test('parseChatStreamPacket requires complete tool result metadata', () => {
  const base = {
    toolCallId: 'tc_0', turn: 1, maxTurns: 5, activityKind: 'search', activitySubject: { kind: 'none' }, command: 'rg foo', promptTokenCount: 42,
  };
  assert.equal(parseChatStreamPacket(`event: tool_result\ndata: ${JSON.stringify(base)}`), null);
});

const SAMPLE_SESSION: ChatSessionResponse['session'] = {
  id: 's1',
  title: 't',
  modelPresetId: 'test-model',
  model: null,
  contextWindowTokens: 0,
  planRepoRoot: 'C:/repo',
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
  imageUsedTokens: 0,
  totalUsedTokens: 0,
  remainingTokens: 0,
  warnThresholdTokens: 0,
  shouldCondense: false,
  estimatedTokenFallbackTokens: 0,
  providerOverheadTokens: 0,
};
const SAMPLE_DONE: ChatSessionResponse = { session: SAMPLE_SESSION, contextUsage: SAMPLE_CONTEXT_USAGE };

test('parseChatStreamPacket parses done and error', () => {
  const done = parseChatStreamPacket(`event: done\ndata: ${JSON.stringify(SAMPLE_DONE)}`);
  assert.ok(done?.kind === 'done');
  assert.deepEqual(done.payload, SAMPLE_DONE);
  assert.deepEqual(parseChatStreamPacket('event: error\ndata: {"error":"boom"}'), { kind: 'error', message: 'boom' });
});

test('parseChatStreamPacket returns null on malformed JSON', () => {
  assert.equal(parseChatStreamPacket('event: answer\ndata: {not json'), null);
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
    'event: thinking\ndata: {"turn":1,"offset":0,"text":"a"}\n\nevent: too',
    'l_start\ndata: {"toolCallId":"tc_0","turn":1,"maxTurns":1,"activityKind":"command","activitySubject":{"kind":"none"},"command":"x","promptTokenCount":0}\n\n',
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

test('ChatStreamReader releases the reader lock after complete consumption', async () => {
  let released = false;
  const mockReader: ReadableStreamDefaultReader<Uint8Array> = {
    async read() {
      return { value: undefined, done: true };
    },
    async cancel() {},
    releaseLock() {
      released = true;
    },
    closed: Promise.resolve(undefined),
  };
  for await (const _event of new ChatStreamReader(mockReader).events()) {
    void _event;
  }
  assert.equal(released, true);
});

test('ChatStreamReader releases the reader lock when consumption stops early', async () => {
  const encoder = new TextEncoder();
  let released = false;
  const mockReader: ReadableStreamDefaultReader<Uint8Array> = {
    async read() {
      return { value: encoder.encode('event: thinking\ndata: {"turn":1,"offset":0,"text":"partial"}\n\n'), done: false };
    },
    async cancel() {},
    releaseLock() {
      released = true;
    },
    closed: Promise.resolve(undefined),
  };
  for await (const _event of new ChatStreamReader(mockReader).events()) {
    void _event;
    break;
  }
  assert.equal(released, true);
});

test('parses a usage frame into a usage event', () => {
  const payload = {
    turn: 3,
    maxTurns: 20,
    record: {
      turn: 3, promptTokens: 700, thinkingTokens: 55, outputTokens: 12, toolTokens: 33,
      generatedChars: 268, thinkingTokensEstimated: false, outputTokensEstimated: false,
    },
    totals: {
      promptTokens: 2100, thinkingTokens: 165, outputTokens: 36, toolTokens: 99,
      thinkingTokensEstimatedCount: 0, outputTokensEstimatedCount: 0,
    },
    charsPerToken: 4,
  };
  const packet = `event: usage\ndata: ${JSON.stringify(payload)}`;
  assert.deepEqual(parseChatStreamPacket(packet), { kind: 'usage', usage: payload });
});

test('rejects a malformed usage frame instead of silently dropping the numbers', () => {
  const packet = 'event: usage\ndata: {"turn":3,"maxTurns":20,"charsPerToken":4}';
  assert.equal(parseChatStreamPacket(packet), null);
});

test('parses the attached frame', () => {
  const event = parseChatStreamPacket(
    'event: attached\ndata: {"operationKind":"plan",'
      + '"operationId":"4f9c1f9a-0000-4000-8000-000000000000",'
      + '"startedAtUtc":"2026-09-08T12:00:00.000Z","replayTruncated":true}',
  );
  assert.deepEqual(event, {
    kind: 'attached',
    operationKind: 'plan',
    operationId: '4f9c1f9a-0000-4000-8000-000000000000',
    replayTruncated: true,
  });
});

test('parses the submitted frame', () => {
  const event = parseChatStreamPacket(
    'event: submitted\ndata: {"content":"fix it","images":["data:image/png;base64,AAAA"]}',
  );
  assert.deepEqual(event, {
    kind: 'submitted',
    content: 'fix it',
    images: ['data:image/png;base64,AAAA'],
  });
});

test('parses a pending approval state frame', () => {
  const event = parseChatStreamPacket(
    'event: approval_state\ndata: {"approval":{'
      + '"runId":"4f9c1f9a-0000-4000-8000-000000000000",'
      + '"approvalId":"4f9c1f9a-0000-4000-8000-000000000001",'
      + '"toolName":"bash","command":"git status","reviewPayload":null}}',
  );
  assert.equal(event?.kind, 'approval-state');
  assert.equal(event?.kind === 'approval-state' ? event.approval?.command : null, 'git status');
});

test('parses an empty approval state frame as a cleared approval', () => {
  const event = parseChatStreamPacket('event: approval_state\ndata: {"approval":null}');
  assert.deepEqual(event, { kind: 'approval-state', approval: null });
});

test('parses a resolved approval frame', () => {
  const event = parseChatStreamPacket(
    'event: approval_resolved\ndata: {"approval":{'
      + '"runId":"4f9c1f9a-0000-4000-8000-000000000000",'
      + '"approvalId":"4f9c1f9a-0000-4000-8000-000000000001",'
      + '"toolName":"bash","command":"rm -rf build","reviewPayload":null},'
      + '"decision":{"decision":"deny","reason":"too broad"},'
      + '"decidedAtUtc":"2026-09-08T12:00:05.000Z"}',
  );
  assert.equal(event?.kind, 'approval-resolved');
  assert.equal(
    event?.kind === 'approval-resolved' ? event.resolution.decision.decision : null,
    'deny',
  );
});

test('parses the ended frame', () => {
  assert.deepEqual(parseChatStreamPacket('event: ended\ndata: {}'), { kind: 'ended' });
});

test('rejects a malformed approval state frame', () => {
  assert.equal(parseChatStreamPacket('event: approval_state\ndata: {"approval":{"runId":"x"}}'), null);
});
