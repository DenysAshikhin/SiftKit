import test from 'node:test';
import assert from 'node:assert/strict';

import { SummaryPlannerActionAdapter, type SummaryPlannerLoopController } from '../src/summary/planner/agent-loop-adapter.js';

const usage = {
  promptTokens: 1,
  completionTokens: 1,
  totalTokens: 2,
  outputTokens: 1,
  thinkingTokens: 0,
  promptCacheTokens: null,
  promptEvalTokens: 1,
};

const controller: SummaryPlannerLoopController = {
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

test('summary planner action adapter parses planner tool and finish actions', () => {
  const adapter = new SummaryPlannerActionAdapter(controller);
  const tool = adapter.parseActions({
    text: '{"action":"find_text","query":"needle"}',
    reasoningText: '',
    toolCalls: [],
    usage,
    raw: {},
    stoppedEarly: false,
  });
  const finish = adapter.parseActions({
    text: '{"action":"finish","classification":"summary","output":"done"}',
    reasoningText: '',
    toolCalls: [],
    usage,
    raw: {},
    stoppedEarly: false,
  });

  assert.equal(tool[0]?.kind, 'tool');
  assert.equal(finish[0]?.kind, 'finish');
});
