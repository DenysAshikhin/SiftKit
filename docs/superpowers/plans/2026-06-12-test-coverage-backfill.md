# Test Coverage Backfill Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Do not use worktrees.

**Goal:** Close the F14/F13 residual by backfilling meaningful branch coverage for `src/llm-protocol/` and `src/agent-loop/`, then update `ARCHITECTURE-REVIEW.md` so the residual is no longer listed as open.

**Architecture:** Keep the existing `LlamaCppClient`, `LlamaCppToolCallParser`, `LlamaCppStreamingResponseAssembler`, `AgentLoop`, and `AgentLoopActionParser` production boundaries intact. Add focused branch tests around the uncovered paths instead of adding production shims, exported test hooks, or broad integration cases. Include these focused tests in `tsconfig.test.json` so typed test fixtures are checked before runtime execution.

**Tech Stack:** TypeScript, `node:test`, `assert/strict`, existing `npm test`, `npm run typecheck`, `npm run test:coverage`, c8 text report.

---

## Current Evidence

- `ARCHITECTURE-REVIEW.md:51` flags F13 residual branch coverage for `src/llm-protocol/` and `src/agent-loop/`.
- `ARCHITECTURE-REVIEW.md:220` ranks closing that residual as priority 1.
- Current `npm run test:coverage` passes, but the relevant source rows remain below the repo's near-100% branch-coverage goal:
  - `src/agent-loop/action-parser.ts`: 87.50% branch.
  - `src/agent-loop/agent-loop.ts`: 83.92% branch.
  - `src/llm-protocol/llama-cpp-client.ts`: 82.81% branch, 85.18% functions.
  - `src/llm-protocol/streaming-response-assembler.ts`: 84.09% branch.
  - `src/llm-protocol/tool-call-parser.ts`: 80.00% branch.
  - `src/llm-protocol/types.ts`: c8 reports type/constant branch noise; treat only executable behavior as actionable.
- The first sandboxed coverage run failed because `npx c8` needed npm cache/network access; the elevated rerun passed.

## Target Structure

Modify:

- `tests/agent-loop.test.ts` - add branch tests for parser variants and loop stop/continue paths.
- `tests/llm-protocol.test.ts` - add non-streaming HTTP, token, model-list, status, usage, and replay parser branch tests.
- `tests/llm-protocol-streaming.test.ts` - add streaming client and assembler branch tests.
- `tsconfig.test.json` - include the focused `agent-loop` and `llm-protocol` test files in test typechecking.
- `ARCHITECTURE-REVIEW.md` - remove or rewrite the F13 residual sentence only after coverage is verified.

Do not create:

- New production test-only exports.
- Coverage-specific runtime code.
- Compatibility wrappers around old protocol/loop paths.
- A global c8 threshold that would fail unrelated low-coverage modules in this slice.

## Commit Policy

Do not commit during execution unless the user explicitly asks for a commit.

---

### Task 1: Typecheck The Focused Coverage Tests

**Files:**

- Modify: `tsconfig.test.json`
- Modify: `tests/llm-protocol.test.ts`

- [ ] **Step 1: Fix the existing protocol test fixture type**

In `tests/llm-protocol.test.ts`, remove `headers: {},` from the current `CapturingHttpClient.requestJsonFull(...)` response object. `FullJsonResponse<T>` is currently:

```ts
export type FullJsonResponse<T> = {
  statusCode: number;
  body: T;
  rawText: string;
};
```

Expected: the existing test behavior is unchanged, and the fixture can be included in `tsconfig.test.json` without an excess-property error.

Then add this method to `CapturingHttpClient` so the fixture satisfies `LlamaCppClient`'s structural client type:

```ts
  async streamSse(): Promise<{ sawDone: boolean }> {
    throw new Error('streamSse should not be called by non-streaming tests');
  }
```

- [ ] **Step 2: Add the focused test files to test typechecking**

Edit `tsconfig.test.json` and add these entries to `include`:

```json
"tests/agent-loop.test.ts",
"tests/llm-protocol.test.ts",
"tests/llm-protocol-streaming.test.ts"
```

The include list should contain the new entries near the other engine/loop tests:

```json
"tests/engine-terminal-synthesizer.test.ts",
"tests/agent-loop.test.ts",
"tests/llm-protocol.test.ts",
"tests/llm-protocol-streaming.test.ts",
"tests/god-function-regression.test.ts",
```

- [ ] **Step 3: Run typecheck for the test fixture surface**

