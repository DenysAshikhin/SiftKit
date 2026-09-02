# Context-Derived Generation Budget and `MaxTokens` Removal Implementation Plan

> **For agentic workers:** REQUIRED PROCESS: follow TDD for every behavior change. Per repository policy, dispatch each implementation task exactly once through `siftkit repo-agent`, review its JSON status and diff, and independently verify it before continuing. Do not commit unless the user separately requests commits.

**Goal:** Replace the 15,000-token response ceiling and model-preset `MaxTokens` setting with one context-derived generation limit that preserves 15,000 tokens as the prompt-compaction buffer.

**Architecture:** One context-budget module will own both the compaction threshold and the generation limit. The prompt may grow only to `contextWindow - compactionReserve`; ordinary generation receives the unused portion of that prompt budget, while explicitly bounded internal operations may lower that amount. `MaxTokens` will be removed completely from active model configuration, UI, launch snapshots, and executable chat-session snapshots; immutable historical run evidence will remain untouched.

**Tech Stack:** TypeScript 5.9, Zod-derived contracts, React 19, Node test runner, SQLite through `better-sqlite3`.

**Spec:** User-approved design in this conversation on 2026-09-02; this plan is the authoritative written specification.

## Global Constraints

- Do not use worktrees and do not commit.
- Preserve unrelated changes.
- Use failing tests before production edits; never weaken existing valid coverage.
- Keep all code and tests TypeScript. Do not introduce `any`, type assertions, non-null assertions, unknown laundering, namespace imports, duplicated schema types, or unvalidated IO.
- This is a complete replacement: delete the old response-reserve module, response-reserve naming, preset `MaxTokens` field, UI control, compatibility metadata, defaults, synchronization, and override path. Do not add aliases, deprecated fields, compatibility reads, or fallback branches.
- Keep assistant-memory fields such as `Assistant.Memory.Tier1.MaxTokens` and `MaxTokensPerDocument`; they are unrelated to model response generation.
- Keep the explicit summary-request input `llamaCppMaxTokens`; it becomes an operation-scoped cap and must no longer mutate model configuration.
- Preserve immutable `run_logs.model_preset_json` as historical evidence. Migrate active app configuration, runtime launch snapshots, and chat-session model snapshots because they can shape future execution.

## Required Semantics

For a normalized context window `C`:

```text
compactionReserve = max(1, min(15_000, floor(C * 0.5)))
maxPromptTokens = max(0, C - compactionReserve)
availableGenerationTokens = max(1, maxPromptTokens - normalizedPromptTokens)
effectiveGenerationTokens = min(availableGenerationTokens, explicitOperationCap ?? availableGenerationTokens)
```

Acceptance examples:

```text
C=155_000, prompt=0       -> reserve=15_000, maxPrompt=140_000, generation=140_000
C=155_000, prompt=285     -> reserve=15_000, maxPrompt=140_000, generation=139_715
C=155_000, prompt=100_000 -> reserve=15_000, maxPrompt=140_000, generation=40_000
C=155_000, prompt=140_000 -> generation=1; this is the final in-budget point
C=8_000,   prompt=1_000   -> reserve=4_000,  maxPrompt=4_000,   generation=3_000
```

`ReasoningBudget` remains preset-controlled. For the reported preset, a 100,000-token reasoning budget can therefore trigger the existing forced-answer continuation within a roughly 140,000-token generation allowance instead of losing the entire response at 15,000 tokens.

---

### Task 1: Replace Response-Reserve Budgeting With Context-Budgeting

**Files:**

- Delete: `src/lib/response-reserve.ts`
- Delete: `src/lib/dynamic-output-cap.ts`
- Create: `src/lib/context-token-budget.ts`
- Rename: `tests/response-reserve.test.ts` -> `tests/context-token-budget.test.ts`
- Delete the duplicate dynamic-limit case from: `tests/engine-token-usage.test.ts`
- Modify: `tests/dynamic-output-cap.test.ts` (rename to `tests/context-generation-limit.test.ts`)
- Modify: `src/repo-search/engine/turn-budget.ts`
- Modify: `src/repo-search/engine/prompt-preparer.ts`
- Modify: `src/repo-search/engine/task-loop.ts`
- Modify: `src/repo-search/engine/transcript-compactor.ts`
- Modify: `src/repo-search/engine/terminal-synthesizer.ts`
- Modify: `src/summary/chunking.ts`
- Modify: `src/summary/types.ts`
- Modify: `src/status-server/chat.ts`
- Modify affected focused tests: `tests/engine-turn-budget.test.ts`, `tests/engine-prompt-preparer.test.ts`, `tests/engine-transcript-compactor.test.ts`, `tests/runtime-planner-token-aware.test.ts`, `tests/mock-repo-search-loop.test.ts`, `tests/live-repo-agent-compaction-replay.test.ts`

