# Single Response Reserve Budget Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the shared response reserve the sole context-capacity reservation across SiftKit and prevent tools from executing when no prompt capacity remains for their results.

**Architecture:** Replace reserve-only arithmetic with one resolved context budget containing total context, response reserve, and maximum prompt tokens. Remove the compaction-specific 5k summary-output and 6k headroom carve-outs, make ordinary preflight and tool results consume the same maximum prompt value, and reject zero-capacity tools before approval or execution. Compaction continues to divide the same response reserve internally and dynamically fits against the physical context remainder.

**Tech Stack:** TypeScript 5.9, Zod-derived runtime validation, Node test runner, llama.cpp/EXL3 tokenization, PowerShell-native repository tools.

**Spec:** `docs/superpowers/specs/2026-09-01-single-response-reserve-budget-design.md`

## Global Constraints

- `RESPONSE_RESERVE_TOKENS` remains exactly `15_000`.
- `responseReserveTokens` remains bounded by preset `MaxTokens` and half of tiny context windows.
- The response reserve covers reasoning plus visible output; compaction’s two-thirds/one-third generation allocation remains internal to that reserve.
- No fixed compaction prompt reserve, headroom constant, or summary-output prompt subtraction may remain.
- A tool with zero result capacity must be rejected before approval, progress-start emission, or execution.
- Repo-search retains `force_answer`; repo-agent and chat retain `compact`.
- Purpose-specific output caps below the response reserve remain allowed but must not reduce prompt capacity.
- All code and tests remain TypeScript with inferred types. No `any`, type assertions, non-null assertions, namespace imports, unknown laundering, or unvalidated IO.
- Preserve unrelated working-tree changes and review the dirty-file list again immediately before implementation.
- Do not use worktrees. Do not commit unless the user explicitly requests commits.
- Run high-volume validation through `siftkit summary` as required by repository policy.

---

## File Structure

- Modify `src/lib/response-reserve.ts`: own the complete context-budget resolver.
- Modify `src/lib/dynamic-output-cap.ts`: consume the complete resolver.
- Modify `src/repo-search/engine/turn-budget.ts`: expose `maxPromptTokens`; remove compaction prompt carve-outs.
- Modify `src/repo-search/prompt-budget.ts`: separate token measurement from policy and accept the resolved prompt limit.
- Modify `src/repo-search/engine/prompt-preparer.ts`: pass the one shared prompt limit into preflight.
- Modify `src/repo-search/engine/transcript-compactor.ts`: retain only dynamic physical fitting and the response-reserve generation ceiling.
- Modify `src/repo-search/engine/terminal-synthesizer.ts`: use shared measurement and dynamic output capping without inventing prompt reserves.
- Modify `src/repo-search/engine/tool-action-processor.ts`: reject zero-capacity actions before approval/execution.
- Modify `src/repo-search/engine/tool-result-budgeter.ts`: fail loudly if the pre-execution invariant is violated.
- Modify `src/summary/chunking.ts`, `src/status-server/chat.ts`, and `src/line-read-guidance.ts`: migrate shared-budget consumers.
- Modify focused tests listed per task. Do not create compatibility aliases for removed exports.

---

### Task 1: Introduce the single context-budget resolver

**Files:**
- Modify: `src/lib/response-reserve.ts`
- Modify: `src/lib/dynamic-output-cap.ts`
- Modify: `tests/response-reserve.test.ts`
- Modify: `tests/dynamic-output-cap.test.ts`
- Modify: `tests/engine-token-usage.test.ts`

**Interfaces:**
- Produces: `ContextTokenBudget` and `resolveContextTokenBudget(options)`.
- Removes: `computeResponseReserveTokens(options)`.
- Preserves: `RESPONSE_RESERVE_TOKENS`, `RESPONSE_RESERVE_MAX_CONTEXT_RATIO`, `getPresetMaxTokens`, `clampToPresetMaxTokens`, and `getDynamicMaxOutputTokens`.

- [ ] **Step 1: Replace reserve-only unit expectations with a complete-budget RED test**

