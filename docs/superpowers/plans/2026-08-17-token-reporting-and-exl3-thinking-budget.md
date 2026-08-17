# Local Token Accounting + Exl3 Thinking Budget Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Agent-loop token reporting becomes backend-agnostic and locally computed (input, output, thinking counted by SiftKit; only cache/prefill stats trusted from the provider), and `ReasoningBudget` is enforced client-side on the exl3 backend.

**Architecture:** exllamav3 1.3.0 underreports `usage.completion_tokens` 4–6x on generations >2048 tokens (requeue counter bug: `site-packages/exllamav3/generator/job.py:906` drops accumulated `rq_new_tokens`; TabbyAPI `output_chunking: true` + `chunk_size: 2048` triggers requeues). Provider `prompt_tokens` is also inflated on requeued jobs. Decision (user-approved): never trust provider generated/prompt token counts on the agent-loop reporting path — count locally (server tokenize with estimate fallback, machinery already exists). Keep provider-only facts (cache hits, prefill counts, timings, speculative stats). Separately, `ReasoningBudget`/`ReasoningBudgetMessage` preset fields are today marked `llama-only` (enforced via llama.cpp `--reasoning-budget` launch args) — exl3 gets no bound, which let a planner turn burn its whole 15K output reserve inside `<think>` and fail with an empty payload. Fix: during exl3 streaming, when accumulated thinking exceeds the budget, early-stop the stream (existing `break streamFrames` teardown) and re-send once with a TabbyAPI `response_prefix` containing the partial reasoning + budget message in a closed think block, forcing the answer.

**Tech Stack:** TypeScript (node:test), TabbyAPI `response_prefix` (`endpoints/OAI/types/chat_completion.py:122`, rendered at `utils/chat_completion.py:471-473`).

**Evidence base (from investigation of failed run `35145b76`):** turn 12 reported 2,102 completion tokens, actual 8,921 (verified via `/v1/token/encode`); turn 14 reported 2,619, actual ≥15,015 (hit the 15K shared reserve mid-think → `turn_action_invalid: Unexpected end of json string`).

---

## Key existing code (reuse, do not duplicate)

