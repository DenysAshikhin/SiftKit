import test from 'node:test';
import assert from 'node:assert/strict';

import { RepoSearchActionAdapter, type RepoSearchLoopController } from '../src/repo-search/agent-loop-adapter.js';
import { resolveRepoSearchPlannerToolDefinitions } from '../src/repo-search/planner-protocol.js';
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
  validateActions: (actions, _turnNumber) => actions,
  handleInvalidResponse: async () => ({ outcome: 'stop' }),
  evaluateFinish: async () => ({ accepted: true, outcome: 'stop' }),
  executeTools: async () => ({ outcome: 'stop', results: [] }),
};

function responseContext(response: NormalizedLlamaCppChatResponse): AgentLoopResponseContext {
  return {
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
    response,
    modelData: null,
    turns: [],
  };
}

test('repo-search action adapter maps native narration, provider call ids, and finish content', () => {
  const adapter = new RepoSearchActionAdapter(resolveRepoSearchPlannerToolDefinitions(['grep']), controller);
  const tools = adapter.parseActions(responseContext({
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
    stop: CLEAN_STREAM_STOP,
  }));
  const finish = adapter.parseActions(responseContext({
    text: 'done',
    rawText: 'done',
    narrationText: 'done',
    classification: 'narration',
    reasoningText: '',
    toolCalls: [],
    usage,
    raw: {},
    stop: CLEAN_STREAM_STOP,
  }));

  assert.deepEqual(tools, [
    { kind: 'tool', callId: 'provider-call-7', toolName: 'grep', args: { pattern: 'x' } },
  ]);
  assert.equal(finish[0]?.kind, 'finish');
});
