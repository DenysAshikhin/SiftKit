import test from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';

import { TranscriptManager } from '../src/repo-search/engine/transcript-manager.js';
import type { ChatContextRecorder } from '../src/repo-search/engine/chat-run-evidence.js';
import { buildCompactionSummaryMessage } from '../src/repo-search/engine/transcript-compactor.js';
import { renderTaskTranscript } from '../src/repo-search/planner-protocol.js';
import { countContentImages, extractContentText } from '../src/llm-protocol/image-attachments.js';
import type {
  ChatContextInit,
  ChatContextSplice,
  ChatMessage,
} from '../src/repo-search/planner-chat-message.js';

function makeTranscript(): TranscriptManager {
  return new TranscriptManager({
    systemPromptContent: 'SYSTEM',
    historyMessages: [{ role: 'user', content: 'earlier' }, { role: 'assistant', content: 'reply' }],
    initialUserContent: 'QUESTION',
    initialUserImages: [],
    liveImagePathKeys: new Set<string>(),
  });
}

test('constructor builds system + history + initial user message in order', () => {
  const transcript = makeTranscript();
  const messages = transcript.getMessages();
  assert.equal(messages.length, 4);
  assert.deepEqual(messages.map((message) => message.role), ['system', 'user', 'assistant', 'user']);
  assert.equal(messages[0].content, 'SYSTEM');
  assert.equal(messages[3].content, 'QUESTION');
});

test('takeNewMessagesForLogging returns only messages appended since last call', () => {
  const transcript = makeTranscript();
  assert.equal(transcript.takeNewMessagesForLogging().length, 4);
  transcript.pushUser('extra');
  const fresh = transcript.takeNewMessagesForLogging();
  assert.equal(fresh.length, 1);
  assert.equal(fresh[0].content, 'extra');
  assert.equal(transcript.takeNewMessagesForLogging().length, 0);
});

test('replaceWith swaps content and resets the logging cursor', () => {
  const transcript = makeTranscript();
  transcript.takeNewMessagesForLogging();
  transcript.replaceWith([{ role: 'system', content: 'S2' }, { role: 'user', content: 'U2' }], 1);
  assert.equal(transcript.length, 2);
  assert.equal(transcript.takeNewMessagesForLogging().length, 2);
});

test('appendBatchExchange appends assistant tool_calls + tool results and returns pre-append length', () => {
  const transcript = makeTranscript();
  const preAppendLength = transcript.appendBatchExchange(
    [{ action: { toolName: 'run_repo_cmd', args: { command: 'rg -n foo' } }, toolCallId: 'call_1', toolContent: 'result-text' }],
    'thinking-text',
  );
  assert.equal(preAppendLength, 4);
  const messages = transcript.getMessages();
  assert.equal(messages[4].role, 'assistant');
  assert.equal(messages[5].role, 'tool');
  assert.equal(messages[5].content, 'result-text');
  assert.equal(messages[5].tool_call_id, 'call_1');
});

test('pruneThinking keeps only the latest assistant reasoning_content when per-step thinking is disabled', () => {
  const transcript = makeTranscript();
  transcript.pushAssistant({ role: 'assistant', content: 'first', reasoning_content: 'think one' });
  transcript.appendBatchExchange(
    [{ action: { toolName: 'run_repo_cmd', args: { command: 'rg -n foo' } }, toolCallId: 'call_1', toolContent: 'result-text' }],
    'think two',
  );
  transcript.pushAssistant({ role: 'assistant', content: 'final', reasoning_content: 'final think' });

  transcript.pruneThinking(false);

  const reasoningMessages = transcript.getMessages().filter((message) => typeof message.reasoning_content === 'string');
  assert.equal(reasoningMessages.length, 1);
  assert.equal(reasoningMessages[0].reasoning_content, 'final think');
});

test('appendToolExchange and explicit push helpers append transcript messages', () => {
  const transcript = makeTranscript();
  transcript.appendToolExchange(
    { toolName: 'run_repo_cmd', args: { command: 'rg -n foo' } },
    'call_1',
    'result-text',
    'thinking-text',
  );
  transcript.pushAssistant({ role: 'assistant', content: 'assistant reply' });
  transcript.pushUser('user reply');
  const messages = transcript.getMessages();
  assert.equal(messages[4].role, 'assistant');
  assert.equal(messages[5].role, 'tool');
  assert.equal(messages[5].tool_call_id, 'call_1');
  assert.equal(messages[6].content, 'assistant reply');
  assert.equal(messages[7].content, 'user reply');
});

test('replaceToolResult refuses a call the transcript never answered', () => {
  const transcript = makeTranscript();
  assert.equal(transcript.hasToolResult('call_missing'), false);
  assert.throws(
    () => transcript.replaceToolResult('call_missing', 'replacement'),
    /no tool result for call call_missing/u,
  );
  assert.deepEqual(transcript.getMessages().map((message) => message.role), ['system', 'user', 'assistant', 'user']);
});

