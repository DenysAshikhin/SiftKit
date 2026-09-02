# No-Think Approval Verdict (exl3) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the LLM approval verdict skip reasoning entirely, without re-rendering the cached planner prompt, so an edit/write gate costs ~1–2 s instead of 25–65 s.

**Architecture:** The verdict request keeps the planner's `chat_template_kwargs` byte-for-byte (any change there rewrites the system prompt and re-prefills the whole context). Instead it sends a TabbyAPI `response_prefix` of `\n</think>\n\n`, which closes the empty think block the generation prompt already opened. The rendered tail is identical to `enable_thinking: false`; the head is untouched, so the prefix cache is preserved for the verdict *and* for the next planner turn. The verdict's output cap drops from the 4,096-token thinking allowance to the 512-token JSON allowance. This is exl3-only: llama-server has no `response_prefix`, and the client fails loudly if one is sent there. llama.cpp is being sunset; no parallel llama path is added.

**Tech Stack:** TypeScript (ESM, zod), node:test, TabbyAPI/exllamav3 (`response_prefix`), existing `LlamaCppClient` streaming path.

**Evidence this works (measured 2026-09-01 against the production preset at 32k):** verdict with the closed-tail prefix reused 25,856 of 26,591 prompt tokens, generated 56 tokens, finished in 1.6 s, and the following planner turn reused 25,856 of 26,006. `enable_thinking: false` by contrast reused 0 tokens on the verdict and 0 again on the next planner turn (two full re-prefills, ~14 s each). The no-think verdict still denied an injected `curl | sh` + `git push --force` payload on both attempts.

**Do not commit.** Per `AGENTS.md`, leave commits to the user. Preserve the unrelated uncommitted StreamStop changes already in the tree.

---

## File map

| File | Change | Responsibility |
|---|---|---|
| `src/llm-protocol/think-markers.ts` | add `CLOSED_EMPTY_THINK_TAIL` | single owner of think-tag strings |
| `src/llm-protocol/llama-cpp-client.ts` | `responsePrefix` chat option, exl3 guard, rename continuation type | HTTP request shape |
| `src/repo-search/planner-protocol.ts` | thread `responsePrefix`; verdict sends the tail, 512 cap | planner request contracts |
| `src/repo-search/engine/llm-approval-gate.ts` | carry the failure message into the `unsure` reason | loud verdict failures |
| `tests/helpers/fake-chat-server.ts` | new generic SSE stub | request-body assertions |
| `tests/llama-cpp-client-response-prefix.test.ts` | new | client-level prefix + backend guard |
| `tests/approval-verdict-response-prefix.test.ts` | new | planner plumbing + verdict body |
| `tests/llm-auto-approval.test.ts`, `tests/auto-approval-verdict-probe.test.ts` | update two reason assertions | |
| `tests/live-approval-verdict-no-think.test.ts` | new, env-gated | live cache-retention proof |
| `package.json` | add `test:live:approval-verdict-no-think` script | |

Running a single test file after building: `npm run build:test && node .\dist\test-runner\run-tests.js <file-name-substring>`.

---

### Task 1: `responsePrefix` on the chat client, exl3-only

**Files:**
- Modify: `src/llm-protocol/think-markers.ts:1-11`
- Modify: `src/llm-protocol/llama-cpp-client.ts:103-143` (options + continuation type), `:229-257` (`chat`, `chatAtBaseUrl`), `:347-383` (`streamChatAtBaseUrl` parameter and budget gate)
- Create: `tests/helpers/fake-chat-server.ts`
- Test: `tests/llama-cpp-client-response-prefix.test.ts`

- [ ] **Step 1: Create the fake SSE server helper**

`tests/helpers/fake-chat-server.ts`:

```ts
import http from 'node:http';
import { parseJsonValueText } from '../../src/lib/json.js';
import type { JsonObject } from '../../src/lib/json-types.js';
import { asObject } from './dashboard-http.js';

export type FakeChatServer = {
  baseUrl: string;
  requestCount: () => number;
  bodyAt: (index: number) => JsonObject;
  close: () => Promise<void>;
};

export type FakeChatServerOptions = {
  /** Streamed as `reasoning_content` deltas before the content, on every request. */
  reasoningDeltas?: string[];
  /** Streamed as the single content delta. */
  content: string;
};

/**
 * OpenAI-compatible SSE stub for request-body assertions: records every chat body, answers
 * token-count probes with a constant, then streams the configured reasoning and content.
 */
export function startFakeChatServer(options: FakeChatServerOptions): Promise<FakeChatServer> {
  return new Promise((resolve) => {
    const bodies: string[] = [];
    const server = http.createServer((req, res) => {
      let raw = '';
      req.on('data', (chunk) => { raw += chunk; });
      req.on('end', () => {
        if (req.url === '/v1/token/encode' || req.url === '/tokenize') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ length: 32 }));
          return;
        }
        bodies.push(raw);
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
        });
        const writeDelta = (delta: JsonObject, usage?: JsonObject): void => {
          res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta }], object: 'chat.completion.chunk', ...(usage ? { usage } : {}) })}\n\n`);
        };
        writeDelta({}, { prompt_tokens: 100, prompt_tokens_details: { cached_tokens: 90 } });
        for (const text of options.reasoningDeltas ?? []) {
          writeDelta({ reasoning_content: text });
        }
        writeDelta({ content: options.content });
        res.write('data: [DONE]\n\n');
        res.end();
      });
      res.on('error', () => {});
      req.on('error', () => {});
    });
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      resolve({
        baseUrl: `http://127.0.0.1:${port}`,
        requestCount: () => bodies.length,
        bodyAt: (index) => asObject(parseJsonValueText(bodies[index] ?? '{}')),
        close: () => new Promise<void>((done) => server.close(() => done())),
      });
    });
  });
}
```

- [ ] **Step 2: Write the failing client tests**

`tests/llama-cpp-client-response-prefix.test.ts`:

```ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { LlamaCppClient } from '../src/llm-protocol/llama-cpp-client.js';
import { CLOSED_EMPTY_THINK_TAIL } from '../src/llm-protocol/think-markers.js';
import type { SiftConfig } from '../src/config/types.js';
import { mockModelPreset, mockSiftConfig } from './helpers/mock-config.js';
import { startFakeChatServer } from './helpers/fake-chat-server.js';

const VERDICT = '{"verdict":"approve","reason":"ok"}';

// A tiny ReasoningBudget: any streamed reasoning would trip the budget gate unless a
// response prefix disables it.
function presetConfig(backend: 'exl3' | 'llama', baseUrl: string): SiftConfig {
  const preset = mockModelPreset({
    id: 'prefix-test',
    label: 'prefix test',
    Backend: backend,
    Reasoning: 'on',
    ReasoningBudget: 8,
    ReasoningBudgetMessage: 'Answer now.',
    BaseUrl: baseUrl,
  });
  return mockSiftConfig({
    Server: { ModelPresets: { Presets: [preset], ActivePresetId: 'prefix-test' } },
  });
}

function chatOptions(config: SiftConfig, baseUrl: string) {
  return {
    config,
    baseUrl,
    model: 'mock',
    messages: [{ role: 'user' as const, content: 'hi' }],
    tools: [],
    maxTokens: 64,
    allowedToolNames: [],
    retry: false as const,
    responsePrefix: CLOSED_EMPTY_THINK_TAIL,
  };
}

test('CLOSED_EMPTY_THINK_TAIL closes the think block the generation prompt opened', () => {
  assert.equal(CLOSED_EMPTY_THINK_TAIL, '\n</think>\n\n');
});

test('exl3 chat sends responsePrefix as response_prefix and disables the thinking-budget gate', async () => {
  const fake = await startFakeChatServer({
    content: VERDICT,
    // 10 x 8 chars = 80 chars, well past an 8-token budget under the 2.5 chars/token estimate.
    reasoningDeltas: Array.from({ length: 10 }, (_, index) => `r${String(index).padStart(2, '0')}`.padEnd(8, '.')),
  });
  try {
    const response = await new LlamaCppClient().chat(chatOptions(presetConfig('exl3', fake.baseUrl), fake.baseUrl));
    assert.equal(fake.requestCount(), 1);
    const body = fake.bodyAt(0);
    assert.equal(body.response_prefix, CLOSED_EMPTY_THINK_TAIL);
    // The prompt-rendering flags are untouched: thinking stays on at the template level.
    assert.equal(asRecord(body.chat_template_kwargs).enable_thinking, true);
    assert.equal(response.text, VERDICT);
    assert.equal(response.thinkingBudgetExhausted, undefined);
  } finally {
    await fake.close();
  }
});

test('a responsePrefix on the llama backend fails before any request is sent', async () => {
  const fake = await startFakeChatServer({ content: VERDICT });
  try {
    await assert.rejects(
      new LlamaCppClient().chat(chatOptions(presetConfig('llama', fake.baseUrl), fake.baseUrl)),
      /responsePrefix requires the exl3 backend/u,
    );
    assert.equal(fake.requestCount(), 0);
  } finally {
    await fake.close();
  }
});

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`expected an object, received ${JSON.stringify(value)}`);
  }
  return Object.fromEntries(Object.entries(value));
}
```

- [ ] **Step 3: Run the new test file and confirm it fails**

Run: `npm run build:test && node .\dist\test-runner\run-tests.js llama-cpp-client-response-prefix`
Expected: FAIL. `CLOSED_EMPTY_THINK_TAIL` is not exported; the exl3 test sees 2 requests (budget continuation) and no `response_prefix`; the llama test resolves instead of rejecting.

- [ ] **Step 4: Add the tail constant**

Append to `src/llm-protocol/think-markers.ts` after `buildClosedThinkBlock`:

```ts
/**
 * Closes the empty think block the generation prompt opens (`<think>\n`). Sent as a TabbyAPI
 * `response_prefix`, it renders the same tail `enable_thinking: false` would, without touching
 * the system prompt that flag also rewrites — so the cached prompt prefix stays byte-identical.
 */