In `tests/response-reserve.test.ts`, import `resolveContextTokenBudget` instead of `computeResponseReserveTokens` and add:

```ts
test('the active-sized context resolves one response reserve and one prompt limit', () => {
  const budget = resolveContextTokenBudget({
    totalContextTokens: 155_000,
    config: configWithMaxTokens(15_000),
  });

  assert.deepEqual(budget, {
    totalContextTokens: 155_000,
    responseReserveTokens: 15_000,
    maxPromptTokens: 140_000,
  });
});
```

Migrate the existing half-window, preset-bound, null-config, one-token-floor, and invalid-preset tests to assert the three-field result. For an 8,000-token context with no config, assert `{ totalContextTokens: 8_000, responseReserveTokens: 4_000, maxPromptTokens: 4_000 }`.

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```powershell
npm run build:test
if ($?) { npm test -- tests/response-reserve.test.ts }
```

Expected: build or test failure because `resolveContextTokenBudget` does not exist.

- [ ] **Step 3: Implement the complete resolver and remove the reserve-only API**

Replace `computeResponseReserveTokens` in `src/lib/response-reserve.ts` with:

```ts
export type ContextTokenBudget = {
  totalContextTokens: number;
  responseReserveTokens: number;
  maxPromptTokens: number;
};

export function resolveContextTokenBudget(options: {
  totalContextTokens: number;
  config: SiftConfig | null | undefined;
}): ContextTokenBudget {
  const totalContextTokens = Math.max(1, Math.floor(Number(options.totalContextTokens) || 0));
  const presetMaxTokens = options.config ? getPresetMaxTokens(options.config) : RESPONSE_RESERVE_TOKENS;
  const responseReserveTokens = Math.max(1, Math.min(
    RESPONSE_RESERVE_TOKENS,
    presetMaxTokens,
    Math.floor(totalContextTokens * RESPONSE_RESERVE_MAX_CONTEXT_RATIO),
  ));
  return {
    totalContextTokens,
    responseReserveTokens,
    maxPromptTokens: Math.max(totalContextTokens - responseReserveTokens, 0),
  };
}
```

Do not retain a wrapper or alias named `computeResponseReserveTokens`.

- [ ] **Step 4: Migrate dynamic output capping to the complete resolver**

In `src/lib/dynamic-output-cap.ts`, resolve once and cap generation by both the shared reserve and physical remainder:

```ts
const budget = resolveContextTokenBudget({
  totalContextTokens: options.totalContextTokens,
  config: options.config,
});
const remainingContextTokens = Math.max(budget.totalContextTokens - options.promptTokenCount, 0);
return Math.max(1, Math.min(budget.responseReserveTokens, remainingContextTokens));
```

Update `tests/dynamic-output-cap.test.ts` and `tests/engine-token-usage.test.ts` imports without weakening existing reserve, remaining-context, preset-clamp, and one-token-floor assertions.

- [ ] **Step 5: Run focused tests and verify GREEN**

Run:

```powershell
npm run build:test
if ($?) { npm test -- tests/response-reserve.test.ts }
if ($?) { npm test -- tests/dynamic-output-cap.test.ts }
if ($?) { npm test -- tests/engine-token-usage.test.ts }
```

Expected: all focused tests pass.

---

### Task 2: Collapse TurnBudget onto the shared prompt limit

**Files:**
- Modify: `src/repo-search/engine/turn-budget.ts`
- Modify: `src/line-read-guidance.ts`
- Modify: `tests/engine-turn-budget.test.ts`
- Modify: `tests/line-read-guidance.test.ts`

**Interfaces:**
- Consumes: `resolveContextTokenBudget` from Task 1.
- Produces: `TurnBudget.maxPromptTokens`, `perToolCapTokens`, and `remainingToolAllowance` based on the same value.
- Removes: `COMPACTION_PROMPT_HEADROOM_TOKENS`, `TurnBudget.compactionReserveTokens`, and `TurnBudget.usablePromptTokens`.

- [ ] **Step 1: Rewrite TurnBudget tests to express the single-limit invariant**

