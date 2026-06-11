import test from 'node:test';
import assert from 'node:assert/strict';

import { AgentLoopActionParser } from '../src/agent-loop/action-parser.js';
import { AgentLoop } from '../src/agent-loop/agent-loop.js';
import type {
  AgentLoopAction,
  AgentLoopActionAdapter,
  AgentLoopFinishAction,
  AgentLoopFinishEvaluation,
  AgentLoopInvalidResponseResult,
  AgentLoopModelData,
  AgentLoopPreparedTurn,
  AgentLoopPromptAdapter,
  AgentLoopResponseContext,
  AgentLoopToolAction,
  AgentLoopToolAdapter,
  AgentLoopToolExecution,
  AgentLoopToolResult,
  AgentLoopTurn,
} from '../src/agent-loop/types.js';
import type { LlamaCppChatMessage, LlamaCppToolDefinition, NormalizedLlamaCppChatResponse } from '../src/llm-protocol/types.js';

test('agent loop action parser parses repo-search and summary planner actions explicitly', () => {
  const parser = new AgentLoopActionParser();

  const repo = parser.parseRepoSearchAction('{"action":"finish","output":"done"}', ['repo_rg']);
  const summary = parser.parseSummaryPlannerAction('{"action":"finish","classification":"summary","output":"done"}');

  assert.equal(repo.kind, 'finish');
  assert.equal(repo.text, 'done');
  assert.equal(summary.kind, 'finish');
  assert.equal(summary.text, 'done');
  assert.equal(summary.classification, 'summary');
});

test('agent loop action parser expands tool batches into explicit tool actions', () => {
  const parser = new AgentLoopActionParser();

  const actions = parser.parseRepoSearchActions(
    '{"action":"tool_batch","calls":[{"action":"repo_rg","command":"rg -n \\"AgentLoop\\" src"},{"action":"repo_read_file","path":"src/x.ts"}]}',
    ['repo_rg', 'repo_read_file'],
  );

  assert.deepEqual(actions.map((action) => action.kind), ['tool', 'tool']);
  assert.equal(actions[0]?.toolName, 'repo_rg');
  assert.equal(actions[1]?.args.path, 'src/x.ts');
});

class StubPromptAdapter implements AgentLoopPromptAdapter {
  readonly kind = 'repo-search' as const;

  async prepareTurn(turnNumber: number): Promise<AgentLoopPreparedTurn> {
    return {
      outcome: 'continue',
      turnNumber,
      promptTokenCount: turnNumber,
      maxOutputTokens: 128,
      messages: [{ role: 'user', content: 'search' }],
      toolDefinitions: [],
      inForcedFinishMode: false,
    };
  }
}

class StubActionAdapter implements AgentLoopActionAdapter {
  invalidResponses = 0;

  parseActions(response: NormalizedLlamaCppChatResponse): AgentLoopAction[] {
    if (response.text === 'invalid') {
      throw new Error('bad json');
    }
    return response.text === 'finish'
      ? [{ kind: 'finish', text: 'done' }]
      : [{ kind: 'tool', callId: 'call_1', toolName: 'read_lines', args: { startLine: 1 } }];
  }

  inspectResponse(_context: AgentLoopResponseContext): 'continue' | 'stop' | null {
    return null;
  }

  async handleInvalidResponse(_context: AgentLoopResponseContext & { error: Error }): Promise<AgentLoopInvalidResponseResult> {
    this.invalidResponses += 1;
    return { outcome: 'continue' };
  }

  async evaluateFinish(_action: AgentLoopFinishAction, context: AgentLoopResponseContext): Promise<AgentLoopFinishEvaluation> {
    return context.turns.length >= 1
      ? { accepted: true, outcome: 'stop' }
      : { accepted: false, outcome: 'continue' };
  }
}

class StubToolAdapter implements AgentLoopToolAdapter {
  async executeTools(actions: readonly AgentLoopToolAction[]): Promise<AgentLoopToolExecution> {
    return {
      outcome: 'continue',
      results: actions.map((action): AgentLoopToolResult => ({
        callId: action.callId,
        toolName: action.toolName,
        args: action.args,
        text: 'tool output',
        raw: { ok: true },
      })),
    };
  }
}

