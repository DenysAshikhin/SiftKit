# Unify Agentic Loop And Llama Protocol Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Do not use worktrees.

**Goal:** Resolve `ARCHITECTURE-REVIEW.md` F13 by replacing the parallel repo-search, summary-planner, and llama.cpp protocol implementations with one typed llama.cpp protocol client and one reusable agent-loop engine.

**Architecture:** Add a first-class `LlamaCppClient` for OpenAI-compatible chat, streaming, tool-call, token-count, model-list, status, retry, reasoning, and usage normalization. Add an explicit `AgentLoop` class that owns transcript mutation, provider invocation, action parsing, invalid-response handling, tool execution, tool-result budgeting, forced finish, repetition protection, thinking retention, and final output assembly through typed collaborator classes. Migrate repo-search/chat first, migrate summary planner second, move persisted chat replay tool-call construction into the shared protocol layer, then delete duplicate protocol/loop code paths instead of preserving legacy wrappers.

**Tech Stack:** TypeScript, Node HTTP, existing `HttpClient`, existing `retryProviderRequest`, `node:test`, `tsx`, existing repo-search and summary tool definitions.

---

## Current Evidence

- `ARCHITECTURE-REVIEW.md:68-77` flags three parallel agentic-loop / LLM-protocol implementations.
- `src/repo-search/planner-protocol.ts:354` parses repo-search tool calls, `:479` sends planner requests, `:754` streams SSE, and `:826` / `:845` implement runaway thinking/content detection.
- `src/repo-search/engine/task-loop.ts:71` owns the repo-search/chat task loop, `:358` calls `requestPlannerAction`, and `:401` mutates transcript tool exchanges.
- `src/summary/planner/mode.ts:198` owns a separate planner `while` loop, `:245` calls `invokePlannerProviderAction`, and `:596` calls `executePlannerTool`.
- `src/providers/llama-cpp.ts:312`, `:453`, `:499`, `:527`, and `:560` separately implement token counting, model listing, status, basic completion, and chat completion.
- `src/lib/model-json.ts:195-273` parses repo-search and summary planner actions from JSON text.
- `src/tool-call-messages.ts` already centralizes assistant/tool exchange message construction and must be reused by the new loop.

## Target Structure

Create:

- `src/llm-protocol/types.ts` - OpenAI-compatible message, tool, streaming, normalized response, usage, and protocol error types.
- `src/llm-protocol/llama-cpp-client.ts` - `LlamaCppClient` class for all llama.cpp HTTP calls.
- `src/llm-protocol/tool-call-parser.ts` - one parser for `message.tool_calls`, `choice.tool_calls`, legacy `function_call`, and streamed tool-call deltas.
- `src/llm-protocol/streaming-response-assembler.ts` - one class for SSE delta accumulation, thinking/content runaway detection, and early-stop output text.
- `src/agent-loop/types.ts` - loop contracts, action types, turn result types, and explicit collaborator interfaces.
- `src/agent-loop/action-parser.ts` - action parser class that delegates repo-search and summary JSON parsing to `ModelJson`.
- `src/agent-loop/agent-loop.ts` - reusable `AgentLoop` class.
- `src/repo-search/agent-loop-adapter.ts` - repo-search/chat collaborator classes for prompts, actions, finish policy, progress, and result assembly.
- `src/summary/planner/agent-loop-adapter.ts` - summary-planner collaborator classes for prompts, actions, artifacts, and result assembly.
- `tests/llm-protocol.test.ts` - protocol normalization and request-body coverage.
- `tests/llm-protocol-streaming.test.ts` - streaming assembly and runaway-stop coverage.
- `tests/agent-loop.test.ts` - generic loop behavior coverage.
- `tests/repo-search-agent-loop-adapter.test.ts` - repo-search/chat migration coverage.
- `tests/summary-agent-loop-adapter.test.ts` - summary planner migration coverage.
- `tests/agent-loop-boundary.test.ts` - static guard that prevents reintroduced duplicate loops/protocol clients.

Modify:

- `src/providers/llama-cpp.ts` - shrink to typed exports that instantiate `LlamaCppClient`; remove request/parse logic from this file.
- `src/repo-search/planner-protocol.ts` - keep tool definition builders only during migration, then delete request/streaming/parser code from it.
- `src/repo-search/engine/task-loop.ts` - replace local turn loop with `AgentLoop` plus repo-search adapter classes.
- `src/repo-search/engine/task-loop-support.ts` - move generic loop types into `src/agent-loop/types.ts` where they are no longer repo-search-specific.
- `src/repo-search/engine/prompt-preparer.ts`, `transcript-manager.ts`, `token-usage.ts`, and `tool-result-budgeter.ts` - move or generalize only when the new loop imports them directly.
- `src/summary/planner/provider.ts` - replace provider-specific action invocation with `LlamaCppClient`.
- `src/summary/planner/mode.ts` - replace the planner `while` loop with `AgentLoop` plus summary adapter classes.
- `src/summary/planner/prompts.ts` and `tools.ts` - retain summary-specific prompt and tool definitions, but expose them through explicit adapter classes.
- `src/lib/model-json.ts` - keep JSON action parsing, remove duplicate tool-call interpretation if moved to `tool-call-parser.ts`.
- `src/status-server/chat.ts` - remove local replay tool-call protocol construction and call the shared replay helper instead.
- Existing tests listed under F13 evidence - update expectations to target the unified implementation.

Delete:

- `requestPlannerAction`, `requestStreaming`, `parseRepoToolCallCandidate`, `getRunawayStructuralTail`, and `buildEarlyStoppedPlannerText` from `src/repo-search/planner-protocol.ts`.
- `invokePlannerProviderAction` from `src/summary/planner/provider.ts` after summary planner uses `LlamaCppClient` directly.
- Any local loop branch in `src/summary/planner/mode.ts` that duplicates invalid-response retry, forced finish, duplicate-call handling, or transcript rendering after `AgentLoop` owns it.

## Commit Policy

Do not commit during execution. Every task's final step records changed files and verification output only. Leave all changes uncommitted for human review.

---

### Task 1: Add Boundary Guard Tests For Duplicate Protocol And Loop Code

**Files:**

- Create: `tests/agent-loop-boundary.test.ts`

- [ ] **Step 1: Write the failing static guard**

Create `tests/agent-loop-boundary.test.ts`:

```ts
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

type SourceFile = {
  filePath: string;
  text: string;
};

function listTsFiles(root: string): SourceFile[] {
  const files: SourceFile[] = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const fullPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...listTsFiles(fullPath));
      continue;
    }
    if (entry.isFile() && entry.name.endsWith('.ts')) {
      files.push({
        filePath: path.relative(process.cwd(), fullPath).replace(/\\/gu, '/'),
        text: fs.readFileSync(fullPath, 'utf8'),
      });
    }
  }
  return files;
}

const LLAMA_ENDPOINT_LITERAL_ALLOWLIST = new Set<string>([
  'src/llm-protocol/llama-cpp-client.ts',
  'src/status-server/routes/llama-passthrough.ts',
]);

test('llama.cpp active HTTP request construction lives only in LlamaCppClient', () => {
  const files = listTsFiles(path.join(process.cwd(), 'src'));
  const offenders = files
    .filter((file) => !LLAMA_ENDPOINT_LITERAL_ALLOWLIST.has(file.filePath))
    .filter((file) => /\/v1\/chat\/completions|\/tokenize|\/v1\/models/u.test(file.text))
    .map((file) => file.filePath);

  assert.deepEqual(offenders, [
    'src/providers/llama-cpp.ts',
    'src/repo-search/planner-protocol.ts',
    'src/benchmark-matrix/config-rpc.ts',
    'src/status-server/managed-llama.ts',
    'src/status-server/routes/core.ts',
  ]);
});

test('tool-call protocol parsing has one implementation', () => {
  const files = listTsFiles(path.join(process.cwd(), 'src'));
  const offenders = files
    .filter((file) => file.filePath !== 'src/llm-protocol/llama-cpp-client.ts')
    .filter((file) => !file.filePath.endsWith('/src/llm-protocol/tool-call-parser.ts'))
    .filter((file) => /function_call|delta\.tool_calls|message\?\.tool_calls|choice\?\.tool_calls/u.test(file.text))
    .map((file) => file.filePath);

  assert.equal(
    offenders.includes('src/repo-search/planner-protocol.ts'),
    true,
    'guard must fail before planner-protocol parsing is removed',
  );
});

test('summary planner does not keep a separate agent loop', () => {
  const modePath = path.join(process.cwd(), 'src', 'summary', 'planner', 'mode.ts');
  const text = fs.readFileSync(modePath, 'utf8');

  assert.equal(/while\s*\(\s*toolResults\.length\s*<=\s*MAX_PLANNER_TOOL_CALLS\s*\)/u.test(text), false);
  assert.equal(/invokePlannerProviderAction/u.test(text), false);
});

test('status-server chat does not synthesize private replay tool-call protocol names', () => {
  const chatPath = path.join(process.cwd(), 'src', 'status-server', 'chat.ts');
  const text = fs.readFileSync(chatPath, 'utf8');

  assert.equal(/persisted_tool_call/u.test(text), false);
  assert.equal(/function\s+buildReplayToolCall\(/u.test(text), false);
});
```

- [ ] **Step 2: Run the guard and confirm it fails for current F13 debt**

Run:

```powershell
npm test -- tests/agent-loop-boundary.test.ts
```

Expected: FAIL. The failure must point at existing protocol URLs in `src/providers/llama-cpp.ts`, `src/repo-search/planner-protocol.ts`, `src/benchmark-matrix/config-rpc.ts`, `src/status-server/managed-llama.ts`, and `src/status-server/routes/core.ts`; protocol parsing in `src/repo-search/planner-protocol.ts`; replay protocol construction in `src/status-server/chat.ts`; and the summary planner loop in `src/summary/planner/mode.ts`.

- [ ] **Step 3: Record changed files**

Changed files: `tests/agent-loop-boundary.test.ts`.

---

### Task 2: Define One Typed LLM Protocol Model

**Files:**

- Create: `src/llm-protocol/types.ts`
- Create: `tests/llm-protocol.test.ts`

- [ ] **Step 1: Write protocol type compile coverage**

Create `tests/llm-protocol.test.ts` with the first type-oriented assertions:

```ts
import test from 'node:test';
import assert from 'node:assert/strict';

import type {
  LlamaCppChatMessage,
  LlamaCppToolDefinition,
  LlamaCppChatRequest,
  NormalizedLlamaCppChatResponse,
} from '../src/llm-protocol/types.js';

test('llm protocol types model text, reasoning, and tool-call responses', () => {
  const message: LlamaCppChatMessage = {
    role: 'assistant',
    content: 'answer',
    reasoning_content: 'thinking',
    tool_calls: [{
      id: 'call_1',
      type: 'function',
      function: { name: 'repo_rg', arguments: '{"pattern":"x"}' },
    }],
  };
  const tool: LlamaCppToolDefinition = {
    type: 'function',
    function: {
      name: 'repo_rg',
      description: 'Search repository text.',
      parameters: { type: 'object', properties: { pattern: { type: 'string' } }, required: ['pattern'] },
    },
  };
  const request: LlamaCppChatRequest = {
    model: 'local',
    messages: [{ role: 'user', content: 'find x' }],
    tools: [tool],
    parallel_tool_calls: true,
    stream: true,
    chat_template_kwargs: { enable_thinking: true },
  };
  const response: NormalizedLlamaCppChatResponse = {
    text: message.content,
    reasoningText: message.reasoning_content || '',
    toolCalls: message.tool_calls || [],
    usage: {
      promptTokens: 3,
      completionTokens: 4,
      outputTokens: 4,
      thinkingTokens: 1,
      promptCacheTokens: null,
      promptEvalTokens: 3,
    },
    raw: { choices: [{ message }] },
    stoppedEarly: false,
  };

  assert.equal(request.tools?.[0]?.function.name, 'repo_rg');
  assert.equal(response.toolCalls[0]?.function.name, 'repo_rg');
});
```

- [ ] **Step 2: Run the test and verify it fails because the module does not exist**

Run:

```powershell
npm test -- tests/llm-protocol.test.ts
```

Expected: FAIL with module resolution errors for `src/llm-protocol/types.ts`.

- [ ] **Step 3: Add explicit protocol types**

Create `src/llm-protocol/types.ts`:

```ts
export type LlamaCppChatRole = 'system' | 'user' | 'assistant' | 'tool';

export type LlamaCppToolCall = {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
};

export type LlamaCppChatMessage = {
  role: LlamaCppChatRole;
  content: string | Array<{ type: string; text?: string; image_url?: { url: string } }> | null;
  reasoning_content?: string | Array<{ type?: string; text?: string }> | null;
  tool_call_id?: string;
  tool_calls?: LlamaCppToolCall[];
};

export type LlamaCppToolDefinition = {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
};

export type LlamaCppResponseFormat =
  | { type: 'json_object' }
  | { type: 'json_schema'; json_schema: Record<string, unknown> };

export type LlamaCppChatRequest = {
  model: string;
  messages: LlamaCppChatMessage[];
  temperature?: number;
  max_tokens?: number;
  stream?: boolean;
  tools?: LlamaCppToolDefinition[];
  tool_choice?: 'auto' | 'none' | { type: 'function'; function: { name: string } };
  parallel_tool_calls?: boolean;
  response_format?: LlamaCppResponseFormat;
  chat_template_kwargs?: {
    enable_thinking?: boolean;
    reasoning_content?: boolean;
  };
};

export type LlamaCppUsage = {
  promptTokens: number | null;
  completionTokens: number | null;
  outputTokens: number | null;
  thinkingTokens: number | null;
  promptCacheTokens: number | null;
  promptEvalTokens: number | null;
};

export type NormalizedLlamaCppChatResponse = {
  text: string;
  reasoningText: string;
  toolCalls: LlamaCppToolCall[];
  usage: LlamaCppUsage;
  raw: Record<string, unknown>;
  stoppedEarly: boolean;
  earlyStopReason?: string;
};
```

- [ ] **Step 4: Run protocol type test**

Run:

```powershell
npm test -- tests/llm-protocol.test.ts
```

Expected: PASS.

- [ ] **Step 5: Record changed files**