Replace the first six tests in `tests/engine-turn-budget.test.ts` with assertions equivalent to:

```ts
test('TurnBudget exposes the shared response reserve and prompt limit', () => {
  const budget = new TurnBudget({ totalContextTokens: 155_000, maxTurns: 45, config: null });
  assert.equal(budget.responseReserveTokens, 15_000);
  assert.equal(budget.maxPromptTokens, 140_000);
});

test('TurnBudget adds no compaction-specific prompt reservation', () => {
  const budget = new TurnBudget({ totalContextTokens: 155_000, maxTurns: 45, config: null });
  assert.equal(budget.remainingToolAllowance(129_000, 0), 11_000);
  assert.equal(budget.remainingToolAllowance(140_000, 0), 0);
});
```

Update all later expected tool caps to use `budget.maxPromptTokens`. For a 100,000-token context with the default 15,000 reserve, the floor-share expectation becomes `Math.floor(85_000 * MIN_TURN_TOOL_RESULT_RATIO)`.

Delete tests that assert the removed 5k/6k reserve arithmetic. Retain tests for small contexts, preset-bound reserves, batch division, progress growth, one-token per-tool floors, remaining allowance, and invalid constructor inputs.

- [ ] **Step 2: Run TurnBudget tests and verify RED**

Run:

```powershell
npm run build:test
if ($?) { npm test -- tests/engine-turn-budget.test.ts }
if ($?) { npm test -- tests/line-read-guidance.test.ts }
```

Expected: failures because `maxPromptTokens` is absent and removed exports still exist.

- [ ] **Step 3: Replace TurnBudget’s derived fields**

Change the class fields and constructor to:

```ts
export class TurnBudget {
  readonly totalContextTokens: number;
  readonly responseReserveTokens: number;
  readonly maxPromptTokens: number;
  private readonly maxTurns: number;

  constructor(options: { totalContextTokens: number; maxTurns: number; config: SiftConfig | null | undefined }) {
    const context = resolveContextTokenBudget({
      totalContextTokens: options.totalContextTokens,
      config: options.config,
    });
    this.totalContextTokens = context.totalContextTokens;
    this.responseReserveTokens = context.responseReserveTokens;
    this.maxPromptTokens = context.maxPromptTokens;
    this.maxTurns = Math.max(1, options.maxTurns);
  }
```

Change `perToolCapTokens` and `remainingToolAllowance` to use `this.maxPromptTokens`. Delete `COMPACTION_PROMPT_HEADROOM_TOKENS` and every comment describing a second prompt reserve. Keep `splitCompactionGenerationTokens`, `COMPACTION_SUMMARY_MIN_OUTPUT_TOKENS`, and `COMPACTION_PROMPT_HEADROOM_TOKENS`’s removal distinct: the split remains; the headroom constant does not.

- [ ] **Step 4: Keep line-read guidance derived from TurnBudget**

Update `src/line-read-guidance.ts` only as required by removed field/import names. `getRepoSearchPromptBaselinePerToolAllowanceTokens` must continue to call `TurnBudget.perToolCapTokens(0, 1)` rather than reproduce the ratio arithmetic.

- [ ] **Step 5: Run focused tests and verify GREEN**

Run:

```powershell
npm run build:test
if ($?) { npm test -- tests/engine-turn-budget.test.ts }
if ($?) { npm test -- tests/line-read-guidance.test.ts }
```

Expected: all focused tests pass and the 155k/15k/140k arithmetic is explicit.

---

### Task 3: Give planner preflight the resolved prompt limit

**Files:**
- Modify: `src/repo-search/prompt-budget.ts`
- Modify: `src/repo-search/engine/prompt-preparer.ts`
- Modify: `src/repo-search/engine/transcript-compactor.ts`
- Modify: `src/repo-search/engine/terminal-synthesizer.ts`
- Modify: `tests/incremental-token-counter.test.ts`
- Modify: `tests/engine-prompt-preparer.test.ts`
- Modify: `tests/engine-transcript-compactor.test.ts`
- Modify: `tests/repo-search-request-normalizers.test.ts`
- Modify: any additional test identified by the required final zero-reference search that still calls the old preflight signature

