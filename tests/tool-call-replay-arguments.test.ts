import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildAssistantToolCallMessage } from '../src/tool-call-messages.js';
import { toProtocolChatMessages } from '../src/repo-search/planner-protocol.js';

test('replayed tool calls carry standard string arguments', () => {
  const message = buildAssistantToolCallMessage([
    { action: { toolName: 'git', args: { operation: 'status' } }, toolCallId: 't1_c0', toolContent: '' },
  ]);
  const call = message.tool_calls[0];
  assert.equal(call.function.arguments, '{"operation":"status"}');
});

test('serialization preserves string arguments byte-for-byte', () => {
  const serialized = toProtocolChatMessages([
    buildAssistantToolCallMessage([
      { action: { toolName: 'read', args: { path: 'src/app.ts', offset: 1, limit: 10 } }, toolCallId: 't2_c0', toolContent: '' },
    ]),
  ]);
  const call = serialized[0].tool_calls?.[0];
  assert.ok(call);
  assert.equal(call.function.arguments, '{"path":"src/app.ts","offset":1,"limit":10}');
});