export const CLOSED_EMPTY_THINK_TAIL = `\n${THINK_CLOSE_TAG}\n\n`;
```

- [ ] **Step 5: Add the chat option and rename the continuation type**

In `src/llm-protocol/llama-cpp-client.ts`, add to `LlamaCppChatOptions` after `continuationMinTokens`:

```ts
  /**
   * Rendered after the generation prompt (TabbyAPI `response_prefix`). exl3 only: llama-server
   * has no such field. Its presence disables the thinking-budget gate — a caller-closed think
   * block cannot be continued.
   */
  responsePrefix?: string;
```

Replace the `ThinkingBudgetContinuation` type (and its doc comment) with:

```ts
/**
 * A request whose generation prompt is extended by a rendered prefix (TabbyAPI
 * `response_prefix`): the closed think block of a thinking-budget continuation, or a
 * caller-supplied prefix. Its presence disables the budget gate, so a prefixed request never
 * recurses into a continuation.
 */
type ResponsePrefixRequest = {
  responsePrefix: string;
};
```

Rename every remaining `ThinkingBudgetContinuation` reference to `ResponsePrefixRequest` (the `streamChatAtBaseUrl` parameter type) and rename that parameter from `continuation` to `prefixed` at its three use sites in `streamChatAtBaseUrl`: the parameter, `this.buildChatRequest(options, prefixed?.responsePrefix)`, and the budget gate `const thinkingBudgetTokens = prefixed === undefined && ...`.

- [ ] **Step 6: Guard the backend and forward the prefix**

Replace `chat`:

```ts
  async chat(options: LlamaCppChatOptions): Promise<NormalizedLlamaCppChatResponse> {
    const baseUrl = options.baseUrl || getConfiguredLlamaBaseUrl(options.config);
    const backend = getActiveInferenceBackend(options.config);
    if (backend !== 'exl3') {
      if (options.responsePrefix !== undefined) {
        throw new Error(
          'responsePrefix requires the exl3 backend: llama-server has no response_prefix, so the prefix would be silently dropped.',
        );
      }
      return this.chatAtBaseUrl(baseUrl, options);
    }
    await exl3RequestGate.acquire();
    try {
      return await this.chatAtBaseUrl(baseUrl, options);
    } finally {
      exl3RequestGate.release();
    }
  }
```

In `chatAtBaseUrl`, replace the first line of `attempt`:

```ts
    const attempt = async (): Promise<NormalizedLlamaCppChatResponse> => {
      const streamed = await this.streamChatAtBaseUrl(
        baseUrl,
        options,
        options.responsePrefix === undefined ? undefined : { responsePrefix: options.responsePrefix },
      );
      if (streamed.stop.earlyStopReason !== THINKING_BUDGET_EARLY_STOP_REASON) {
        return streamed;
      }
      return this.continueAfterThinkingBudget(baseUrl, options, streamed);
    };
```

`continueAfterThinkingBudget` is unchanged: it can only be reached when no prefix was set, because the prefix disables the budget early-stop.

- [ ] **Step 7: Run the new tests and the existing budget tests**

Run: `npm run build:test && node .\dist\test-runner\run-tests.js llama-cpp-client-response-prefix && node .\dist\test-runner\run-tests.js llama-cpp-client-thinking-budget`
Expected: both PASS. The budget file still asserts `!('response_prefix' in fake.bodyAt(0))` for un-prefixed requests and a `<think>`-prefixed continuation on request 2.

---

### Task 2: Thread `responsePrefix` through the planner request layer

**Files:**
- Modify: `src/repo-search/planner-protocol.ts:291-317` (`PlannerRequestBase`), `:480-505` (the `LlamaCppClient().chat({...})` call inside `requestRepoSearchPlannerProtocolAction`)
- Test: `tests/approval-verdict-response-prefix.test.ts` (created here, extended in Task 3)

- [ ] **Step 1: Write the failing plumbing test**

`tests/approval-verdict-response-prefix.test.ts`:

```ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { requestRepoSearchPlannerProtocolAction } from '../src/repo-search/planner-protocol.js';
import { CLOSED_EMPTY_THINK_TAIL } from '../src/llm-protocol/think-markers.js';
import type { SiftConfig } from '../src/config/types.js';
import { mockModelPreset, mockSiftConfig } from './helpers/mock-config.js';
import { startFakeChatServer } from './helpers/fake-chat-server.js';

