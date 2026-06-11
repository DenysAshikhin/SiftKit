import test from 'node:test';
import assert from 'node:assert/strict';

import { RepoSearchActionAdapter, type RepoSearchLoopController } from '../src/repo-search/agent-loop-adapter.js';

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
    promptTokenCount: 0,
    maxOutputTokens: 0,
    messages: [],
    toolDefinitions: [],
    inForcedFinishMode: false,
  }),
  requestModelResponse: async () => ({ outcome: 'stop', data: null }),
  inspectModelResponse: () => null,
  handleInvalidResponse: async () => ({ outcome: 'stop' }),
  evaluateFinish: async () => ({ accepted: true, outcome: 'stop' }),
  executeTools: async () => ({ outcome: 'stop', results: [] }),
};

test('repo-search action adapter parses tool batches and finish actions', () => {
  const adapter = new RepoSearchActionAdapter(['repo_rg'], controller);
  const tools = adapter.parseActions({
    text: '{"action":"tool_batch","calls":[{"action":"repo_rg","command":"rg -n \\"x\\" src"}]}',
    reasoningText: 'thinking',
    toolCalls: [],
    usage,
    raw: {},
    stoppedEarly: false,
  });
  const finish = adapter.parseActions({
    text: '{"action":"finish","output":"done"}',
    reasoningText: '',
    toolCalls: [],
    usage,
    raw: {},
    stoppedEarly: false,
  });

  assert.equal(tools[0]?.kind, 'tool');
  assert.equal(finish[0]?.kind, 'finish');
});
