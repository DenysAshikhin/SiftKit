# Wire-Faithful Prompt Token Accounting Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the `prompt=<N>tok` figure on repo-search progress and server-log lines describe the prompt the model actually receives, by counting a ChatML-shaped rendering of the real wire payload instead of transcript prose plus a JSON request-envelope reserve.

**Architecture:** A new pure function `renderWirePrompt` renders the wire-serialized messages plus tool schemas into ChatML text. `preflightPlannerPromptBudget` renders and counts that text itself, replacing the two-pass `transcript + providerPromptReserveText` computation with one count. The `reported`/`budgeted` split (`TurnPromptTokens`) collapses to a single `promptTokenCount: number`. No display site changes — they read the value off the progress event.

**Tech Stack:** TypeScript, `node:test` via the repo's test runner (`npm run build:test`, `npm test`), exl3/TabbyAPI `POST /v1/token/encode` tokenization.

**Design doc:** `docs/superpowers/specs/2026-09-01-wire-faithful-prompt-token-accounting-design.md`

---

## Background the engineer needs

Today two figures exist:

- `transcriptPromptTokenCount` — tokens of `renderTaskTranscript` output (`[role]`-header prose). This is what gets **displayed**.
- `promptTokenCount` — the above plus `providerPromptReserveTokenCount`, the tokens of `buildPlannerRequestPromptReserveText` output. This is what **budget decisions** use.

Both are wrong in opposite directions:

- The displayed figure **excludes tool schemas**, which the model does receive.
- The budgeted figure **includes JSON request keys** like `"stream":true`, `"temperature"`, `"stream_options"` — request-envelope fields that never enter the model's context. `tests/repo-search-request-normalizers.test.ts:77-78` asserts exactly this over-count today.
- Neither counts the text the server actually templates: the transcript renderer emits `tool_call_id=call_1` and `[reasoning]\n…`, while the wire carries `"tool_call_id": "call_1"` and a `reasoning_content` field.

exl3 tokenization is `POST /v1/token/encode` with `{ text }` — raw text only. There is no apply-template endpoint, so the chat template is modelled as ChatML markers rather than measured.

**Non-goal:** provider `usage.prompt_tokens` must never feed these figures. `docs/superpowers/plans/2026-08-17-token-reporting-and-exl3-thinking-budget.md` records a user-approved decision against it (exllamav3 1.3.0 inflates prompt counts on requeued jobs).

## File structure

**Create:**
- `src/repo-search/wire-prompt.ts` — `renderWirePrompt` and its helpers. New file rather than growing `planner-protocol.ts` (already ~870 lines). Depends on `planner-protocol.ts` for `serializeProtocolMessages`; nothing in `planner-protocol.ts` imports it, so no cycle.
- `tests/wire-prompt.test.ts` — unit tests for the renderer.

**Modify:**
- `src/repo-search/prompt-budget.ts` — `PreflightResult`, `preflightPlannerPromptBudget` signature and body.
- `src/repo-search/engine/prompt-preparer.ts` — one counter, no reserve, updated logs.
- `src/repo-search/engine/transcript-compactor.ts:152,161-168` — preflight call site.
- `src/repo-search/engine/terminal-synthesizer.ts:47,59-66` — preflight call site.
- `src/repo-search/planner-protocol.ts` — delete `buildPlannerRequestPromptReserveText`, `PlannerPromptReserveOptions`, and the module-level `reserveRequestBuilder`.
- `src/agent-loop/types.ts:65-84` — delete `TurnPromptTokens`, change `AgentLoopPreparedTurn`.
- `src/repo-search/engine/task-loop.ts` — 7 `.reported` reads, 1 shape construction.
- `src/repo-search/engine/tool-action-processor.ts` — 4 `.reported` reads, 1 `.budgeted` read, 5 signatures.
- `src/summary/planner/mode.ts:369,392,400,407,417` — 5 shape constructions.

**Modify (tests):**
- `tests/wire-prompt.test.ts` (new), `tests/repo-search-prompt-accounting.test.ts`, `tests/engine-prompt-preparer.test.ts`, `tests/incremental-token-counter.test.ts`, `tests/repo-search-request-normalizers.test.ts`, `tests/mock-repo-search-loop.test.ts`, `tests/live-repo-agent-compaction-replay.test.ts`, `tests/token-count-source.test.ts`, `tests/agent-loop.test.ts`, `tests/engine-tool-action-processor.test.ts`.

## How to run tests in this repo

There is no plain `node --test` script. The runner wraps it:

```bash
npm run build:test
npm test -- tests/wire-prompt.test.ts
```

`npm test` with no argument runs every top-level `tests/*.test.ts`. A stale build throws `No compiled test artifact matches … Run npm run build:test.` — always `build:test` first.

Gates: `npm run typecheck` and `npm run lint`.

---

### Task 1: `renderWirePrompt`

Pure, additive, no consumers yet. The tree stays green throughout.

**Files:**
- Create: `src/repo-search/wire-prompt.ts`
- Test: `tests/wire-prompt.test.ts`

- [ ] **Step 1: Confirm the import surface**