const FINISH = '{"action":"finish","output":"done"}';

// Preset values are the sole source of the request's chat_template_kwargs, so the fixture pins
// them to make the rendered-flag assertions exact.
function exl3Config(baseUrl: string): SiftConfig {
  const preset = mockModelPreset({
    id: 'verdict-prefix-test',
    label: 'verdict prefix test',
    Backend: 'exl3',
    Reasoning: 'on',
    ReasoningContent: true,
    PreserveThinking: true,
    ReasoningEffort: 'low',
    BaseUrl: baseUrl,
  });
  return mockSiftConfig({
    Server: { ModelPresets: { Presets: [preset], ActivePresetId: 'verdict-prefix-test' } },
  });
}

function plannerOptions(config: SiftConfig, baseUrl: string) {
  return {
    config,
    baseUrl,
    model: 'mock',
    messages: [{ role: 'user' as const, content: 'hi' }],
    timeoutMs: 5000,
    maxTokens: 64,
    thinkingEnabled: true,
    reasoningContentEnabled: false,
    preserveThinking: false,
    stage: 'planner_action' as const,
    tools: [],
    responseSchema: null,
  };
}

test('a planner request without responsePrefix sends no response_prefix', async () => {
  const fake = await startFakeChatServer({ content: FINISH });
  try {
    await requestRepoSearchPlannerProtocolAction(plannerOptions(exl3Config(fake.baseUrl), fake.baseUrl));
    assert.ok(!('response_prefix' in fake.bodyAt(0)));
  } finally {
    await fake.close();
  }
});

test('requestRepoSearchPlannerProtocolAction forwards responsePrefix to the request body', async () => {
  const fake = await startFakeChatServer({ content: FINISH });
  try {
    await requestRepoSearchPlannerProtocolAction({
      ...plannerOptions(exl3Config(fake.baseUrl), fake.baseUrl),
      responsePrefix: CLOSED_EMPTY_THINK_TAIL,
    });
    assert.equal(fake.bodyAt(0).response_prefix, CLOSED_EMPTY_THINK_TAIL);
  } finally {
    await fake.close();
  }
});
```

- [ ] **Step 2: Run and confirm the second test fails**

Run: `npm run build:test && node .\dist\test-runner\run-tests.js approval-verdict-response-prefix`
Expected: first test PASS, second FAIL (TypeScript excess-property error on `responsePrefix`, or body lacks `response_prefix`).

- [ ] **Step 3: Add the option and forward it**

In `PlannerRequestBase` (after `continuationMinTokens?: number;`):

```ts
  /** Rendered after the generation prompt (TabbyAPI `response_prefix`); exl3 only. */
  responsePrefix?: string;
```

In the `new LlamaCppClient().chat({ ... })` call inside `requestRepoSearchPlannerProtocolAction`, add after `continuationMinTokens: options.continuationMinTokens,`:

```ts
        ...(options.responsePrefix === undefined ? {} : { responsePrefix: options.responsePrefix }),
```

- [ ] **Step 4: Run the test file**

Run: `npm run build:test && node .\dist\test-runner\run-tests.js approval-verdict-response-prefix`
Expected: both PASS.

---

### Task 3: The verdict closes the think block and drops to the 512 cap

**Files:**
- Modify: `src/repo-search/planner-protocol.ts:588-597` (comment + constants), `:618-670` (`requestApprovalVerdict`), and the existing `think-markers.js` import near the top of the file
- Test: `tests/approval-verdict-response-prefix.test.ts` (append)
- Regression: `tests/approval-verdict-request.test.ts` must keep passing unchanged

- [ ] **Step 1: Append the failing verdict tests**

Replace the `requestRepoSearchPlannerProtocolAction` import line in `tests/approval-verdict-response-prefix.test.ts` with:

```ts
import {
  captureExecutingPlannerRequest,
  requestApprovalVerdict,
  requestRepoSearchPlannerProtocolAction,
  resolveRepoSearchPlannerToolDefinitions,
  serializeProtocolMessages,
  type ChatMessage,
  type PlannerThinkingFlags,
} from '../src/repo-search/planner-protocol.js';
import { toProtocolTools } from '../src/providers/llama-cpp.js';
```

Add next to `FINISH`:

```ts
const VERDICT = '{"verdict":"approve","reason":"ok"}';
```

Then append to the file:

```ts
const transcript: ChatMessage[] = [
  { role: 'system', content: 'sys' },
  { role: 'user', content: 'task' },
];

