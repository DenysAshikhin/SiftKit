import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildToolBatchMessages,
  buildToolExchangeMessages,
  upsertTrailingUserMessage,
  type ToolBatchOutcome,
} from '../src/tool-call-messages.js';
import type { ChatMessage } from '../src/repo-search/planner-chat-message.js';

test('buildToolExchangeMessages builds assistant tool_call and tool result messages', () => {
  const messages = buildToolExchangeMessages(
    {
      toolName: 'grep',
      args: { command: 'rg -n "planner" src' },
    },
    'call_1',
    'Invalid action: example',
    'thinking',
  );

  assert.equal(messages.length, 2);
  assert.equal(messages[0]?.role, 'assistant');
  assert.equal(messages[1]?.role, 'tool');
  assert.equal(String(messages[0]?.tool_calls?.[0]?.function?.name || ''), 'grep');
  assert.equal(
    messages[0]?.tool_calls?.[0]?.function?.arguments,
    '{"command":"rg -n \\"planner\\" src"}',
  );
  assert.equal(String(messages[1]?.tool_call_id || ''), 'call_1');
  assert.equal(String(messages[1]?.content || ''), 'Invalid action: example');
});

test('buildToolBatchMessages emits one assistant message with all tool_calls followed by ordered tool replies', () => {
  const outcomes: ToolBatchOutcome[] = [
    {
      action: { toolName: 'grep', args: { pattern: 'foo' } },
      toolCallId: 'call_a',
      toolContent: 'result a',
    },
    {
      action: { toolName: 'read_lines', args: { path: 'src/x.ts', start: 1, count: 10 } },
      toolCallId: 'call_b',
      toolContent: 'result b',
    },
    {
      action: { toolName: 'json_filter', args: { query: '.foo' } },
      toolCallId: 'call_c',
      toolContent: 'result c',
    },
  ];

  const messages = buildToolBatchMessages(outcomes, 'batched thinking');

  assert.equal(messages.length, 4);
  assert.equal(messages[0]?.role, 'assistant');
  assert.equal(messages[0]?.tool_calls?.length, 3);
  assert.equal(messages[0]?.reasoning_content, 'batched thinking');
  assert.equal(messages[0]?.tool_calls?.[0]?.id, 'call_a');
  assert.equal(messages[0]?.tool_calls?.[1]?.id, 'call_b');
  assert.equal(messages[0]?.tool_calls?.[2]?.id, 'call_c');
  assert.equal(messages[0]?.tool_calls?.[0]?.function?.name, 'grep');
  assert.equal(messages[0]?.tool_calls?.[1]?.function?.name, 'read_lines');
  assert.equal(messages[0]?.tool_calls?.[2]?.function?.name, 'json_filter');

  assert.equal(messages[1]?.role, 'tool');
  assert.equal(messages[1]?.tool_call_id, 'call_a');
  assert.equal(messages[1]?.content, 'result a');
  assert.equal(messages[2]?.tool_call_id, 'call_b');
  assert.equal(messages[2]?.content, 'result b');
  assert.equal(messages[3]?.tool_call_id, 'call_c');
  assert.equal(messages[3]?.content, 'result c');
});

test('buildToolBatchMessages yields nothing for an empty outcome list', () => {
  assert.deepEqual(buildToolBatchMessages([], 'thinking'), []);
});

test('buildToolBatchMessages omits reasoning_content when thinking text is empty', () => {
  const messages = buildToolBatchMessages([
    { action: { toolName: 'grep', args: {} }, toolCallId: 'call_1', toolContent: 'r' },
  ], '');
  assert.equal(messages.length, 2);
  assert.equal('reasoning_content' in (messages[0] || {}), false);
});

test('upsertTrailingUserMessage replaces the existing countdown message in place', () => {
  const messages: ChatMessage[] = [
    { role: 'assistant', content: '' },
    { role: 'tool', content: 'Rejected command.' },
  ];

  const firstIndex = upsertTrailingUserMessage(
    messages,
    -1,
    'Forced finish attempts remaining: 2. Return a finish action now.',
  );
  const secondIndex = upsertTrailingUserMessage(
    messages,
    firstIndex,
    'Forced finish attempts remaining: 1. Return a finish action now.',
  );

  assert.equal(firstIndex, secondIndex);
  assert.equal(messages.length, 3);
  assert.equal(String(messages[2]?.content || ''), 'Forced finish attempts remaining: 1. Return a finish action now.');
});