Run:

```powershell
npm run typecheck:test
```

Expected: PASS. If it fails, fix the typed fixtures in the test files before adding more coverage.

---

### Task 2: Backfill `AgentLoop` And Action Parser Branches

**Files:**

- Modify: `tests/agent-loop.test.ts`

- [ ] **Step 1: Add parser branch tests**

Append this block to `tests/agent-loop.test.ts`:

```ts
test('agent loop action parser covers single-tool repo and summary batches', () => {
  const parser = new AgentLoopActionParser();

  const repoTool = parser.parseRepoSearchAction(
    '{"action":"repo_read_file","path":"src/agent-loop/agent-loop.ts"}',
    ['repo_read_file'],
  );
  const summaryBatch = parser.parseSummaryPlannerActions(
    '{"action":"tool_batch","tool_calls":[{"tool_name":"find_text","args":{"query":"needle"}},{"tool_name":"read_lines","args":{"start_line":1,"end_line":2}}]}',
  );

  assert.equal(repoTool.kind, 'tool');
  assert.equal(repoTool.callId, 'call_1');
  assert.equal(repoTool.toolName, 'repo_read_file');
  assert.equal(repoTool.args.path, 'src/agent-loop/agent-loop.ts');
  assert.deepEqual(summaryBatch.map((action) => action.toolName), ['find_text', 'read_lines']);
  assert.equal(summaryBatch[1]?.callId, 'call_2');
});
```

- [ ] **Step 2: Add loop stop/continue branch tests**

Append this block to `tests/agent-loop.test.ts`:

```ts
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
    { text: 'ignored', reasoningText: '', toolCalls: [], usage: { promptTokens: 1, completionTokens: null, totalTokens: null, outputTokens: null, thinkingTokens: null, promptCacheTokens: null, promptEvalTokens: null }, raw: {}, stoppedEarly: false },
    { text: 'ignored', reasoningText: '', toolCalls: [], usage: { promptTokens: 2, completionTokens: null, totalTokens: null, outputTokens: null, thinkingTokens: null, promptCacheTokens: null, promptEvalTokens: null }, raw: {}, stoppedEarly: false },
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
        response: { text: 'invalid', reasoningText: '', toolCalls: [], usage: { promptTokens: null, completionTokens: null, totalTokens: null, outputTokens: null, thinkingTokens: null, promptCacheTokens: null, promptEvalTokens: null }, raw: {}, stoppedEarly: false },
        data: null,
      }),
    },
  }).run();

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
    usage: { promptTokens: null, completionTokens: null, totalTokens: null, outputTokens: null, thinkingTokens: null, promptCacheTokens: null, promptEvalTokens: null },
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
```

- [ ] **Step 3: Run focused loop tests**

Run:

```powershell
npm test -- tests/agent-loop.test.ts
```

Expected: PASS.

---

### Task 3: Backfill Non-Streaming `LlamaCppClient` And Tool Parser Branches

**Files:**

- Modify: `tests/llm-protocol.test.ts`

- [ ] **Step 1: Replace the narrow HTTP stub with a configurable stub**

In `tests/llm-protocol.test.ts`, replace `CapturingHttpClient` with:

```ts
class CapturingHttpClient {
  readonly requests: RequestJsonOptions[] = [];
  private readonly responses: Array<FullJsonResponse<unknown> | Error>;

  constructor(responses: Array<FullJsonResponse<unknown> | Error> = []) {
    this.responses = responses;
  }

  async requestJsonFull<T>(options: RequestJsonOptions): Promise<FullJsonResponse<T>> {
    this.requests.push(options);
    const response = this.responses.shift() || {
      statusCode: 200,
      rawText: JSON.stringify({
        choices: [{ message: { content: 'ok', reasoning_content: 'think' } }],
        usage: { prompt_tokens: 3, completion_tokens: 5, completion_tokens_details: { reasoning_tokens: 2 } },
      }),
      body: {
        choices: [{ message: { content: 'ok', reasoning_content: 'think' } }],
        usage: { prompt_tokens: 3, completion_tokens: 5, completion_tokens_details: { reasoning_tokens: 2 } },
      },
    };
    if (response instanceof Error) {
      throw response;
    }
    return response as FullJsonResponse<T>;
  }

  async streamSse(): Promise<{ sawDone: boolean }> {
    throw new Error('streamSse should not be called by non-streaming tests');
  }
}

function jsonResponse<T>(body: T, statusCode = 200, rawText = JSON.stringify(body)): FullJsonResponse<T> {
  return {
    statusCode,
    rawText,
    body,
  };
}

const protocolConfig = {
  Backend: 'llama.cpp',
  Runtime: {
    Model: 'local',
    LlamaCpp: {
      BaseUrl: 'http://127.0.0.1:8097',
    },
  },
  Server: {
    LlamaCpp: {
      ActivePresetId: 'p1',
      Presets: [{ id: 'p1', name: 'p1', Reasoning: 'on', ReasoningContent: true, PreserveThinking: false }],
    },
  },
} as SiftConfig;
```