Open `src/repo-search/planner-protocol.ts` around line 410 and confirm `serializeProtocolMessages` is exported:

```ts
export function serializeProtocolMessages(messages: ChatMessage[], reasoningContentEnabled: boolean) {
  return toProtocolChatMessages(messages.map((message) => serializePlannerMessage(message, reasoningContentEnabled)));
}
```

If it is not exported, add `export`. Note the exact exported names of `ChatMessage` and `LlamaCppToolDefinition` and where they come from (`src/llm-protocol/types.ts`) — Step 3 imports them.

- [ ] **Step 2: Write the failing tests**

Create `tests/wire-prompt.test.ts`:

```ts
import assert from 'node:assert/strict';
import test from 'node:test';

import { renderWirePrompt, WIRE_GENERATION_PROMPT } from '../src/repo-search/wire-prompt.js';

test('renders each message as a ChatML block and appends the generation prompt', () => {
  const rendered = renderWirePrompt({
    messages: [
      { role: 'system', content: 'SYS' },
      { role: 'user', content: 'HELLO' },
    ],
    tools: [],
    responseFormat: null,
    includeReasoningContent: false,
  });

  assert.equal(
    rendered,
    '<|im_start|>system\nSYS<|im_end|>\n'
    + '<|im_start|>user\nHELLO<|im_end|>\n'
    + WIRE_GENERATION_PROMPT,
  );
});

test('places tool schemas in the leading block', () => {
  const tools = [{ type: 'function', function: { name: 'grep', description: 'search', parameters: { type: 'object' } } }];
  const rendered = renderWirePrompt({
    messages: [{ role: 'system', content: 'SYS' }, { role: 'user', content: 'HI' }],
    tools,
    responseFormat: null,
    includeReasoningContent: false,
  });

  assert.ok(rendered.startsWith('<|im_start|>system\nSYS\n' + JSON.stringify(tools) + '<|im_end|>\n'));
  assert.ok(rendered.includes('"grep"'));
});

test('emits a standalone leading block when tools exist but messages do not', () => {
  const tools = [{ type: 'function', function: { name: 'grep', description: 'search', parameters: { type: 'object' } } }];
  const rendered = renderWirePrompt({ messages: [], tools, responseFormat: null, includeReasoningContent: false });

  assert.equal(rendered, '<|im_start|>system\n' + JSON.stringify(tools) + '<|im_end|>\n' + WIRE_GENERATION_PROMPT);
});

test('renders tool_calls in wire shape, not transcript shape', () => {
  const rendered = renderWirePrompt({
    messages: [
      {
        role: 'assistant',
        content: null,
        tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'grep', arguments: '{"q":"x"}' } }],
      },
      { role: 'tool', content: 'RESULT', tool_call_id: 'call_1' },
    ],
    tools: [],
    responseFormat: null,
    includeReasoningContent: false,
  });

  assert.ok(rendered.includes('"tool_call_id":"call_1"'));
  assert.ok(!rendered.includes('tool_call_id=call_1'));
  assert.ok(rendered.includes('"name":"grep"'));
});

test('includes reasoning_content only when enabled, and never as a [reasoning] section', () => {
  const messages = [{ role: 'assistant', content: 'ANSWER', reasoning_content: 'THINKING' }];

  const on = renderWirePrompt({ messages, tools: [], responseFormat: null, includeReasoningContent: true });
  const off = renderWirePrompt({ messages, tools: [], responseFormat: null, includeReasoningContent: false });

  assert.ok(on.includes('THINKING'));
  assert.ok(!on.includes('[reasoning]'));
  assert.ok(!off.includes('THINKING'));
});

test('drops image parts and concatenates text parts', () => {
  const rendered = renderWirePrompt({
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: 'ALPHA' },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
        { type: 'text', text: 'BETA' },
      ],
    }],
    tools: [],
    responseFormat: null,
    includeReasoningContent: false,
  });

  assert.equal(rendered, '<|im_start|>user\nALPHABETA<|im_end|>\n' + WIRE_GENERATION_PROMPT);
});

test('appending a message keeps the previous rendering as a prefix', () => {
  const base = [{ role: 'system', content: 'SYS' }, { role: 'user', content: 'ONE' }];
  const grown = [...base, { role: 'assistant', content: 'TWO' }];
  const options = { tools: [], responseFormat: null, includeReasoningContent: false };

  const first = renderWirePrompt({ messages: base, ...options });
  const second = renderWirePrompt({ messages: grown, ...options });

  assert.ok(second.startsWith(first.slice(0, first.length - WIRE_GENERATION_PROMPT.length)));
});
```

The last test is load-bearing: `IncrementalTokenCounter` only deltas when the new text starts with the old text (`src/repo-search/incremental-token-counter.ts:43`). A prefix break costs a full re-tokenize.

- [ ] **Step 3: Run the tests to verify they fail**

```bash
npm run build:test && npm test -- tests/wire-prompt.test.ts
```

Expected: FAIL — `Cannot find module '../src/repo-search/wire-prompt.js'`.

- [ ] **Step 4: Implement**

