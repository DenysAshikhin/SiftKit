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
- `npm run build:test` runs `tsc` over every file under `tests/` (`tsconfig.test-build.json`). A task that removes an export or a class field must migrate every source and test reference in that same task, or the build stays red for every later task.

---

## File Structure

- Modify `src/lib/response-reserve.ts`: own the complete context-budget resolver.
- Modify `src/lib/dynamic-output-cap.ts`, `src/summary/chunking.ts`, `src/status-server/chat.ts`: consume the complete resolver (all current importers of the removed function move in Task 1).
- Modify `src/repo-search/engine/turn-budget.ts`: expose `maxPromptTokens`; remove compaction prompt carve-outs.
- Modify `src/repo-search/prompt-budget.ts`: separate token measurement from policy and accept the resolved prompt limit.
- Modify `src/repo-search/engine/prompt-preparer.ts`: pass the one shared prompt limit into preflight.
- Modify `src/repo-search/engine/transcript-compactor.ts`: retain only dynamic physical fitting and the response-reserve generation ceiling.
- Modify `src/repo-search/engine/terminal-synthesizer.ts`: use shared measurement and dynamic output capping without inventing prompt reserves.
- Modify `src/repo-search/engine/tool-action-processor.ts`: reject zero-capacity actions before approval/execution.
- Modify `src/repo-search/engine/tool-result-budgeter.ts`: fail loudly if the pre-execution invariant is violated.
- Modify `src/line-read-guidance.ts`: only if removed field names require it.
- Verify `src/providers/llama-cpp.ts`: already reaches the reserve only through `getDynamicMaxOutputTokens`; no edit expected.
- Modify focused tests listed per task. Do not create compatibility aliases for removed exports.

---

### Task 1: Introduce the single context-budget resolver

**Files:**
- Modify: `src/lib/response-reserve.ts`
- Modify: `src/lib/dynamic-output-cap.ts`
- Modify: `src/summary/chunking.ts` (importer of the removed function)
- Modify: `src/status-server/chat.ts` (importer of the removed function)
- Modify: `src/repo-search/engine/turn-budget.ts` (call site only; the class is rewritten in Task 2)
- Modify: `tests/response-reserve.test.ts`
- Verify: `tests/dynamic-output-cap.test.ts`, `tests/engine-token-usage.test.ts` (import only `RESPONSE_RESERVE_TOKENS` / `getDynamicMaxOutputTokens`; no edit expected)

**Interfaces:**
- Produces: `ContextTokenBudget` and `resolveContextTokenBudget(options)`.
- Removes: `computeResponseReserveTokens(options)`. Current importers: `dynamic-output-cap.ts`, `turn-budget.ts`, `summary/chunking.ts`, `status-server/chat.ts`, `tests/response-reserve.test.ts`. All five migrate in this task.
- Preserves: `RESPONSE_RESERVE_TOKENS`, `RESPONSE_RESERVE_MAX_CONTEXT_RATIO`, `getPresetMaxTokens`, `clampToPresetMaxTokens`, `getDynamicMaxOutputTokens`, and the `PlannerPromptBudget` shape in `src/summary/types.ts`.

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

`tests/dynamic-output-cap.test.ts` and `tests/engine-token-usage.test.ts` need no import changes; keep their reserve, remaining-context, preset-clamp, and one-token-floor assertions unchanged.

- [ ] **Step 4b: Migrate the remaining importers so the build stays green**

`src/summary/chunking.ts` — `getPlannerPromptBudget` resolves the complete budget:

```ts
const budget = resolveContextTokenBudget({ totalContextTokens: getConfiguredLlamaNumCtx(config), config });
return {
  numCtxTokens: budget.totalContextTokens,
  responseReserveTokens: budget.responseReserveTokens,
  plannerStopLineTokens: budget.maxPromptTokens,
};
```

The reserve-characters helper below it (`getChunkThresholdCharacters` subtraction, currently `chunking.ts:238-242`) selects `resolveContextTokenBudget({ ... }).responseReserveTokens`. Keep the public `PlannerPromptBudget` shape; do not add aliases.

