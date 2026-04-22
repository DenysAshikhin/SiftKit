import test from 'node:test';
import assert from 'node:assert/strict';

import {
  appendToolCallExchange,
  upsertTrailingUserMessage,
  type ToolTranscriptMessage,
} from '../src/tool-call-messages.js';

test('appendToolCallExchange appends assistant tool_call and tool result messages', () => {
  const messages: ToolTranscriptMessage[] = [];

  appendToolCallExchange(
    messages,
    {
      tool_name: 'repo_rg',
      args: { command: 'rg -n "planner" src' },
    },
    'call_1',
    'Invalid action: example',
    'thinking',
  );

  assert.equal(messages.length, 2);
  assert.equal(messages[0]?.role, 'assistant');
  assert.equal(messages[1]?.role, 'tool');
  assert.equal(String(messages[0]?.tool_calls?.[0]?.function?.name || ''), 'repo_rg');
  assert.equal(String(messages[1]?.tool_call_id || ''), 'call_1');
  assert.equal(String(messages[1]?.content || ''), 'Invalid action: example');
});

test('upsertTrailingUserMessage replaces the existing countdown message in place', () => {
  const messages: ToolTranscriptMessage[] = [
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
