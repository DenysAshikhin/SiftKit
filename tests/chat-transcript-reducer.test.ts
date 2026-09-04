import test from 'node:test';
import assert from 'node:assert/strict';
import {
  finalizeStoppedChatTranscript,
  reduceChatTranscript,
  type ChatTranscriptMessage,
  type ChatStreamUsageEvent,
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

test('a usage frame refuses to fold the run total onto more than one answer row', () => {
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
    () => reduceChatTranscript(messages, { kind: 'usage', usage: usageFrameForTurn(2, 10, 60) }, metadata),
    /multiple answer rows/u,
  );
});

function usageFrameForTurn(turn: number, thinkingTokens: number, outputTokens: number): ChatStreamUsageEvent {
  return {
    turn,
    maxTurns: 20,
    record: {
      turn,
      promptTokens: 500,
      thinkingTokens,
      outputTokens,
      toolTokens: 0,
      generatedChars: 480,
      thinkingTokensEstimated: false,
      outputTokensEstimated: false,
    },
    totals: {
      promptTokens: 500,
      thinkingTokens,
      outputTokens,
      toolTokens: 0,
      thinkingTokensEstimatedCount: 0,
      outputTokensEstimatedCount: 0,
    },
    charsPerToken: 4,
  };
}

test('a live thinking row carries no self-derived token estimate', () => {
  const messages = reduceChatTranscript([], {
    kind: 'thinking',
    delta: { turn: 1, offset: 0, text: 'x'.repeat(400) },
  }, metadata);
  assert.equal(messages[0]?.thinkingTokens, 0);
  assert.equal(messages[0]?.thinkingTokensEstimated, false);
});

test('a live answer row carries no self-derived token estimate', () => {
  const messages = reduceChatTranscript([], {
    kind: 'answer',
    delta: { turn: 1, offset: 0, text: 'y'.repeat(400) },
  }, metadata);
  assert.equal(messages[0]?.outputTokensEstimate, 0);
  assert.equal(messages[0]?.outputTokensEstimated, false);
});

test('a usage frame snaps the turn rows to the engine-measured counts', () => {
  const usageFrame = usageFrameForTurn(2, 95, 60);
  const streamed = reduceChatTranscript(
    reduceChatTranscript([], { kind: 'thinking', delta: { turn: 2, offset: 0, text: 'reasoning' } }, metadata),
    { kind: 'answer', delta: { turn: 2, offset: 0, text: 'the answer' } },
    metadata,
  );
  const settled = reduceChatTranscript(streamed, { kind: 'usage', usage: usageFrame }, metadata);
  const thinking = settled.find((message) => message.kind === 'assistant_thinking');
  const answer = settled.find((message) => message.kind === 'assistant_answer');
  assert.equal(thinking?.thinkingTokens, usageFrame.record.thinkingTokens);
  assert.equal(answer?.outputTokensEstimate, usageFrame.totals.outputTokens);
});

test('a usage frame for another turn leaves that turn thinking row alone', () => {
  const streamed = reduceChatTranscript(
    reduceChatTranscript([], { kind: 'thinking', delta: { turn: 1, offset: 0, text: 'first reasoning' } }, metadata),
    { kind: 'thinking', delta: { turn: 2, offset: 0, text: 'second reasoning' } },
    metadata,
  );
  const settled = reduceChatTranscript(streamed, { kind: 'usage', usage: usageFrameForTurn(2, 95, 60) }, metadata);
  assert.equal(settled.find((message) => message.id === 'test-thinking-1')?.thinkingTokens, 0);
  assert.equal(settled.find((message) => message.id === 'test-thinking-2')?.thinkingTokens, 95);
});
