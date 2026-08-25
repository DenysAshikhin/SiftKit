import test from 'node:test';
import assert from 'node:assert/strict';

import { SummaryPlannerActionAdapter, type SummaryPlannerLoopController } from '../src/summary/planner/agent-loop-adapter.js';
import { buildSummaryPlannerToolDefinitions } from '../src/planner-protocol/summary-tools.js';
import type { AgentLoopResponseContext } from '../src/agent-loop/types.js';
import type { NormalizedLlamaCppChatResponse } from '../src/llm-protocol/types.js';

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
  allowUnsupportedInput: false,
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
  handleInvalidResponse: async () => ({ outcome: 'stop' }),
  evaluateFinish: async () => ({ accepted: true, outcome: 'stop' }),
  executeTools: async () => ({ outcome: 'stop', results: [] }),
};

function buildResponse(text: string): NormalizedLlamaCppChatResponse {
  return {
    text,
    reasoningText: '',
    toolCalls: [],
    usage,
    raw: {},
    stoppedEarly: false,
    invalidFrameCount: 0,
  };
}

const RESPONSE_CONTEXT: AgentLoopResponseContext = {
  turnNumber: 1,
  preparedTurn: {
    outcome: 'continue',
    turnNumber: 1,
    promptTokens: { reported: 0, budgeted: 0 },
    maxOutputTokens: 0,
    messages: [],
    toolDefinitions: [],
    inForcedFinishMode: false,
  },
  response: buildResponse('{}'),
  modelData: null,
  turns: [],
};

test('summary planner action adapter parses planner tool and finish actions', () => {
  const adapter = new SummaryPlannerActionAdapter(controller, buildSummaryPlannerToolDefinitions());
  const tool = adapter.parseActions({
    text: '{"action":"tool","toolName":"find_text","args":{"query":"needle","mode":"literal"}}',
    reasoningText: '',
    toolCalls: [],
    usage,
    raw: {},
    stoppedEarly: false,
    invalidFrameCount: 0,
  });
  const finish = adapter.parseActions({
    text: '{"action":"finish","classification":"summary","raw_review_required":false,"output":"done"}',
    reasoningText: '',
    toolCalls: [],
    usage,
    raw: {},
    stoppedEarly: false,
    invalidFrameCount: 0,
  });

  assert.equal(tool[0]?.kind, 'tool');
  assert.equal(finish[0]?.kind, 'finish');
});

test('summary planner action adapter routes decision-shaped output to the invalid-response path', async () => {
  const invalidResponses: string[] = [];
  const finishEvaluations: string[] = [];
  const adapter = new SummaryPlannerActionAdapter(
    {
      ...controller,
      handleInvalidResponse: async (context) => {
        invalidResponses.push(context.error.message);
        return { outcome: 'stop' };
      },
      evaluateFinish: async (action) => {
        finishEvaluations.push(action.text);
        return { accepted: true, outcome: 'stop' };
      },
    },
    buildSummaryPlannerToolDefinitions(),
  );

  assert.throws(
    () => adapter.parseActions(
      buildResponse('{"classification":"summary","raw_review_required":false,"output":"legacy decision"}'),
    ),
    /unknown planner action/u,
  );

  await adapter.handleInvalidResponse({
    ...RESPONSE_CONTEXT,
    error: new Error('Provider returned an unknown planner action.'),
  });

  assert.deepEqual(invalidResponses, ['Provider returned an unknown planner action.']);
  assert.deepEqual(finishEvaluations, []);
});

test('summary planner action adapter applies the unsupported-input finish policy', () => {
  const unsupportedFinish = buildResponse(
    '{"action":"finish","classification":"unsupported_input","raw_review_required":true,"output":"unsupported"}',
  );

  assert.throws(
    () => new SummaryPlannerActionAdapter(controller, buildSummaryPlannerToolDefinitions())
      .parseActions(unsupportedFinish),
    /invalid planner finish action/u,
  );

  const allowed = new SummaryPlannerActionAdapter(
    { ...controller, allowUnsupportedInput: true },
    buildSummaryPlannerToolDefinitions(),
  ).parseActions(unsupportedFinish);
  assert.equal(allowed[0]?.kind, 'finish');
});