**Interfaces:**
- Consumes: `TurnBudget.maxPromptTokens` and `responseReserveTokens`.
- Produces: ordinary preflight whose only policy input is `maxPromptTokens`.
- Preserves: exact recount, image-token allowance, token-source telemetry, compaction’s dynamic physical-remainder calculation, and terminal synthesis’s dynamic output cap.

- [ ] **Step 1: Add RED tests for direct prompt-limit policy**

Update preflight tests so the policy call passes `maxPromptTokens` directly:

```ts
const result = await preflightPlannerPromptBudget({
  config,
  prompt,
  maxPromptTokens: 140_000,
  promptTokenCounter,
});
assert.equal(result.maxPromptBudget, 140_000);
```

Add a boundary test proving `promptTokenCount === maxPromptTokens` is accepted and `promptTokenCount === maxPromptTokens + 1` overflows by one. Keep the exact-recount trigger at `maxPromptTokens - EXACT_RECOUNT_MARGIN_TOKENS`.

- [ ] **Step 2: Run focused preflight tests and verify RED**

Run:

```powershell
npm run build:test
if ($?) { npm test -- tests/incremental-token-counter.test.ts }
if ($?) { npm test -- tests/engine-prompt-preparer.test.ts }
```

Expected: compile failures because preflight still expects total context and response reserve separately.

- [ ] **Step 3: Separate prompt measurement from budget comparison**

In `src/repo-search/prompt-budget.ts`, extract the existing render/count/image/exact-recount work into a function that returns the measured fields without deciding policy:

```ts
export async function countPlannerPromptTokens(options: {
  config?: SiftConfig;
  prompt: WirePrompt;
  promptTokenCounter?: PromptTokenCounter;
  exactRecountThresholdTokens?: number;
}): Promise<PromptTokenMeasurement>;
```

Define the measurement type from the existing preflight result rather than duplicating provider-tokenization fields:

```ts
export type PromptTokenMeasurement = Omit<
  PreflightResult,
  'ok' | 'maxPromptBudget' | 'overflowTokens'
>;
```

Then make `preflightPlannerPromptBudget` accept `maxPromptTokens` and derive only:

```ts
const overflowTokens = Math.max(measurement.promptTokenCount - options.maxPromptTokens, 0);
return {
  ...measurement,
  ok: overflowTokens === 0,
  maxPromptBudget: options.maxPromptTokens,
  overflowTokens,
};
```

No caller may reconstruct `totalContextTokens - responseReserveTokens` inside this module.

- [ ] **Step 4: Migrate PromptPreparer to `budget.maxPromptTokens`**

Both initial and post-compaction calls in `src/repo-search/engine/prompt-preparer.ts` must pass:

```ts
maxPromptTokens: budget.maxPromptTokens
```

Keep `getDynamicMaxOutputTokens` driven by `budget.totalContextTokens`, the measured prompt count, and the shared config. Preserve existing `maxPromptBudget` telemetry, now sourced from the passed limit.

- [ ] **Step 5: Migrate compactor and terminal synthesis measurement without introducing a reserve**

Use `countPlannerPromptTokens` in `TranscriptCompactor.resolveSummaryGenerationTokens` and `TerminalSynthesizer.synthesize`. These paths need an actual prompt count, not a fake preflight with `responseReserveTokens: 0`.

For compaction, retain:

```ts
const remainingTokens = this.options.totalContextTokens - measurement.promptTokenCount;
const requestedTokens = splitCompactionGenerationTokens(this.options.responseReserveTokens);
```

and the existing clamps to physical remainder. Remove the comment claiming that `TurnBudget` keeps a compaction floor available. Keep the explicit `< COMPACTION_SUMMARY_MIN_OUTPUT_TOKENS` failure.

For terminal synthesis, count the actual prompt and call `getDynamicMaxOutputTokens`; do not add another prompt threshold or reserve.

- [ ] **Step 6: Replace compaction-reserve tests with dynamic-fit tests**