const THINKING_ON = {
  thinkingEnabled: true,
  reasoningContentEnabled: true,
  preserveThinking: true,
} satisfies PlannerThinkingFlags;

const THINKING_OFF = {
  thinkingEnabled: false,
  reasoningContentEnabled: false,
  preserveThinking: false,
} satisfies PlannerThinkingFlags;

function executing(flags: PlannerThinkingFlags) {
  return captureExecutingPlannerRequest(
    serializeProtocolMessages(transcript, flags.reasoningContentEnabled),
    flags,
    toProtocolTools(resolveRepoSearchPlannerToolDefinitions()),
    2,
  );
}

function verdictOptions(config: SiftConfig, baseUrl: string, flags: PlannerThinkingFlags) {
  return {
    config,
    baseUrl,
    model: 'mock',
    transcriptMessages: transcript,
    pendingMessages: [],
    question: 'approve?',
    executing: executing(flags),
    timeoutMs: 5000,
  };
}

test('a verdict under a thinking planner closes the think block by prefix, keeps the planner flags, and caps at 512', async () => {
  const fake = await startFakeChatServer({ content: VERDICT });
  try {
    const response = await requestApprovalVerdict(verdictOptions(exl3Config(fake.baseUrl), fake.baseUrl, THINKING_ON));
    const body = fake.bodyAt(0);
    assert.equal(body.response_prefix, CLOSED_EMPTY_THINK_TAIL);
    assert.equal(body.max_tokens, 512);
    // Byte-identical template kwargs to the planner request: this is what keeps the prefix cached.
    assert.deepEqual(body.chat_template_kwargs, {
      enable_thinking: true,
      preserve_thinking: true,
      reasoning_effort: 'low',
    });
    assert.equal(body.tool_choice, 'none');
    assert.equal(response.text, VERDICT);
    assert.equal(response.thinkingText, '');
  } finally {
    await fake.close();
  }
});

test('a verdict under a non-thinking planner sends no response prefix', async () => {
  const fake = await startFakeChatServer({ content: VERDICT });
  try {
    await requestApprovalVerdict(verdictOptions(exl3Config(fake.baseUrl), fake.baseUrl, THINKING_OFF));
    const body = fake.bodyAt(0);
    // The template already rendered `<think>\n\n</think>\n\n`; a second close would corrupt the tail.
    assert.ok(!('response_prefix' in body));
    assert.equal(body.max_tokens, 512);
    assert.deepEqual(body.chat_template_kwargs, { enable_thinking: false });
  } finally {
    await fake.close();
  }
});
```

- [ ] **Step 2: Run and confirm the two new tests fail**

Run: `npm run build:test && node .\dist\test-runner\run-tests.js approval-verdict-response-prefix`
Expected: the thinking-on test FAILS (`response_prefix` missing, `max_tokens` is 4096); the thinking-off test FAILS only on `max_tokens` (512 expected, 512 received is fine — if it passes already, that is acceptable).

- [ ] **Step 3: Replace the verdict constants and comment**

In `src/repo-search/planner-protocol.ts`, replace lines `588-597` (the block ending in the two constants) with:

```ts
 * An approval verdict may only be requested as an extension of this prompt —
 * anything else re-prefills the whole context and breaks the prompt cache.
 */
/**
 * The verdict is a two-field JSON object and never thinks: under a thinking planner the
 * request closes the think block with `CLOSED_EMPTY_THINK_TAIL`, so this is the whole allowance.
 */
const APPROVAL_VERDICT_MAX_TOKENS = 512;
```

`APPROVAL_VERDICT_THINKING_MAX_TOKENS` is deleted; there must be no remaining reference (`rg APPROVAL_VERDICT_THINKING_MAX_TOKENS` returns nothing).

- [ ] **Step 4: Send the tail from `requestApprovalVerdict`**

Add `CLOSED_EMPTY_THINK_TAIL` to the existing `../llm-protocol/think-markers.js` import at the top of `planner-protocol.ts`.

Inside `requestApprovalVerdict`, replace the `maxTokens:` entry and the flag-spread comment block with:

```ts
    maxTokens: clampToPresetMaxTokens(options.config, APPROVAL_VERDICT_MAX_TOKENS),
    // The thinking flags mirror the executing planner request: they feed the server-side
    // chat_template_kwargs, and any difference re-renders (and so re-prefills) the shared
    // prompt prefix. Thinking is switched off at the tail instead: the response prefix closes
    // the empty think block the generation prompt opened, which is the exact tail
    // `enable_thinking: false` would render. A non-thinking planner already rendered that
    // closed block, so it gets no prefix.
    ...options.executing.flags,
    ...(options.executing.flags.thinkingEnabled ? { responsePrefix: CLOSED_EMPTY_THINK_TAIL } : {}),