Then update the existing `llama client builds chat request with nested reasoning_content and tools` test to use `config: protocolConfig`.

- [ ] **Step 2: Add model/token/status branch tests**

Append:

```ts
test('llama client covers token-count fallbacks, model fallbacks, and status errors', async () => {
  const countClient = new LlamaCppClient(new CapturingHttpClient([
    jsonResponse({ token_count: 7 }),
    jsonResponse({ n_tokens: 8 }),
    jsonResponse({ tokens: ['a', 'b', 'c'] }),
    jsonResponse({}),
  ]));

  assert.equal((await countClient.countTokens(protocolConfig, 'a')).tokenCount, 7);
  assert.equal((await countClient.countTokens(protocolConfig, 'b')).tokenCount, 8);
  assert.equal((await countClient.countTokens(protocolConfig, 'c')).tokenCount, 3);
  assert.equal((await countClient.countTokens(protocolConfig, 'd')).tokenCount, 0);

  const modelClient = new LlamaCppClient(new CapturingHttpClient([
    jsonResponse({ data: [{ id: '' }, { model: 'fallback-model' }] }),
    jsonResponse({ models: ['plain-model'] }),
    jsonResponse({ error: 'bad' }, 500, 'server exploded'),
  ]));

  assert.deepEqual(await modelClient.listModels(protocolConfig), ['fallback-model']);
  assert.deepEqual(await modelClient.listModels(protocolConfig), ['plain-model']);
  await assert.rejects(() => modelClient.listModels(protocolConfig), /HTTP 500: server exploded/u);

  const status = await new LlamaCppClient(new CapturingHttpClient([
    jsonResponse({ error: 'bad' }, 500, 'server exploded'),
  ])).getStatus(protocolConfig);
  assert.deepEqual(status, { ok: false, models: [], error: 'HTTP 500: server exploded' });
});
```

- [ ] **Step 3: Add chat request and response normalization branch tests**

Append:

```ts
test('llama client covers non-streaming request and response normalization branches', async () => {
  const http = new CapturingHttpClient([
    jsonResponse({
      choices: [{
        text: 'fallback text',
        message: {
          content: [{ type: 'text', text: '' }, { type: 'text', text: '' }],
          reasoning_content: [{ type: 'text', text: 'reason ' }, { type: 'text', text: 'trace' }],
          function_call: { name: 'finish', arguments: '{"output":"done"}' },
        },
      }],
      usage: {
        prompt_tokens: 11,
        completion_tokens: 13,
        total_tokens: 24,
        output_tokens_details: { thinking_tokens: 3 },
        input_tokens_details: { cached_tokens: 4 },
      },
    }),
  ]);

  const response = await new LlamaCppClient(http).chat({
    config: protocolConfig,
    model: 'local',
    messages: [{ role: 'user', content: 'hello' }],
    tools: [],
    maxTokens: 33,
    temperature: 0.2,
    cachePrompt: false,
    slotId: 2,
    stream: false,
    responseFormat: { type: 'json_object' },
    reasoningOverride: 'off',
    retryMaxWaitMs: 0,
    allowedToolNames: ['finish'],
    extraBody: { custom_value: 'kept' },
  });

  const body = JSON.parse(String(http.requests[0]?.body || '{}'));
  assert.equal(body.cache_prompt, false);
  assert.equal(body.id_slot, 2);
  assert.equal(body.temperature, 0.2);
  assert.equal(body.tools, undefined);
  assert.deepEqual(body.chat_template_kwargs, { enable_thinking: false });
  assert.deepEqual(body.response_format, { type: 'json_object' });
  assert.equal(body.custom_value, 'kept');
  assert.equal(response.text, 'fallback text');
  assert.equal(response.reasoningText, 'reason trace');
  assert.equal(response.toolCalls[0]?.function.name, 'finish');
  assert.equal(response.usage.promptEvalTokens, 7);
  assert.equal(response.usage.thinkingTokens, 3);
});
```