**Interfaces:**

- Produces `PROMPT_COMPACTION_RESERVE_TOKENS = 15_000`.
- Produces `PROMPT_COMPACTION_RESERVE_MAX_CONTEXT_RATIO = 0.5`.
- Produces `resolveContextTokenBudget({ totalContextTokens }): { totalContextTokens; compactionReserveTokens; maxPromptTokens }`.
- Produces `resolveGenerationTokenLimit({ totalContextTokens, promptTokenCount, operationMaxTokens? }): number`.
- Removes `RESPONSE_RESERVE_TOKENS`, `RESPONSE_RESERVE_MAX_CONTEXT_RATIO`, `responseReserveTokens`, `getPresetMaxTokens`, `clampToPresetMaxTokens`, and `getDynamicMaxOutputTokens`.

- [ ] **Step 1: Write the failing pure-budget tests**

Replace the old reserve assertions with direct acceptance tests:

```ts
test('155k context keeps a 15k compaction reserve', () => {
  assert.deepEqual(resolveContextTokenBudget({ totalContextTokens: 155_000 }), {
    totalContextTokens: 155_000,
    compactionReserveTokens: 15_000,
    maxPromptTokens: 140_000,
  });
});

test('generation uses the prompt budget remaining at the current position', () => {
  assert.equal(resolveGenerationTokenLimit({ totalContextTokens: 155_000, promptTokenCount: 0 }), 140_000);
  assert.equal(resolveGenerationTokenLimit({ totalContextTokens: 155_000, promptTokenCount: 285 }), 139_715);
  assert.equal(resolveGenerationTokenLimit({ totalContextTokens: 155_000, promptTokenCount: 100_000 }), 40_000);
});

test('an explicit operation cap may only lower the context-derived limit', () => {
  assert.equal(resolveGenerationTokenLimit({
    totalContextTokens: 155_000,
    promptTokenCount: 285,
    operationMaxTokens: 4_096,
  }), 4_096);
});

test('small and exhausted contexts remain bounded', () => {
  assert.equal(resolveGenerationTokenLimit({ totalContextTokens: 8_000, promptTokenCount: 1_000 }), 3_000);
  assert.equal(resolveGenerationTokenLimit({ totalContextTokens: 155_000, promptTokenCount: 140_000 }), 1);
  assert.equal(resolveGenerationTokenLimit({ totalContextTokens: 155_000, promptTokenCount: 200_000 }), 1);
});
```

Also assert that a non-positive, fractional, or non-finite `operationMaxTokens` fails loudly rather than being normalized silently.

- [ ] **Step 2: Run the focused tests and verify RED**

Run:

```powershell
npm test -- context-token-budget
npm test -- context-generation-limit
```

Expected: compilation or assertion failure because the new module, names, and context-derived behavior do not exist.

- [ ] **Step 3: Implement the single context-budget source of truth**

Create `src/lib/context-token-budget.ts` with the two constants, a normalized `ContextTokenBudget`, and the two functions. `resolveGenerationTokenLimit` must subtract the current prompt from `maxPromptTokens`, not from the full context window, and then apply only an explicitly supplied operation cap.

Delete both old modules. Update all production imports and rename every live field/property/log label from `responseReserveTokens` / `response_reserve_tokens` to `compactionReserveTokens` / `compaction_reserve_tokens`.

`TurnBudget` must expose:

```ts
readonly totalContextTokens: number;
readonly compactionReserveTokens: number;
readonly maxPromptTokens: number;
```

The transcript compactor must continue using `compactionReserveTokens` as its operation-specific generation ceiling. Planner turns and terminal synthesis must use `resolveGenerationTokenLimit` with their measured prompt token count.

- [ ] **Step 4: Update focused consumers and remove obsolete assertions**

Update summary chunking and planner-stop calculations to preserve the same 140k compaction boundary at 155k. Remove tests claiming preset `MaxTokens` shrinks the prompt reserve. Update event assertions and compactor constructor arguments to the new names. Remove the duplicate dynamic-output test from `engine-token-usage.test.ts`; the dedicated context-generation test is canonical.

- [ ] **Step 5: Verify GREEN for the budget subsystem**

Run:

```powershell
npm test -- context-token-budget
npm test -- context-generation-limit
npm test -- engine-turn-budget
npm test -- engine-prompt-preparer
npm test -- engine-transcript-compactor
npm test -- runtime-planner-token-aware
```