test('TranscriptManager attaches images to the initial user turn', () => {
  const manager = new TranscriptManager({
    systemPromptContent: 'system',
    historyMessages: [],
    initialUserContent: 'describe this',
    initialUserImages: ['data:image/png;base64,AAAA'],
    liveImagePathKeys: new Set<string>(),
  });
  assert.deepEqual(manager.getMessages()[1], {
    role: 'user',
    content: [
      { type: 'text', text: 'describe this' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
    ],
  });
});

test('TranscriptManager keeps a plain string when there are no images', () => {
  const manager = new TranscriptManager({
    systemPromptContent: 'system',
    historyMessages: [],
    initialUserContent: 'plain',
    initialUserImages: [],
    liveImagePathKeys: new Set<string>(),
  });
  assert.deepEqual(manager.getMessages()[1], { role: 'user', content: 'plain' });
});

test('replaceToolResult overwrites the answer in place, keeping its call id', () => {
  const transcript = makeTranscript();
  transcript.appendBatchExchange(
    [{ action: { toolName: 'run_repo_cmd', args: { command: 'rg -n foo' } }, toolCallId: 'call_1', toolContent: 'original' }],
    '',
  );
  transcript.replaceToolResult('call_1', 'duplicate command requested x2');
  const replaced = transcript.getMessages()[5];
  assert.equal(replaced.role, 'tool');
  assert.equal(replaced.tool_call_id, 'call_1');
  assert.equal(replaced.content, 'duplicate command requested x2');
});

test('replaceToolResult finds the answer after inserted images shifted its index', () => {
  const transcript = makeTranscript();
  transcript.appendBatchExchange(
    [
      { action: { toolName: 'read', args: { path: 'a.png' } }, toolCallId: 'call_a', toolContent: 'image a' },
      { action: { toolName: 'grep', args: { pattern: 'x' } }, toolCallId: 'call_b', toolContent: 'hits' },
    ],
    '',
  );
  // The engine inserts the read image directly after its own tool result, which moves call_b's.
  transcript.insertUserAfter(5, 'image a', ['data:image/png;base64,AAAA'], 'a.png');

  transcript.replaceToolResult('call_b', 'duplicate command requested x2');

  const answers = transcript.getMessages().filter((message) => message.role === 'tool');
  assert.deepEqual(answers.map((message) => message.tool_call_id), ['call_a', 'call_b']);
  assert.equal(answers[1].content, 'duplicate command requested x2');
});

test('upsertForcedFinishCountdown appends then updates the same trailing user message', () => {
  const transcript = makeTranscript();
  transcript.upsertForcedFinishCountdown('countdown 2');
  assert.equal(transcript.getMessages()[4].content, 'countdown 2');
  transcript.upsertForcedFinishCountdown('countdown 1');
  assert.equal(transcript.length, 5);
  assert.equal(transcript.getMessages()[4].content, 'countdown 1');
});

test('a compaction forgets the countdown slot instead of overwriting a rebuilt message', () => {
  const transcript = makeTranscript();
  transcript.upsertForcedFinishCountdown('countdown 2');
  transcript.replaceWith([
    { role: 'system', content: 'S2' },
    buildCompactionSummaryMessage('summary'),
    { role: 'user', content: 'trigger question' },
  ], 2);

  transcript.upsertForcedFinishCountdown('countdown 1');

  assert.deepEqual(transcript.getMessages().map((message) => message.content), [
    'S2',
    buildCompactionSummaryMessage('summary').content,
    'trigger question',
    'countdown 1',
  ]);
});

test('replaceWith bumps the context revision', () => {
  const transcript = new TranscriptManager({
    systemPromptContent: 'sys',
    historyMessages: [],
    initialUserContent: 'question',
    initialUserImages: [],
    liveImagePathKeys: new Set<string>(),
  });
  assert.equal(transcript.contextRevision, 0);
  transcript.replaceWith([{ role: 'user', content: 'compacted' }], 0);
  assert.equal(transcript.contextRevision, 1);
});

test('chat compaction tracks the current turn after persisted history and after replacement', () => {
  const transcript = new TranscriptManager({
    systemPromptContent: 'system',
    historyMessages: [
      { role: 'user', content: 'old question' },
      { role: 'assistant', content: 'old answer' },
    ],
    initialUserContent: 'trigger question',
    initialUserImages: [],
    liveImagePathKeys: new Set<string>(),
  });

  assert.equal(transcript.currentTurnStartIndex, 3);
  transcript.replaceWith([
    { role: 'system', content: 'system' },
    buildCompactionSummaryMessage('summary'),
    { role: 'user', content: 'trigger question' },
  ], 2);
  assert.equal(transcript.currentTurnStartIndex, 2);
});

test('render produces transcripts and tolerates malformed input', () => {
  const transcript = makeTranscript();
  assert.ok(transcript.render(false).includes('QUESTION'));
  // Intentionally malformed (no role) to exercise the renderer's roleless path;
  // brand it as ChatMessage through a runtime check instead of a cast.
  const roleless = z.custom<ChatMessage>(() => true).parse({ content: 'roleless' });
  assert.ok(renderTaskTranscript([roleless], { includeReasoningContent: false }).includes('roleless'));
});

class SpyRecorder implements ChatContextRecorder {
  readonly initialized: ChatContextInit[] = [];
  readonly splices: ChatContextSplice[] = [];

  recordContextInitialized(init: ChatContextInit): void {
    this.initialized.push(init);
  }

  recordContextSpliced(splice: ChatContextSplice): void {
    this.splices.push(splice);
  }
}

function makeRecordedTranscript(recorder: ChatContextRecorder): TranscriptManager {
  return new TranscriptManager({
    systemPromptContent: 'SYSTEM',
    historyMessages: [{ role: 'user', content: 'earlier' }],
    initialUserContent: 'QUESTION',
    initialUserImages: [],
    liveImagePathKeys: new Set<string>(),
    contextRecorder: recorder,
  });
}

test('a bound transcript records its initial context before anything mutates it', () => {
  const recorder = new SpyRecorder();
  const transcript = makeRecordedTranscript(recorder);

  assert.equal(recorder.initialized.length, 1);
  assert.deepEqual(recorder.initialized[0].messages, transcript.getMessages());
  assert.equal(recorder.initialized[0].contextRevision, 0);
  assert.equal(recorder.initialized[0].turnBoundary, 2);
  assert.deepEqual(recorder.splices, []);
});

test('every named mutation is recorded as one splice against the revision it amends', () => {
  const recorder = new SpyRecorder();
  const transcript = makeRecordedTranscript(recorder);

  transcript.appendBatchExchange(
    [{ action: { toolName: 'grep', args: { pattern: 'x' } }, toolCallId: 'call_1', toolContent: 'hit' }],
    'thinking',
  );
  transcript.insertUserAfter(3, 'image', ['data:image/png;base64,AAAA'], 'a.png');
  transcript.replaceToolResult('call_1', 'duplicate command requested x2');
  transcript.upsertForcedFinishCountdown('countdown 1');
  transcript.pushAssistant({ role: 'assistant', content: 'final', reasoning_content: 'final think' });
  transcript.pruneThinking(false);
  transcript.replaceWith([{ role: 'system', content: 'SYSTEM' }, { role: 'user', content: 'QUESTION' }], 1);

  assert.deepEqual(recorder.splices.map((splice) => splice.reason), [
    'append',
    'insert',
    'tool_result_replaced',
    'trailing_user_replaced',
    'append',
    'thinking_pruned',
    'compacted',
  ]);
  recorder.splices.forEach((splice, index) => {
    assert.equal(splice.expectedRevision, index);
    assert.equal(splice.contextRevision, index + 1);
  });
  assert.equal(transcript.contextRevision, recorder.splices.length);
});

test('a mutation the recorder refuses never reaches the history the model reads', () => {
  const recorder = new SpyRecorder();
  const failing: ChatContextRecorder = {
    recordContextInitialized: (init) => recorder.recordContextInitialized(init),
    recordContextSpliced: () => {
      throw new Error('journal write failed');
    },
  };
  const transcript = makeRecordedTranscript(failing);
  const before = [...transcript.getMessages()];

  assert.throws(() => transcript.pushUser('never committed'), /journal write failed/u);

  assert.deepEqual(transcript.getMessages(), before);
  assert.equal(transcript.contextRevision, 0);
});

test('pruning images through the transcript records the rewrite and releases the guards', () => {
  const liveImagePathKeys = new Set<string>(['docs/a.png']);
  const recorder = new SpyRecorder();
  const transcript = new TranscriptManager({
    systemPromptContent: 'SYSTEM',
    historyMessages: [],
    initialUserContent: 'QUESTION',
    initialUserImages: [],
    liveImagePathKeys,
    contextRecorder: recorder,
  });
  transcript.pushUser('image docs/a.png', ['data:image/png;base64,AAAA'], 'docs/a.png');

  transcript.pruneImages(0);
  // Nothing left to age out: a second pass must not record a no-op splice.
  transcript.pruneImages(0);

  assert.deepEqual(recorder.splices.map((splice) => splice.reason), ['append', 'images_pruned']);
  assert.equal(liveImagePathKeys.size, 0);
  assert.equal(countContentImages(transcript.getMessages()[2].content), 0);
  assert.equal(
    extractContentText(transcript.getMessages()[2].content).includes('dropped from context'),
    true,
  );
});