Changed files: `src/llm-protocol/types.ts`, `tests/llm-protocol.test.ts`.

---

### Task 3: Extract One Tool-Call Parser

**Files:**

- Create: `src/llm-protocol/tool-call-parser.ts`
- Modify: `tests/llm-protocol.test.ts`

- [ ] **Step 1: Add failing parser tests**

Append to `tests/llm-protocol.test.ts`:

```ts
import { LlamaCppToolCallParser } from '../src/llm-protocol/tool-call-parser.js';

test('tool-call parser normalizes message, choice, and legacy function calls', () => {
  const parser = new LlamaCppToolCallParser(['repo_rg', 'finish']);
  const calls = parser.parseFromChoice({
    message: {
      tool_calls: [{
        id: 'call_1',
        type: 'function',
        function: { name: 'repo_rg', arguments: '{"pattern":"AgentLoop"}' },
      }],
      function_call: { name: 'finish', arguments: '{"answer":"done"}' },
    },
    tool_calls: [{
      id: 'call_2',
      type: 'function',
      function: { name: 'not_allowed', arguments: '{}' },
    }],
  });

  assert.deepEqual(calls.map((call) => call.function.name), ['repo_rg', 'finish']);
  assert.equal(calls[0]?.function.arguments, '{"pattern":"AgentLoop"}');
});
```

- [ ] **Step 2: Run the parser test and verify it fails**

Run:

```powershell
npm test -- tests/llm-protocol.test.ts
```

Expected: FAIL because `LlamaCppToolCallParser` does not exist.

- [ ] **Step 3: Implement explicit parser class**

Create `src/llm-protocol/tool-call-parser.ts`:

```ts
import type { LlamaCppToolCall } from './types.js';

type RawFunctionCall = {
  name?: unknown;
  arguments?: unknown;
};

type RawToolCall = {
  id?: unknown;
  type?: unknown;
  function?: RawFunctionCall;
};

type RawChoice = {
  message?: {
    tool_calls?: RawToolCall[];
    function_call?: RawFunctionCall;
  };
  tool_calls?: RawToolCall[];
};

export class LlamaCppToolCallParser {
  private readonly allowedToolNames: Set<string>;

  constructor(allowedToolNames: readonly string[]) {
    this.allowedToolNames = new Set(allowedToolNames);
  }

  parseFromChoice(choice: RawChoice): LlamaCppToolCall[] {
    const calls: LlamaCppToolCall[] = [];
    for (const raw of choice.message?.tool_calls || []) {
      const parsed = this.parseToolCall(raw);
      if (parsed) calls.push(parsed);
    }
    for (const raw of choice.tool_calls || []) {
      const parsed = this.parseToolCall(raw);
      if (parsed) calls.push(parsed);
    }
    const legacy = this.parseLegacyFunctionCall(choice.message?.function_call);
    if (legacy) calls.push(legacy);
    return calls;
  }

  parseToolCall(raw: RawToolCall): LlamaCppToolCall | null {
    const name = typeof raw.function?.name === 'string' ? raw.function.name.trim() : '';
    if (!this.allowedToolNames.has(name)) return null;
    return {
      id: typeof raw.id === 'string' && raw.id.trim() ? raw.id : `call_${name}`,
      type: 'function',
      function: {
        name,
        arguments: typeof raw.function?.arguments === 'string' ? raw.function.arguments : '{}',
      },
    };
  }

  private parseLegacyFunctionCall(raw: RawFunctionCall | undefined): LlamaCppToolCall | null {
    const name = typeof raw?.name === 'string' ? raw.name.trim() : '';
    if (!this.allowedToolNames.has(name)) return null;
    return {
      id: `call_${name}`,
      type: 'function',
      function: {
        name,
        arguments: typeof raw?.arguments === 'string' ? raw.arguments : '{}',
      },
    };
  }
}
```

- [ ] **Step 4: Run parser tests**

Run:

```powershell
npm test -- tests/llm-protocol.test.ts
```

Expected: PASS.

- [ ] **Step 5: Record changed files**

Changed files: `src/llm-protocol/tool-call-parser.ts`, `tests/llm-protocol.test.ts`.

---

### Task 4: Extract Streaming Response Assembly

**Files:**

- Create: `src/llm-protocol/streaming-response-assembler.ts`
- Create: `tests/llm-protocol-streaming.test.ts`

- [ ] **Step 1: Write failing streaming assembler tests**

Create `tests/llm-protocol-streaming.test.ts`:

```ts
import test from 'node:test';
import assert from 'node:assert/strict';

import { LlamaCppStreamingResponseAssembler } from '../src/llm-protocol/streaming-response-assembler.js';

test('streaming assembler accumulates content, reasoning, and tool-call deltas', () => {
  const assembler = new LlamaCppStreamingResponseAssembler(['repo_rg']);

  assembler.ingestChoiceDelta({ delta: { reasoning_content: 'think ', content: 'ans' } });
  assembler.ingestChoiceDelta({
    delta: {
      tool_calls: [{ index: 0, id: 'call_1', function: { name: 'repo_rg', arguments: '{"pattern":' } }],
    },
  });
  assembler.ingestChoiceDelta({
    delta: {
      tool_calls: [{ index: 0, function: { arguments: '"x"}' } }],
    },
  });

  const response = assembler.toResponse({ promptTokens: 1, completionTokens: 2, outputTokens: 2, thinkingTokens: 1, promptCacheTokens: null, promptEvalTokens: 1 });

  assert.equal(response.text, 'ans');
  assert.equal(response.reasoningText, 'think ');
  assert.equal(response.toolCalls[0]?.function.arguments, '{"pattern":"x"}');
});

test('streaming assembler early-stops runaway structural repetition', () => {
  const assembler = new LlamaCppStreamingResponseAssembler(['finish'], { structuralRepeatLimit: 4 });

  for (const chunk of ['||||', '||||', '||||', '||||']) {
    assembler.ingestChoiceDelta({ delta: { content: chunk } });
  }

  const response = assembler.toResponse({ promptTokens: null, completionTokens: null, outputTokens: null, thinkingTokens: null, promptCacheTokens: null, promptEvalTokens: null });

  assert.equal(response.stoppedEarly, true);
  assert.match(response.earlyStopReason || '', /runaway/i);
});
```

- [ ] **Step 2: Run and verify failure**

Run:

```powershell
npm test -- tests/llm-protocol-streaming.test.ts
```

Expected: FAIL because `streaming-response-assembler.ts` does not exist.

- [ ] **Step 3: Implement assembler**

Implement `LlamaCppStreamingResponseAssembler` by moving the behavior from `src/repo-search/planner-protocol.ts:712-889` into `src/llm-protocol/streaming-response-assembler.ts`.

Required public shape:

```ts
import type { LlamaCppToolCall, LlamaCppUsage, NormalizedLlamaCppChatResponse } from './types.js';

export type LlamaCppStreamingAssemblerOptions = {
  structuralRepeatLimit?: number;
};

export class LlamaCppStreamingResponseAssembler {
  constructor(allowedToolNames: readonly string[], options?: LlamaCppStreamingAssemblerOptions);
  ingestChoiceDelta(choice: Record<string, unknown>): void;
  toResponse(usage: LlamaCppUsage): NormalizedLlamaCppChatResponse;
}
```