In `tests/engine-transcript-compactor.test.ts`, delete the worst-case transcript formula based on `usablePromptTokens + responseReserveTokens`. Add cases proving:

```ts
assert.equal(outcome.summaryGenerationTokenBudget <= responseReserveTokens, true);
assert.equal(
  outcome.summaryGenerationTokenBudget,
  outcome.summaryReasoningTokenBudget + outcome.summaryOutputTokenBudget,
);
```

Add one near-full physical-context case where the generated budget is clamped below the 15k ceiling but remains above `COMPACTION_SUMMARY_MIN_OUTPUT_TOKENS`, and retain the existing explicit overflow case below that minimum.

- [ ] **Step 7: Run focused tests and verify GREEN**

Run:

```powershell
npm run build:test
if ($?) { npm test -- tests/incremental-token-counter.test.ts }
if ($?) { npm test -- tests/engine-prompt-preparer.test.ts }
if ($?) { npm test -- tests/engine-transcript-compactor.test.ts }
if ($?) { npm test -- tests/repo-search-request-normalizers.test.ts }
```

Expected: all focused tests pass; ordinary planner preflight has one policy threshold and compaction uses measured physical remainder.

---

### Task 4: Reject zero-capacity tools before approval or execution

**Files:**
- Modify: `src/repo-search/engine/turn-budget.ts`
- Modify: `src/repo-search/engine/tool-action-processor.ts`
- Modify: `src/repo-search/engine/tool-result-budgeter.ts`
- Modify: `tests/engine-tool-action-processor.test.ts`
- Modify: `tests/engine-tool-result-budgeter.test.ts`
- Modify: `tests/helpers/tool-action-processor.ts` only if a counter/approval probe cannot be injected through its current options

**Interfaces:**
- Consumes: `TurnBudget.maxPromptTokens`, `perToolCapTokens`, and `remainingToolAllowance`.
- Produces: a discriminated `ToolResultCapacity` resolved before side effects.
- Preserves: existing `rejectionKind: 'budget'`, command/result alignment, batch ordering, approval semantics, duplicate screening, and forced-finish behavior.

- [ ] **Step 1: Add a RED zero-capacity side-effect test**

In `tests/engine-tool-action-processor.test.ts`, construct a processor with a counting approval gate and a mocked `run` result, then call:

```ts
await processor.executeBatch(
  1,
  [{ kind: 'tool', callId: 'zero_capacity', toolName: 'run', args: { command: 'Write-Output should-not-run' } }],
  '',
  budget.maxPromptTokens,
  false,
);
```

Assert all of the following:

```ts
assert.equal(approvalRequestCount, 0);
assert.equal(events.some((event) => event.kind === 'turn_command_start'), false);
assert.equal(commands.length, 1);
assert.equal(commands[0]?.safe, false);
assert.equal(commands[0]?.exitCode, null);
assert.match(commands[0]?.reason ?? '', /context budget exhausted/u);
assert.match(commands[0]?.output ?? '', /tool was not executed/u);
assert.match(JSON.stringify(transcript.getMessages()), /reissue the action after compaction/u);
```

Add a three-action batch test at zero capacity and assert three aligned rejected command entries and zero starts/executions.

- [ ] **Step 2: Run processor tests and verify RED**

Run:

```powershell
npm run build:test
if ($?) { npm test -- tests/engine-tool-action-processor.test.ts }
```

Expected: the current implementation invokes approval and executes the tool before discovering zero allowance.

- [ ] **Step 3: Add a typed pre-execution capacity result**

In `turn-budget.ts`, add:

```ts
export type ToolResultCapacity =
  | { kind: 'available'; perToolCapTokens: number; remainingTokenAllowance: number }
  | { kind: 'exhausted'; perToolCapTokens: number; remainingTokenAllowance: 0 };

resolveToolResultCapacity(options: {
  promptTokenCount: number;
  acceptedToolPromptTokensThisTurn: number;
  completedCommandCount: number;
  batchCommandCount: number;
}): ToolResultCapacity;
```

The method calls the existing cap/allowance methods exactly once and returns `exhausted` only when allowance is zero. Do not add a second threshold.

