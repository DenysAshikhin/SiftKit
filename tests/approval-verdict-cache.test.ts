import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildApprovalVerdictPromptMessages,
  captureExecutingPlannerRequest,
  resolveRepoSearchPlannerToolDefinitions,
  serializeProtocolMessages,
} from '../src/repo-search/planner-protocol.js';
import { buildAssistantToolCallMessage } from '../src/tool-call-messages.js';
import { toProtocolTools } from '../src/providers/llama-cpp.js';

test('the verdict prompt shares P + A with the next planner request', () => {
  const transcript = [
    { role: 'system' as const, content: 'sys' },
    { role: 'user' as const, content: 'task' },
  ];
  const assistant = buildAssistantToolCallMessage([{
    action: { toolName: 'write', args: { path: 'a.ts', content: 'x'.repeat(4096) } },
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

test('captureExecutingPlannerRequest isolates the snapshot from later input mutation', () => {
  const flags = {
    thinkingEnabled: false,
    reasoningContentEnabled: false,
    preserveThinking: false,
  };
  const tools = toProtocolTools(resolveRepoSearchPlannerToolDefinitions(['read']));
  const captured = captureExecutingPlannerRequest(
    serializeProtocolMessages([{ role: 'user', content: 'q' }], false),
    flags,
    tools,
    3,
    1_000,
  );
  const serializedToolsBefore = captured.serializedToolsJson;
  const toolsBefore = [{
    type: 'function',
    function: {
      name: 'read',
      description: tools[0].function.description,
      parameters: tools[0].function.parameters,
    },
  }];

  flags.thinkingEnabled = true;
  flags.reasoningContentEnabled = true;
  flags.preserveThinking = true;
  tools[0].function.description = 'mutated after capture';

  assert.deepEqual(captured.flags, {
    thinkingEnabled: false,
    reasoningContentEnabled: false,
    preserveThinking: false,
  });
  assert.equal(captured.serializedToolsJson, serializedToolsBefore);
  assert.deepEqual(captured.tools, toolsBefore);
});