`src/status-server/chat.ts` (manual condense, currently `chat.ts:852-859`) — resolve the complete budget once and pass `budget.responseReserveTokens` to `TranscriptCompactor`.

`src/repo-search/engine/turn-budget.ts` — swap the constructor call site to `resolveContextTokenBudget({ ... }).responseReserveTokens` only; leave the rest of the class for Task 2.

- [ ] **Step 5: Run focused tests and verify GREEN**

Run:

```powershell
npm run build:test
if ($?) { npm test -- tests/response-reserve.test.ts }
if ($?) { npm test -- tests/dynamic-output-cap.test.ts }
if ($?) { npm test -- tests/engine-token-usage.test.ts }
if ($?) { npm test -- tests/host-sync.test.ts }
if ($?) { npm test -- tests/runtime-planner-token-aware.test.ts }
```

Expected: all focused tests pass with no changes to `host-sync` or `runtime-planner-token-aware` assertions (their `plannerStopLineTokens` expectations are already `NumCtx - reserve`).

---

### Task 2: Collapse TurnBudget onto the shared prompt limit

**Files:**
- Modify: `src/repo-search/engine/turn-budget.ts`
- Verify: `src/line-read-guidance.ts` (uses only `TurnBudget.perToolCapTokens`; no edit expected)
- Modify: `tests/engine-turn-budget.test.ts`
- Modify: `tests/engine-transcript-compactor.test.ts` (the `usablePromptTokens` worst-case loop, currently line ~378)
- Modify: `tests/mock-repo-search-loop.test.ts` (the `usablePromptTokens` scenario, currently line ~1021)
- Verify: `tests/line-read-guidance.test.ts` (compares against `TurnBudget.perToolCapTokens(0, 1)`; no edit expected)

**Interfaces:**
- Consumes: `resolveContextTokenBudget` from Task 1.
- Produces: `TurnBudget.maxPromptTokens`, `perToolCapTokens`, and `remainingToolAllowance` based on the same value.
- Removes: `COMPACTION_PROMPT_HEADROOM_TOKENS`, `TurnBudget.compactionReserveTokens`, and `TurnBudget.usablePromptTokens`. Current references outside `turn-budget.ts`: `tests/engine-turn-budget.test.ts`, `tests/engine-transcript-compactor.test.ts:381`, `tests/mock-repo-search-loop.test.ts:1027`. All migrate in this task.

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

Update all later expected tool caps to use `budget.maxPromptTokens`. For a 100,000-token context with the default 15,000 reserve, the floor-share expectation becomes `Math.floor(85_000 * MIN_TURN_TOOL_RESULT_RATIO)` (6,375, replacing 5,550). The `remainingToolAllowance` and invalid-constructor tests switch from `usablePromptTokens` to `maxPromptTokens` (`-10` context resolves to `totalContextTokens: 1`, `responseReserveTokens: 1`, `maxPromptTokens: 0`).

Delete tests that assert the removed 5k/6k reserve arithmetic. Retain tests for small contexts, preset-bound reserves, batch division, progress growth, one-token per-tool floors, remaining allowance, and invalid constructor inputs.

In `tests/engine-transcript-compactor.test.ts`, replace the `for (const totalContextTokens of [150_000, 32_000, 9_000])` worst-case loop (it computes `usablePromptTokens + responseReserveTokens`) with dynamic-fit cases:

```ts
assert.equal(outcome.summaryGenerationTokenBudget <= budget.responseReserveTokens, true);
assert.equal(
  outcome.summaryGenerationTokenBudget,
  outcome.summaryReasoningTokenBudget + outcome.summaryOutputTokenBudget,
);
```

Add one near-full physical-context case (transcript sized so `totalContextTokens - promptTokenCount` lands between `COMPACTION_SUMMARY_MIN_OUTPUT_TOKENS` and the reserve) proving the generation budget is clamped below the reserve ceiling but still compacts. The existing explicit-overflow case below the minimum stays. These assertions hold against the current compactor, so they are GREEN once `TurnBudget` compiles; Task 3 only changes how the compactor measures its prompt.