- [ ] **Step 4: Move capacity resolution before approval and execution**

In `ToolActionProcessor.processToolAction`, resolve capacity after validation, forced-finish screening, and duplicate/safety-independent screening, but before the approval gate. When exhausted, call the existing rejected-command path with:

```text
context budget exhausted: prompt_tokens=<value> max_prompt_tokens=<value> remaining_tool_tokens=0; tool was not executed. Reissue the action after compaction.
```

Use `rejectionKind: 'budget'`, increment `rejectedCalls`, and return `next`. Do not emit `turn_command_start`, call the approval gate, decay invalid responses, alter non-zero exit counts, or register tool-output novelty.

Pass the available capacity through `AcceptedToolContext` into `executeAcceptedTool` and `fitToolResult`; do not recompute it after side effects.

- [ ] **Step 5: Make ToolResultBudgeter reject zero allowance**

Replace:

```ts
Math.max(1, options.remainingTokenAllowance)
```

with an explicit invariant check before token fitting:

```ts
if (!Number.isInteger(options.remainingTokenAllowance) || options.remainingTokenAllowance < 1) {
  throw new Error(
    `tool_result_budget_invalid task=${options.taskId} turn=${options.turn} `
      + `tool=${options.toolName} remaining_tool_tokens=${options.remainingTokenAllowance}`,
  );
}
```

Add a unit test passing zero and assert rejection with `tool_result_budget_invalid`. Keep all existing successful and failed-output fitting tests.

- [ ] **Step 6: Run focused tests and verify GREEN**

Run:

```powershell
npm run build:test
if ($?) { npm test -- tests/engine-tool-action-processor.test.ts }
if ($?) { npm test -- tests/engine-tool-result-budgeter.test.ts }
if ($?) { npm test -- tests/engine-turn-budget.test.ts }
```

Expected: all tests pass; zero-capacity tools are represented as non-executed budget rejections.

---

### Task 5: Migrate every shared-budget consumer

**Files:**
- Modify: `src/summary/chunking.ts`
- Modify: `src/status-server/chat.ts`
- Modify: `src/providers/llama-cpp.ts`
- Modify: any remaining current source importing `computeResponseReserveTokens`
- Modify: `tests/host-sync.test.ts`
- Modify: `tests/runtime-planner-token-aware.test.ts`
- Modify: `tests/runtime-planner-mode.test.ts`
- Modify: any focused consumer test found by the required zero-reference search

**Interfaces:**
- Consumes: `resolveContextTokenBudget` from Task 1.
- Produces: no new interface; completes the replacement migration.

- [ ] **Step 1: Run a source-and-test reference audit before edits**

Run:

```powershell
rg -n "computeResponseReserveTokens|COMPACTION_PROMPT_HEADROOM_TOKENS|compactionReserveTokens|usablePromptTokens" src tests packages dashboard
```

Expected before migration: every remaining consumer is listed. Save no temporary output file.

- [ ] **Step 2: Migrate idle-summary prompt budgeting**

In `src/summary/chunking.ts`, replace reserve-only resolution with:

```ts
const budget = resolveContextTokenBudget({ totalContextTokens: numCtxTokens, config });
return {
  numCtxTokens: budget.totalContextTokens,
  responseReserveTokens: budget.responseReserveTokens,
  plannerStopLineTokens: budget.maxPromptTokens,
};
```

Keep the public `PlannerPromptBudget` shape unless a direct rename is already required by current code; do not add aliases. Update host-sync and runtime-planner tests to preserve their existing behavioral assertions.

- [ ] **Step 3: Migrate manual chat condense and provider defaults**

In `src/status-server/chat.ts`, resolve the complete budget once for manual condense and pass `budget.responseReserveTokens` to `TranscriptCompactor`.

In `src/providers/llama-cpp.ts`, ensure default dynamic output capping reaches `resolveContextTokenBudget` only through `getDynamicMaxOutputTokens`; do not duplicate reserve arithmetic locally.

- [ ] **Step 4: Remove every obsolete current-code reference**