Expected: all pass; no references to the deleted module or old reserve names remain in production code.

---

### Task 2: Preserve Only Explicit Operation-Scoped Output Caps

**Files:**

- Modify: `src/providers/llama-cpp.ts`
- Modify: `src/summary/types.ts`
- Modify: `src/summary/request-runner.ts`
- Modify: `src/status-server/route-request-normalizers.ts`
- Modify: `src/status-server/routes/operations.ts`
- Modify: `src/repo-search/planner-protocol.ts`
- Modify: `src/status-server/routes/inference-passthrough.ts`
- Modify tests: `tests/runtime-summarize.test.ts`, `tests/summary-status-server.test.ts`, `tests/route-request-normalizers.test.ts`, `tests/repo-search-planner-protocol.test.ts`, `tests/inference-passthrough-status-server.test.ts`

**Interfaces:**

- `generateWithLlamaCpp` accepts `operationMaxTokens?: number` and passes it only to `resolveGenerationTokenLimit`.
- `SummaryRequest.llamaCppMaxTokens` remains the validated external name; it maps directly to `operationMaxTokens`.
- Approval-verdict constants remain explicit local limits.
- Passthrough callers may supply `max_tokens`; it is capped by the context-derived maximum, never by a model preset.

- [ ] **Step 1: Write failing operation-cap tests**

Add tests proving:

1. A summary request with `llamaCppMaxTokens: 2_000` sends `max_tokens: 2_000` when the context-derived allowance is larger.
2. A summary request without the field sends the full context-derived allowance.
3. Approval verdicts still use their dedicated thinking/non-thinking constants.
4. Passthrough preserves a lower caller `max_tokens`, caps an excessive caller value at `maxPromptTokens`, and supplies `maxPromptTokens` when the caller omits it.
5. No operation cap is persisted into or overlaid onto a model preset.

- [ ] **Step 2: Run focused tests and verify RED**

Run:

```powershell
npm test -- runtime-summarize
npm test -- summary-status-server
npm test -- repo-search-planner-protocol
npm test -- inference-passthrough-status-server
```

Expected: failures show that summary currently mutates preset `MaxTokens`, approval verdict uses the preset clamp, and passthrough reads the preset default.

- [ ] **Step 3: Decouple summary caps from configuration**

Remove `applyMaxTokensOverrideToConfig` from `SummaryRequestRunner`. Carry the already-validated `llamaCppMaxTokens` through the summary execution path as `operationMaxTokens` and apply it only where the provider computes the current request's generation limit.

Do not rename the public request field in this refactor; it is an explicit per-operation API, not the removed preset setting.

- [ ] **Step 4: Decouple approval and passthrough caps**

Replace approval-verdict preset clamping with:

```ts
resolveGenerationTokenLimit({
  totalContextTokens: getConfiguredLlamaNumCtx(options.config),
  promptTokenCount: measuredPromptTokens,
  operationMaxTokens: options.executing.flags.thinkingEnabled
    ? APPROVAL_VERDICT_THINKING_MAX_TOKENS
    : APPROVAL_VERDICT_MAX_TOKENS,
});
```

If the approval path does not currently carry `measuredPromptTokens`, measure the exact serialized verdict prompt with the existing planner token counter before issuing the request; do not estimate or invent a second budget formula.

For inference passthrough, remove preset-default authority over `max_tokens`. Use the valid caller value when present, otherwise the preset's `NumCtx`-derived `maxPromptTokens`, and clamp the result to that same context-derived maximum. Upstream SiftKit requests already send their measured dynamic limit; generic passthrough remains bounded even when it omits one.

- [ ] **Step 5: Verify GREEN for operation-scoped caps**

Run the four focused suites from Step 2 plus `npm test -- route-request-normalizers`. Expected: all pass and no request-scoped cap mutates persisted config.

---

### Task 3: Remove Model-Preset `MaxTokens` End to End and Migrate Active State

**Files:**

- Modify: `packages/contracts/src/config.ts`
- Modify: `src/config/defaults.ts`
- Modify: `src/config/normalization.ts`
- Modify: `src/config/constants.ts`
- Modify: `src/config/host-sync.ts`
- Modify: `src/config/overrides.ts`
- Modify: `src/config/index.ts`
- Modify: `src/inference-presets/preset-compatibility.ts`
- Modify: `src/status-server/config-store.ts`
- Modify: `src/status-server/runtime-launch-snapshot.ts`
- Modify: `dashboard/src/settings-draft-editor.ts`
- Modify: `dashboard/src/settings-runtime.ts`
- Modify: `dashboard/src/settings-sections.ts`
- Modify: `dashboard/src/tabs/settings/ModelPresetsSection.tsx`
- Modify: `dashboard/src/tabs/settings/model-preset-groups.ts`
- Modify: `src/state/runtime-db.ts`
- Modify: `src/state/migrations/registry.ts`
- Modify: `src/state/migrations/app-config-migrations.ts`
- Create: `tests/runtime-db-schema-v58.test.ts`
- Modify all model-preset fixtures and focused tests identified by `rg -l '\bMaxTokens\b'`, excluding assistant-memory limits and the explicit `llamaCppMaxTokens` request field.

