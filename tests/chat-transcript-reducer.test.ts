import test from 'node:test';
import assert from 'node:assert/strict';
import {
  finalizeStoppedChatTranscript,
  reduceChatTranscript,
  type ChatTranscriptMessage,
  type ChatTranscriptMetadata,
} from '@siftkit/contracts';

const metadata: ChatTranscriptMetadata = {
  messageIdPrefix: 'test',
  sourceRunId: 'run-1',
  createdAtUtc: '2026-09-03T12:00:00.000Z',
};

test('chat transcript reducer applies cumulative and appended text in turn order', () => {
  let messages: ChatTranscriptMessage[] = [];
  messages = reduceChatTranscript(messages, {
    kind: 'thinking',
    delta: { turn: 1, offset: 0, text: 'Inspect' },
  }, metadata);
  messages = reduceChatTranscript(messages, {
    kind: 'thinking',
    delta: { turn: 1, offset: 7, text: ' files' },
  }, metadata);
  messages = reduceChatTranscript(messages, {
    kind: 'thinking',
    delta: { turn: 2, offset: 0, text: 'Check tests' },
  }, metadata);
  messages = reduceChatTranscript(messages, {
    kind: 'narration',
    delta: { turn: 2, offset: 0, text: 'Opening files.' },
  }, metadata);
  messages = reduceChatTranscript(messages, {
    kind: 'answer',
    delta: { turn: 2, offset: 0, text: 'Partial answer' },
  }, metadata);

  assert.deepEqual(messages.map((message) => [message.kind, message.content]), [
    ['assistant_thinking', 'Inspect files'],
    ['assistant_thinking', 'Check tests'],
    ['assistant_answer', 'Partial answer'],
  ]);
});

test('chat transcript reducer replaces progress and upserts tool lifecycle state', () => {
  let messages: ChatTranscriptMessage[] = [];
  messages = reduceChatTranscript(messages, {
    kind: 'narration',
    delta: { turn: 1, offset: 0, text: 'Inspecting.' },
  }, metadata);
  messages = reduceChatTranscript(messages, {
    kind: 'progress',
    progress: { turn: 1, text: 'Step 1 of 2', elapsedMs: 10 },
  }, metadata);
  messages = reduceChatTranscript(messages, {
    kind: 'progress',
    progress: { turn: 1, text: 'Step 2 of 2', elapsedMs: 20 },
  }, metadata);
  messages = reduceChatTranscript(messages, {
    kind: 'tool',
    tool: {
      kind: 'tool_start',
      toolCallId: 'read-1',
      turn: 1,
      maxTurns: 3,
      activityKind: 'read',
      activitySubject: { kind: 'file', value: 'src/a.ts' },
      command: 'read path="src/a.ts"',
      promptTokenCount: 4,
    },
  }, metadata);
  messages = reduceChatTranscript(messages, {
    kind: 'tool',
    tool: {
      kind: 'tool_result',
      toolCallId: 'read-1',
      turn: 1,
      maxTurns: 3,
      activityKind: 'read',
      activitySubject: { kind: 'file', value: 'src/a.ts' },
      command: 'read path="src/a.ts"',
      promptTokenCount: 4,
      exitCode: 0,
      outputSnippet: 'file text',
      outputTokens: 2,
      outputTokensEstimated: false,
    },
  }, metadata);

  assert.deepEqual(messages.map((message) => message.kind), [
    'assistant_progress',
    'assistant_progress',
    'assistant_tool_call',
  ]);
  assert.equal(messages[0]?.content, 'Inspecting.');
  assert.equal(messages[1]?.content, 'Step 2 of 2');
  const tool = messages.find((message) => message.kind === 'assistant_tool_call');
  assert.equal(tool?.id, 'test-tool-read-1');
  assert.equal(tool?.toolCallStatus, 'done');
  assert.equal(tool?.toolCallOutputSnippet, 'file text');
  assert.equal(tool?.toolCallPromptTokenCount, 4);
  assert.equal(tool?.outputTokensEstimated, false);
});

test('stopped transcript finalization preserves partial output and terminals running tools', () => {
  let messages: ChatTranscriptMessage[] = [];
  messages = reduceChatTranscript(messages, {
    kind: 'thinking',
    delta: { turn: 1, offset: 0, text: 'Reasoning' },
  }, metadata);
  messages = reduceChatTranscript(messages, {
    kind: 'progress',
    progress: { turn: 1, text: 'Working', elapsedMs: 12 },
  }, metadata);
  messages = reduceChatTranscript(messages, {
    kind: 'tool',
    tool: {
      kind: 'tool_start',
      toolCallId: 'search-1',
      turn: 1,
      maxTurns: 2,
      activityKind: 'search',
      activitySubject: { kind: 'none' },
      command: 'search query="needle"',
      promptTokenCount: 3,
    },
  }, metadata);
  messages = reduceChatTranscript(messages, {
    kind: 'answer',
    delta: { turn: 1, offset: 0, text: 'partial answer' },
  }, metadata);

  const stopped = finalizeStoppedChatTranscript(messages, '*Stopped by user.*', metadata);

  assert.deepEqual(stopped.map((message) => message.kind), [
    'assistant_thinking',
    'assistant_progress',
    'assistant_tool_call',
    'assistant_answer',
  ]);
  const tool = stopped.find((message) => message.kind === 'assistant_tool_call');
  assert.equal(tool?.toolCallStatus, 'stopped');
  assert.equal(stopped.at(-1)?.content, 'partial answer\n\n*Stopped by user.*');
});

test('empty snapshots do not create transcript rows', () => {
  const messages = reduceChatTranscript([], {
    kind: 'thinking',
    delta: { turn: 1, offset: 0, text: '' },
  }, metadata);
  assert.deepEqual(messages, []);
});

test('stopped transcript finalization rejects multiple answer rows', () => {
  let messages: ChatTranscriptMessage[] = [];
  messages = reduceChatTranscript(messages, {
    kind: 'answer',
    delta: { turn: 1, offset: 0, text: 'first' },
  }, metadata);
  messages = reduceChatTranscript(messages, {
    kind: 'answer',
    delta: { turn: 2, offset: 0, text: 'second' },
  }, metadata);

  assert.throws(
    () => finalizeStoppedChatTranscript(messages, '*Stopped by user.*', metadata),
    /multiple answer rows/u,
  );
});
