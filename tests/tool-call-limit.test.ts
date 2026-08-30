import assert from 'node:assert/strict';
import test from 'node:test';

import type { AgentLoopAction } from '../src/agent-loop/types.js';
import { enforceToolCallLimit } from '../src/repo-search/engine/task-loop.js';
import {
  buildToolBudgetNotice,
  formatToolCallLimitReached,
  POST_LIMIT_ANSWER_SLACK_TURNS,
} from '../src/repo-search/engine/task-loop-support.js';

function tool(callId: string): AgentLoopAction {
  return { kind: 'tool', callId, toolName: 'read', args: { path: 'README.md' } };
}

test('a multi-call batch is one budget unit: allowed with exactly one batch remaining', () => {
  const actions = [tool('a'), tool('b'), tool('c')];
  assert.equal(enforceToolCallLimit(actions, 44, 45), actions);
});

test('tool calls are rejected once the batch budget is exhausted', () => {
  assert.throws(
    () => enforceToolCallLimit([tool('a')], 45, 45),
    /Tool-call limit reached \(45\/45 batches used\)/u,
  );
});

test('content-only responses pass even at the limit', () => {
  const actions: AgentLoopAction[] = [];
  assert.equal(enforceToolCallLimit(actions, 45, 45), actions);
});

test('the limit-reached notice and the enforcement error share one prefix', () => {
  const prefix = formatToolCallLimitReached(45, 45);
  assert.equal(prefix, 'Tool-call limit reached (45/45 batches used).');
  assert.ok(String(buildToolBudgetNotice(45, 45)).startsWith(`[tool budget] ${prefix}`));
  assert.throws(
    () => enforceToolCallLimit([tool('a')], 45, 45),
    { message: /^Tool-call limit reached \(45\/45 batches used\)\. Do not call tools again/u },
  );
});

test('the post-limit answer slack is its own named constant', () => {
  assert.equal(POST_LIMIT_ANSWER_SLACK_TURNS, 3);
});