**Interfaces:**

- `ModelRuntimePreset`, `ManagedLlamaSettings`, `RuntimeLlamaCppConfig`, `ModelPresetField`, and `PresetRequestDefaults` no longer contain a response `MaxTokens`/`maxTokens` member.
- Runtime schema version becomes 58.
- Migration 58 removes `MaxTokens` from active `app_config.server_llama_presets_json`, every executable `chat_sessions.model_preset_json`, and the `runtime_llama_launch_snapshot` metadata object.
- Historical `run_logs.model_preset_json` remains byte-for-byte unchanged.

- [ ] **Step 1: Write failing contract and UI tests**

Update focused contract/config tests to assert:

```ts
assert.equal(Object.hasOwn(defaultPreset, 'MaxTokens'), false);
assert.equal(ModelPresetFieldSchema.safeParse('MaxTokens').success, false);
assert.equal(Object.hasOwn(buildRuntimeLaunchSnapshot(config).LlamaCpp, 'MaxTokens'), false);
```

Update dashboard tests so the Sampling group contains temperature/top-p/top-k information but no `MaxTokens` control or `max 134k` summary. Add a rendered `ModelPresetsSection` assertion that no input labelled `MaxTokens` exists.

- [ ] **Step 2: Write the failing v58 migration test**

Seed a version-57 database with:

- `server_llama_presets_json` containing two presets with different `MaxTokens` values;
- a chat session `model_preset_json` containing `MaxTokens`;
- `runtime_metadata['runtime_llama_launch_snapshot']` whose `LlamaCpp` object contains `MaxTokens`;
- a historical `run_logs.model_preset_json` containing `MaxTokens`.

Run `migrateDatabaseFile`, then assert schema version 58, absence of the field from the first three executable stores, preservation of all neighboring values, and exact preservation of the historical run snapshot.

- [ ] **Step 3: Run focused tests and verify RED**

Run:

```powershell
npm test -- runtime-db-schema-v58
npm test -- model-preset-adapters
npm test -- dashboard-managed-presets
npm test -- settings-sections
```

Expected: the new migration is absent and model/dashboard contracts still require and render `MaxTokens`.

- [ ] **Step 4: Remove the field from contracts, configuration, and runtime snapshots**

Delete the field from both runtime and managed preset Zod shapes, the editable field enum/support matrix, default construction, normalization, host sync, runtime-owned field lists, runtime launch snapshots, and preset request defaults. Delete `applyMaxTokensOverrideToConfig` and its export now that Task 2 removed its last consumer.

Do not retain a nullable field, ignored parser member, default value, or compatibility accessor. Existing persisted executable data is handled exclusively by migration 58.

- [ ] **Step 5: Remove the WebUI control and derived copies**

Delete the `MaxTokens` numeric control, settings help entry, integer draft key, active-preset-to-runtime projection, and Sampling summary text. Update fixtures by removing only model-generation `MaxTokens`; preserve assistant-memory token fields.

- [ ] **Step 6: Implement migration 58**

Add a typed migration helper that parses each JSON boundary with Zod/`JsonObjectSchema`, removes exactly the `MaxTokens` property, and serializes the remaining object. It must:

```text
app_config.server_llama_presets_json       -> strip from every preset
chat_sessions.model_preset_json            -> strip from every non-null snapshot
runtime_llama_launch_snapshot.LlamaCpp     -> strip from the nested launch object
run_logs.model_preset_json                  -> do not update
```

Malformed JSON or an invalid container shape must fail the migration loudly. Do not catch and retain stale data.

- [ ] **Step 7: Verify GREEN for removal and migration**

Run the suites from Step 3 plus:

```powershell
npm test -- config-overrides
npm test -- host-sync
npm test -- managed-llama-launch-snapshot
npm test -- chat-sessions-db
npm test -- preset-unification-gate
```

Expected: all pass; active configuration and WebUI types have no model response `MaxTokens`.

---

### Task 4: Prove the 155k Chat Regression End to End

**Files:**