Create `src/repo-search/wire-prompt.ts`:

```ts
import type { ChatMessage, LlamaCppContentPart, LlamaCppToolDefinition } from '../llm-protocol/types.js';
import { serializeProtocolMessages } from './planner-protocol.js';

/** ChatML tail that opens the assistant turn the model is asked to complete. */
export const WIRE_GENERATION_PROMPT = '<|im_start|>assistant\n';

export type WirePromptInput = {
  messages: readonly ChatMessage[];
  tools: readonly LlamaCppToolDefinition[];
  /** Serialized alongside the tools when the request constrains the response shape. */
  responseFormat: unknown;
  includeReasoningContent: boolean;
};

function renderContent(content: string | LlamaCppContentPart[] | null | undefined): string {
  if (typeof content === 'string') {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .filter((part) => part.type === 'text')
      .map((part) => part.text ?? '')
      .join('');
  }
  return '';
}

function renderLeadingExtras(input: WirePromptInput): string {
  const sections: string[] = [];
  if (input.tools.length > 0) {
    sections.push(JSON.stringify(input.tools));
  }
  if (input.responseFormat !== null && input.responseFormat !== undefined) {
    sections.push(JSON.stringify(input.responseFormat));
  }
  return sections.join('\n');
}

/**
 * Renders the prompt the model receives: wire-serialized messages plus tool schemas,
 * wrapped in ChatML markers. Image parts are excluded here and accounted for by the
 * caller's per-image token allowance.
 */
export function renderWirePrompt(input: WirePromptInput): string {
  const protocolMessages = serializeProtocolMessages([...input.messages], input.includeReasoningContent);
  const leadingExtras = renderLeadingExtras(input);

  if (protocolMessages.length === 0) {
    const leadingBlock = leadingExtras ? `<|im_start|>system\n${leadingExtras}<|im_end|>\n` : '';
    return leadingBlock + WIRE_GENERATION_PROMPT;
  }

  const blocks = protocolMessages.map((message, index) => {
    const sections: string[] = [];
    if (typeof message.reasoning_content === 'string' && message.reasoning_content) {
      sections.push(message.reasoning_content);
    }
    const contentText = renderContent(message.content);
    if (contentText) {
      sections.push(contentText);
    }
    if (index === 0 && leadingExtras) {
      sections.push(leadingExtras);
    }
    if (message.tool_calls !== undefined) {
      sections.push(JSON.stringify({ tool_calls: message.tool_calls }));
    }
    if (message.tool_call_id !== undefined) {
      sections.push(JSON.stringify({ tool_call_id: message.tool_call_id }));
    }
    return `<|im_start|>${message.role}\n${sections.join('\n')}<|im_end|>\n`;
  });

  return blocks.join('') + WIRE_GENERATION_PROMPT;
}
```

- [ ] **Step 5: Run the tests to verify they pass**

```bash
npm run build:test && npm test -- tests/wire-prompt.test.ts
```

Expected: PASS. If the tool-schema placement test fails on separator placement, adjust the expected strings in the test to match the implementation — the exact separator is a modelling choice, but tool JSON must be inside the first block.

- [ ] **Step 6: Gates**

```bash
npm run typecheck && npm run lint
```

Expected: clean.

- [ ] **Step 7: Commit**

```bash
git add src/repo-search/wire-prompt.ts tests/wire-prompt.test.ts
git commit -m "feat(repo-search): add renderWirePrompt for wire-faithful prompt text"
```

---

### Task 2: Collapse `preflightPlannerPromptBudget` onto the wire prompt

Atomic: the signature change, all four call sites, and the deletion of the reserve builders land together. No shim, no parallel path.

**Files:**
- Modify: `src/repo-search/prompt-budget.ts:73-192`
- Modify: `src/repo-search/engine/prompt-preparer.ts:38-41,79-92,124-315`
- Modify: `src/repo-search/engine/transcript-compactor.ts:152,161-168`
- Modify: `src/repo-search/engine/terminal-synthesizer.ts:47,59-66`
- Modify: `src/repo-search/planner-protocol.ts:264,276-324`
- Test: `tests/incremental-token-counter.test.ts`, `tests/mock-repo-search-loop.test.ts`, `tests/repo-search-prompt-accounting.test.ts`, `tests/engine-prompt-preparer.test.ts`, `tests/repo-search-request-normalizers.test.ts`, `tests/token-count-source.test.ts`, `tests/live-repo-agent-compaction-replay.test.ts`

- [ ] **Step 1: Write the failing preflight tests**

In `tests/incremental-token-counter.test.ts`, replace the test `preflight with counters tokenizes only the appended tail across turns` (currently at `:140`, asserting `transcriptPromptTokenCount` at `:156`/`:168` and `providerPromptReserveTokenCount` at `:157`/`:169`) with:

```ts
const GREP_TOOL = {
  type: 'function',
  function: { name: 'grep', description: 'search the repository', parameters: { type: 'object' } },
};

const PREFLIGHT_BUDGET = { totalContextTokens: 9_000, responseReserveTokens: 1_000 };

test('preflight counts tool schemas as part of the prompt', async () => {
  const seen: string[] = [];
  await withTestEnvAndServer({ tokenizeTokenCount: trackingTokenizer(seen) }, async (stub) => {
    const config = activateEngine(asRuntimeSiftConfig(stub.state.config), 'exl3');
    const messages = [{ role: 'user', content: 'turn one' }];

    const withoutTools = await preflightPlannerPromptBudget({
      config,
      messages,
      includeReasoningContent: false,
      tools: [],
      responseFormat: null,
      ...PREFLIGHT_BUDGET,
      promptTokenCounter: new IncrementalTokenCounter(),
    });

    const withTools = await preflightPlannerPromptBudget({
      config,
      messages,
      includeReasoningContent: false,
      tools: [GREP_TOOL],
      responseFormat: null,
      ...PREFLIGHT_BUDGET,
      promptTokenCounter: new IncrementalTokenCounter(),
    });

    assert.ok(
      withTools.promptTokenCount > withoutTools.promptTokenCount,
      `tool schemas must raise the counted prompt: ${withTools.promptTokenCount} vs ${withoutTools.promptTokenCount}`,
    );
    assert.equal(withTools.promptChars > withoutTools.promptChars, true);
  });
});

test('preflight tokenizes only the appended tail across turns', async () => {
  const seen: string[] = [];
  await withTestEnvAndServer({ tokenizeTokenCount: trackingTokenizer(seen) }, async (stub) => {
    const config = activateEngine(asRuntimeSiftConfig(stub.state.config), 'exl3');
    const counter = new IncrementalTokenCounter();

    const first = await preflightPlannerPromptBudget({
      config,
      messages: [{ role: 'user', content: 'turn one' }],
      includeReasoningContent: false,
      tools: [],
      responseFormat: null,
      ...PREFLIGHT_BUDGET,
      promptTokenCounter: counter,
    });

    const second = await preflightPlannerPromptBudget({
      config,
      messages: [{ role: 'user', content: 'turn one' }, { role: 'assistant', content: 'turn two' }],
      includeReasoningContent: false,
      tools: [],
      responseFormat: null,
      ...PREFLIGHT_BUDGET,
      promptTokenCounter: counter,
    });

    assert.ok(second.promptTokenCount > first.promptTokenCount);
    assert.equal(seen.length, 2, 'the second turn must tokenize a tail, not the whole prompt');
    assert.ok(seen[1].length < seen[0].length, 'the second tokenize call must be the shorter tail');
  });
});
```

Both tests use the harness already in this file: `withTestEnvAndServer` (`tests/_test-helpers.ts:494`), its `tokenizeTokenCount` stub option (`tests/_test-helpers.ts:239`), the local `trackingTokenizer(seen)` helper (`tests/incremental-token-counter.test.ts:26`, returns `content.length` and records each call), and `activateEngine` / `asRuntimeSiftConfig` (`tests/helpers/mock-config.ts:44`). Do not introduce a new harness.

The tail assertion holds because `renderWirePrompt` appends `WIRE_GENERATION_PROMPT` as a constant suffix: turn two's text is turn one's text with the suffix replaced by the new block plus the suffix, so the delta is the changed tail, not the whole prompt. If the prefix check in `src/repo-search/incremental-token-counter.ts:43` fails, `seen[1]` will be the full second prompt and this assertion catches it.

Delete the now-meaningless `providerPromptReserveText: 'reserve'` options at `:150` and `:162`.

- [ ] **Step 2: Run to verify failure**

```bash
npm run build:test && npm test -- tests/incremental-token-counter.test.ts
```

Expected: FAIL — `preflightPlannerPromptBudget` does not accept `tools`/`responseFormat`/`promptTokenCounter`, and `PreflightResult` has no `promptChars`.

- [ ] **Step 3: Rewrite `prompt-budget.ts`**

Replace `PreflightResult` (currently `:91-106`) with:

```ts
export type PreflightResult = {
  ok: boolean;
  /** Tokens the rendered wire prompt occupies, including tool schemas and the image allowance. */
  promptTokenCount: number;
  /** Character length of the rendered wire prompt, for progress reporting. */
  promptChars: number;
  maxPromptBudget: number;
  overflowTokens: number;
  tokenCountSource: TokenCountSource;
  tokenizationAttempted: boolean;
  tokenizeElapsedMs: number | null;
  tokenizeRetryCount: number | null;
  tokenizeTimeoutMs: number;
  tokenizeRetryMaxWaitMs: number;
  tokenizeStatus: string | null;
  tokenizeErrorMessage: string | null;
};
```

Replace the signature (currently `:108-121`) with:

```ts
export async function preflightPlannerPromptBudget(options: {
  config?: SiftConfig;
  messages: readonly ChatMessage[];
  includeReasoningContent: boolean;
  tools: readonly LlamaCppToolDefinition[];
  responseFormat: unknown;
  totalContextTokens: number;
  responseReserveTokens: number;
  promptTokenCounter?: PromptTokenCounter;
}): Promise<PreflightResult> {
```