- [ ] **Step 4: Add parser replay branch tests**

Append to the existing replay parser test or add a new test:

```ts
test('tool-call parser covers fallback ids, default arguments, quoted replay values, and empty quotes', () => {
  const parser = new LlamaCppToolCallParser(['repo_rg', 'finish']);

  assert.deepEqual(parser.parseFromChoice({}), []);
  assert.deepEqual(parser.parseToolCall({ type: 'function', function: { name: 'not_allowed', arguments: '{}' } }), null);
  assert.deepEqual(parser.parseToolCall({ type: 'function', function: { name: 'repo_rg' } }), {
    id: 'call_repo_rg',
    type: 'function',
    function: { name: 'repo_rg', arguments: '{}' },
  });

  const quotedSearch = buildReplayToolCall({ id: 'quoted', command: 'web_search query="local llama"' });
  assert.equal(quotedSearch.function.arguments, '{"query":"local llama"}');
  assert.throws(
    () => buildReplayToolCall({ id: 'blank', command: 'web_search query=""' }),
    /Cannot replay unknown persisted tool command/u,
  );
});
```

- [ ] **Step 5: Run focused protocol tests**

Run:

```powershell
npm test -- tests/llm-protocol.test.ts
```

Expected: PASS.

---

### Task 4: Backfill Streaming Client And Streaming Assembler Branches

**Files:**

- Modify: `tests/llm-protocol-streaming.test.ts`

- [ ] **Step 1: Add imports and streaming HTTP stubs**

At the top of `tests/llm-protocol-streaming.test.ts`, add:

```ts
import {
  LlamaHttpError,
  type FullJsonResponse,
  type SseStreamOptions,
  type SseStreamPacket,
  type SseStreamSignal,
} from '../src/lib/http-client.js';
import { LlamaCppClient } from '../src/llm-protocol/llama-cpp-client.js';
import type { SiftConfig } from '../src/config/types.js';
```

Append these helpers:

```ts
class StreamingHttpClient {
  readonly requests: SseStreamOptions[] = [];
  private readonly packets: SseStreamPacket[];
  private readonly error: Error | null;

  constructor(packets: SseStreamPacket[], error: Error | null = null) {
    this.packets = packets;
    this.error = error;
  }

  async requestJsonFull<T>(): Promise<FullJsonResponse<T>> {
    throw new Error('requestJsonFull should not be called by streaming tests');
  }

  async streamSse(
    options: SseStreamOptions,
    onData: (packet: SseStreamPacket) => SseStreamSignal,
  ): Promise<{ sawDone: boolean }> {
    this.requests.push(options);
    if (this.error) {
      throw this.error;
    }
    for (const packet of this.packets) {
      if (onData(packet) === 'stop') {
        return { sawDone: false };
      }
    }
    return { sawDone: true };
  }
}

const streamingConfig = {
  Backend: 'llama.cpp',
  Runtime: {
    Model: 'local',
    LlamaCpp: {
      BaseUrl: 'http://127.0.0.1:8097',
    },
  },
  Server: {
    LlamaCpp: {
      ActivePresetId: 'p1',
      Presets: [{ id: 'p1', name: 'p1', Reasoning: 'on', ReasoningContent: true, PreserveThinking: true }],
    },
  },
} as SiftConfig;
```

- [ ] **Step 2: Add streaming client branch tests**

Append:

```ts
test('llama streaming client assembles deltas, callbacks, timings, tool chunks, and early reasoning actions', async () => {
  const thinkingUpdates: string[] = [];
  const contentUpdates: string[] = [];
  const http = new StreamingHttpClient([
    {
      usage: {
        prompt_tokens: 10,
        completion_tokens: 4,
        completion_tokens_details: { reasoning_tokens: 1 },
        prompt_tokens_details: { cached_tokens: 3 },
      },
      timings: { prompt_n: 7, prompt_ms: 12, predicted_ms: 34 },
      choices: [{ delta: { reasoning_content: 'thinking ' } }],
    },
    { choices: [{ delta: { content: 'answer ' } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, id: 'tool_1', function: { name: 'repo_rg', arguments: '{"pattern":' } }] } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"x"}' } }] } }] },
  ]);

  const response = await new LlamaCppClient(http).chat({
    config: streamingConfig,
    model: 'local',
    messages: [{ role: 'user', content: 'hello' }],
    tools: [{ type: 'function', function: { name: 'repo_rg', description: 'Search.', parameters: { type: 'object' } } }],
    maxTokens: 64,
    stream: true,
    allowedToolNames: ['repo_rg'],
    onThinkingDelta: (value) => thinkingUpdates.push(value),
    onContentDelta: (value) => contentUpdates.push(value),
  });

  const body = JSON.parse(http.requests[0]?.body || '{}');
  assert.equal(body.stream, true);
  assert.equal(body.timings_per_token, true);
  assert.equal(response.text, 'answer ');
  assert.equal(response.reasoningText, 'thinking ');
  assert.equal(response.toolCalls[0]?.function.arguments, '{"pattern":"x"}');
  assert.equal(response.usage.promptTokens, 10);
  assert.equal(response.usage.promptEvalTokens, 7);
  assert.equal(response.usage.promptCacheTokens, 3);
  assert.equal(response.usage.thinkingTokens, 1);
  assert.deepEqual(thinkingUpdates, ['thinking ']);
  assert.deepEqual(contentUpdates, ['answer ']);
});

test('llama streaming client stops on completed planner action in reasoning', async () => {
  const http = new StreamingHttpClient([
    { choices: [{ delta: { reasoning: 'prefix {"action":"finish","output":"done"} suffix' } }] },
    { choices: [{ delta: { content: 'must not be read' } }] },
  ]);

  const response = await new LlamaCppClient(http).chat({
    config: streamingConfig,
    model: 'local',
    messages: [{ role: 'user', content: 'hello' }],
    tools: [],
    maxTokens: 64,
    stream: true,
    allowedToolNames: [],
  });

  assert.equal(response.text, '{"action":"finish","output":"done"}');
  assert.equal(response.reasoningText, '');
  assert.equal(response.stoppedEarly, true);
  assert.equal(response.earlyStopReason, 'planner action completed in streamed reasoning');
});

test('llama streaming client converts transient llama HTTP stream errors', async () => {
  const http = new StreamingHttpClient([], new LlamaHttpError(503, 'loading model'));

  await assert.rejects(
    () => new LlamaCppClient(http).chat({
      config: streamingConfig,
      model: 'local',
      messages: [{ role: 'user', content: 'hello' }],
      tools: [],
      maxTokens: 64,
      stream: true,
      allowedToolNames: [],
    }),
    /HTTP 503: loading model/u,
  );
});
```

- [ ] **Step 3: Add assembler edge branch tests**

Append:

```ts
test('streaming assembler ignores packets after early stop and covers empty delta branches', () => {
  const assembler = new LlamaCppStreamingResponseAssembler(['repo_rg'], { structuralRepeatLimit: 2 });

  assembler.ingestChoiceDelta({});
  assembler.ingestChoiceDelta({ delta: { content: '}}' } });
  assembler.ingestChoiceDelta({ delta: { content: 'ignored' } });

  const response = assembler.toResponse({
    promptTokens: null,
    completionTokens: null,
    totalTokens: null,
    outputTokens: null,
    thinkingTokens: null,
    promptCacheTokens: null,
    promptEvalTokens: null,
  });

  assert.equal(response.text, '}}');
  assert.equal(response.stoppedEarly, true);
});

test('streaming assembler covers fallback tool index and filters disallowed calls', () => {
  const assembler = new LlamaCppStreamingResponseAssembler(['repo_rg']);

  assembler.ingestChoiceDelta({ delta: { tool_calls: [{ function: { name: 'repo_rg', arguments: '{"pattern":"x"}' } }] } });
  assembler.ingestChoiceDelta({ delta: { tool_calls: [{ function: { name: 'not_allowed', arguments: '{}' } }] } });

  const response = assembler.toResponse({
    promptTokens: null,
    completionTokens: null,
    totalTokens: null,
    outputTokens: null,
    thinkingTokens: null,
    promptCacheTokens: null,
    promptEvalTokens: null,
  });

  assert.equal(response.toolCalls.length, 1);
  assert.equal(response.toolCalls[0]?.id, 'call_0');
});
```

- [ ] **Step 4: Run focused streaming tests**

Run:

```powershell
npm test -- tests/llm-protocol-streaming.test.ts
```

Expected: PASS.

---

### Task 5: Verify Coverage Closure And Update The Architecture Review

**Files:**

- Modify: `ARCHITECTURE-REVIEW.md`

- [ ] **Step 1: Run focused tests together**

Run:

```powershell
npm test -- tests/agent-loop.test.ts tests/llm-protocol.test.ts tests/llm-protocol-streaming.test.ts tests/agent-loop-boundary.test.ts
```

Expected: PASS.

- [ ] **Step 2: Run typecheck**

Run:

```powershell
npm run typecheck
```

Expected: PASS.

- [ ] **Step 3: Run full tests**

Run:

```powershell
npm test
```

Expected: PASS.

- [ ] **Step 4: Run coverage**

Run:

```powershell
npm run test:coverage
```

Expected: PASS. Inspect `src/agent-loop/*` and `src/llm-protocol/*` rows in the text report:

- `src/agent-loop/action-parser.ts`: branch coverage at or above 95%, ideally 100%.
- `src/agent-loop/agent-loop.ts`: branch coverage at or above 95%, ideally 100%.
- `src/llm-protocol/llama-cpp-client.ts`: branch coverage at or above 95% and function coverage at 100%.
- `src/llm-protocol/streaming-response-assembler.ts`: branch coverage at or above 95%, ideally 100%.
- `src/llm-protocol/tool-call-parser.ts`: branch coverage at or above 95%, ideally 100%.

If any row remains below 95%, add another focused branch test to the owning test file before editing `ARCHITECTURE-REVIEW.md`.

- [ ] **Step 5: Refresh the c8 JSON report for exact rows if the text report is hard to inspect**

Run:

```powershell
npx c8 report --reporter=json
```

Then extract the target rows from `coverage/coverage-final.json` with a narrow local script or PowerShell object read. Expected: the target rows match the Step 4 threshold.

- [ ] **Step 6: Update `ARCHITECTURE-REVIEW.md`**

After verification passes, edit the F14 bullet that currently says:

```markdown
- F13 residual: the unified protocol/loop modules are below the repo's branch-coverage goal ...
```

Replace it with:

```markdown
- F13 residual coverage backfill completed 2026-06-12: `src/llm-protocol/` and `src/agent-loop/` now have focused branch tests for protocol normalization, streaming assembly, parser variants, loop stop/continue paths, and error branches. Keep future protocol/loop edits covered by `tests/llm-protocol.test.ts`, `tests/llm-protocol-streaming.test.ts`, and `tests/agent-loop.test.ts`.
```

Then update priority item 1 from:

```markdown
1. Close the F13 residual: branch coverage for `src/llm-protocol/` and `src/agent-loop/` (F14).
```

to the next open priority from the list, preserving numbering order.

- [ ] **Step 7: Final grep gate**

Run:

```powershell
rg -n "F13 residual|below the repo's branch-coverage goal|Task 11 Step 4" ARCHITECTURE-REVIEW.md docs/superpowers/plans/2026-06-10-unify-agentic-loop-llama-protocol.md docs/superpowers/plans/2026-06-12-test-coverage-backfill.md
```

Expected:

- `ARCHITECTURE-REVIEW.md` no longer lists the residual as open.
- The old unified-loop plan may still mention its historical Task 11.
- This plan may mention the old terms only in `Current Evidence`.

---

## Completion Criteria

- `tests/agent-loop.test.ts`, `tests/llm-protocol.test.ts`, and `tests/llm-protocol-streaming.test.ts` are included in `tsconfig.test.json`.
- Focused tests cover the executable uncovered branches in `src/agent-loop/action-parser.ts`, `src/agent-loop/agent-loop.ts`, `src/llm-protocol/llama-cpp-client.ts`, `src/llm-protocol/streaming-response-assembler.ts`, and `src/llm-protocol/tool-call-parser.ts`.
- No production code is added solely for coverage.
- No dynamic function-passing abstraction or test shim is introduced.
- `npm run typecheck`, `npm test`, and `npm run test:coverage` pass.
- `ARCHITECTURE-REVIEW.md` no longer lists the F13 branch-coverage residual as an open priority.

## Self-Review

- Spec coverage: The plan addresses the exact F14/F13 residual from `ARCHITECTURE-REVIEW.md` and keeps the work limited to `src/llm-protocol/`, `src/agent-loop/`, tests, typecheck inclusion, and review cleanup.
- Placeholder scan: No placeholder task is left; every code step names exact files, commands, expected outcomes, and branch paths.
- Type consistency: The snippets use existing `AgentLoop*`, `LlamaCpp*`, `SiftConfig`, `FullJsonResponse`, `RequestJsonOptions`, and `SseStream*` types from current source.
