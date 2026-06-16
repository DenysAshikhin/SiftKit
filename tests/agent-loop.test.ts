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
import type {
  LlamaCppChatMessage,
  LlamaCppToolDefinition,
  LlamaCppUsage,
  NormalizedLlamaCppChatResponse,
} from '../src/llm-protocol/types.js';

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
  const firstAction = actions[0];
  const secondAction = actions[1];
  assert.equal(firstAction?.kind, 'tool');
  assert.equal(secondAction?.kind, 'tool');
  if (firstAction?.kind !== 'tool' || secondAction?.kind !== 'tool') {
    throw new Error('expected tool actions');
  }
  assert.equal(firstAction.toolName, 'repo_rg');
  assert.equal(secondAction.args.path, 'src/x.ts');
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

function stubUsage(promptTokens: number | null): LlamaCppUsage {
  return {
    promptTokens,
    completionTokens: 1,
    totalTokens: promptTokens === null ? null : promptTokens + 1,
    outputTokens: 1,
    thinkingTokens: 0,
    promptCacheTokens: null,
    promptEvalTokens: promptTokens,
  };
}

test('agent loop executes tool turns before accepting finish', async () => {
  const responses: NormalizedLlamaCppChatResponse[] = [
    { text: 'tool', reasoningText: '', toolCalls: [], usage: stubUsage(1), raw: {}, stoppedEarly: false },
    { text: 'finish', reasoningText: '', toolCalls: [], usage: stubUsage(2), raw: {}, stoppedEarly: false },
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
    { text: 'invalid', reasoningText: '', toolCalls: [], usage: stubUsage(1), raw: {}, stoppedEarly: false },
    { text: 'finish', reasoningText: '', toolCalls: [], usage: stubUsage(2), raw: {}, stoppedEarly: false },
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
          usage: stubUsage(1),
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

test('agent loop action parser covers single-tool repo and summary batches', () => {
  const parser = new AgentLoopActionParser();

  const repoTool = parser.parseRepoSearchAction(
    '{"action":"repo_read_file","path":"src/agent-loop/agent-loop.ts"}',
    ['repo_read_file'],
  );
  const summaryTool = parser.parseSummaryPlannerAction('{"action":"find_text","query":"needle"}');
  const summaryBatch = parser.parseSummaryPlannerActions(
    '{"action":"tool_batch","calls":[{"action":"find_text","query":"needle"},{"action":"read_lines","start_line":1,"end_line":2}]}',
  );

  assert.equal(repoTool.kind, 'tool');
  assert.equal(repoTool.callId, 'call_1');
  assert.equal(repoTool.toolName, 'repo_read_file');
  assert.equal(repoTool.args.path, 'src/agent-loop/agent-loop.ts');
  if (summaryTool.kind !== 'tool') {
    throw new Error('expected summary action to be a tool');
  }
  assert.equal(summaryTool.toolName, 'find_text');
  assert.equal(summaryTool.args.query, 'needle');
  const summaryToolNames = summaryBatch.map((action) => {
    assert.equal(action.kind, 'tool');
    return action.kind === 'tool' ? action.toolName : '';
  });
  assert.deepEqual(summaryToolNames, ['find_text', 'read_lines']);
  assert.equal(summaryBatch[1]?.kind, 'tool');
  if (summaryBatch[1]?.kind !== 'tool') {
    throw new Error('expected second summary batch action to be a tool');
  }
  assert.equal(summaryBatch[1].callId, 'call_2');
});

test('agent loop fails loud when required adapters are missing', async () => {
  await assert.rejects(
    () => new AgentLoop({ maxTurns: 1 }).run(),
    /requires prompt\/action\/tool\/model adapters/u,
  );
});

test('agent loop stops when model client requests stop', async () => {
  const result = await new AgentLoop({
    maxTurns: 1,
    promptAdapter: new StubPromptAdapter(),
    actionAdapter: new StubActionAdapter(),
    toolAdapter: new StubToolAdapter(),
    modelClient: {
      chat: async () => ({ outcome: 'stop', data: { kind: 'model-stop' } }),
    },
  }).run();

  assert.equal(result.reason, 'aborted');
  assert.equal(result.turns.length, 0);
});

test('agent loop honors inspect continue and inspect stop without parsing actions', async () => {
  const responses: NormalizedLlamaCppChatResponse[] = [
    { text: 'ignored', reasoningText: '', toolCalls: [], usage: stubUsage(1), raw: {}, stoppedEarly: false },
    { text: 'ignored', reasoningText: '', toolCalls: [], usage: stubUsage(2), raw: {}, stoppedEarly: false },
  ];
  let inspectCount = 0;
  const actionAdapter: AgentLoopActionAdapter = {
    parseActions: () => {
      throw new Error('parseActions should not run');
    },
    inspectResponse: () => {
      inspectCount += 1;
      return inspectCount === 1 ? 'continue' : 'stop';
    },
    handleInvalidResponse: async () => ({ outcome: 'stop' }),
    evaluateFinish: async () => ({ accepted: false, outcome: 'stop' }),
  };

  const result = await new AgentLoop({
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
  }).run();

  assert.equal(inspectCount, 2);
  assert.equal(result.reason, 'aborted');
  assert.equal(result.turns.length, 0);
});

test('agent loop stops on invalid-response handler stop', async () => {
  const actionAdapter: AgentLoopActionAdapter = {
    parseActions: () => {
      throw new Error('bad json');
    },
    inspectResponse: () => null,
    handleInvalidResponse: async () => ({ outcome: 'stop' }),
    evaluateFinish: async () => ({ accepted: false, outcome: 'stop' }),
  };

  const result = await new AgentLoop({
    maxTurns: 1,
    promptAdapter: new StubPromptAdapter(),
    actionAdapter,
    toolAdapter: new StubToolAdapter(),
    modelClient: {
      chat: async () => ({
        outcome: 'continue',
        response: { text: 'invalid', reasoningText: '', toolCalls: [], usage: stubUsage(null), raw: {}, stoppedEarly: false },
        data: null,
      }),
    },
  }).run();

  assert.equal(result.reason, 'aborted');
});

test('agent loop wraps non-error parse failures before invalid-response handling', async () => {
  let handledMessage = '';
  const actionAdapter: AgentLoopActionAdapter = {
    parseActions: () => {
      throw 'bad json';
    },
    inspectResponse: () => null,
    handleInvalidResponse: async (context) => {
      handledMessage = context.error.message;
      return { outcome: 'stop' };
    },
    evaluateFinish: async () => ({ accepted: false, outcome: 'stop' }),
  };

  const result = await new AgentLoop({
    maxTurns: 1,
    promptAdapter: new StubPromptAdapter(),
    actionAdapter,
    toolAdapter: new StubToolAdapter(),
    modelClient: {
      chat: async () => ({
        outcome: 'continue',
        response: { text: 'invalid', reasoningText: '', toolCalls: [], usage: stubUsage(null), raw: {}, stoppedEarly: false },
        data: null,
      }),
    },
  }).run();

  assert.equal(handledMessage, 'bad json');
  assert.equal(result.reason, 'aborted');
});

test('agent loop covers rejected finish stop, no-tool continue, tool stop, and max turns', async () => {
  const finishStopAdapter: AgentLoopActionAdapter = {
    parseActions: () => [{ kind: 'finish', text: 'nope' }],
    inspectResponse: () => null,
    handleInvalidResponse: async () => ({ outcome: 'continue' }),
    evaluateFinish: async () => ({ accepted: false, outcome: 'stop' }),
  };
  const emptyToolAdapter = new StubToolAdapter();
  const baseResponse: NormalizedLlamaCppChatResponse = {
    text: 'finish',
    reasoningText: '',
    toolCalls: [],
    usage: stubUsage(null),
    raw: {},
    stoppedEarly: false,
  };

  const rejected = await new AgentLoop({
    maxTurns: 1,
    promptAdapter: new StubPromptAdapter(),
    actionAdapter: finishStopAdapter,
    toolAdapter: emptyToolAdapter,
    modelClient: { chat: async () => ({ outcome: 'continue', response: baseResponse, data: null }) },
  }).run();
  assert.equal(rejected.reason, 'aborted');

  const noTool = await new AgentLoop({
    maxTurns: 1,
    promptAdapter: new StubPromptAdapter(),
    actionAdapter: {
      parseActions: () => [],
      inspectResponse: () => null,
      handleInvalidResponse: async () => ({ outcome: 'continue' }),
      evaluateFinish: async () => ({ accepted: false, outcome: 'continue' }),
    },
    toolAdapter: emptyToolAdapter,
    modelClient: { chat: async () => ({ outcome: 'continue', response: baseResponse, data: null }) },
  }).run();
  assert.equal(noTool.reason, 'max_turns');

  const toolStop = await new AgentLoop({
    maxTurns: 1,
    promptAdapter: new StubPromptAdapter(),
    actionAdapter: new StubActionAdapter(),
    toolAdapter: {
      executeTools: async (actions, context) => {
        assert.equal(context.turns.length, 1);
        return {
          outcome: 'stop',
          results: actions.map((action): AgentLoopToolResult => ({
            callId: action.callId,
            toolName: action.toolName,
            args: action.args,
            text: 'stopped',
            raw: null,
          })),
        };
      },
    },
    modelClient: { chat: async () => ({ outcome: 'continue', response: { ...baseResponse, text: 'tool' }, data: null }) },
  }).run();
  assert.equal(toolStop.reason, 'aborted');
  assert.equal(toolStop.turns[0]?.toolResults[0]?.text, 'stopped');
});
