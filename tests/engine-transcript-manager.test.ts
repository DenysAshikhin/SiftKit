import test from 'node:test';
import assert from 'node:assert/strict';

import { TranscriptManager } from '../src/repo-search/engine/transcript-manager.js';
import type { ChatMessage } from '../src/repo-search/planner-protocol.js';

function makeTranscript(): TranscriptManager {
  return new TranscriptManager({
    systemPromptContent: 'SYSTEM',
    historyMessages: [{ role: 'user', content: 'earlier' }, { role: 'assistant', content: 'reply' }],
    initialUserContent: 'QUESTION',
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
  transcript.replaceWith([{ role: 'system', content: 'S2' }, { role: 'user', content: 'U2' }]);
  assert.equal(transcript.length, 2);
  assert.equal(transcript.takeNewMessagesForLogging().length, 2);
});

test('appendBatchExchange appends assistant tool_calls + tool results and returns pre-append length', () => {
  const transcript = makeTranscript();
  const preAppendLength = transcript.appendBatchExchange(
    [{ action: { tool_name: 'run_repo_cmd', args: { command: 'rg -n foo' } }, toolCallId: 'call_1', toolContent: 'result-text' }],
    'thinking-text',
  );
  assert.equal(preAppendLength, 4);
  const messages = transcript.getMessages();
  assert.equal(messages[4].role, 'assistant');
  assert.equal(messages[5].role, 'tool');
  assert.equal(messages[5].content, 'result-text');
  assert.equal(messages[5].tool_call_id, 'call_1');
});

test('appendToolExchange and explicit push helpers append transcript messages', () => {
  const transcript = makeTranscript();
  transcript.appendToolExchange(
    { tool_name: 'run_repo_cmd', args: { command: 'rg -n foo' } },
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

test('replaceToolMessage on a non-tool message writes a tool message without an id', () => {
  const transcript = makeTranscript();
  transcript.replaceToolMessage(0, 'replacement');
  const message = transcript.getMessages()[0];
  assert.equal(message.role, 'tool');
  assert.equal(message.tool_call_id, undefined);
  assert.equal(message.content, 'replacement');
});

test('replaceToolMessage overwrites in place preserving tool_call_id', () => {
  const transcript = makeTranscript();
  transcript.appendBatchExchange(
    [{ action: { tool_name: 'run_repo_cmd', args: { command: 'rg -n foo' } }, toolCallId: 'call_1', toolContent: 'original' }],
    '',
  );
  transcript.replaceToolMessage(5, 'duplicate command requested x2');
  const replaced = transcript.getMessages()[5];
  assert.equal(replaced.role, 'tool');
  assert.equal(replaced.tool_call_id, 'call_1');
  assert.equal(replaced.content, 'duplicate command requested x2');
});

test('upsertTrailingUser appends then updates the same trailing user message', () => {
  const transcript = makeTranscript();
  const firstIndex = transcript.upsertTrailingUser(-1, 'countdown 2');
  assert.equal(transcript.getMessages()[firstIndex].content, 'countdown 2');
  const secondIndex = transcript.upsertTrailingUser(firstIndex, 'countdown 1');
  assert.equal(secondIndex, firstIndex);
  assert.equal(transcript.length, 5);
  assert.equal(transcript.getMessages()[secondIndex].content, 'countdown 1');
});

test('render and renderTail produce transcripts', () => {
  const transcript = makeTranscript();
  transcript.getMessages().push({ content: 'roleless' } as ChatMessage);
  assert.ok(transcript.render().includes('QUESTION'));
  assert.ok(transcript.messageRoles().includes('unknown'));
  assert.ok(!transcript.renderTail(2).includes('SYSTEM'));
});