Implementation requirements:

- Keep the existing runaway behavior from `getRunawayStructuralTail`, but make `structuralRepeatLimit` constructor-controlled for tests.
- Accumulate `delta.content` into final `text`.
- Accumulate `delta.reasoning_content`, `delta.thinking`, and `delta.reasoning` into final `reasoningText`.
- Accumulate streamed tool call chunks by `index`, preserving `id`, `name`, and concatenated `arguments`.
- Use `LlamaCppToolCallParser` to drop disallowed tool names.
- Build early-stop text with the same user-visible prefix used by `buildEarlyStoppedPlannerText`.

- [ ] **Step 4: Run streaming tests**

Run:

```powershell
npm test -- tests/llm-protocol-streaming.test.ts
```

Expected: PASS.

- [ ] **Step 5: Record changed files**

Changed files: `src/llm-protocol/streaming-response-assembler.ts`, `tests/llm-protocol-streaming.test.ts`.

---

### Task 5: Extract `LlamaCppClient`

**Files:**

- Create: `src/llm-protocol/llama-cpp-client.ts`
- Modify: `tests/llm-protocol.test.ts`
- Modify: `tests/runtime-provider-llama.test.ts`
- Modify: `src/providers/llama-cpp.ts`

- [ ] **Step 1: Add failing client request-body tests**

Append focused tests to `tests/llm-protocol.test.ts` using a stub `HttpClient` with `fetch` and `streamSse` methods.

Required assertions:

- `chat()` posts to `/v1/chat/completions`.
- Reasoning off sends `chat_template_kwargs.enable_thinking === false`.
- Reasoning content on sends `chat_template_kwargs.reasoning_content === true`.
- Tool calls send `tools`, `parallel_tool_calls: true`, and no tool fields when `tools` is empty.
- Structured output sends `response_format`.
- Transient errors still go through existing `retryProviderRequest`.

- [ ] **Step 2: Run and verify failure**

Run:

```powershell
npm test -- tests/llm-protocol.test.ts
```

Expected: FAIL because `LlamaCppClient` does not exist.

- [ ] **Step 3: Implement explicit client class**

Create `src/llm-protocol/llama-cpp-client.ts` with this public shape:

```ts
import type { SiftConfig } from '../config/types.js';
import type { HttpClient } from '../lib/http-client.js';
import type {
  LlamaCppChatMessage,
  LlamaCppChatRequest,
  LlamaCppToolDefinition,
  LlamaCppUsage,
  NormalizedLlamaCppChatResponse,
} from './types.js';

export type LlamaCppChatOptions = {
  config: SiftConfig;
  model: string;
  messages: LlamaCppChatMessage[];
  tools: LlamaCppToolDefinition[];
  maxTokens: number;
  temperature?: number;
  stream: boolean;
  responseFormat?: LlamaCppChatRequest['response_format'];
  reasoningOverride?: 'on' | 'off';
  allowedToolNames: string[];
  requestTimeoutSeconds?: number;
};

export class LlamaCppClient {
  constructor(httpClient?: HttpClient);
  countTokens(config: SiftConfig, content: string, options?: { requestTimeoutSeconds?: number }): Promise<{ tokenCount: number; raw: Record<string, unknown> }>;
  listModels(config: SiftConfig): Promise<string[]>;
  getStatus(config: SiftConfig): Promise<{ ok: boolean; models: string[]; error: string | null }>;
  chat(options: LlamaCppChatOptions): Promise<NormalizedLlamaCppChatResponse>;
}
```

Move the existing implementation logic from `src/providers/llama-cpp.ts` into this class:

- `/tokenize` and token-count normalization from `countLlamaCppTokensDetailed`.
- `/v1/models` parsing from `listLlamaCppModels`.
- provider status behavior from `getLlamaCppProviderStatus`.
- `/v1/chat/completions` body construction from `generateLlamaCppChatResponse`.
- usage extraction from `generateLlamaCppChatResponse`, including `reasoning_tokens` and `thinking_tokens`.
- retry policy from current `retryProviderRequest` usage.
- non-streaming parse through `LlamaCppToolCallParser`.
- streaming parse through `LlamaCppStreamingResponseAssembler`.

- [ ] **Step 4: Shrink provider exports to class delegation**

Change `src/providers/llama-cpp.ts` so the exported functions call a module-local `LlamaCppClient` instance:

```ts
import { LlamaCppClient } from '../llm-protocol/llama-cpp-client.js';

const llamaCppClient = new LlamaCppClient();
```

Keep exported function names only because external callers still use them. Do not keep duplicated HTTP body or response parsing in this file.

- [ ] **Step 5: Run provider and protocol tests**

Run:

```powershell
npm test -- tests/llm-protocol.test.ts tests/llm-protocol-streaming.test.ts tests/runtime-provider-llama.test.ts
```

Expected: PASS.

- [ ] **Step 6: Record changed files**

Changed files: `src/llm-protocol/*`, `src/providers/llama-cpp.ts`, `tests/llm-protocol.test.ts`, `tests/runtime-provider-llama.test.ts`.

---

### Task 6: Introduce Generic `AgentLoop` Contracts

**Files:**

- Create: `src/agent-loop/types.ts`
- Create: `src/agent-loop/action-parser.ts`
- Create: `tests/agent-loop.test.ts`

- [ ] **Step 1: Write failing action parser tests**

Create `tests/agent-loop.test.ts`:

```ts
import test from 'node:test';
import assert from 'node:assert/strict';

import { AgentLoopActionParser } from '../src/agent-loop/action-parser.js';

test('agent loop action parser parses repo-search and summary planner actions explicitly', () => {
  const parser = new AgentLoopActionParser();

  const repo = parser.parseRepoSearchAction('{"action":"finish","answer":"done"}');
  const summary = parser.parseSummaryPlannerAction('{"action":"finish","summary":"done"}');

  assert.equal(repo.kind, 'finish');
  assert.equal(summary.kind, 'finish');
});
```

- [ ] **Step 2: Run and verify failure**

Run:

```powershell
npm test -- tests/agent-loop.test.ts
```

Expected: FAIL because `src/agent-loop/action-parser.ts` does not exist.

- [ ] **Step 3: Add loop contract types**

Create `src/agent-loop/types.ts` with explicit classes/interfaces only. Do not pass anonymous functions into `AgentLoop`.

Required exports:

```ts
import type { LlamaCppChatMessage, LlamaCppToolDefinition, NormalizedLlamaCppChatResponse } from '../llm-protocol/types.js';

export type AgentLoopKind = 'repo-search' | 'chat' | 'summary-planner';

export type AgentLoopFinishAction = {
  kind: 'finish';
  text: string;
};

export type AgentLoopToolAction = {
  kind: 'tool';
  callId: string;
  toolName: string;
  args: Record<string, unknown>;
};

export type AgentLoopAction = AgentLoopFinishAction | AgentLoopToolAction;

export type AgentLoopToolResult = {
  callId: string;
  toolName: string;
  args: Record<string, unknown>;
  text: string;
  raw: unknown;
};

export type AgentLoopTurn = {
  turnNumber: number;
  response: NormalizedLlamaCppChatResponse;
  actions: AgentLoopAction[];
  toolResults: AgentLoopToolResult[];
};

export type AgentLoopResult = {
  finishText: string;
  turns: AgentLoopTurn[];
  reason: 'finished' | 'max_turns' | 'forced_finish' | 'aborted';
  promptTokens: number;
  outputTokens: number;
  thinkingTokens: number;
};

export interface AgentLoopPromptAdapter {
  readonly kind: AgentLoopKind;
  buildInitialMessages(): LlamaCppChatMessage[];
  buildToolDefinitions(): LlamaCppToolDefinition[];
  buildInvalidResponseMessage(errorMessage: string): LlamaCppChatMessage;
  buildForcedFinishMessage(reason: string): LlamaCppChatMessage;
}

export interface AgentLoopActionAdapter {
  parseActions(response: NormalizedLlamaCppChatResponse): AgentLoopAction[];
  evaluateFinish(action: AgentLoopFinishAction, turns: readonly AgentLoopTurn[]): { accepted: boolean; message: string | null };
}

export interface AgentLoopToolAdapter {
  executeTool(action: AgentLoopToolAction): Promise<AgentLoopToolResult>;
}

export interface AgentLoopObserver {
  onTurnStart(turnNumber: number, messages: readonly LlamaCppChatMessage[]): void;
  onModelResponse(turnNumber: number, response: NormalizedLlamaCppChatResponse): void;
  onToolResult(turnNumber: number, result: AgentLoopToolResult): void;
}
```

- [ ] **Step 4: Add explicit action parser class**

Create `src/agent-loop/action-parser.ts`:

```ts
import { ModelJson } from '../lib/model-json.js';
import type { AgentLoopAction } from './types.js';

export class AgentLoopActionParser {
  parseRepoSearchAction(text: string): AgentLoopAction {
    const parsed = ModelJson.parseRepoSearchPlannerAction(text);
    if (parsed.action === 'finish') {
      return { kind: 'finish', text: parsed.answer };
    }
    if (parsed.action === 'tool_batch') {
      const first = parsed.tool_calls[0];
      return { kind: 'tool', callId: first.id, toolName: first.tool_name, args: first.args };
    }
    return { kind: 'tool', callId: parsed.id, toolName: parsed.tool_name, args: parsed.args };
  }

  parseSummaryPlannerAction(text: string): AgentLoopAction {
    const parsed = ModelJson.parseSummaryPlannerAction(text);
    if (parsed.action === 'finish') {
      return { kind: 'finish', text: parsed.summary };
    }
    if (parsed.action === 'tool_batch') {
      const first = parsed.tool_calls[0];
      return { kind: 'tool', callId: first.id, toolName: first.tool_name, args: first.args };
    }
    return { kind: 'tool', callId: parsed.id, toolName: parsed.tool_name, args: parsed.args };
  }
}
```

If actual `ModelJson` return property names differ, update this implementation and the test together from the current `src/lib/model-json.ts` contract.

- [ ] **Step 5: Run action parser tests**

Run:

```powershell
npm test -- tests/agent-loop.test.ts
```

Expected: PASS.

- [ ] **Step 6: Record changed files**

Changed files: `src/agent-loop/types.ts`, `src/agent-loop/action-parser.ts`, `tests/agent-loop.test.ts`.

---

### Task 7: Implement `AgentLoop`

**Files:**

- Create: `src/agent-loop/agent-loop.ts`
- Modify: `tests/agent-loop.test.ts`

- [ ] **Step 1: Add failing generic loop tests**

Append tests to `tests/agent-loop.test.ts` that use explicit stub classes:

```ts
import { AgentLoop } from '../src/agent-loop/agent-loop.js';
import type {
  AgentLoopAction,
  AgentLoopActionAdapter,
  AgentLoopFinishAction,
  AgentLoopPromptAdapter,
  AgentLoopToolAction,
  AgentLoopToolAdapter,
  AgentLoopToolResult,
  AgentLoopTurn,
} from '../src/agent-loop/types.js';
import type { LlamaCppChatMessage, LlamaCppToolDefinition, NormalizedLlamaCppChatResponse } from '../src/llm-protocol/types.js';

class StubPromptAdapter implements AgentLoopPromptAdapter {
  readonly kind = 'repo-search' as const;
  buildInitialMessages(): LlamaCppChatMessage[] {
    return [{ role: 'user', content: 'search' }];
  }
  buildToolDefinitions(): LlamaCppToolDefinition[] {
    return [];
  }
  buildInvalidResponseMessage(errorMessage: string): LlamaCppChatMessage {
    return { role: 'user', content: `Invalid: ${errorMessage}` };
  }
  buildForcedFinishMessage(reason: string): LlamaCppChatMessage {
    return { role: 'user', content: `Finish: ${reason}` };
  }
}

class StubActionAdapter implements AgentLoopActionAdapter {
  parseActions(response: NormalizedLlamaCppChatResponse): AgentLoopAction[] {
    return response.text === 'finish'
      ? [{ kind: 'finish', text: 'done' }]
      : [{ kind: 'tool', callId: 'call_1', toolName: 'read_lines', args: { startLine: 1 } }];
  }
  evaluateFinish(action: AgentLoopFinishAction, turns: readonly AgentLoopTurn[]): { accepted: boolean; message: string | null } {
    return turns.length >= 1 ? { accepted: true, message: null } : { accepted: false, message: 'Need evidence.' };
  }
}

class StubToolAdapter implements AgentLoopToolAdapter {
  async executeTool(action: AgentLoopToolAction): Promise<AgentLoopToolResult> {
    return { callId: action.callId, toolName: action.toolName, args: action.args, text: 'tool output', raw: { ok: true } };
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
      chat: async () => responses.shift() as NormalizedLlamaCppChatResponse,
    },
  });

  const result = await loop.run();

  assert.equal(result.finishText, 'done');
  assert.equal(result.turns.length, 2);
  assert.equal(result.turns[0]?.toolResults[0]?.text, 'tool output');
});
```

- [ ] **Step 2: Run and verify failure**

Run:

```powershell
npm test -- tests/agent-loop.test.ts
```

Expected: FAIL because `AgentLoop` does not exist.

- [ ] **Step 3: Implement `AgentLoop`**

Create `src/agent-loop/agent-loop.ts` with:

```ts
import type { LlamaCppChatMessage, LlamaCppToolDefinition, NormalizedLlamaCppChatResponse } from '../llm-protocol/types.js';
import type {
  AgentLoopActionAdapter,
  AgentLoopObserver,
  AgentLoopPromptAdapter,
  AgentLoopResult,
  AgentLoopToolAdapter,
  AgentLoopToolAction,
  AgentLoopTurn,
} from './types.js';

export type AgentLoopModelClient = {
  chat(options: {
    messages: LlamaCppChatMessage[];
    tools: LlamaCppToolDefinition[];
    allowedToolNames: string[];
    stream: boolean;
  }): Promise<NormalizedLlamaCppChatResponse>;
};

export type AgentLoopOptions = {
  maxTurns: number;
  stream?: boolean;
  promptAdapter: AgentLoopPromptAdapter;
  actionAdapter: AgentLoopActionAdapter;
  toolAdapter: AgentLoopToolAdapter;
  modelClient: AgentLoopModelClient;
  observer?: AgentLoopObserver;
};

export class AgentLoop {
  private readonly messages: LlamaCppChatMessage[];
  private readonly turns: AgentLoopTurn[] = [];

  constructor(private readonly options: AgentLoopOptions) {
    this.messages = options.promptAdapter.buildInitialMessages();
  }

  async run(): Promise<AgentLoopResult> {
    for (let turnNumber = 1; turnNumber <= this.options.maxTurns; turnNumber += 1) {
      this.options.observer?.onTurnStart(turnNumber, this.messages);
      const response = await this.options.modelClient.chat({
        messages: this.messages,
        tools: this.options.promptAdapter.buildToolDefinitions(),
        allowedToolNames: this.options.promptAdapter.buildToolDefinitions().map((tool) => tool.function.name),
        stream: this.options.stream === true,
      });
      this.options.observer?.onModelResponse(turnNumber, response);

      const actions = this.options.actionAdapter.parseActions(response);
      const toolResults = [];
      const turn: AgentLoopTurn = { turnNumber, response, actions, toolResults };
      this.turns.push(turn);

      for (const action of actions) {
        if (action.kind === 'finish') {
          const evaluation = this.options.actionAdapter.evaluateFinish(action, this.turns);
          if (evaluation.accepted) {
            return this.buildResult(action.text, 'finished');
          }
          this.messages.push(this.options.promptAdapter.buildInvalidResponseMessage(evaluation.message || 'Finish was rejected.'));
          continue;
        }

        const toolResult = await this.options.toolAdapter.executeTool(action as AgentLoopToolAction);
        toolResults.push(toolResult);
        this.options.observer?.onToolResult(turnNumber, toolResult);
        this.messages.push({
          role: 'tool',
          tool_call_id: toolResult.callId,
          content: toolResult.text,
        });
      }
    }

    this.messages.push(this.options.promptAdapter.buildForcedFinishMessage('Maximum turns reached.'));
    return this.buildResult('', 'max_turns');
  }

  private buildResult(finishText: string, reason: AgentLoopResult['reason']): AgentLoopResult {
    return {
      finishText,
      turns: this.turns,
      reason,
      promptTokens: this.turns.reduce((sum, turn) => sum + Number(turn.response.usage.promptTokens || 0), 0),
      outputTokens: this.turns.reduce((sum, turn) => sum + Number(turn.response.usage.outputTokens || 0), 0),
      thinkingTokens: this.turns.reduce((sum, turn) => sum + Number(turn.response.usage.thinkingTokens || 0), 0),
    };
  }
}
```

Then refine inside this task so production requirements are met:

- Build tool definitions once per run, not multiple times per turn.
- Append assistant messages with content, reasoning, and tool calls through `appendToolBatchExchange` where tool calls exist.
- Append invalid-response prompts when parsing throws.
- Stop after `maxInvalidResponses`, using the same failure reason strings expected by existing repo-search tests.
- Call explicit observer methods for progress/debug artifacts.
- Respect abort signals by using existing `throwIfAborted`.

- [ ] **Step 4: Run generic loop tests**

Run:

```powershell
npm test -- tests/agent-loop.test.ts
```

Expected: PASS.

- [ ] **Step 5: Record changed files**

Changed files: `src/agent-loop/agent-loop.ts`, `tests/agent-loop.test.ts`.

---

### Task 8: Migrate Repo-Search And Chat Onto `AgentLoop`

**Files:**

- Create: `src/repo-search/agent-loop-adapter.ts`
- Modify: `src/repo-search/engine/task-loop.ts`
- Modify: `src/repo-search/engine/task-loop-support.ts`
- Modify: `src/repo-search/planner-protocol.ts`
- Modify: `src/status-server/chat.ts`
- Modify: `tests/repo-search-agent-loop-adapter.test.ts`
- Modify: `tests/mock-repo-search-loop.test.ts`
- Modify: `tests/repo-search-loop.core.test.ts`
- Modify: `tests/repo-search-chat-loop.test.ts`

- [ ] **Step 1: Add failing adapter tests**

Create `tests/repo-search-agent-loop-adapter.test.ts`:

```ts
import test from 'node:test';
import assert from 'node:assert/strict';

import { RepoSearchActionAdapter } from '../src/repo-search/agent-loop-adapter.js';

test('repo-search action adapter parses tool batches and finish actions', () => {
  const adapter = new RepoSearchActionAdapter(['repo_rg', 'finish']);

  const tools = adapter.parseActions({
    text: '{"action":"tool_batch","tool_calls":[{"id":"call_1","tool_name":"repo_rg","args":{"pattern":"x"}}]}',
    reasoningText: 'thinking',
    toolCalls: [],
    usage: { promptTokens: 1, completionTokens: 1, outputTokens: 1, thinkingTokens: 1, promptCacheTokens: null, promptEvalTokens: 1 },
    raw: {},
    stoppedEarly: false,
  });
  const finish = adapter.parseActions({
    text: '{"action":"finish","answer":"done"}',
    reasoningText: '',
    toolCalls: [],
    usage: { promptTokens: 1, completionTokens: 1, outputTokens: 1, thinkingTokens: 0, promptCacheTokens: null, promptEvalTokens: 1 },
    raw: {},
    stoppedEarly: false,
  });

  assert.equal(tools[0]?.kind, 'tool');
  assert.equal(finish[0]?.kind, 'finish');
});
```

- [ ] **Step 2: Run and verify failure**

Run:

```powershell
npm test -- tests/repo-search-agent-loop-adapter.test.ts
```

Expected: FAIL because the adapter does not exist.

- [ ] **Step 3: Implement repo-search adapter classes**

Create `src/repo-search/agent-loop-adapter.ts` with explicit classes:

- `RepoSearchPromptAdapter`
- `RepoSearchActionAdapter`
- `RepoSearchToolAdapter`
- `RepoSearchLoopObserver`
- `RepoSearchResultAssembler`

Move existing repo-search-specific behavior into those classes:

- System and initial prompt construction from `task-loop.ts:160-198`.
- Tool definitions from `resolveRepoSearchPlannerToolDefinitions`.
- Allowed tool-name rules from `task-loop.ts:137-145`.
- Finish evaluation through existing `evaluateFinishAttempt`.
- Tool execution through existing `ToolActionProcessor`.
- Prompt budgeting through existing `PromptPreparer`.
- Transcript mutation through existing `TranscriptManager`.
- Thinking retention through existing `ThinkingRetentionPolicy`.
- Progress events through existing `ProgressReporter`.
- Final scorecard/result assembly from current `TaskLoop.run`.

- [ ] **Step 4: Replace `TaskLoop` internal loop**

In `src/repo-search/engine/task-loop.ts`:

- Keep `TaskLoop` as the repo-search public orchestrator class.
- Remove direct calls to `requestPlannerAction`.
- Instantiate `LlamaCppClient` and `AgentLoop`.
- Pass explicit adapter objects into `AgentLoop`.
- Convert `AgentLoopResult` back to existing `TaskResult`.
- Preserve current `RunTaskLoopOptions` public shape.

- [ ] **Step 5: Delete repo-search protocol request implementation**

In `src/repo-search/planner-protocol.ts`:

- Keep exported planner tool definition builders and action types only if they are still imported.
- Delete `requestPlannerAction`.
- Delete `requestStreaming`.
- Delete `parseRepoToolCallCandidate`.
- Delete runaway streaming helpers moved to `src/llm-protocol/streaming-response-assembler.ts`.

- [ ] **Step 6: Move persisted chat replay tool-call construction into shared protocol code**

Add a replay helper in `src/llm-protocol/tool-call-parser.ts`:

```ts
export type ReplayToolCallInput = {
  id: string;
  command: string;
};

export function buildReplayToolCall(input: ReplayToolCallInput): LlamaCppToolCall {
  const trimmedCommand = input.command.trim();
  const searchPrefix = 'web_search:';
  const fetchPrefix = 'web_fetch:';
  if (trimmedCommand.startsWith(searchPrefix)) {
    return {
      id: input.id,
      type: 'function',
      function: {
        name: 'web_search',
        arguments: JSON.stringify({ query: trimmedCommand.slice(searchPrefix.length).trim() }),
      },
    };
  }
  if (trimmedCommand.startsWith(fetchPrefix)) {
    return {
      id: input.id,
      type: 'function',
      function: {
        name: 'web_fetch',
        arguments: JSON.stringify({ url: trimmedCommand.slice(fetchPrefix.length).trim() }),
      },
    };
  }
  throw new Error(`Cannot replay unknown persisted tool command: ${trimmedCommand}`);
}
```

Then update `src/status-server/chat.ts`:

- Import `buildReplayToolCall` from `../llm-protocol/tool-call-parser.js`.
- Delete the local `buildReplayToolCall` function.
- Keep `buildReplayToolCallId`.
- Call the shared helper from `appendReplayToolMessages`.
- Fail loud for unknown persisted commands instead of emitting a fictitious `persisted_tool_call`.

Add a focused test in `tests/status-server-chat.test.ts`:

```ts
test('buildChatHistoryMessages replays persisted web tool calls with real protocol names', () => {
  const messages = buildChatHistoryMessages({
    thinkingEnabled: true,
    preserveThinking: true,
    maintainPerStepThinking: true,
    messages: [
      { id: 'tool-1', role: 'assistant', kind: 'assistant_tool_call', content: 'web_search: local llamacpp', toolCallOutput: 'result' },
    ],
  });

  assert.equal(messages[0]?.tool_calls?.[0]?.function.name, 'web_search');
  assert.equal(messages[1]?.role, 'tool');
});
```

- [ ] **Step 7: Run repo-search/chat regression tests**

Run:

```powershell
npm test -- tests/repo-search-agent-loop-adapter.test.ts tests/mock-repo-search-loop.test.ts tests/repo-search-loop.core.test.ts tests/repo-search-chat-loop.test.ts tests/planner-streaming-timings.test.ts tests/repo-search-planner-protocol.test.ts tests/status-server-chat.test.ts
```

Expected: PASS. If `tests/repo-search-planner-protocol.test.ts` targets deleted request functions, move those cases into `tests/llm-protocol*.test.ts` or `tests/repo-search-agent-loop-adapter.test.ts` in the same change.

- [ ] **Step 8: Record changed files**

Changed files: `src/agent-loop/*`, `src/llm-protocol/*`, `src/repo-search/*`, `src/status-server/chat.ts`, `tests/repo-search-agent-loop-adapter.test.ts`, `tests/mock-repo-search-loop.test.ts`, `tests/repo-search-loop.core.test.ts`, `tests/repo-search-chat-loop.test.ts`, `tests/planner-streaming-timings.test.ts`, `tests/repo-search-planner-protocol.test.ts`, `tests/status-server-chat.test.ts`.

---

### Task 9: Migrate Summary Planner Onto `AgentLoop`

**Files:**

- Create: `src/summary/planner/agent-loop-adapter.ts`
- Modify: `src/summary/planner/mode.ts`
- Modify: `src/summary/planner/provider.ts`
- Modify: `src/summary/planner/prompts.ts`
- Modify: `src/summary/planner/tools.ts`
- Modify: `tests/summary-agent-loop-adapter.test.ts`
- Modify: existing summary planner tests that currently assert provider-loop behavior.

- [ ] **Step 1: Add failing summary adapter tests**

Create `tests/summary-agent-loop-adapter.test.ts`:

```ts
import test from 'node:test';
import assert from 'node:assert/strict';

import { SummaryPlannerActionAdapter } from '../src/summary/planner/agent-loop-adapter.js';

test('summary planner action adapter parses planner tool and finish actions', () => {
  const adapter = new SummaryPlannerActionAdapter(['find_text', 'read_lines', 'json_filter', 'json_get']);

  const tool = adapter.parseActions({
    text: '{"action":"tool","id":"call_1","tool_name":"find_text","args":{"query":"needle"}}',
    reasoningText: '',
    toolCalls: [],
    usage: { promptTokens: 1, completionTokens: 1, outputTokens: 1, thinkingTokens: 0, promptCacheTokens: null, promptEvalTokens: 1 },
    raw: {},
    stoppedEarly: false,
  });
  const finish = adapter.parseActions({
    text: '{"action":"finish","summary":"done"}',
    reasoningText: '',
    toolCalls: [],
    usage: { promptTokens: 1, completionTokens: 1, outputTokens: 1, thinkingTokens: 0, promptCacheTokens: null, promptEvalTokens: 1 },
    raw: {},
    stoppedEarly: false,
  });

  assert.equal(tool[0]?.toolName, 'find_text');
  assert.equal(finish[0]?.kind, 'finish');
});
```

- [ ] **Step 2: Run and verify failure**

Run:

```powershell
npm test -- tests/summary-agent-loop-adapter.test.ts
```

Expected: FAIL because the adapter does not exist.

- [ ] **Step 3: Implement summary adapter classes**

Create `src/summary/planner/agent-loop-adapter.ts` with explicit classes:

- `SummaryPlannerPromptAdapter`
- `SummaryPlannerActionAdapter`
- `SummaryPlannerToolAdapter`
- `SummaryPlannerObserver`
- `SummaryPlannerResultAssembler`

Move summary-specific behavior out of `mode.ts`:

- Prompt setup from `buildPlannerSystemPrompt` and `buildPlannerInitialUserPrompt`.
- Invalid-response prompts from `buildPlannerInvalidResponseUserPrompt`.
- Forced-finish prompts from `buildPlannerForcedFinishUserPrompt`.
- Tool definitions from `buildPlannerToolDefinitions`.
- Tool execution from `executePlannerTool`.
- Tool result formatting from `formatPlannerResult` and `formatPlannerToolResultHeader`.
- Read-line duplicate handling from current `lastSuccessfulReadLinesArgsText` logic.
- Artifact/debug recorder calls from `createPlannerDebugRecorder`.
- Token guard behavior from current summary planner truncation logic.

- [ ] **Step 4: Replace `invokePlannerMode` loop**

In `src/summary/planner/mode.ts`:

- Keep `invokePlannerMode(options)` as the public entrypoint.
- Resolve prompt budget, allowed tools, artifact recorder, and token options.
- Instantiate `LlamaCppClient` and `AgentLoop`.
- Use summary adapter classes to run the loop.
- Convert `AgentLoopResult` back to the existing summary planner result shape.
- Remove the local `while (toolResults.length <= MAX_PLANNER_TOOL_CALLS)` loop.