```

Everything else in the call (`mockResponses`, `cachePrefix`, `stage: 'approval_verdict'`, `responseSchema`, `tools`, `toolChoice: 'none'`) stays as is.

- [ ] **Step 5: Run the verdict tests, the existing verdict request tests, and the probe tests**

Run: `npm run build:test && node .\dist\test-runner\run-tests.js approval-verdict-response-prefix && node .\dist\test-runner\run-tests.js approval-verdict-request && node .\dist\test-runner\run-tests.js auto-approval-verdict-probe`
Expected: all PASS. The mock-mode tests never reach the client, so they are unaffected by the prefix. `ConfiguredApprovalVerdictModelClient` (the probe) goes through `requestApprovalVerdict` and inherits the behaviour with no change.

---

### Task 4: Verdict failures carry their cause

Without this, the exl3-only guard from Task 1 would surface on a llama backend only as the bare `unsure: verdict call failed` line.

**Files:**
- Modify: `src/repo-search/engine/llm-approval-gate.ts:84-103`
- Modify: `tests/llm-auto-approval.test.ts:298`, `tests/auto-approval-verdict-probe.test.ts:305`
- Test: `tests/llm-auto-approval.test.ts` (append)

- [ ] **Step 1: Update the two existing assertions and add the new test**

`tests/llm-auto-approval.test.ts:298` becomes:

```ts
    assert.match(auto[0].reason, /^verdict call failed: /u);
```

`tests/auto-approval-verdict-probe.test.ts:305` becomes:

```ts
  assert.match(result.reason, /^verdict call failed: /u);
```

Append to `tests/llm-auto-approval.test.ts` (it already imports `LlmApprovalGate`, `ApprovalGateHarness`, `UnansweringWriter`, `buildApprovalTimeoutMessage`, and `ESCALATION_DECISION_TIMEOUT_MS`):

```ts
test('a verdict request that throws reports its message, whitespace-collapsed, in the unsure reason', async () => {
  const writer = new UnansweringWriter();
  const harness = new ApprovalGateHarness(writer, false, ESCALATION_DECISION_TIMEOUT_MS);
  const gate = new LlmApprovalGate({
    requestId: 'run-1',
    humanGate: harness.gate,
    verdictRequester: {
      requestApprovalVerdict: () => Promise.reject(
        new Error('responsePrefix requires the exl3 backend:\n  llama-server has no response_prefix'),
      ),
    },
    progressWriter: writer,
    logger: null,
  });

  const decision = await gate.request({
    turn: 1,
    toolName: 'edit',
    command: 'edit path="a.ts" edits=1 sha="0000000000"',
    reviewPayload: null,
    pendingMessages: [],
  });

  assert.equal(decision.kind, 'abort');
  const auto = writer.events.find((event) => event.kind === 'approval_auto');
  assert.ok(auto !== undefined && auto.kind === 'approval_auto');
  assert.equal(
    auto.reason,
    'verdict call failed: responsePrefix requires the exl3 backend: llama-server has no response_prefix',
  );
});
```

- [ ] **Step 2: Run and confirm failures**

Run: `npm run build:test && node .\dist\test-runner\run-tests.js llm-auto-approval && node .\dist\test-runner\run-tests.js auto-approval-verdict-probe`
Expected: the three touched tests FAIL with reason `verdict call failed` (no suffix).

- [ ] **Step 3: Carry the failure message**

Replace `requestVerdictWithRetry` in `src/repo-search/engine/llm-approval-gate.ts`:

```ts
  private async requestVerdictWithRetry(
    question: string,
    pendingMessages: ChatMessage[],
  ): Promise<ApprovalVerdictAttempt> {
    let lastFailure = 'no attempt made';
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const response = await this.deps.verdictRequester.requestApprovalVerdict(question, pendingMessages);
        if (response.toolCalls.length > 0) {
          return { kind: 'failure', reason: FORBIDDEN_TOOL_CALL_REASON };
        }
        return {
          kind: 'verdict',
          value: ApprovalVerdictSchema.parse(parseJsonValueText(String(response.text || ''))),
        };
      } catch (error) {
        // Inference failure or schema mismatch: retry once, then escalate to the human gate
        // with the cause collapsed onto one line so the progress log says why.
        const message = error instanceof Error ? error.message : String(error);
        lastFailure = message.replace(/\s+/gu, ' ').trim().slice(0, 200);
      }
    }
    return { kind: 'failure', reason: `verdict call failed: ${lastFailure}` };
  }