Body changes:

1. Import `renderWirePrompt` from `./wire-prompt.js`.
2. Render once at the top of the body:
   ```ts
   const promptText = renderWirePrompt({
     messages: options.messages,
     tools: options.tools,
     responseFormat: options.responseFormat,
     includeReasoningContent: options.includeReasoningContent,
   });
   ```
   Delete the existing `prompt`/`messages` union handling and any internal `renderTaskTranscript` call.
3. Replace the two counters (`:139-140`) with one:
   ```ts
   const promptCounter = options.promptTokenCounter ?? oneShotTokenCounter;
   ```
   Keep `oneShotTokenCounter` (`:81-85`) unchanged.
4. Delete `providerPromptReserveText`, `reserveTokenCount`, `reserveLlamaTokenCount`, and `providerPromptReserveTokenCount` (`:144-148`).
5. Keep the image allowance (`:134-137`) exactly as-is.
6. Replace the count and sums:
   ```ts
   let tokenCount = await promptCounter.count(options.config, promptText);
   const provisionalPromptTokenCount = tokenCount.tokenCount + imageTokenCount;
   ```
   Keep the existing near-budget `forceExact` recount logic that reads `provisionalPromptTokenCount`; it now compares the single figure against the budget.
   ```ts
   const promptTokenCount = tokenCount.tokenCount + imageTokenCount;
   ```
   Delete `transcriptPromptTokenCount` entirely.
7. Simplify the tokenize telemetry in the return literal — there is only one `llamaTokenCount` now, so drop the `Math.max`/sum pairing with the reserve:
   ```ts
   tokenCountSource: tokenCount.source,
   tokenizationAttempted: llamaTokenCount !== null,
   tokenizeElapsedMs: llamaTokenCount?.elapsedMs ?? null,
   tokenizeRetryCount: llamaTokenCount?.retryCount ?? null,
   tokenizeTimeoutMs: llamaTokenCount?.timeoutMs ?? DEFAULT_LLAMA_CPP_TOKENIZE_TIMEOUT_MS,
   tokenizeRetryMaxWaitMs: llamaTokenCount?.retryMaxWaitMs ?? DEFAULT_LLAMA_CPP_TOKENIZE_RETRY_MAX_WAIT_MS,
   tokenizeStatus: llamaTokenCount?.status ?? null,
   tokenizeErrorMessage: llamaTokenCount?.errorMessage ?? null,
   ```
8. Return `promptChars: promptText.length` alongside `promptTokenCount`.

- [ ] **Step 4: Delete the reserve builders**

In `src/repo-search/planner-protocol.ts`, delete:
- `buildPlannerRequestPromptReserveText` (`:293-324`)
- `PlannerPromptReserveOptions` (`:276-282`)
- the module-level `reserveRequestBuilder` (`:264`), and its `InferenceRequestBuilder` import if now unused.

Keep `buildPlannerResponseFormat` (`:284-291`) — Task 2 Step 5 uses it.

In `src/repo-search/engine/prompt-preparer.ts`, delete the private `buildProviderPromptReserveText` (`:82-92`) and its two call sites (`:135`, `:248`), plus the `providerPromptReserveChars` span field (`:142`).

- [ ] **Step 5: Migrate the four preflight call sites**

`src/repo-search/engine/prompt-preparer.ts` — replace the two `preflightPlannerPromptBudget` calls (`:154-162` and `:256-264`) with the messages form. The preparer currently renders the prompt itself at `:139` (`transcript.render(...)`); delete that and pass messages:

```ts
const preflight = await preflightPlannerPromptBudget({
  config: this.options.config,
  messages: transcript.messages,
  includeReasoningContent: reasoningContentEnabled,
  tools: this.options.plannerTools,
  responseFormat: null,
  totalContextTokens: budget.totalContextTokens,
  responseReserveTokens: budget.responseReserveTokens,
  promptTokenCounter: this.promptTokenCounter,
});
```

`responseFormat: null` preserves today's behavior exactly — `buildProviderPromptReserveText` passed `responseSchema: null` at `:83`. Counting the real response schema is deliberately out of scope for this plan; see "Known residual gap" below.

If `TranscriptManager` does not expose `messages` publicly (it is built at `src/repo-search/engine/transcript-manager.ts:40-44`), add a readonly accessor next to the existing `messageRoles()` (`:56`) and `render()` (`:60-62`).

`src/repo-search/engine/transcript-compactor.ts` — delete the `buildPlannerRequestPromptReserveText` call at `:152` and its import at `:3`; pass its inputs straight through:

```ts
const preflight = await preflightPlannerPromptBudget({
  config: this.tokenCountConfig,
  messages: summaryRequestMessages,
  includeReasoningContent,
  tools: state.tools,
  responseFormat: null,
  totalContextTokens,
  responseReserveTokens: 0,
});
```

`src/repo-search/engine/terminal-synthesizer.ts` — same shape; delete the call at `:47` and the import at `:6`:

```ts
const preflight = await preflightPlannerPromptBudget({
  config: this.options.config,
  messages: terminalMessages,
  includeReasoningContent,
  tools: input.executing.tools,
  responseFormat: null,
  totalContextTokens,
  responseReserveTokens: 0,
});
```

- [ ] **Step 6: Update the preparer's counters, logs, and progress calls**

`src/repo-search/engine/prompt-preparer.ts`:

1. Replace the two counter fields (`:79-80`) with one:
   ```ts
   private readonly promptTokenCounter = new IncrementalTokenCounter();
   ```
2. Delete the `toTokenizeDoneInfo` override (`:38-41`). It exists only to substitute `transcriptPromptTokenCount`; with one figure it becomes the identity:
   ```ts
   // before
   return { ...preflight, promptTokenCount: preflight.transcriptPromptTokenCount };
   ```
   Replace every `toTokenizeDoneInfo(preflight)` call with `preflight` and delete the function.
3. `:168` — `progress.preflightDone(turn, prompt.length, preflight.transcriptPromptTokenCount)` becomes:
   ```ts
   progress.preflightDone(turn, preflight.promptChars, preflight.promptTokenCount);
   ```
4. Delete the `transcriptPromptTokenCount` and `providerPromptReserveTokenCount` fields from all four log records: `turn_preflight_overflow_fail` (`:112-113`), `turn_preflight_budget` (`:186-187`), `turn_preflight_forced_answer` (`:207-208`), `turn_preflight_compaction_applied` (`:284-286`). Each already logs `promptTokenCount`; keep it.
5. Delete `beforeProviderPromptReserveTokenCount` (`:247`, `:285`). Keep `beforePromptTokenCount`/`afterPromptTokenCount`.
6. `:305-314` — the return literal becomes:
   ```ts
   return {
     kind: 'ready',
     promptTokenCount: preflight.promptTokenCount,
     maxOutputTokens,
     compactionSummary,
     nextMockResponseIndex,
   };
   ```
   and `PreparedTurnBudget`'s `ready` variant (`:43-58`) swaps `promptTokens: TurnPromptTokens` for `promptTokenCount: number`. Task 3 fixes the resulting consumer errors; typecheck will be red until then, which is expected and is why Steps 7-9 defer gating.

- [ ] **Step 7: Update the remaining affected tests**

`tests/repo-search-request-normalizers.test.ts` — **delete** the two tests `the planner prompt reserve reflects the preset reasoning effort` (`:42`) and `the planner prompt reserve carries the streaming envelope of the real request` (`:64`), and the `buildPlannerRequestPromptReserveText` import at `:5`. They assert the contents of a deleted function, and their subject (`"stream":true`, `"stream_options"`) is request-envelope JSON that never enters the model context. This is deletion of tests for removed behavior, not weakening of valid tests. The four `normalizeRepoSearchMockCommandResults` tests in that file are untouched.

`tests/repo-search-prompt-accounting.test.ts` — rewrite the test `reported prompt tokens are the transcript count, excluding the provider reserve` (`:99`). Replace `:103-109` with:

```ts
assert.equal(budgetEvents.length, 1, 'the run must take exactly one turn for this sum to be exact');
assert.equal(run.promptTokens, Number(budget.promptTokenCount));
assert.notEqual(run.promptTokens, SERVER_REPORTED_PROMPT_TOKENS);
```

Rename the test to `reported prompt tokens are the full wire prompt count`. Delete the `reserveTokenCount` binding at `:105` and the guard at `:106`. Keep the drift test at `:89` unchanged.

`tests/mock-repo-search-loop.test.ts`:
- Rewrite `preflightPlannerPromptBudget reserves provider prompt overhead against context budget` (`:768`) as `preflightPlannerPromptBudget counts tool schemas against context budget`: build `withoutTools` and `withTools` variants differing only in the `tools` array, and assert `withTools.promptTokenCount > withoutTools.promptTokenCount` and `withTools.ok === false` / `withoutTools.ok === true`. Delete `:791` (`providerPromptReserveTokenCount > 0`).
- `:870-874` — delete the `providerPromptReserveTokenCount` assertion and replace the sum identity with `assert.equal(Number(budgetEvent?.promptTokenCount) > 0, true);`. Keep `:875` (`maxOutputTokens > 0`).
- `:919-920` — delete both `beforeProviderPromptReserveTokenCount`/`providerPromptReserveTokenCount` assertions. Keep `:921-924` (the after < before comparison), which is the assertion that actually matters.
- Update the `preflightPlannerPromptBudget` option literals at `:752`, `:769-777`, `:778-787` to the new signature (`messages`, `includeReasoningContent`, `tools`, `responseFormat`).

`tests/token-count-source.test.ts:77-83` — replace `providerPromptReserveText: 'reserve text the tokenizer refuses'` with a `tools` array; the test's subject is the `source: 'estimate'` fallback, which is unchanged.

`tests/live-repo-agent-compaction-replay.test.ts:236-250` — delete the `buildPlannerRequestPromptReserveText` call and its import at `:21`; pass `tools: plannerTools`, `responseFormat: null`, `messages`, `includeReasoningContent`.