- Modify: `tests/repo-search-loop.core.test.ts`
- Modify: `tests/dashboard-status-server.test.ts`
- Modify: `tests/status-server-chat.test.ts`
- Modify: `tests/dynamic-output-cap.test.ts` only if Task 1 did not rename it as required

**Acceptance:** A chat session at 155k context sends a first-turn `max_tokens` equal to `140_000 - measuredPromptTokens`; neither the removed 15k ceiling nor the removed 134k preset value can affect the request. Terminal synthesis follows the same rule. Compaction still begins when the prompt exceeds 140k.

- [ ] **Step 1: Add the failing chat regression**

Use the existing local streaming-provider fixture to capture request bodies. Configure:

```ts
NumCtx: 155_000,
Reasoning: 'on',
ReasoningBudget: 100_000,
```

Do not include `MaxTokens`. Capture the exact prompt token count from the existing preflight event and assert:

```ts
assert.equal(request.max_tokens, 140_000 - promptTokenCount);
assert.ok(Number(request.max_tokens) > 15_000);
assert.ok(Number(request.max_tokens) > 134_000);
```

Choose a short fixture prompt whose measured count is below 6,000 so the last assertion is stable and meaningful.

- [ ] **Step 2: Add boundary regressions**

Cover:

- a prompt exactly at 140k receives the one-token floor without being misclassified as overflow;
- a prompt above 140k enters compaction before the provider request;
- after compaction, `max_tokens` is recomputed from the compacted prompt;
- terminal synthesis recomputes from its own larger prompt rather than reusing the planner turn's allowance;
- a 100k reasoning budget is carried unchanged and is lower than the captured generation allowance for the short-prompt case.

- [ ] **Step 3: Run focused tests and verify RED, then GREEN after Tasks 1-3 are applied**

Run:

```powershell
npm test -- repo-search-loop.core
npm test -- dashboard-status-server
npm test -- status-server-chat
```

The regression must fail against the old code with `15_000` and pass only with the context-derived implementation.

- [ ] **Step 4: Run a complete obsolete-symbol scan**

Run:

```powershell
rg -n "response-reserve|RESPONSE_RESERVE|responseReserveTokens|response_reserve_tokens|getPresetMaxTokens|clampToPresetMaxTokens|getDynamicMaxOutputTokens" src dashboard packages tests
rg -n "\bMaxTokens\b" src dashboard packages tests
```

Expected:

- The first scan returns no matches.
- The second returns only explicitly retained assistant-memory limits and test text proving model-preset `MaxTokens` is rejected/removed.
- `llamaCppMaxTokens` may remain because it is the explicit summary-operation cap.

---

### Task 5: Full Validation and Review

**Files:** No planned production edits. Fix only regressions caused by Tasks 1-4.

- [ ] **Step 1: Run all relevant focused suites together**

```powershell
npm test -- context-token-budget
npm test -- context-generation-limit
npm test -- engine-turn-budget
npm test -- engine-prompt-preparer
npm test -- engine-transcript-compactor
npm test -- runtime-planner-token-aware
npm test -- runtime-summarize
npm test -- summary-status-server
npm test -- repo-search-planner-protocol
npm test -- inference-passthrough-status-server
npm test -- runtime-db-schema-v58
npm test -- model-preset-adapters
npm test -- dashboard-managed-presets
npm test -- managed-llama-launch-snapshot
npm test -- chat-sessions-db
npm test -- repo-search-loop.core
npm test -- dashboard-status-server
npm test -- status-server-chat
```

- [ ] **Step 2: Run the broader required validation with large output summarized**

```powershell
npm test 2>&1 | siftkit summary --question "Return pass/fail, failing test names, root errors, and relevant file:line anchors."
npm run typecheck 2>&1 | siftkit summary --question "Return pass/fail and every TypeScript diagnostic with file:line anchors."
npm run lint 2>&1 | siftkit summary --question "Return pass/fail and every lint diagnostic with file:line anchors."
npm run build 2>&1 | siftkit summary --question "Return pass/fail and actionable build errors with file:line anchors."
```

- [ ] **Step 3: Independently inspect the final diff**

Confirm:

- no compatibility alias or ignored `MaxTokens` path remains;
- the 15k constant participates only in compaction/prompt budgeting and compaction-summary generation;
- ordinary planner, chat, summary, and terminal-synthesis requests derive their limit from current prompt position;
- explicit operation caps can only lower the derived amount;
- historical run snapshots were not rewritten;
- no unrelated files changed and no temporary artifacts remain.

- [ ] **Step 4: Report completion without committing**

Report result, changed files, focused and broad validation, any unverified live-provider behavior, and residual risk. Do not commit unless the user explicitly asks.
