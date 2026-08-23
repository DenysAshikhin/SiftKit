import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildBatchToolCallId,
  buildPendingAssistantMessage,
  resolveToolActionIdentity,
} from '../src/repo-search/engine/pending-tool-call-message.js';
import { buildAssistantToolCallMessage } from '../src/tool-call-messages.js';
import { buildApprovalVerdictPromptMessages } from '../src/repo-search/planner-protocol.js';

test('tool-call ids depend only on turn and batch index', () => {
  assert.equal(buildBatchToolCallId(3, 0), 't3_c0');
  assert.equal(buildBatchToolCallId(3, 1), 't3_c1');
  assert.notEqual(buildBatchToolCallId(3, 0), buildBatchToolCallId(4, 0));
});

test('the pending message equals the appended message when every call is approved', () => {
  const pending = buildPendingAssistantMessage({
    turn: 2,
    thinkingText: 'plan',
    toolActions: [{
      action: 'tool',
      tool_name: 'write',
      args: { path: 'a.ts', content: 'x' },
    }],
  });
  const appended = buildAssistantToolCallMessage([{
    action: { tool_name: 'write', args: { path: 'a.ts', content: 'x' } },
    toolCallId: 't2_c0',
    toolContent: 'ok',
  }], 'plan');

  assert.deepEqual(pending, appended);
});

test('pending and validated command tools share one normalized identity', () => {
  const toolAction = { action: 'tool' as const, tool_name: 'git', args: { command: 'status --short' } };

  assert.deepEqual(resolveToolActionIdentity(toolAction), {
    normalizedToolName: 'git',
    isCommandTool: true,
    isNativeTool: false,
    command: 'git status --short',
    rawArgs: { command: 'status --short' },
  });
  const pending = buildPendingAssistantMessage({
    turn: 4,
    thinkingText: '',
    toolActions: [toolAction],
  });
  assert.equal(pending.tool_calls[0]?.function.arguments, '{"command":"git status --short"}');
});

test('the verdict prompt is transcript, then pending message, then question', () => {
  const transcript = [
    { role: 'system' as const, content: 'sys' },
    { role: 'user' as const, content: 'task' },
  ];
  const pending = [{
    role: 'assistant' as const,
    content: '',
    tool_calls: [{
      id: 't1_c0',
      type: 'function',
      function: { name: 'write', arguments: '{"path":"a.ts"}' },
    }],
  }];

  const messages = buildApprovalVerdictPromptMessages(transcript, pending, 'policy?');

  assert.equal(messages.length, 4);
  assert.equal(messages[2], pending[0]);
  assert.deepEqual(messages[3], { role: 'user', content: 'policy?' });
});
