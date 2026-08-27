import assert from 'node:assert/strict';
import test from 'node:test';

import type { AgentLoopAction } from '../src/agent-loop/types.js';
import { enforceToolCallLimit } from '../src/repo-search/engine/task-loop.js';

function tool(callId: string): AgentLoopAction {
  return { kind: 'tool', callId, toolName: 'read', args: { path: 'README.md' } };
}

test('tool-call limit accepts a batch that exactly fills the remaining budget', () => {
  const actions = [tool('a'), tool('b')];
  assert.equal(enforceToolCallLimit(actions, 43, 45), actions);
});

test('tool-call limit rejects a batch before any call can exceed the displayed denominator', () => {
  assert.throws(
    () => enforceToolCallLimit([tool('a'), tool('b')], 44, 45),
    /2 tool calls with 1 remaining/u,
  );
});
