import test from 'node:test';
import assert from 'node:assert/strict';

import { RepoSearchActionAdapter, type RepoSearchLoopController } from '../src/repo-search/agent-loop-adapter.js';
import { resolveRepoSearchPlannerToolDefinitions } from '../src/repo-search/planner-protocol.js';

const usage = {
  promptTokens: 1,
  completionTokens: 1,
  totalTokens: 2,
  outputTokens: 1,
  thinkingTokens: 0,
  promptCacheTokens: null,
  promptEvalTokens: 1,
};

const controller: RepoSearchLoopController = {
  prepareTurn: async (turnNumber) => ({
    outcome: 'continue',
    turnNumber,
    promptTokens: { reported: 0, budgeted: 0 },
    maxOutputTokens: 0,
    messages: [],
    toolDefinitions: [],
    inForcedFinishMode: false,
  }),
  requestModelResponse: async () => ({ outcome: 'stop', data: null }),
  inspectModelResponse: () => null,
  validateActions: (actions) => actions,
  handleInvalidResponse: async () => ({ outcome: 'stop' }),
  evaluateFinish: async () => ({ accepted: true, outcome: 'stop' }),
  executeTools: async () => ({ outcome: 'stop', results: [] }),
};

test('repo-search action adapter maps native narration, provider call ids, and finish content', () => {
  const adapter = new RepoSearchActionAdapter(resolveRepoSearchPlannerToolDefinitions(['grep']), controller);
  const tools = adapter.parseActions({
    text: 'Searching now.',
    rawText: 'Searching now.',
    narrationText: 'Searching now.',
    classification: 'narration',
    reasoningText: 'thinking',
    toolCalls: [{
      id: 'provider-call-7',
      type: 'function',
      function: { name: 'grep', arguments: '{"pattern":"x"}' },
    }],
    usage,
    raw: {},
    stoppedEarly: false,
    invalidFrameCount: 0,
  });
  const finish = adapter.parseActions({
    text: 'done',
    rawText: 'done',
    narrationText: 'done',
    classification: 'narration',
    reasoningText: '',
    toolCalls: [],
    usage,
    raw: {},
    stoppedEarly: false,
    invalidFrameCount: 0,
  });

  assert.deepEqual(tools, [
    { kind: 'tool', callId: 'provider-call-7', toolName: 'grep', args: { pattern: 'x' } },
  ]);
  assert.equal(finish[0]?.kind, 'finish');
});