In `tests/mock-repo-search-loop.test.ts` (`runTaskLoop fits tool output that exceeds remaining token allowance`), replace `budget.usablePromptTokens` with `budget.maxPromptTokens` and rewrite the comment: 50,500 total minus the 15,000 reserve leaves 35,500 prompt tokens. The scenario is relative to the cap, so its assertions are unchanged.

- [ ] **Step 2: Run TurnBudget tests and verify RED**

Run:

```powershell
npm run build:test
if ($?) { npm test -- tests/engine-turn-budget.test.ts }
if ($?) { npm test -- tests/line-read-guidance.test.ts }
```

Expected: `build:test` fails because `maxPromptTokens` is absent on `TurnBudget` while the rewritten tests read it.

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

Change `perToolCapTokens` and `remainingToolAllowance` to use `this.maxPromptTokens`. Delete `COMPACTION_PROMPT_HEADROOM_TOKENS`. Keep `splitCompactionGenerationTokens` and `COMPACTION_SUMMARY_MIN_OUTPUT_TOKENS`.

Rewrite the two comments that describe a prompt-side reserve: the `splitCompactionGenerationTokens` doc comment (“it sizes the prompt-side compaction reserve”) now states that the output share is a floor internal to the response reserve; the `MIN_TURN_TOOL_RESULT_RATIO` comment refers to `maxPromptTokens`, not “usable prompt tokens”.

- [ ] **Step 4: Keep line-read guidance derived from TurnBudget**

`src/line-read-guidance.ts` reads only `TurnBudget.perToolCapTokens(0, 1)` and needs no edit. Confirm it still calls that method rather than reproducing the ratio arithmetic.

- [ ] **Step 5: Run focused tests and verify GREEN**

Run:

```powershell
npm run build:test
if ($?) { npm test -- tests/engine-turn-budget.test.ts }
if ($?) { npm test -- tests/line-read-guidance.test.ts }
if ($?) { npm test -- tests/engine-transcript-compactor.test.ts }
if ($?) { npm test -- tests/mock-repo-search-loop.test.ts }
```

Expected: all focused tests pass and the 155k/15k/140k arithmetic is explicit.

---

### Task 3: Give planner preflight the resolved prompt limit

**Files:**
- Modify: `src/repo-search/prompt-budget.ts`
- Modify: `src/repo-search/engine/prompt-preparer.ts`
- Modify: `src/repo-search/engine/transcript-compactor.ts`
- Modify: `src/repo-search/engine/terminal-synthesizer.ts`
- Modify: `tests/incremental-token-counter.test.ts` (direct preflight calls at lines ~156-265)
- Modify: `tests/token-count-source.test.ts` (direct preflight calls at lines ~36, ~62, ~86)
- Modify: `tests/mock-repo-search-loop.test.ts` (direct preflight calls at lines ~788-830)
- Modify: `tests/live-repo-agent-compaction-replay.test.ts` (direct preflight call at line ~236; live-gated but compiled by `build:test`)
- Verify: `tests/engine-prompt-preparer.test.ts` (drives preflight through `PromptPreparer`; passes `budget.responseReserveTokens` only to `TranscriptCompactor`, which is unchanged)
- Verify: `tests/engine-transcript-compactor.test.ts` (already migrated in Task 2; rerun)

**Interfaces:**
- Consumes: `TurnBudget.maxPromptTokens` and `responseReserveTokens`.
- Produces: ordinary preflight whose only policy input is `maxPromptTokens`.
- Preserves: exact recount, image-token allowance, token-source telemetry, compaction’s dynamic physical-remainder calculation, and terminal synthesis’s dynamic output cap.

- [ ] **Step 1: Add RED tests for direct prompt-limit policy**

