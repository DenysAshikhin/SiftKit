import assert from 'node:assert/strict';
import test from 'node:test';
import {
  captureExecutingPlannerRequest,
  resolveRepoSearchPlannerToolDefinitions,
  serializeProtocolMessages,
} from '../src/repo-search/planner-protocol.ts';
import { toProtocolTools } from '../src/providers/inference.ts';

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