test('agent loop executes tool turns before accepting finish', async () => {
  const responses: NormalizedLlamaCppChatResponse[] = [
    { text: 'tool', reasoningText: '', toolCalls: [], usage: { promptTokens: 1, completionTokens: 1, outputTokens: 1, thinkingTokens: 0, promptCacheTokens: null, promptEvalTokens: 1 }, raw: {}, stoppedEarly: false },
    { text: 'finish', reasoningText: '', toolCalls: [], usage: { promptTokens: 2, completionTokens: 1, outputTokens: 1, thinkingTokens: 0, promptCacheTokens: null, promptEvalTokens: 2 }, raw: {}, stoppedEarly: false },
  ];
  const loop = new AgentLoop({
    maxTurns: 4,
    promptAdapter: new StubPromptAdapter(),
    actionAdapter: new StubActionAdapter(),
    toolAdapter: new StubToolAdapter(),
    modelClient: {
      chat: async (options) => {
        assert.equal(options.preparedTurn.turnNumber, 3 - responses.length);
        const response = responses.shift();
        assert.ok(response);
        return { outcome: 'continue', response, data: null };
      },
    },
  });

  const result = await loop.run();

  assert.equal(result.finishText, 'done');
  assert.equal(result.turns.length, 2);
  assert.equal(result.turns[0]?.toolResults[0]?.text, 'tool output');
  assert.equal(result.promptTokens, 3);
});

test('agent loop delegates invalid responses to the action adapter', async () => {
  const actionAdapter = new StubActionAdapter();
  const responses: NormalizedLlamaCppChatResponse[] = [
    { text: 'invalid', reasoningText: '', toolCalls: [], usage: { promptTokens: 1, completionTokens: 1, outputTokens: 1, thinkingTokens: 0, promptCacheTokens: null, promptEvalTokens: 1 }, raw: {}, stoppedEarly: false },
    { text: 'finish', reasoningText: '', toolCalls: [], usage: { promptTokens: 2, completionTokens: 1, outputTokens: 1, thinkingTokens: 0, promptCacheTokens: null, promptEvalTokens: 2 }, raw: {}, stoppedEarly: false },
  ];
  const loop = new AgentLoop({
    maxTurns: 3,
    promptAdapter: new StubPromptAdapter(),
    actionAdapter,
    toolAdapter: new StubToolAdapter(),
    modelClient: {
      chat: async () => {
        const response = responses.shift();
        assert.ok(response);
        return { outcome: 'continue', response, data: null };
      },
    },
  });

  await loop.run();

  assert.equal(actionAdapter.invalidResponses, 1);
});

test('agent loop can stop at prepareTurn without fabricating a model response', async () => {
  let modelCalled = false;
  const promptAdapter: AgentLoopPromptAdapter = {
    kind: 'summary-planner',
    prepareTurn: async (turnNumber) => ({
      outcome: 'stop',
      turnNumber,
      promptTokenCount: 0,
      maxOutputTokens: 0,
      messages: [],
      toolDefinitions: [],
      inForcedFinishMode: false,
    }),
  };

  const result = await new AgentLoop({
    maxTurns: 3,
    promptAdapter,
    actionAdapter: new StubActionAdapter(),
    toolAdapter: new StubToolAdapter(),
    modelClient: {
      chat: async () => {
        modelCalled = true;
        throw new Error('model should not be called');
      },
    },
  }).run();

  assert.equal(modelCalled, false);
  assert.equal(result.reason, 'aborted');
  assert.equal(result.turns.length, 0);
});

test('agent loop carries model data through response contexts', async () => {
  const modelData: AgentLoopModelData = { kind: 'test-loop' };
  let seenData: AgentLoopModelData | null = null;
  const actionAdapter: AgentLoopActionAdapter = {
    parseActions: () => [{ kind: 'finish', text: 'done' }],
    inspectResponse: (context) => {
      assert.equal(context.modelData, modelData);
      return null;
    },
    handleInvalidResponse: async () => ({ outcome: 'stop' }),
    evaluateFinish: async (_action, context) => {
      seenData = context.modelData;
      return { accepted: true, outcome: 'stop', finishText: 'done' };
    },
  };

  const result = await new AgentLoop({
    maxTurns: 1,
    promptAdapter: new StubPromptAdapter(),
    actionAdapter,
    toolAdapter: new StubToolAdapter(),
    modelClient: {
      chat: async () => ({
        outcome: 'continue',
        response: {
          text: 'finish',
          reasoningText: '',
          toolCalls: [],
          usage: { promptTokens: 1, completionTokens: 1, outputTokens: 1, thinkingTokens: 0, promptCacheTokens: null, promptEvalTokens: 1 },
          raw: {},
          stoppedEarly: false,
        },
        data: modelData,
      }),
    },
  }).run();

  assert.equal(seenData, modelData);
  assert.equal(result.finishText, 'done');
});