- `src/repo-search/engine/token-usage.ts` — `TokenUsageTracker`; `resolveTextTokens` (lines 128-144) already counts text locally but only as fallback when the provider count is absent.
- `src/repo-search/engine/task-loop.ts:382-408` — `requestModelResponse`; logs `turn_model_response` at 391-400 with raw provider counts; `prepared.promptTokenCount` (local preflight count) is in scope.
- `src/llm-protocol/llama-cpp-client.ts` — streaming loop 369-447 with labeled `break streamFrames` early-stop (`earlyStopReason` at 353; socket teardown happens in `streamSse`'s `finally`, `src/lib/http-client.ts:304-308`); `countTokens` 180-209 (`/tokenize` llama, `/v1/token/encode` exl3); `getActiveInferenceBackend` used at 264.
- `src/llm-protocol/inference-request-builder.ts:30-52` — request body builder (has backend-conditional fields already, e.g. llama-only `cache_prompt`).
- `src/inference-presets/preset-compatibility.ts:88-141` — `PRESET_FIELD_SUPPORT` with `ReasoningBudget: 'llama-only'` (130-131); single consumer `getPresetFieldAvailability` (156-175).
- `src/config/constants.ts:40-41` — `SIFT_DEFAULT_LLAMA_REASONING_BUDGET = 10_000` + default message.
- Config getters: `getActiveModelPreset`, `getActiveInferenceBackend` (`src/config/getters.ts:26-28`).
- Test harnesses: `tests/engine-token-usage.test.ts` (TokenUsageTracker unit + fake `/tokenize` server), `tests/planner-streaming-timings.test.ts` (fake SSE llama server + `requestRepoSearchPlannerProtocolAction`), `tests/helpers/mock-config.ts` (`mockOfflineSiftConfig`).

**Layering constraint:** `src/llm-protocol/*` must not import from `src/repo-search/*`. If a chars-per-token estimate is needed in the client, use the config-level helper that `estimateTokenCount` (`src/repo-search/prompt-budget.ts:23-28`) delegates to, or the same default constant — do not import `prompt-budget.ts` into `llm-protocol`.

---

### Task 1: Local token accounting in the agent loop

**Files:**
- Modify: `src/repo-search/engine/token-usage.ts`
- Modify: `src/repo-search/engine/task-loop.ts:382-408`
- Test: `tests/engine-token-usage.test.ts`

- [ ] **Step 1: Write the failing tests**

In `tests/engine-token-usage.test.ts`, replace the first test's expectations and add a regression test (the old behavior — trusting `completionTokens: 20, usageThinkingTokens: 7` — is exactly the bug):

```ts
test('recordModelResponse counts output and thinking locally, ignoring provider counts', async () => {
  const tracker = new TokenUsageTracker(undefined);
  // 400 chars thinking, 80 chars text; estimate path (no config) = chars/4
  const resolved = await tracker.recordModelResponse({
    text: 'x'.repeat(80),
    thinkingText: 'y'.repeat(400),
    promptCacheTokens: 50, promptEvalTokens: 60,
    promptEvalDurationMs: 11, generationDurationMs: 22,
    speculativeAcceptedTokens: 16, speculativeGeneratedTokens: 20,
  }, 123);
  assert.equal(resolved.completionTokens, 20);
  assert.equal(resolved.thinkingTokens, 100);
  assert.equal(resolved.completionTokensEstimated, true);
  assert.equal(resolved.thinkingTokensEstimated, true);
  const snapshot = tracker.snapshot();
  assert.equal(snapshot.promptTokens, 123); // local preflight count, not provider usage
  assert.equal(snapshot.thinkingTokens, 100);
  assert.equal(snapshot.promptCacheTokens, 50);
  assert.equal(snapshot.promptEvalTokens, 60);
});

test('regression: provider-shaped usage fields cannot influence resolved counts', async () => {
  // exllamav3 requeue bug: provider reported 2102 tokens for an 8921-token response.
  const tracker = new TokenUsageTracker(undefined);
  // These provider fields no longer exist on ModelUsageResponse; passing a
  // variable (not a literal) keeps this compiling if someone re-adds them,
  // and the assertions below still protect us. No type assertions.
  const providerShaped = {
    text: 'z'.repeat(200),
    thinkingText: '',
    completionTokens: 2, usageThinkingTokens: 3, promptTokens: 999999,
  };
  const withBogus = await tracker.recordModelResponse(providerShaped, 10);
  assert.equal(withBogus.completionTokens, 50);
  assert.equal(tracker.snapshot().promptTokens, 10);
});
```

Update the two other existing tests in this file to the new signature: `recordModelResponse({...}, <promptTokens>)`, and delete assertions that provider `completionTokens`/`usageThinkingTokens` are echoed back (`resolved.completionTokens === 20` style with provider-sourced expectations). The `/tokenize`-server test keeps its server and now asserts the server-tokenized counts are used for BOTH text and thinking (it already exercises `countTokensWithFallbackDetailed`).

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run build:test` then the file's suite (match repo convention, e.g. `node --test dist-test/tests/engine-token-usage.test.js` or the package script used by other tasks).
Expected: FAIL — signature mismatch / resolved counts come from provider fields.

- [ ] **Step 3: Implement**

`src/repo-search/engine/token-usage.ts`:
1. `ModelUsageResponse`: delete `promptTokens`, `completionTokens`, `usageThinkingTokens` fields (keep `text`, `thinkingText`, `promptCacheTokens`, `promptEvalTokens`, `promptEvalDurationMs`, `generationDurationMs`, `speculativeAcceptedTokens`, `speculativeGeneratedTokens`).
2. `recordModelResponse(response: ModelUsageResponse, promptTokenCount: number)`: replace the provider `response.promptTokens` accumulation (lines 63-65) with `if (Number.isFinite(promptTokenCount) && promptTokenCount >= 0) { this.promptTokens += promptTokenCount; }`; call `this.resolveTextTokens(response.text)` / `this.resolveTextTokens(response.thinkingText)`.
3. `resolveTextTokens(text: string | undefined)`: drop the `explicitTokens` parameter and the trust branch (lines 132-134); the rest is unchanged (empty → 0, no config/`useEstimatedTokensOnly` → estimate, else `countTokensWithFallbackDetailed`).

`src/repo-search/engine/task-loop.ts` (`requestModelResponse`): move `recordModelResponse` above the transcript write and log local values:

```ts
const resolvedTokens = await this.tokenUsage.recordModelResponse(response, prepared.promptTokenCount);

this.options.logger?.write({
  kind: 'turn_model_response', taskId: this.task.id, turn,
  text: response.text, thinkingText: response.thinkingText || '',
  mockExhausted: Boolean(response.mockExhausted),
  promptTokens: prepared.promptTokenCount,
  completionTokens: resolvedTokens.completionTokens,
  completionTokensEstimated: resolvedTokens.completionTokensEstimated,
  thinkingTokens: resolvedTokens.thinkingTokens,
  thinkingTokensEstimated: resolvedTokens.thinkingTokensEstimated,
  promptCacheTokens: Number.isFinite(response.promptCacheTokens) ? Number(response.promptCacheTokens) : null,
  promptEvalTokens: Number.isFinite(response.promptEvalTokens) ? Number(response.promptEvalTokens) : null,
});
```

(The old fields `usageThinkingTokens` and provider-sourced `promptTokens`/`completionTokens` are gone — complete replacement, no dual reporting.) Keep the `ThinkingRetentionPolicy` block and the rest of the method unchanged; remove the now-duplicate `recordModelResponse` call at the old position (line 408).

4. Fix every other `recordModelResponse(` caller found by typecheck (pass the local prompt token count available at that call site; if a caller has none, pass `0` and leave a one-line comment naming the missing source).

- [ ] **Step 4: Run tests + full gates**

Run: file suite, then `npm run typecheck` and `npm run lint`, then the broader test suite. Some existing tests assert the old transcript fields or tracker behavior (`tests/planner-streaming-timings.test.ts:96` asserts the protocol-layer `response.completionTokens`, which is UNCHANGED — the client still parses provider usage; only tracker/transcript stop consuming it). Update only tests that assert the replaced tracker/transcript behavior; do not weaken protocol-layer tests.
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/repo-search/engine/token-usage.ts src/repo-search/engine/task-loop.ts tests/engine-token-usage.test.ts
git commit -m "fix(repo-search): count prompt/output/thinking tokens locally instead of trusting provider usage"
```

---

### Task 2: Client-side ReasoningBudget enforcement for exl3

**Files:**
- Modify: `src/llm-protocol/llama-cpp-client.ts`
- Modify: `src/llm-protocol/inference-request-builder.ts:30-52`
- Modify (types if needed): `src/llm-protocol/types.ts` (~112)
- Test: `tests/llama-cpp-client-thinking-budget.test.ts` (create)

**Behavior spec:**
- Gate (streaming path only): active backend is `exl3` AND `options.reasoningOverride === 'on'` AND active preset `ReasoningBudget` is a finite number > 0 AND this is not already a budget continuation. llama backend is untouched (server-side `--reasoning-budget` already handles it — `src/status-server/managed-llama.ts:618`).
- Detection: in the `deltaReasoning` branch of the stream loop (after the `FirstJsonObjectScanner` check, `llama-cpp-client.ts:406-416`), when the estimated token count of accumulated `reasoningText` exceeds the budget → `earlyStopReason = THINKING_BUDGET_EARLY_STOP_REASON; break streamFrames;`. Estimation: same chars-per-token config default the repo uses (default 4) — cheap length check, no tokenize round-trip mid-stream. Respect the layering constraint above.
- Continuation: one follow-up streaming request, identical body plus `responsePrefix` = `` `<think>\n${reasoningText}\n\n${budgetMessage}\n</think>\n\n` `` where `budgetMessage` = preset `ReasoningBudgetMessage` or the default from `src/config/constants.ts:41`. `chat_template_kwargs` unchanged (with `enable_thinking: true` the Qwen/GLM templates do not auto-open a think block; the closed block in the prefix means generation starts at the answer, and the planner's `response_format` schema constrains it to the JSON payload). Budget enforcement disabled on the continuation.
- Merged result: `text`/tool calls/content-derived fields from the continuation; `reasoningText` = partial reasoning + `\n\n` + budgetMessage; prompt/cache usage fields from the continuation (the prefix re-uses cache); `generationDurationMs` = sum of both when finite; add `thinkingBudgetExhausted: true` to the normalized response type (optional field, absent otherwise).
- Non-streaming requests: no enforcement (nothing to intercept); this matches the planner, which always streams.

- [ ] **Step 1: Write the failing test**

Create `tests/llama-cpp-client-thinking-budget.test.ts`, modeled on `tests/planner-streaming-timings.test.ts`'s fake SSE server, but: config's active preset has `Backend: 'exl3'`, `ReasoningBudget: 8`, `ReasoningBudgetMessage: 'Answer now.'` (extend `mockOfflineSiftConfig`/`mockConfig` with a preset override if it doesn't support one — check `tests/helpers/mock-config.ts` first). Server behavior: request 1 streams ~10 `reasoning_content` chunks of 8 chars each (≥64 chars > 8 tokens × 4 chars) and no content, writing chunks until the socket closes; request 2 records the body and streams one `content` delta `{"action":"finish","output":"done"}` then `[DONE]`.

```ts
test('exl3 streaming enforces ReasoningBudget with a response_prefix continuation', async () => {
  const fake = await startFakeExl3Server();
  try {
    const response = await runStreamingPlanner(fake.baseUrl); // same helper shape as planner-streaming-timings.test.ts
    assert.equal(fake.requestCount(), 2);
    const secondBody = asObject(parseJsonValueText(fake.lastBody()));
    const prefix = String(secondBody.response_prefix);
    assert.ok(prefix.startsWith('<think>\n'));
    assert.ok(prefix.includes('Answer now.'));
    assert.ok(prefix.trimEnd().endsWith('</think>'));
    assert.ok(!('response_prefix' in asObject(parseJsonValueText(fake.firstBody()))));
    assert.match(response.text, /"action"\s*:\s*"finish"/u);
    assert.ok(response.thinkingText.includes('Answer now.'));
  } finally {
    await fake.close();
  }
});

test('llama backend streaming never sends response_prefix', async () => {
  // reuse the fake server with a llama-backend config and the same long-reasoning stream;
  // assert requestCount() === 1 and no response_prefix in the body.
});
```

- [ ] **Step 2: Run test to verify it fails**

Expected: FAIL — single request, no `response_prefix`, stream runs to completion.

- [ ] **Step 3: Implement**

1. `llama-cpp-client.ts`: export `const THINKING_BUDGET_EARLY_STOP_REASON = 'thinking budget exhausted'`. Resolve the gate once before the loop (preset via `getActiveModelPreset(options.config)`); add the detection check in the `deltaReasoning` branch; add `responsePrefix?: string` and `enforceThinkingBudget?: boolean` to `LlamaCppChatOptions` (`:157-175`); in `chatAtBaseUrl`'s streaming branch, when the first result's `earlyStopReason === THINKING_BUDGET_EARLY_STOP_REASON`, issue the single continuation call (`enforceThinkingBudget: false`, `responsePrefix` as specified) and merge per the behavior spec.
2. `inference-request-builder.ts`: emit `...(input.responsePrefix ? { response_prefix: input.responsePrefix } : {})` — plumb `responsePrefix` through `buildChatRequest` (`llama-cpp-client.ts:305-333`). Only the exl3 gate ever sets it, so no backend conditional is needed in the builder.
3. `types.ts`: add optional `thinkingBudgetExhausted?: true` to the normalized chat response; surface it through `PlannerActionResponse` so `task-loop.ts` can include `...(response.thinkingBudgetExhausted ? { thinkingBudgetExhausted: true } : {})` in the `turn_model_response` record (one-line addition to the Task 1 block).

- [ ] **Step 4: Run tests + gates**

File suite, `npm run typecheck`, `npm run lint`, broader suite.
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/llm-protocol tests/llama-cpp-client-thinking-budget.test.ts src/repo-search/engine/task-loop.ts
git commit -m "feat(llm-protocol): enforce ReasoningBudget client-side on exl3 via response_prefix continuation"
```

---

### Task 3: Expose ReasoningBudget for exl3 presets

**Files:**
- Modify: `src/inference-presets/preset-compatibility.ts:130-131`
- Modify: `dashboard/src/settings-sections.ts:163-164`
- Test: whichever existing test asserts `getPresetFieldAvailability` / preset field visibility (check `tests/dashboard-model-presets-section.test.ts` and any `preset-compatibility` test)

- [ ] **Step 1: Write/adjust the failing test** — assert `getPresetFieldAvailability(<exl3 preset>, 'ReasoningBudget').visible === true` (and same for `ReasoningBudgetMessage`); keep llama expectations.
- [ ] **Step 2: Run to verify it fails** (currently `HIDDEN` for exl3 via the `'llama-only'` case at `preset-compatibility.ts:163-164`).
- [ ] **Step 3: Implement** — change both fields' support markers from `'llama-only'` to the marker used for both-backend fields in the same table (see neighboring entries, e.g. `'supported'`); reword the help text at `settings-sections.ts:163-164` to be backend-neutral: llama.cpp enforces it server-side, exl3 client-side (mention the continuation message).
- [ ] **Step 4: Run tests + gates** — file suite, `npm run typecheck`, `npm run lint`, broader suite. Expected: PASS.
- [ ] **Step 5: Commit**

```bash
git add src/inference-presets/preset-compatibility.ts dashboard/src/settings-sections.ts tests/
git commit -m "feat(presets): ReasoningBudget applies to exl3 presets"
```

---

## Verification (end-to-end, after all tasks)

1. `npm run typecheck` && `npm run lint` && full test suite — all green.
2. Live check against the local engine (dev server + exl3 preset running): trigger a `siftkit repo-search` question that forces a long reasoning turn; confirm in the new transcript (`runtime_artifacts` → `repo_search_transcript`) that `turn_model_response.completionTokens + thinkingTokens` ≈ chars/4 of `text + thinkingText` (no more 4-6x undercount) and, if a turn exceeds the budget, `thinkingBudgetExhausted: true` appears with a non-empty `text` payload (no `turn_action_invalid`).
3. Out of scope (explicitly): chat-session telemetry (`src/status-server/chat-turn-telemetry.ts`) still records provider usage; upstream exllamav3 requeue bug (report separately: `exllamav3/generator/job.py:906` should be `self.rq_new_tokens + self.new_tokens - 1`, and draft counters should carry through `rq_state`).
