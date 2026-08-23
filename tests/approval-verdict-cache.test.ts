import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildApprovalVerdictPromptMessages,
  serializeProtocolMessages,
} from '../src/repo-search/planner-protocol.js';
import { buildAssistantToolCallMessage } from '../src/tool-call-messages.js';

test('the verdict prompt shares P + A with the next planner request', () => {
  const transcript = [
    { role: 'system' as const, content: 'sys' },
    { role: 'user' as const, content: 'task' },
  ];
  const assistant = buildAssistantToolCallMessage([{
    action: { tool_name: 'write', args: { path: 'a.ts', content: 'x'.repeat(4096) } },
    toolCallId: 't1_c0',
    toolContent: '',
  }]);
  const verdict = serializeProtocolMessages(
    buildApprovalVerdictPromptMessages(transcript, [assistant], 'policy?'),
    false,
  );
  const nextTurn = serializeProtocolMessages(
    [...transcript, assistant, { role: 'tool' as const, tool_call_id: 't1_c0', content: 'ok' }],
    false,
  );

  for (let index = 0; index < 3; index += 1) {
    assert.equal(JSON.stringify(verdict[index]), JSON.stringify(nextTurn[index]));
  }
  assert.notEqual(JSON.stringify(verdict[3]), JSON.stringify(nextTurn[3]));
});