Run the same `rg` command. Expected: zero matches in `src`, `tests`, `packages`, and `dashboard` for all four removed names. Historical files under `docs/superpowers/plans` and `docs/superpowers/handoffs` are excluded intentionally.

- [ ] **Step 5: Run focused consumer tests**

Run:

```powershell
npm run build:test
if ($?) { npm test -- tests/host-sync.test.ts }
if ($?) { npm test -- tests/runtime-planner-token-aware.test.ts }
if ($?) { npm test -- tests/runtime-planner-mode.test.ts }
if ($?) { npm test -- tests/line-read-guidance.test.ts }
if ($?) { npm test -- tests/dynamic-output-cap.test.ts }
```

Expected: all focused tests pass.

---

### Task 6: Add loop-level regressions for the former blind zone

**Files:**
- Modify: `tests/mock-repo-search-loop.test.ts`
- Modify: `tests/repo-search-loop.core.test.ts`
- Modify: `tests/live-run-snapshot-collector.test.ts` only if telemetry fixture changes are required

**Interfaces:**
- Consumes: single-limit preflight and pre-execution budget rejection from Tasks 2–4.
- Produces: end-to-end proof for repo-agent/chat compaction and repo-search force-answer behavior.

- [ ] **Step 1: Add an arithmetic regression matching the observed run**

Create a mock repo-agent case with a 155,000-token context, 15,000-token preset maximum, and a prompt count between 129,000 and 140,000. Have the model issue one mocked tool action and assert:

```ts
assert.equal(result.scorecard.tasks[0]?.commands[0]?.safe, true);
assert.notEqual(result.scorecard.tasks[0]?.commands[0]?.output, '1 lines truncated due to per-tool context limit.');
```

The assertion must prove that the old 129k boundary no longer exists, not merely that compaction eventually occurs.

- [ ] **Step 2: Add compacting-loop recovery coverage**

Construct a repo-agent mock sequence where the first tool action arrives with `promptTokenCount === maxPromptTokens`, is budget-rejected without execution, the next turn compacts, and the model reissues the action. Assert:

- The first action has `exitCode: null` and “tool was not executed”.
- Exactly one `turn_preflight_compaction_applied` event occurs.
- The reissued action executes exactly once.
- The final reason is `finish`.
- No command from the blocked attempt produced a side effect.

Add the same behavioral assertion for chat only if the shared TaskLoop test does not already parameterize task kind; otherwise parameterize one test over `repo-agent` and `chat`.

- [ ] **Step 3: Add repo-search force-answer coverage**

Create the same zero-capacity action under task kind `plan`/loop kind `repo-search`. Assert that the tool does not execute and the task exits through `context_overflow`/terminal synthesis according to the existing force-answer policy, with no compaction event.

- [ ] **Step 4: Run loop-level tests and verify GREEN**

Run:

```powershell
npm run build:test
if ($?) { npm test -- tests/mock-repo-search-loop.test.ts }
if ($?) { npm test -- tests/repo-search-loop.core.test.ts }
if ($?) { npm test -- tests/live-run-snapshot-collector.test.ts }
```

Expected: all loop-level regressions pass.

---

### Task 7: Update current documentation and run full validation

**Files:**
- Modify: current non-historical architecture/configuration documentation identified by `rg`
- Verify: `docs/superpowers/specs/2026-09-01-single-response-reserve-budget-design.md`
- Verify: `docs/superpowers/plans/2026-09-01-single-response-reserve-budget.md`

**Interfaces:**
- Consumes: completed implementation.
- Produces: documented invariant and independently verified green tree.

- [ ] **Step 1: Update current documentation**

Search current docs outside historical plans/handoffs:

```powershell
rg -n "compaction reserve|usablePromptTokens|compactionReserveTokens|COMPACTION_PROMPT_HEADROOM_TOKENS|response reserve" README.md docs --glob "!docs/superpowers/plans/**" --glob "!docs/superpowers/handoffs/**"
```

Update only active documentation. State the invariant exactly as:

```text
maxPromptTokens = totalContextTokens - responseReserveTokens
```