Every direct `preflightPlannerPromptBudget` call in the four listed test files currently passes `totalContextTokens` and `responseReserveTokens`. Rewrite each to pass the difference as `maxPromptTokens` (for example the mock-loop case with 7,000/4,000 becomes `maxPromptTokens: 3_000` and keeps its `maxPromptBudget === 3_000` assertion):

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
```

Expected: `build:test` fails because preflight still expects total context and response reserve separately.

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

`preflightPlannerPromptBudget` passes `exactRecountThresholdTokens: options.maxPromptTokens - EXACT_RECOUNT_MARGIN_TOKENS` into the measurement. Callers without a `promptTokenCounter` (compactor, terminal synthesis) omit the threshold; the one-shot counter is never approximate, so no recount is reachable there.

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

- [ ] **Step 6: Run focused tests and verify GREEN**

Run:

```powershell
npm run build:test
if ($?) { npm test -- tests/incremental-token-counter.test.ts }
if ($?) { npm test -- tests/token-count-source.test.ts }
if ($?) { npm test -- tests/engine-prompt-preparer.test.ts }
if ($?) { npm test -- tests/engine-transcript-compactor.test.ts }
if ($?) { npm test -- tests/mock-repo-search-loop.test.ts }
```

Expected: all focused tests pass; ordinary planner preflight has one policy threshold and compaction uses measured physical remainder. The compactor dynamic-fit tests added in Task 2 stay green.

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
assert.match(JSON.stringify(transcript.getMessages()), /Reissue the action after compaction/u);
```

`makeProcessor` builds a 20,000-token `TurnBudget`, so `budget.maxPromptTokens` is 10,000 and the allowance at that prompt count is zero. Pass `['run']` as the allowed tools, a counting `approvalGate`, and a `mockCommandResults` entry for the command; all three are existing `makeProcessor` parameters.

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

In `ToolActionProcessor.processToolAction`, resolve capacity after validation and forced-finish screening, and before `beginRun`, duplicate screening, and the approval gate. `RunFullOutputGate.beginRun` records state for full-output validation commands, so it must not observe a request that never executes; `DuplicateTracker.classify` has no side effects, but it depends on the `beginRun` decision, so it moves after the capacity check as well. When exhausted, call the existing rejected-command path with:

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

### Task 5: Audit shared-budget consumers

The source migrations formerly in this task moved into Task 1 (they are importers of the removed function and had to move with it). This task is the zero-reference gate plus the consumer regression run.

**Files:**
- Verify: `src/providers/llama-cpp.ts` (reaches the reserve only through `getDynamicMaxOutputTokens` at line ~402; no local reserve arithmetic)
- Verify: `tests/host-sync.test.ts`, `tests/runtime-planner-token-aware.test.ts`, `tests/runtime-planner-mode.test.ts` (assert `plannerStopLineTokens === NumCtx - reserve`; unchanged behavior)

**Interfaces:**
- Consumes: `resolveContextTokenBudget` from Task 1 and `TurnBudget` from Task 2.
- Produces: no new interface; proves the replacement migration is complete.

- [ ] **Step 1: Confirm every obsolete reference is gone**

Run:

```powershell
rg -n "computeResponseReserveTokens|COMPACTION_PROMPT_HEADROOM_TOKENS|compactionReserveTokens|usablePromptTokens" src tests packages dashboard
```

Expected: zero matches. Any hit is a missed migration from Task 1 or Task 2 and is fixed here before continuing. Historical files under `docs/superpowers/plans` and `docs/superpowers/handoffs` are excluded intentionally. Save no temporary output file.

- [ ] **Step 2: Confirm the provider adds no reserve arithmetic**

Read `src/providers/llama-cpp.ts` around the `getDynamicMaxOutputTokens` call. Expected: no local `RESPONSE_RESERVE_TOKENS` or `resolveContextTokenBudget` use. If any exists, remove it so the cap comes only through `getDynamicMaxOutputTokens`.

- [ ] **Step 3: Run focused consumer tests**

Run:

```powershell
npm run build:test
if ($?) { npm test -- tests/host-sync.test.ts }
if ($?) { npm test -- tests/runtime-planner-token-aware.test.ts }
if ($?) { npm test -- tests/runtime-planner-mode.test.ts }
if ($?) { npm test -- tests/line-read-guidance.test.ts }
if ($?) { npm test -- tests/dynamic-output-cap.test.ts }
```

Expected: all focused tests pass with no assertion changes.

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