`tests/engine-prompt-preparer.test.ts`:
- `:210-211` — delete both assertions (`transcriptPromptTokenCount`, `providerPromptReserveTokenCount`). Keep `:209` and `:212-216`.
- Rewrite `prepareTurn reports the transcript prompt size, not the request-envelope reserve` (`:350`) as `prepareTurn reports the full wire prompt size`. Replace `:373-379` with:
  ```ts
  assert.equal(prepared.promptTokenCount, Number(budgetEvent.promptTokenCount));
  ```
- `:133` — `assert.ok(prepared.promptTokens.reported > 0)` becomes `assert.ok(prepared.promptTokenCount > 0)`.
- `:330` — `counted.promptTokens.reported`/`uncounted.promptTokens.reported` become `.promptTokenCount`. The assertion still holds: `reasoning_content` is in the wire rendering when enabled.
- `:155-156` — leave unchanged. These assert `transcript.render(false)` for the compaction marker, which is transcript display, not counting.

- [ ] **Step 8: Do not gate yet**

`npm run typecheck` will report errors in `task-loop.ts`, `tool-action-processor.ts`, `summary/planner/mode.ts`, `agent-loop/types.ts`, and their tests. That is expected — Task 3 resolves them. Do not add temporary shims to make this step green.

- [ ] **Step 9: Commit**

```bash
git add src/repo-search/prompt-budget.ts src/repo-search/planner-protocol.ts src/repo-search/engine tests/
git commit -m "refactor(repo-search): count the wire prompt in preflight and delete the request-envelope reserve"
```

---

### Task 3: Collapse `TurnPromptTokens` to a single `promptTokenCount`

**Files:**
- Modify: `src/agent-loop/types.ts:65-84`
- Modify: `src/repo-search/engine/task-loop.ts:459,494,496,501,517,519,525,553,609,672,676`
- Modify: `src/repo-search/engine/tool-action-processor.ts:202,300,811,821,912,940,996,1045,1056,1082`
- Modify: `src/summary/planner/mode.ts:369,392,400,407,417`
- Test: `tests/agent-loop.test.ts`, `tests/engine-tool-action-processor.test.ts`

- [ ] **Step 1: Write the failing test**

In `tests/agent-loop.test.ts`, change the stub adapter at `:100` from `promptTokens: { reported: turnNumber, budgeted: turnNumber }` to:

```ts
promptTokenCount: turnNumber,
```

and `:225` from `promptTokens: { reported: 0, budgeted: 0 }` to:

```ts
promptTokenCount: 0,
```

- [ ] **Step 2: Run to verify failure**

```bash
npm run build:test && npm test -- tests/agent-loop.test.ts
```

Expected: FAIL — `AgentLoopPreparedTurn` still requires `promptTokens`.

- [ ] **Step 3: Delete the type**

In `src/agent-loop/types.ts`, delete `TurnPromptTokens` (`:65-74`) entirely, and in `AgentLoopPreparedTurn` (`:76-84`) replace `promptTokens: TurnPromptTokens;` (`:79`) with:

```ts
/** Tokens the rendered wire prompt occupies. Reported, displayed, persisted, and budgeted against. */
promptTokenCount: number;
```

Update `AgentLoopPromptAdapter.prepareTurn`'s return type reference (`:114`) if it names `TurnPromptTokens` directly.

- [ ] **Step 4: Update `task-loop.ts`**

Replace every `prepared.promptTokens.reported` with `prepared.promptTokenCount` at `:494`, `:496`, `:517`, `:519`, `:525`, `:553`, and `:676`.

`:459` — the overflow path currently builds the pair from one value:
```ts
promptTokens: { reported: overflow.promptTokenCount, budgeted: overflow.promptTokenCount },
```
becomes:
```ts
promptTokenCount: overflow.promptTokenCount,
```

`:501` — `promptTokens: prepared.promptTokens,` becomes `promptTokenCount: prepared.promptTokenCount,`.

`:609` — `context.preparedTurn.promptTokens,` becomes `context.preparedTurn.promptTokenCount,`.

`:672` — the inline param type `prepared: { promptTokens: TurnPromptTokens; maxOutputTokens: number }` becomes `prepared: { promptTokenCount: number; maxOutputTokens: number }`.

- [ ] **Step 5: Update `tool-action-processor.ts`**

Change the threaded parameter from `promptTokens: TurnPromptTokens` to `promptTokenCount: number` in all five signatures: `executeBatch` (`:202`), `processToolAction` (`:300`), `executeAcceptedTool` (`:811`), `fitToolResult` (`:912`), `recordToolOutcome` (`:996`).

Replace the reads:
- `:821` — `promptTokens.reported` becomes `promptTokenCount`.
- `:1045`, `:1056`, `:1082` — `promptTokenCount: promptTokens.reported,` becomes `promptTokenCount,`.
- `:940` — the single `.budgeted` read:
  ```ts
  // The wire prompt is what occupies the request, so what still fits is measured against it.
  const remainingTokenAllowance = this.deps.budget.remainingToolAllowance(promptTokenCount, state.acceptedToolPromptTokensThisTurn);
  ```
  Replace the existing comment about the reserve occupying request space — it no longer describes the code.