- [ ] **Step 5: Delete duplicate provider action invocation**

In `src/summary/planner/provider.ts`:

- Delete `invokePlannerProviderAction` after all imports are removed.
- Keep no replacement wrapper.
- If the file becomes empty, delete it and update imports.

- [ ] **Step 6: Run summary planner regressions**

Run:

```powershell
npm test -- tests/summary-agent-loop-adapter.test.ts tests/runtime-summarize.test.ts tests/runtime-status-server.test.ts tests/runtime-status-server.idle-summary.test.ts tests/summary-cli.test.ts tests/summary-logging.test.ts
```

Expected: PASS.

- [ ] **Step 7: Record changed files**

Changed files: `src/summary/*`, `tests/summary-agent-loop-adapter.test.ts`, `tests/runtime-summarize.test.ts`, `tests/runtime-status-server.test.ts`, `tests/runtime-status-server.idle-summary.test.ts`, `tests/summary-cli.test.ts`, `tests/summary-logging.test.ts`.

---

### Task 10: Remove Remaining Duplicate Protocol And Loop Code

**Files:**

- Modify: `src/repo-search/planner-protocol.ts`
- Modify: `src/providers/llama-cpp.ts`
- Modify: `src/summary/planner/mode.ts`
- Modify: `src/summary/planner/provider.ts`
- Modify: `src/lib/model-json.ts`
- Modify: `tests/agent-loop-boundary.test.ts`

- [ ] **Step 1: Run boundary guard before cleanup**

Run:

```powershell
npm test -- tests/agent-loop-boundary.test.ts
```

Expected: FAIL only for files still containing duplicate protocol or loop implementation.

- [ ] **Step 2: Delete remaining duplicate code**

Apply these removals:

- `src/providers/llama-cpp.ts`: remove any local request body construction, response usage parsing, retry loops, or endpoint string literals that now belong to `LlamaCppClient`.
- `src/repo-search/planner-protocol.ts`: remove all request, streaming, tool-call parsing, and provider response parsing functions.
- `src/benchmark-matrix/config-rpc.ts`: route model listing through `LlamaCppClient.listModels` or a server endpoint that uses it; leave no direct `/v1/models` request.
- `src/status-server/managed-llama.ts`: route healthcheck model-list probing through `LlamaCppClient.getStatus` or a dedicated readiness method; leave no direct `/v1/models` request.
- `src/status-server/routes/core.ts`: route model-list probing through `LlamaCppClient.listModels`; leave no direct `/v1/models` request.
- `src/status-server/routes/llama-passthrough.ts`: keep endpoint path constants allowlisted because this file is an HTTP proxy surface, not the internal llama.cpp protocol client.
- `src/summary/planner/mode.ts`: remove local invalid-response, forced-finish, duplicate-tool-call, and transcript-render loop code now owned by `AgentLoop`.
- `src/summary/planner/provider.ts`: delete the file if empty.
- `src/lib/model-json.ts`: keep JSON payload parsing only; remove any code that parses OpenAI-compatible `tool_calls`.
- `src/status-server/chat.ts`: remove `persisted_tool_call` and local replay tool-call construction.

- [ ] **Step 3: Tighten boundary assertions**

Update `tests/agent-loop-boundary.test.ts` so all guard tests expect no offenders outside:

- `src/llm-protocol/llama-cpp-client.ts` for llama.cpp endpoints.
- `src/status-server/routes/llama-passthrough.ts` for passthrough route constants only.
- `src/llm-protocol/tool-call-parser.ts` and `src/llm-protocol/streaming-response-assembler.ts` for tool-call delta parsing.
- `src/agent-loop/agent-loop.ts` for agent-loop turn orchestration.

- [ ] **Step 4: Run boundary guard**

Run:

```powershell
npm test -- tests/agent-loop-boundary.test.ts
```

Expected: PASS.

- [ ] **Step 5: Record changed files**

Changed files: `src/*`, `tests/agent-loop-boundary.test.ts`.

---

### Task 11: Full Verification And Coverage Closure

**Files:**

- Modify: `tsconfig.test.json` if new tests are not included.
- Modify: `package.json` only if a missing targeted script blocks verification.

- [ ] **Step 1: Run focused migrated suites**

Run:

```powershell
npm test -- tests/llm-protocol.test.ts tests/llm-protocol-streaming.test.ts tests/agent-loop.test.ts tests/repo-search-agent-loop-adapter.test.ts tests/summary-agent-loop-adapter.test.ts tests/mock-repo-search-loop.test.ts tests/repo-search-loop.core.test.ts tests/repo-search-chat-loop.test.ts tests/runtime-provider-llama.test.ts tests/runtime-summarize.test.ts
```

Expected: PASS.

- [ ] **Step 2: Run typecheck**

Run:

```powershell
npm run typecheck
```

Expected: PASS.

- [ ] **Step 3: Run full test suite**

Run:

```powershell
npm test
```

Expected: PASS.

- [ ] **Step 4: Run coverage check**

Run:

```powershell
npm run test:coverage
```

Expected: PASS with branch coverage at or above the current project threshold. If no threshold is enforced, inspect the text summary and add targeted tests for uncovered branches in `src/llm-protocol/*`, `src/agent-loop/*`, and both adapter files before finalizing.

- [ ] **Step 5: Verify F13 is no longer true**

Run:

```powershell
siftkit repo-search --prompt "Verify ARCHITECTURE-REVIEW.md F13 against current source. Return whether repo-search, summary planner, and llama.cpp protocol now share src/agent-loop and src/llm-protocol, and list any remaining duplicate agentic-loop or OpenAI-compatible protocol implementations with exact file:line anchors."
```

Expected: PASS verdict with no remaining duplicate loop/protocol implementations outside `src/agent-loop/*` and `src/llm-protocol/*`.

- [ ] **Step 6: Record final verification state**

Record the passing command output and leave all changes uncommitted for human review.

---

## Completion Criteria

- `src/llm-protocol/llama-cpp-client.ts` is the only file that constructs llama.cpp HTTP requests.
- `src/llm-protocol/tool-call-parser.ts` and `src/llm-protocol/streaming-response-assembler.ts` are the only files that parse OpenAI-compatible tool-call protocol details.
- `src/status-server/chat.ts` no longer emits `persisted_tool_call`; persisted replay uses shared protocol helpers and fails loud on unknown commands.
- `src/agent-loop/agent-loop.ts` is the only reusable turn-loop implementation.
- Repo-search/chat and summary planner use explicit adapter classes, not copied while loops.
- No legacy request wrappers remain for deleted planner-protocol or summary-provider paths.
- `npm run typecheck`, focused migrated tests, `npm test`, and `npm run test:coverage` pass.

## Self-Review

- Spec coverage: F13's duplicated protocol, streaming, parsing, retry, transcript, thinking, repetition, and loop behavior are covered by Tasks 2-10.
- Placeholder scan: no task depends on unresolved placeholders; implementation names, files, commands, and expected outcomes are explicit.
- Type consistency: all new surfaces use typed classes and explicit interfaces; no `any`, dynamic function passing, or legacy compatibility path is planned.