```

- [ ] **Step 4: Run the two files again**

Run: `npm run build:test && node .\dist\test-runner\run-tests.js llm-auto-approval && node .\dist\test-runner\run-tests.js auto-approval-verdict-probe`
Expected: PASS.

---

### Task 5: Live proof of cache retention (env-gated)

Mirrors the manual measurement. Skipped unless `SIFTKIT_TEST_LIVE_APPROVAL_VERDICT_NO_THINK=1` and the active preset is exl3 with reasoning on.

**Files:**
- Create: `tests/live-approval-verdict-no-think.test.ts`
- Modify: `package.json` scripts (next to `test:live:approval-cache-chain`)

- [ ] **Step 1: Write the live test**

`tests/live-approval-verdict-no-think.test.ts`:

```ts
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import { getActiveModelPreset, getConfiguredLlamaBaseUrl, loadConfig } from '../src/config/index.js';
import { parseJsonValueText } from '../src/lib/json.js';
import { ApprovalVerdictSchema } from '../src/repo-search/approval-verdict.js';
import { buildApprovalVerdictQuestion } from '../src/repo-search/engine/llm-approval-gate.js';
import { allocateLlamaCppSlotId, resolvePlannerThinkingFlags } from '../src/repo-search/engine/task-loop-support.js';
import {
  captureExecutingPlannerRequest,
  requestApprovalVerdict,
  requestRepoSearchPlannerProtocolAction,
  resolveRepoSearchPlannerToolDefinitions,
  serializeProtocolMessages,
  type ChatMessage,
  type PlannerActionResponse,
} from '../src/repo-search/planner-protocol.js';
import { INTERACTIVE_REPO_TOOL_NAMES } from '../src/planner-protocol/repo-search.js';
import { toProtocolTools } from '../src/providers/llama-cpp.js';

const ENABLED = process.env.SIFTKIT_TEST_LIVE_APPROVAL_VERDICT_NO_THINK === '1';
const CONTEXT_LINE_COUNT = 1_200;
const CACHE_RETENTION_FRACTION = 0.9;
const LIVE_REQUEST_TIMEOUT_MS = 300_000;
const LIVE_TEST_TIMEOUT_MS = 600_000;

function requireConfiguredString(value: string | null | undefined, message: string): string {
  if (!value) throw new Error(message);
  return value;
}

function retention(response: PlannerActionResponse, label: string): number {
  const cached = response.promptCacheTokens;
  const evaluated = response.promptEvalTokens;
  if (cached === null || cached === undefined || evaluated === null || evaluated === undefined) {
    throw new Error(`${label}: provider reported no prompt cache usage`);
  }
  return cached / (cached + evaluated);
}

test('a no-think verdict keeps the planner prefix cached for itself and for the next planner turn', {
  timeout: LIVE_TEST_TIMEOUT_MS,
  skip: ENABLED ? false : 'set SIFTKIT_TEST_LIVE_APPROVAL_VERDICT_NO_THINK=1 and use an existing local exl3 server',
}, async () => {
  const config = await loadConfig({ ensure: true });
  const preset = getActiveModelPreset(config);
  assert.equal(preset.Backend, 'exl3', `active preset ${preset.id} must be exl3`);
  const thinking = resolvePlannerThinkingFlags(config);
  assert.equal(thinking.thinkingEnabled, true, `active preset ${preset.id} must have Reasoning on`);
  const model = requireConfiguredString(preset.Model, `active preset ${preset.id} has no configured model`);
  const baseUrl = requireConfiguredString(getConfiguredLlamaBaseUrl(config), `active preset ${preset.id} has no configured base URL`);
  const tools = toProtocolTools(resolveRepoSearchPlannerToolDefinitions(INTERACTIVE_REPO_TOOL_NAMES, preset.VisionEnabled === true));
  const slotId = allocateLlamaCppSlotId(config);

  const transcript: ChatMessage[] = [
    { role: 'system', content: `No-think verdict run ${randomUUID()}. Keep this context; answer only what is asked.` },
    {
      role: 'user',
      content: Array.from({ length: CONTEXT_LINE_COUNT }, (_, index) => `Context line ${index}: parser cache approval schema tool replay deterministic evidence.`).join('\n'),
    },
    { role: 'user', content: 'Reply with the single word ok. Do not call tools.' },
  ];

  const plannerMessages = serializeProtocolMessages(transcript, thinking.reasoningContentEnabled);
  const executing = captureExecutingPlannerRequest(plannerMessages, thinking, tools, slotId);
  await requestRepoSearchPlannerProtocolAction({
    config, baseUrl, model, messages: plannerMessages, slotId,
    timeoutMs: LIVE_REQUEST_TIMEOUT_MS, maxTokens: 1, ...thinking,
    stage: 'planner_action', tools, responseSchema: null,
  });

  const verdict = await requestApprovalVerdict({
    config, baseUrl, model,
    transcriptMessages: transcript,
    pendingMessages: [],
    question: buildApprovalVerdictQuestion({
      toolName: 'edit',
      command: 'edit path="src/probe.ts" edits=1 sha="0000000000"',
      reviewPayload: null,
    }),
    executing,
    timeoutMs: LIVE_REQUEST_TIMEOUT_MS,
  });
  assert.equal(verdict.thinkingText, '', 'the verdict must not think');
  assert.equal(verdict.toolCalls.length, 0);
  ApprovalVerdictSchema.parse(parseJsonValueText(verdict.text));
  assert.ok(retention(verdict, 'verdict') >= CACHE_RETENTION_FRACTION, `verdict retention ${retention(verdict, 'verdict')}`);

  const next = await requestRepoSearchPlannerProtocolAction({
    config, baseUrl, model,
    messages: serializeProtocolMessages([...transcript, { role: 'user', content: 'Reply with the single word ok again.' }], thinking.reasoningContentEnabled),
    slotId, timeoutMs: LIVE_REQUEST_TIMEOUT_MS, maxTokens: 1, ...thinking,
    stage: 'planner_action', tools, responseSchema: null,
  });
  assert.ok(retention(next, 'next planner turn') >= CACHE_RETENTION_FRACTION, `next-turn retention ${retention(next, 'next planner turn')}`);
});
```

- [ ] **Step 2: Add the npm script**

In `package.json` scripts, after `test:live:approval-cache-chain`:

```json
    "test:live:approval-verdict-no-think": "npm run build:test && powershell -Command \"$env:SIFTKIT_TEST_LIVE_APPROVAL_VERDICT_NO_THINK='1'; if (-not $env:SIFTKIT_STATUS_BACKEND_URL) { $env:SIFTKIT_STATUS_BACKEND_URL='http://127.0.0.1:4765/status' }; if (-not $env:SIFTKIT_CONFIG_SERVICE_URL) { $env:SIFTKIT_CONFIG_SERVICE_URL='http://127.0.0.1:4765/config' }; node .\\dist\\test-runner\\run-tests.js live-approval-verdict-no-think\"",