- [ ] **Step 6: Update `summary/planner/mode.ts`**

`:369` — `promptTokens: { reported: 0, budgeted: 0 },` becomes `promptTokenCount: 0,`.

`:392`, `:400`, `:407`, `:417` — `promptTokens: { reported: this.promptTokenCount, budgeted: this.promptTokenCount },` becomes `promptTokenCount: this.promptTokenCount,`.

- [ ] **Step 7: Update `tests/engine-tool-action-processor.test.ts`**

Every `{ reported: 0, budgeted: 0 }` literal passed as the `promptTokens` argument to `executeBatch` becomes the number `0`. There are roughly 40, including lines 67, 85, 106, 125, 153, 174, 192, 216, 234, 250, 271, 292, 304, 318, 319, 334, 359, 378, 413, 432, 433, 434, 466, 467, 495, 496, 497, 498 and more. Use a repo-wide search to catch them all:

```bash
grep -rn "reported:" tests/ src/
```

Expected after the edit: no matches for `reported:` or `budgeted:` anywhere in `src/` or `tests/`. Any remaining match is a missed migration — fix it rather than leaving it.

- [ ] **Step 8: Run the full gates**

```bash
npm run typecheck && npm run lint
```

Expected: clean. A `TurnPromptTokens` "cannot find name" error means a call site was missed.

```bash
npm run build:test && npm test
```

Expected: PASS. Route the output through summary if it is large:

```bash
npm test 2>&1 | siftkit summary --question "Return pass/fail, failing test names, root errors, and relevant file:line anchors."
```

- [ ] **Step 9: Commit**

```bash
git add src/agent-loop/types.ts src/repo-search/engine src/summary/planner/mode.ts tests/
git commit -m "refactor(agent-loop): collapse TurnPromptTokens into a single promptTokenCount"
```

---

### Task 4: End-to-end regression test for the reported figure

Proves the actual bug is fixed at the level the user observes: the number on the log line.

**Files:**
- Test: `tests/repo-search-prompt-accounting.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `tests/repo-search-prompt-accounting.test.ts`, reusing the existing `runOneTurnAgainstServer` harness (`:30`) whose `/tokenize` route answers `count: Math.max(1, Math.ceil(String(parsed.content || '').length / 4))` (`:39`):

```ts
test('adding a planner tool raises the reported prompt token count', async () => {
  const withoutTools = await runOneTurnAgainstServer({ plannerTools: [] });
  const withTools = await runOneTurnAgainstServer({
    plannerTools: [{
      type: 'function',
      function: {
        name: 'grep',
        description: 'search the repository',
        parameters: { type: 'object', properties: { pattern: { type: 'string' } } },
      },
    }],
  });

  assert.ok(
    withTools.promptTokens > withoutTools.promptTokens,
    `tool schemas must be counted: ${withTools.promptTokens} vs ${withoutTools.promptTokens}`,
  );
});
```

Add a `plannerTools` option to `runOneTurnAgainstServer` if it does not already accept one, defaulting to the value it uses today so the existing two tests are unaffected.

- [ ] **Step 2: Run to verify it fails on the pre-change code**

This test passes on the Task 3 tree. To confirm it is a real regression test, stash the source changes and verify it fails against the original behavior:

```bash
git stash push src/
npm run build:test && npm test -- tests/repo-search-prompt-accounting.test.ts
```

Expected: FAIL — the reported count is identical with and without tools, which is the bug.

```bash
git stash pop
```

- [ ] **Step 3: Run to verify it passes**

```bash
npm run build:test && npm test -- tests/repo-search-prompt-accounting.test.ts
```

Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add tests/repo-search-prompt-accounting.test.ts
git commit -m "test(repo-search): assert tool schemas raise the reported prompt token count"
```

---

## Final verification

- [ ] `npm run typecheck` — clean.
- [ ] `npm run lint` — clean.
- [ ] `npm run build:test && npm test` — full suite green.
- [ ] `grep -rn "providerPromptReserve\|transcriptPromptTokenCount\|TurnPromptTokens\|buildPlannerRequestPromptReserveText" src/ tests/` returns **zero** matches. Any match is a missed migration.
- [ ] Live check against a running exl3 preset: run a `siftkit repo-search` question and confirm the `prompt=<N>tok` figure on the console progress line is materially larger than before (the planner tool schemas are several thousand tokens) and that it tracks transcript growth across turns.

## Known residual gap

`responseFormat: null` is passed at all four preflight call sites, matching today's behavior (`buildProviderPromptReserveText` passed `responseSchema: null`). When a planner turn constrains the response with a JSON schema, that schema reaches the model but is still not counted. `renderWirePrompt` accepts and renders `responseFormat`, so closing this is a one-line change per call site once the real response format is threaded to the preparer — deliberately out of scope here.

Template scaffolding remains modelled as ChatML markers rather than measured, because TabbyAPI exposes no apply-template endpoint. Models whose `chat_template.jinja` is not ChatML-shaped will carry a small constant error.
