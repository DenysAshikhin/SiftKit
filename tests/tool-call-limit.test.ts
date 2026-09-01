import assert from 'node:assert/strict';
import test from 'node:test';

import type { AgentLoopAction } from '../src/agent-loop/types.js';
import { enforceToolCallLimit } from '../src/repo-search/engine/task-loop.js';
import {
  buildToolBudgetNotice,
  buildToolLimitReachedSummary,
  POST_LIMIT_ANSWER_SLACK_TURNS,
} from '../src/repo-search/engine/task-loop-support.js';

function tool(callId: string): AgentLoopAction {
  return { kind: 'tool', callId, toolName: 'read', args: { path: 'README.md' } };
}

test('a multi-call batch is one turn: allowed on the final tool turn', () => {
  const actions = [tool('a'), tool('b'), tool('c')];
  assert.equal(enforceToolCallLimit(actions, 44, 45), actions);
});

test('tool calls are rejected on the first turn past the budget', () => {
  assert.throws(
    () => enforceToolCallLimit([tool('a')], 45, 45),
    /Tool-call limit reached \(45\/45 turns used\)/u,
  );
});

test('the gate flips exactly at the budget', () => {
  const actions = [tool('a')];
  assert.equal(enforceToolCallLimit(actions, 44, 45), actions);
  assert.throws(
    () => enforceToolCallLimit(actions, 45, 45),
    /Tool-call limit reached \(45\/45 turns used\)/u,
  );
  // A slack turn past the budget still reports the cap, not the inflated count.
  assert.throws(
    () => enforceToolCallLimit(actions, 47, 45),
    /Tool-call limit reached \(45\/45 turns used\)/u,
  );
});

test('turns that spend no tool batch do not earn extra tool turns', () => {
  // The gate reads turns already consumed, so a turn wasted on a rejected finish or an
  // invalid response cannot buy back a tool-calling turn inside the answer slack.
  for (const usedTurns of [46, 47]) {
    assert.throws(
      () => enforceToolCallLimit([tool('a')], usedTurns, 45),
      /Tool-call limit reached \(45\/45 turns used\)/u,
    );
  }
});

test('content-only responses pass even past the limit', () => {
  const actions: AgentLoopAction[] = [];
  assert.equal(enforceToolCallLimit(actions, 47, 45), actions);
});

test('the limit-reached notice and the enforcement error share one prefix', () => {
  const prefix = buildToolLimitReachedSummary(45, 45);
  assert.equal(prefix, 'Tool-call limit reached (45/45 turns used).');
  assert.ok(String(buildToolBudgetNotice(45, 45)).startsWith(`[tool budget] ${prefix}`));
  assert.throws(
    () => enforceToolCallLimit([tool('a')], 45, 45),
    { message: /^Tool-call limit reached \(45\/45 turns used\)\. Do not call tools again/u },
  );
});

test('the post-limit answer slack is its own named constant', () => {
  assert.equal(POST_LIMIT_ANSWER_SLACK_TURNS, 3);
});
