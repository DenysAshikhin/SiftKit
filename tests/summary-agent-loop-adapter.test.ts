import test from 'node:test';
import assert from 'node:assert/strict';

import { SummaryPlannerActionAdapter, type SummaryPlannerLoopController } from '../src/summary/planner/agent-loop-adapter.js';
import { buildSummaryPlannerToolDefinitions } from '../src/planner-protocol/summary-tools.js';
import type { AgentLoopResponseContext } from '../src/agent-loop/types.js';
import { CLEAN_STREAM_STOP, type NormalizedLlamaCppChatResponse } from '../src/llm-protocol/types.js';

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

function buildResponse(
  text: string,
  toolCalls: NormalizedLlamaCppChatResponse['toolCalls'] = [],
): NormalizedLlamaCppChatResponse {
  return {
    text,
    rawText: text,
    narrationText: text,
    classification: text ? 'narration' : 'undecided',
    reasoningText: '',
    toolCalls,
    usage,
    raw: {},
    stop: CLEAN_STREAM_STOP,
  };
}

const RESPONSE_CONTEXT: AgentLoopResponseContext = {
  turnNumber: 1,
  preparedTurn: {
    outcome: 'continue',
    turnNumber: 1,
    promptTokenCount: 0,
    maxOutputTokens: 0,
    messages: [],
    toolDefinitions: [],
    inForcedFinishMode: false,
  },
  response: buildResponse('{}'),
  modelData: null,
  turns: [],
};

function contextFor(response: NormalizedLlamaCppChatResponse): AgentLoopResponseContext {
  return { ...RESPONSE_CONTEXT, response };
}

test('summary planner action adapter parses planner tool and finish actions', () => {
  const adapter = new SummaryPlannerActionAdapter(controller, buildSummaryPlannerToolDefinitions());
  const tool = adapter.parseActions(contextFor(buildResponse('', [{
    id: 'find-1',
    type: 'function',
    function: { name: 'find_text', arguments: '{"query":"needle","mode":"literal"}' },
  }])));
  const finish = adapter.parseActions(contextFor(buildResponse('', [{
    id: 'finish-1',
    type: 'function',
    function: { name: 'finish', arguments: '{"classification":"summary","raw_review_required":false,"output":"done"}' },
  }])));

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
      contextFor(buildResponse('{"classification":"summary","raw_review_required":false,"output":"legacy decision"}')),
    ),
    /content without a valid tool call/u,
  );

  await adapter.handleInvalidResponse({
    ...RESPONSE_CONTEXT,
    error: new Error('Provider returned an unknown planner action.'),
  });

  assert.deepEqual(invalidResponses, ['Provider returned an unknown planner action.']);
  assert.deepEqual(finishEvaluations, []);
});

test('summary planner action adapter applies the unsupported-input finish policy', () => {
  const unsupportedFinish = buildResponse('', [{
    id: 'finish-unsupported',
    type: 'function',
    function: { name: 'finish', arguments: '{"classification":"unsupported_input","raw_review_required":true,"output":"unsupported"}' },
  }]);

  assert.throws(
    () => new SummaryPlannerActionAdapter(controller, buildSummaryPlannerToolDefinitions(undefined, false))
      .parseActions(contextFor(unsupportedFinish)),
    /classification.*expected one of.*summary.*command_failure/u,
  );

  const allowed = new SummaryPlannerActionAdapter(
    { ...controller, allowUnsupportedInput: true },
    buildSummaryPlannerToolDefinitions(),
  ).parseActions(contextFor(unsupportedFinish));
  assert.equal(allowed[0]?.kind, 'finish');
});