State that compaction’s reasoning/output split is internal to the response reserve and does not reduce prompt capacity.

- [ ] **Step 2: Run formatting if required by changed files**

Run the repository’s existing formatter only on changed TypeScript/Markdown files if formatting checks identify drift. Do not bulk-format unrelated files.

- [ ] **Step 3: Run all focused budget and loop tests together**

Run:

```powershell
npm run build:test
if ($?) { npm test -- tests/response-reserve.test.ts }
if ($?) { npm test -- tests/dynamic-output-cap.test.ts }
if ($?) { npm test -- tests/engine-turn-budget.test.ts }
if ($?) { npm test -- tests/engine-tool-result-budgeter.test.ts }
if ($?) { npm test -- tests/engine-tool-action-processor.test.ts }
if ($?) { npm test -- tests/engine-prompt-preparer.test.ts }
if ($?) { npm test -- tests/engine-transcript-compactor.test.ts }
if ($?) { npm test -- tests/mock-repo-search-loop.test.ts }
if ($?) { npm test -- tests/repo-search-loop.core.test.ts }
if ($?) { npm test -- tests/host-sync.test.ts }
if ($?) { npm test -- tests/runtime-planner-token-aware.test.ts }
if ($?) { npm test -- tests/runtime-planner-mode.test.ts }
if ($?) { npm test -- tests/line-read-guidance.test.ts }
```

Expected: all focused tests pass.

- [ ] **Step 4: Run the broader applicable suite through SiftKit summary**

Run:

```powershell
npm test 2>&1 | siftkit summary --question "Return pass/fail, failing test names, root errors, counts, and relevant file:line anchors."
```

Expected: pass with zero failing tests.

- [ ] **Step 5: Run typecheck and lint through SiftKit summary**

Run:

```powershell
npm run typecheck 2>&1 | siftkit summary --question "Return pass/fail and every actionable TypeScript or lint diagnostic with file:line anchors."
```

Then run the explicit lint command because repository completion requires it even if typecheck currently invokes lint internally:

```powershell
npm run lint 2>&1 | siftkit summary --question "Return pass/fail and every actionable lint diagnostic with file:line anchors."
```

Expected: both pass.

- [ ] **Step 6: Verify the removed architecture is absent**

Run:

```powershell
rg -n "computeResponseReserveTokens|COMPACTION_PROMPT_HEADROOM_TOKENS|compactionReserveTokens|usablePromptTokens" src tests packages dashboard
```

Expected: zero matches.

Run:

```powershell
rg -n "RESPONSE_RESERVE_TOKENS|resolveContextTokenBudget|maxPromptTokens" src tests packages dashboard
```

Review the results and verify every context-capacity calculation routes through `resolveContextTokenBudget` or a `TurnBudget` constructed from it. Purpose-specific output caps may remain but must not reduce prompt capacity.

- [ ] **Step 7: Review the final diff and report risks**

Review only changed files. Confirm:

- No unrelated user changes were overwritten.
- No compatibility aliases or parallel budget paths remain.
- No tool can execute with zero result capacity.
- Compaction still has at least 512 visible-output tokens or fails explicitly.
- Repo-search, repo-agent, chat, manual condense, idle summary, terminal synthesis, and provider defaults all obey the single response-reserve authority.

Report result, changed files, focused and broad validation, and any unverified live EXL3 behavior. Do not commit unless requested.

---

## Plan Self-Review

- Spec coverage: every approved invariant and acceptance criterion maps to Tasks 1–7.
- Replacement completeness: obsolete APIs and fields have explicit zero-reference gates; no compatibility layer is planned.
- Type consistency: `ContextTokenBudget`, `resolveContextTokenBudget`, `TurnBudget.maxPromptTokens`, and `ToolResultCapacity` have one definition each and are consumed by later tasks under the same names.
- TDD: each behavioral change begins with a failing focused test and ends with focused verification.
- Safety: zero-capacity actions are blocked before approval and execution; the plan does not broaden mutation authority.
- Scope: validation-output shaping, duplicate detection, raw-output persistence, and transactional rollback remain explicitly outside this plan.