Create a mock repo-agent case with a 155,000-token context, 15,000-token preset maximum, and a prompt count between 129,000 and 140,000 (mock mode estimates at `getTokenEstimateCharactersPerToken` characters per token; size the question the same way the existing `runTaskLoop fits tool output that exceeds remaining token allowance` case does). Have the model issue one mocked tool action with a short stdout and assert:

```ts
const command = result.scorecard.tasks[0]?.commands[0];
assert.equal(command?.safe, true);
assert.match(command?.output ?? '', /<the mocked stdout>/u);
assert.doesNotMatch(command?.output ?? '', /truncated due to per-tool context limit/u);
```

The assertion must prove that the old 129k boundary no longer exists (the result is inserted intact, not collapsed to the truncation marker), not merely that compaction eventually occurs.

- [ ] **Step 2: Add compacting-loop recovery coverage**

Zero allowance with a healthy preflight occurs at exactly `promptTokenCount === maxPromptTokens` or, more robustly, inside a batch once earlier results consume the remainder. Construct a repo-agent mock sequence whose first turn issues a two-action batch with the prompt a few hundred tokens under `maxPromptTokens`: the first action's mocked output is larger than the remaining allowance (it is fitted to the remainder), so the second action resolves zero capacity and is budget-rejected without execution. The next turn overflows, compacts, and the model reissues the second action. Assert:

- The blocked action has `exitCode: null` and “tool was not executed”, and no `turn_command_start` event names its command.
- Exactly one `turn_preflight_compaction_applied` event occurs.
- The reissued action executes exactly once (one `turn_command_start` for its command).
- The final reason is `finish`.
- No command from the blocked attempt produced a side effect.

Add the same behavioral assertion for chat only if the shared TaskLoop test does not already parameterize task kind; otherwise parameterize one test over `repo-agent` and `chat`.

- [ ] **Step 3: Add repo-search force-answer coverage**

Create the same zero-capacity batch under task kind `repo-search` (loop kind `repo-search`, `contextOverflowPolicy: 'force_answer'`). Assert that the blocked tool does not execute (no `turn_command_start` for it), the next turn logs `turn_context_overflow_forced_answer`, `result.reason === 'context_overflow'`, and no `turn_preflight_compaction_applied` event occurs.

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
rg -n "compaction reserve|usablePromptTokens|compactionReserveTokens|COMPACTION_PROMPT_HEADROOM_TOKENS|response reserve" README.md docs --glob "!docs/superpowers/plans/**" --glob "!docs/superpowers/handoffs/**" --glob "!docs/superpowers/specs/**"
```

Earlier dated specs (`2026-08-20-llm-compaction-design.md`, `2026-08-28-compaction-continuation-budget-design.md`) describe the superseded design and are historical records like plans and handoffs; they are not rewritten. At the time of writing this search returns no active documentation, so this step is a gate: if it finds any, update only active documentation and state the invariant exactly as:

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
if ($?) { npm test -- tests/incremental-token-counter.test.ts }
if ($?) { npm test -- tests/token-count-source.test.ts }
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
- Build-scope ordering: `build:test` type-checks all tests together, so each removal (Task 1 function, Task 2 fields, Task 3 preflight signature) migrates every source and test reference in the same task; the tree is green at the end of every task.
- Known pre-existing risk (not introduced here): a transcript that reaches preflight at `maxPromptTokens`, then gains a full 15k response plus a tool result, can present the compactor with a summary request near `totalContextTokens`, which fails explicitly with `planner_compaction_prompt_overflow`. The removed compaction reserve never bounded the response share, so the worst case is unchanged; the spec keeps the explicit failure.
- Type consistency: `ContextTokenBudget`, `resolveContextTokenBudget`, `TurnBudget.maxPromptTokens`, and `ToolResultCapacity` have one definition each and are consumed by later tasks under the same names.
- TDD: each behavioral change begins with a failing focused test and ends with focused verification.
- Safety: zero-capacity actions are blocked before approval and execution; the plan does not broaden mutation authority.
- Scope: validation-output shaping, duplicate detection, raw-output persistence, and transactional rollback remain explicitly outside this plan.