```

- [ ] **Step 3: Run it skipped, then live**

Run: `npm run build:test && node .\dist\test-runner\run-tests.js live-approval-verdict-no-think`
Expected: 1 skipped.

With the SiftKit status server and the exl3 model up: `npm run test:live:approval-verdict-no-think`
Expected: PASS. Verdict retention and next-turn retention both ≥ 0.9; the TabbyAPI log's `Metrics` line for the verdict shows cached tokens within one 256-token page of the planner prefix and a two-digit `tokens generated`.

If the status server is not running, the test fails on `loadConfig`; that is an environment error, not a code error.

---

### Task 6: Final validation

**Files:** none new.

- [ ] **Step 1: Confirm no stale references**

Run: `rg "APPROVAL_VERDICT_THINKING_MAX_TOKENS|ThinkingBudgetContinuation" src tests`
Expected: no matches.

- [ ] **Step 2: Typecheck and lint**

Run: `npm run typecheck`
Expected: exit 0 (this script already runs `npm run lint` at the end).

- [ ] **Step 3: Full suite**

Run: `npm run build:test && npm run test`
Expected: all PASS, live tests skipped. Route the output through `siftkit summary --question "Return pass/fail, failing tests, root errors, and relevant file:line anchors."` if the runner is available; otherwise grep for `not ok`.

- [ ] **Step 4: Report**

State: files changed, test results, the live-test result if it was run, and that nothing was committed.

---

## Acceptance criteria

1. An approval verdict under a thinking exl3 planner sends `response_prefix: "\n</think>\n\n"`, `max_tokens: 512`, and `chat_template_kwargs` identical to the planner request.
2. An approval verdict under a non-thinking planner sends no `response_prefix`.
3. Sending a `responsePrefix` on the llama backend throws before any HTTP request, and the gate reports `verdict call failed: <message, whitespace-collapsed, ≤200 chars>`.
4. The thinking-budget continuation path is unchanged for un-prefixed requests.
5. Live: verdict and next-planner prompt-cache retention ≥ 90 %, verdict `thinkingText` empty, valid JSON.

## Risks and notes

- **Existing continuation prefix includes an opening tag.** `buildClosedThinkBlock` renders `<think>\n…\n</think>\n\n`, and TabbyAPI appends it after a generation prompt that already ends in `<think>\n`. That means budget continuations currently send a doubled `<think>`. Out of scope here; the verdict deliberately uses only the closing half.
- **Verdict quality without reasoning.** Measured on one benign and one malicious payload only. If the live reviewer starts returning `unsure` on routine edits, the fallback is the human gate, not a silent approve.
- **Template coupling.** The tail string assumes the Qwen-style template that opens `<think>\n` in the generation prompt. A preset with a different template needs its own tail; `think-markers.ts` is the single place to change.
