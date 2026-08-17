# Token-Reporting Drift Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the seven drift findings left by the token-reporting/thinking-budget session: dead provider token fields, a budget-gate reasoning mismatch, leaked internal options, hardcoded think markers, duplicated estimators, lossy continuation usage merge, and the summary surface still trusting provider usage.

**Architecture:** All changes complete the "local counting is the single source of truth for generated/input tokens; provider supplies only cache/prefill/timing stats" decision already shipped. Every task is a complete replacement — no shims, no dual paths. Tests are node:test files driven by fake HTTP/SSE servers (existing harness patterns in `tests/llama-cpp-client-thinking-budget.test.ts` and `tests/planner-streaming-timings.test.ts`).

**Tech Stack:** TypeScript strict (no casts/`any`/`!`), zod-derived IO types, node:test.

**Task order matters:** Task 2 edits the budget gate that Task 3 restructures; Task 5 renames the estimator call that Tasks 2–3 leave in place; write them in the order below.

---

## Facts the tasks rely on (verified via repo-search)

- `PlannerActionResponse.promptTokens/completionTokens/usageThinkingTokens` (`src/repo-search/planner-protocol.ts:33-35`, written at `:706-708`) have exactly one src reader: `toNormalizedResponse` (`src/repo-search/engine/task-loop.ts:498-515`, fields at `:504-508`). Its downstream sums (`src/agent-loop/agent-loop.ts:129-138`) are discarded by both production call sites (`task-loop.ts:349-356`, `src/summary/planner/mode.ts:1460-1466`); only `tests/agent-loop.test.ts:155` asserts them (via AgentLoop's own fixtures, unaffected).
- Test readers of those fields: `tests/planner-streaming-timings.test.ts:96`, `tests/repo-search-planner-protocol.test.ts:488-489`.
- `<think>` literals exist in exactly two src files: `planner-protocol.ts` (`:486` regex, `:604`/`:690` `includes` guards) and `llama-cpp-client.ts` (continuation prefix, ~`:334`).
- `estimateTokenCount(config, text)` (`src/repo-search/prompt-budget.ts:23-28`) callers: prompt-budget `:57,:64`; `incremental-token-counter.ts:60`; `engine/repo-tools.ts:649`; `engine/token-usage.ts:134`; `engine/tool-result-budgeter.ts:44`; `engine/tool-action-processor.ts:897`; re-export `src/repo-search/index.ts:29-33`; tests `engine-tool-result-budgeter.test.ts`, `repo-search-loop.core.test.ts`. `estimatePromptTokenCountFromCharacters` (`src/lib/dynamic-output-cap.ts:12-20`) callers: `llama-cpp-client.ts:467`, `providers/llama-cpp.ts:473`. (The 1-arg `estimateTokenCount` in `src/state/chat-sessions.ts:287` is a different, chat-message-shaped function — out of scope.)
- Continuation usage merge (`llama-cpp-client.ts:336-344`) spreads `continuation.usage` and sums only `generationDurationMs`; the client parses usage per SSE packet (`:387-396`), so stats emitted in early chunks of the aborted stream ARE captured in `streamed.usage`.
- Summary surface: `generateLlamaCppChatResponse` (`src/providers/llama-cpp.ts:451-553`) passes provider usage through (`:537-539`), only deriving `thinkingTokens` locally when absent (`:533-534`); consumed at `src/summary/provider-invoke.ts:144-157` and `src/summary/planner/mode.ts:552,568-577`. Direct chat (`routes/chat.ts:761-774,785-796`) and engine-backed chat (`routes/chat.ts:735-742,1018-1025` via scorecard) already use local counts.

---

### Task 1: Delete the dead provider token fields from `PlannerActionResponse`

**Files:**
- Modify: `src/repo-search/planner-protocol.ts:33-35, 706-708`
- Modify: `src/repo-search/engine/task-loop.ts:498-515` (`toNormalizedResponse`)
- Test: `tests/planner-streaming-timings.test.ts`, `tests/repo-search-planner-protocol.test.ts`

- [ ] **Step 1: Red via type removal.** Delete the three fields from the `PlannerActionResponse` type (`:33-35`) and the three writer lines in the return mapping (`:706-708`; the mock path `:600-608` never set them). Run `npm run build:test` — expect TS2339 errors at `task-loop.ts:504-508` and in the two test files. Those errors are the red state enumerating every remaining consumer.
- [ ] **Step 2: Rewire `toNormalizedResponse` to local counts.** The turn's local counts already exist beside the response (`RepoSearchModelData { plannerResponse, resolvedTokens }`, `task-loop.ts:415-419`; `prepared.promptTokenCount` in scope). Change `toNormalizedResponse` (and its call site) so the normalized usage is built from them:

```ts
// task-loop.ts — target shape inside toNormalizedResponse's usage
promptTokens: promptTokenCount,                       // local preflight count
completionTokens: resolvedTokens.completionTokens,    // local text count
outputTokens: resolvedTokens.completionTokens,
thinkingTokens: resolvedTokens.thinkingTokens,        // local thinking count
// promptCacheTokens / promptEvalTokens / durations / speculative stay as today
```

Pass `resolvedTokens` and `promptTokenCount` in via parameters (explicit dependencies, no stashing on fields unless the class already holds them). With this, `AgentLoopResult` totals become consistent with the tracker instead of dead provider numbers.
- [ ] **Step 3: Fix the two test files.** `planner-streaming-timings.test.ts:96` — delete the `response.completionTokens` assertion (the test's purpose, `generationDurationMs === PREDICTED_MS`, stays). `repo-search-planner-protocol.test.ts:488-489` — delete the `completionTokens`/`usageThinkingTokens` assertions (keep `:487` promptEvalTokens and `:490-491` durations).
- [ ] **Step 4: Green + gates.** `npm run build:test`, then `node .\dist\test-runner\run-tests.js planner-streaming-timings repo-search-planner-protocol agent-loop engine-token-usage mock-repo-search-loop repo-search-loop.core`. Expected: PASS.

---

### Task 2: Budget gate resolves reasoning the same way as the request builder

**Files:**
- Modify: `src/llm-protocol/llama-cpp-client.ts` (gate before the stream loop; `buildChatRequest`)
- Test: `tests/llama-cpp-client-thinking-budget.test.ts`

- [ ] **Step 1: Write the failing test** (preset default `Reasoning: 'on'`, no `reasoningOverride` — today the gate never fires):

```ts
test('exl3 budget enforcement applies when reasoning comes from the preset default', async () => {
  const fake = await startFakeStreamServer();
  try {
    const response = await new LlamaCppClient().chat({
      config: budgetedConfig('exl3'),
      baseUrl: fake.baseUrl,
      model: 'mock',
      messages: [{ role: 'user', content: 'hi' }],
      tools: [],
      maxTokens: 64,
      stream: true,
      allowedToolNames: [],
      retryMaxWaitMs: 0,
    });
    assert.equal(fake.requestCount(), 2);
    assert.equal(response.thinkingBudgetExhausted, true);
  } finally {
    await fake.close();
  }
});
```

(Import `LlamaCppClient` from `../src/llm-protocol/llama-cpp-client.js`.)
- [ ] **Step 2: Run it — expect FAIL** (`requestCount()` is 1: gate checks `options.reasoningOverride === 'on'` which is undefined).
- [ ] **Step 3: Implement.** Extract one private resolver and use it in BOTH places:

```ts
private resolveReasoning(options: LlamaCppChatOptions): 'on' | 'off' | undefined {
  return options.reasoningOverride
    ?? buildPresetRequestDefaults(getActiveModelPreset(options.config)).reasoning;
}
```

`buildChatRequest` replaces its inline `const resolvedReasoning = options.reasoningOverride ?? defaults.reasoning;` with `this.resolveReasoning(options)`. The budget gate replaces `options.reasoningOverride === 'on'` with `this.resolveReasoning(options) === 'on'`.
- [ ] **Step 4: Green.** `node .\dist\test-runner\run-tests.js llama-cpp-client-thinking-budget planner-streaming-timings repo-search-planner-protocol`. Expected: PASS (planner behavior unchanged — it always passes an override).

---

### Task 3: Take `responsePrefix` / `enforceThinkingBudget` off the public options type

**Files:**
- Modify: `src/llm-protocol/llama-cpp-client.ts` (`LlamaCppChatOptions:157-181`, `streamChatAtBaseUrl`, `continueAfterThinkingBudget`, `buildChatRequest`)
- Test: existing `tests/llama-cpp-client-thinking-budget.test.ts` (behavior must not change)

- [ ] **Step 1: Red via type removal.** Delete both fields from `LlamaCppChatOptions`. `npm run build:test` — expect TS2339 at their internal uses. (Behavioral coverage already exists; this is a surface-narrowing refactor, so compile errors are the red.)
- [ ] **Step 2: Implement.** Continuation state becomes an explicit internal parameter:

```ts
private async streamChatAtBaseUrl(
  baseUrl: string,
  options: LlamaCppChatOptions,
  continuation?: { responsePrefix: string },
): Promise<NormalizedLlamaCppChatResponse> {
```

- Gate condition: replace `options.enforceThinkingBudget !== false` with `continuation === undefined`.
- Body build: `const body = JSON.stringify(this.buildChatRequest(options, continuation?.responsePrefix));` and `buildChatRequest(options: LlamaCppChatOptions, responsePrefix?: string)` forwards `...(responsePrefix ? { responsePrefix } : {})` into the builder input (the `InferenceRequestInput.responsePrefix` plumbing from the previous plan stays as-is).
- `continueAfterThinkingBudget`: `await this.streamChatAtBaseUrl(baseUrl, options, { responsePrefix: buildClosedThinkBlock-or-current-literal });` (Task 4 swaps in the helper) — drop the `{ ...options, enforceThinkingBudget: false, responsePrefix }` spread.
- `chatAtBaseUrl` streaming branch calls `streamChatAtBaseUrl(baseUrl, options)` unchanged.
- [ ] **Step 3: Green.** `node .\dist\test-runner\run-tests.js llama-cpp-client-thinking-budget llm-protocol llm-protocol-streaming llama-cpp`. Expected: PASS, identical assertions.

---

### Task 4: One owner for the `<think>` markers

**Files:**
- Create: `src/llm-protocol/think-markers.ts`
- Modify: `src/llm-protocol/llama-cpp-client.ts` (continuation prefix), `src/repo-search/planner-protocol.ts:486, 604, 690`
- Test: existing inline-think + budget-prefix assertions (pure refactor; existing green tests are the safety net)

- [ ] **Step 1: Create the module** (llm-protocol so both layers can import it — repo-search already imports from llm-protocol, never the reverse):

```ts
/**
 * Chat-template reasoning markers (Qwen/GLM convention). Single owner for
 * inline-think extraction and the thinking-budget continuation prefix.
 */
export const THINK_OPEN_TAG = '<think>';
export const THINK_CLOSE_TAG = '</think>';

/** A completed reasoning block the model will not reopen: used as a response prefix. */
export function buildClosedThinkBlock(thinkingText: string): string {
  return `${THINK_OPEN_TAG}\n${thinkingText}\n${THINK_CLOSE_TAG}\n\n`;
}

export function buildInlineThinkPattern(): RegExp {
  return new RegExp(`${THINK_OPEN_TAG}([\\s\\S]*?)${THINK_CLOSE_TAG}`, 'gu');
}
```

- [ ] **Step 2: Replace the literals.** `llama-cpp-client.ts` continuation: `responsePrefix: buildClosedThinkBlock(exhaustedThinking)`. `planner-protocol.ts:486`: regex literal → `buildInlineThinkPattern()` (note: the `g` flag makes the RegExp stateful — keep constructing it per call, as the factory does). Guards `:604` and `:690`: `.includes('<think>')` → `.includes(THINK_OPEN_TAG)`.
- [ ] **Step 3: Green.** `node .\dist\test-runner\run-tests.js llama-cpp-client-thinking-budget repo-search-planner-protocol planner-streaming-timings`. Expected: PASS (prefix assertions `startsWith('<think>\n')` / `endsWith('</think>')` unchanged).

---

### Task 5: One chars-per-token estimator in `src/lib`

**Files:**
- Create: `src/lib/token-estimate.ts`
- Modify: `src/lib/dynamic-output-cap.ts` (delete `estimatePromptTokenCountFromCharacters`), `src/repo-search/prompt-budget.ts` (delete `estimateTokenCount`), and the callers listed in Facts
- Test: existing suites named in Step 3 (pure consolidation; semantics must be byte-identical)

- [ ] **Step 1: Create the module** (identical semantics to both old copies — min 1, `chars/4` default, `getEffectiveInputCharactersPerContextToken` when config present):

```ts
import { getEffectiveInputCharactersPerContextToken, type SiftConfig } from '../config/index.js';

export function estimateTokenCountFromCharacters(config: SiftConfig | undefined, characterCount: number): number {
  const charsPerToken = config
    ? Math.max(Number(getEffectiveInputCharactersPerContextToken(config) || 4), 0.1)
    : 4;
  return Math.max(1, Math.ceil(Math.max(0, Number(characterCount) || 0) / charsPerToken));
}

export function estimateTokenCount(config: SiftConfig | undefined, text: string): number {
  return estimateTokenCountFromCharacters(config, String(text || '').length);
}
```

- [ ] **Step 2: Red via deletion, then rewire.** Delete both old functions. `npm run build:test` red enumerates every caller; update each import to `src/lib/token-estimate.js`: prompt-budget internals (`:57,:64`), `incremental-token-counter.ts`, `engine/repo-tools.ts`, `engine/token-usage.ts`, `engine/tool-result-budgeter.ts`, `engine/tool-action-processor.ts`, the `src/repo-search/index.ts:29-33` re-export (now re-exports from `../lib/token-estimate.js` — aggregation surface, not a shim), the budget gate (`llama-cpp-client.ts:467` → `estimateTokenCountFromCharacters`, which also fixes the "Prompt"-named helper counting thinking text), `providers/llama-cpp.ts:473`, and the two test imports (`engine-tool-result-budgeter.test.ts`, `repo-search-loop.core.test.ts`). No re-export left in `prompt-budget.ts` or `dynamic-output-cap.ts` — missed callers must fail loud.
- [ ] **Step 3: Green.** `node .\dist\test-runner\run-tests.js engine-token-usage engine-tool-result-budgeter repo-search-loop.core incremental-token-counter dynamic-output-cap llama-cpp-client-thinking-budget repo-tools`. Expected: PASS.

---

### Task 6: Continuation usage merge keeps both requests' stats

**Files:**
- Modify: `src/llm-protocol/llama-cpp-client.ts` (`continueAfterThinkingBudget` merge, `sumFiniteDurations`)
- Test: `tests/llama-cpp-client-thinking-budget.test.ts`

- [ ] **Step 1: Write the failing test.** Extend `startFakeStreamServer` so the FIRST frame of every request carries provider usage (parsed per-packet, so it survives the mid-stream abort): request 1 `usage: { prompt_tokens: 100, prompt_tokens_details: { cached_tokens: 60 } }` (→ cache 60, eval 40), request 2 `usage: { prompt_tokens: 110, prompt_tokens_details: { cached_tokens: 100 } }` (→ cache 100, eval 10). Then in the exl3 test assert the planner response reports the sums:

```ts
assert.equal(response.promptCacheTokens, 160);
assert.equal(response.promptEvalTokens, 50);
```

- [ ] **Step 2: Run — expect FAIL** (today: 100 and 10 — first request's stats discarded).
- [ ] **Step 3: Implement.** Rename `sumFiniteDurations` → `sumFinite` (same body) and merge every additive stat; generated-token fields stay continuation-only (they are provider-reported and unconsumed on this path):

```ts
usage: {
  ...continuation.usage,
  promptCacheTokens: sumFinite(streamed.usage.promptCacheTokens, continuation.usage.promptCacheTokens),
  promptEvalTokens: sumFinite(streamed.usage.promptEvalTokens, continuation.usage.promptEvalTokens),
  promptEvalDurationMs: sumFinite(streamed.usage.promptEvalDurationMs, continuation.usage.promptEvalDurationMs),
  generationDurationMs: sumFinite(streamed.usage.generationDurationMs, continuation.usage.generationDurationMs),
  speculativeAcceptedTokens: sumFinite(streamed.usage.speculativeAcceptedTokens, continuation.usage.speculativeAcceptedTokens),
  speculativeGeneratedTokens: sumFinite(streamed.usage.speculativeGeneratedTokens, continuation.usage.speculativeGeneratedTokens),
},
```

- [ ] **Step 4: Green.** `node .\dist\test-runner\run-tests.js llama-cpp-client-thinking-budget`. Expected: PASS.

---

### Task 7: Summary surface counts tokens locally

**Files:**
- Modify: `src/providers/llama-cpp.ts` (`generateLlamaCppChatResponse`, lines ~451-553)
- Test: create `tests/providers-llama-cpp-local-usage.test.ts`

**Behavior spec:** the returned `usage` reports locally counted values for what the model consumed/produced — `promptTokens` = server-tokenized concatenation of the request messages' string contents (an approximation that ignores template overhead; flag nothing, it replaces a provider number that can be 4-6x wrong), `completionTokens`/`outputTokens` = tokenized `text`, `thinkingTokens` = tokenized `reasoningText` (null/0 when empty). Cache/prefill/timing/speculative fields still pass through from the provider. Tokenization goes through the provider file's existing `countLlamaCppTokensDetailed` (`:303-362`); on `status !== 'completed'` fall back to `estimateTokenCount` from `src/lib/token-estimate.js` (Task 5). The current partial fallback at `:533-539` is replaced outright — no "prefer provider when present" branch survives.

- [ ] **Step 1: Write the failing test.** Fake non-streaming server: `/v1/chat/completions` returns `{ choices: [{ message: { content: 'x'.repeat(400), reasoning_content: 'y'.repeat(200) } }], usage: { prompt_tokens: 999, completion_tokens: 2 } }`; `/tokenize` returns `{ tokens: [] }`-style counts (mirror the harness in `tests/engine-token-usage.test.ts`'s tokenize server: respond with `{ count: Math.ceil(content.length / 2) }`). Call `generateLlamaCppChatResponse` with a config pointing at the fake server and assert:

```ts
assert.equal(result.usage?.completionTokens, 200); // 400 chars / 2, not provider's 2
assert.equal(result.usage?.thinkingTokens, 100);   // 200 chars / 2
assert.equal(result.usage?.promptTokens, Math.ceil(joinedMessageChars / 2)); // not 999
```

- [ ] **Step 2: Run — expect FAIL** (provider's 2/999 pass through today).
- [ ] **Step 3: Implement** per the behavior spec: count text, reasoning, and the joined message contents with `countLlamaCppTokensDetailed`, estimate-fallback each; build `usage` from `{ ...response.usage, promptTokens, completionTokens, outputTokens: completionTokens, thinkingTokens }`.
- [ ] **Step 4: Green + consumers.** `node .\dist\test-runner\run-tests.js providers-llama-cpp-local-usage llama-cpp summary-planner-runtime` plus whichever summary suites the runner lists for `src/summary` (`summary`-prefixed bundles). Fix only assertions that pinned provider passthrough.

---

## Verification (after all tasks)

1. `npm run build:test` + full `node .\dist\test-runner\run-tests.js` targeted list per task, then `npm run test | siftkit summary --question "totals and failures"`, `npm run typecheck` (chains lint). All green, zero failures.
2. Grep-level completeness checks (each must return nothing): `estimatePromptTokenCountFromCharacters` anywhere; `usageThinkingTokens` outside `src/status-server/chat.ts` (chat's own field naming is separate); `<think>` literal outside `src/llm-protocol/think-markers.ts`; `responsePrefix` in `LlamaCppChatOptions`.
3. Optional live check: one repo-search run against the local engine; transcript turn records still show sane local counts, and a low-budget preset still produces `thinkingBudgetExhausted: true` with summed `promptEvalTokens`.
4. Do not commit unless the user asks.
