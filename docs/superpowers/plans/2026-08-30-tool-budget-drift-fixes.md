> **SUPERSEDED** by `docs/superpowers/plans/2026-09-01-turn-based-tool-budget.md`. The batch
> basis (`executedToolBatches`) described below no longer exists; the tool budget is counted in
> turns. Retained for history only — do not implement from this document.

# Tool-Budget Drift Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the five drift findings from commit `709babfb` (tool-batch budget work): duplicated limit-reached messaging, the `ToolBatchTally` parallel counter box, the borrowed `FORCED_FINISH_MAX_ATTEMPTS` turn slack, the tally-semantics comment mismatch, and the budget constant living outside the budget layer.

**Architecture:** All changes are containment-preserving refactors inside `src/repo-search/engine/` plus test updates. No behavior changes except: the shared message prefix becomes a single function, and the batch tally moves into the existing `LoopCounters` shared-state object (same by-reference mutation idiom, one box instead of two).

**Tech Stack:** TypeScript (strict, no casts/`any`/`!`), `node:test` + `node:assert/strict`, custom runner (`npm test` after `npm run build:test`), single-file runs via `npx tsx --test tests/<file>.test.ts`.

**Do not commit any changes. Do not create temporary files.**

---

## File map

- Modify: `src/repo-search/engine/task-loop-support.ts` — add `formatToolCallLimitReached`, `POST_LIMIT_ANSWER_SLACK_TURNS`; delete `ToolBatchTally`; extend `LoopCounters`.
- Modify: `src/repo-search/engine/task-loop.ts` — use shared prefix + slack constant; drop `toolBatchTally` field for `counters.executedToolBatches`.
- Modify: `src/repo-search/engine/tool-action-processor.ts` — drop `toolBatchTally` dep for `counters.executedToolBatches`.
- Modify: `src/repo-search/engine/turn-budget.ts` — take ownership of `FAILED_COMMAND_TAIL_CAP_TOKENS`.
- Modify: `src/repo-search/engine/tool-result-budgeter.ts` — import the constant instead of defining it.
- Modify: `tests/helpers/tool-action-processor.ts`, `tests/tool-call-limit.test.ts`, `tests/engine-tool-action-processor.test.ts`, `tests/engine-tool-result-budgeter.test.ts`.

---

### Task 1: Shared limit-reached prefix and dedicated post-limit slack constant

Fixes findings 1 (message duplicated at `task-loop-support.ts:43` and `task-loop.ts:131`) and 3 (`maxTurns + FORCED_FINISH_MAX_ATTEMPTS` at `task-loop.ts:417` borrows an unrelated constant).

**Files:**
- Modify: `src/repo-search/engine/task-loop-support.ts:36-54`
- Modify: `src/repo-search/engine/task-loop.ts:61,122-135,411-417`
- Test: `tests/tool-call-limit.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `tests/tool-call-limit.test.ts` (it already imports `enforceToolCallLimit` from `../src/repo-search/engine/task-loop.js` and the `tool()` helper):

```ts
import {
  buildToolBudgetNotice,
  formatToolCallLimitReached,
  POST_LIMIT_ANSWER_SLACK_TURNS,
} from '../src/repo-search/engine/task-loop-support.js';

test('the limit-reached notice and the enforcement error share one prefix', () => {
  const prefix = formatToolCallLimitReached(45, 45);
  assert.equal(prefix, 'Tool-call limit reached (45/45 batches used).');
  assert.ok(String(buildToolBudgetNotice(45, 45)).startsWith(`[tool budget] ${prefix}`));
  assert.throws(
    () => enforceToolCallLimit([tool('a')], 45, 45),
    (error: unknown) => error instanceof Error && error.message.startsWith(prefix),
  );
});

test('the post-limit answer slack is its own named constant', () => {
  assert.equal(POST_LIMIT_ANSWER_SLACK_TURNS, 3);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx tsx --test tests/tool-call-limit.test.ts`
Expected: FAIL — `formatToolCallLimitReached` and `POST_LIMIT_ANSWER_SLACK_TURNS` are not exported.

- [ ] **Step 3: Implement in `task-loop-support.ts`**

Above `buildToolBudgetNotice` (currently `:40`), add:

```ts
/** The one rendering of the limit-reached state; the in-band notice and the enforcement error both open with it. */
export function formatToolCallLimitReached(executedBatches: number, toolCallLimit: number): string {
  return `Tool-call limit reached (${executedBatches}/${toolCallLimit} batches used).`;
}

/**
 * Turns reserved after the tool budget is exhausted so the model can still deliver its final
 * answer. Deliberately its own constant: it is not the forced-finish retry budget, and retuning
 * one must not silently retune the other.
 */
export const POST_LIMIT_ANSWER_SLACK_TURNS = 3;
```

In `buildToolBudgetNotice`, replace the `remaining <= 0` return (currently `:43`) with:

```ts
    return `[tool budget] ${formatToolCallLimitReached(executedBatches, toolCallLimit)} You must finish now: reply with your final answer as content only — any further tool call will be rejected.`;
```

- [ ] **Step 4: Implement in `task-loop.ts`**

Change the `./forced-finish.js` import (`:61`) to:

```ts
import { ForcedFinishController } from './forced-finish.js';
```

Add `formatToolCallLimitReached` and `POST_LIMIT_ANSWER_SLACK_TURNS` to the existing multi-line `./task-loop-support.js` import block (`:63-80`).

In `enforceToolCallLimit` (`:122-135`), replace the thrown message line:

```ts
      `${formatToolCallLimitReached(executedToolBatches, toolCallLimit)} Do not call tools again; return your final answer as content.`,
```

At `:414-417`, replace the `maxTurns` line (keep the existing three-line comment above it):

```ts
      maxTurns: this.maxTurns + POST_LIMIT_ANSWER_SLACK_TURNS,
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx tsx --test tests/tool-call-limit.test.ts` then `npx tsx --test tests/tool-budget-notice.test.ts`
Expected: PASS (existing regexes match the unchanged message text).

### Task 2: Fold the batch tally into `LoopCounters` and pin the batch-unit semantics

Fixes findings 2 (`ToolBatchTally` at `task-loop-support.ts:34` duplicates the `LoopCounters` shared-counter mechanism) and 4 (comment says "ran tools" but a fully-screened batch still consumes a unit at `tool-action-processor.ts:209`; boundary untested).

**Files:**
- Modify: `src/repo-search/engine/task-loop-support.ts:33-34,262-268`
- Modify: `src/repo-search/engine/task-loop.ts:75-80,183,185-191,349,554`
- Modify: `src/repo-search/engine/tool-action-processor.ts:43-53,183,209,240`
- Modify: `tests/helpers/tool-action-processor.ts:47,99`
- Test: `tests/engine-tool-action-processor.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `tests/engine-tool-action-processor.test.ts` (models the existing duplicate tests at `:258-296`):

```ts
// A tool-bearing response consumes a budget unit even when every call in it is screened
// out — a wasted response still spends the planner's batch budget.
test('a batch whose only call is screened as a duplicate still consumes a budget unit', async () => {
  const root = createManagedTempDir('siftkit-batch-budget-unit-');
  fs.writeFileSync(path.join(root, 'a.ts'), 'alpha\n', 'utf8');
  const { processor, counters } = makeProcessor(root);

  await processor.executeBatch(1, [{ kind: 'tool', callId: 'test_call_60', toolName: 'ls', args: { path: '.' } }], '', { reported: 0, budgeted: 0 }, false);
  await processor.executeBatch(2, [{ kind: 'tool', callId: 'test_call_61', toolName: 'ls', args: { path: '.' } }], '', { reported: 0, budgeted: 0 }, false);

  assert.equal(counters.rejectedCalls, 1);
  assert.equal(counters.executedToolBatches, 2);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx tsx --test tests/engine-tool-action-processor.test.ts`
Expected: FAIL — `executedToolBatches` does not exist on `LoopCounters`.

- [ ] **Step 3: Implement in `task-loop-support.ts`**

Delete lines `:33-34`:

```ts
/** Executed tool batches (one per planner response that ran tools); shared by reference between TaskLoop and ToolActionProcessor. */
export type ToolBatchTally = { executed: number };
```

In `LoopCounters` (currently `:262-268`), add the field with the corrected semantics:

```ts
export type LoopCounters = {
  invalidResponses: number;
  rejectedCalls: number;
  nonZeroExits: number;
  safetyRejects: number;
  /**
   * Tool-bearing planner responses that consumed a batch-budget unit. Counted even when every
   * call in the batch was screened out (duplicate/unsafe) — a wasted response still spends budget.
   */
  executedToolBatches: number;
  reason: TaskEndReason;
};
```

- [ ] **Step 4: Implement in `task-loop.ts`**

Remove `type ToolBatchTally,` from the `./task-loop-support.js` import (`:78`).
Delete the field at `:183`: `private readonly toolBatchTally: ToolBatchTally = { executed: 0 };`
Add `executedToolBatches: 0,` to the `counters` initializer (`:185-191`).
Delete `toolBatchTally: this.toolBatchTally,` from the `ToolActionProcessor` deps (`:349`); keep `toolCallLimit`.
Change `validateActions` (`:554`) to:

```ts
    return enforceToolCallLimit(actions, this.counters.executedToolBatches, this.toolCallLimit);
```

- [ ] **Step 5: Implement in `tool-action-processor.ts`**

Remove `type ToolBatchTally,` from the `./task-loop-support.js` import (`:51`).
Delete the deps field at `:183`: `toolBatchTally: ToolBatchTally;`
At `:209` (top of `executeBatch`, where `counters` is already destructured), replace with:

```ts
    counters.executedToolBatches += 1;
```

At `:240`, replace with:

```ts
      const notice = buildToolBudgetNotice(counters.executedToolBatches, this.deps.toolCallLimit);
```

(`counters` from the `:208` destructuring is in scope for both.)

- [ ] **Step 6: Update the test helper**

In `tests/helpers/tool-action-processor.ts`: add `executedToolBatches: 0,` to the counters literal (`:47`) and delete the deps line `toolBatchTally: { executed: 0 },` (`:99`).

- [ ] **Step 7: Run tests to verify they pass**

Run: `npx tsx --test tests/engine-tool-action-processor.test.ts` then `npx tsx --test tests/tool-budget-notice.test.ts` and `npx tsx --test tests/tool-call-limit.test.ts`
Expected: PASS. Any other `LoopCounters` literal missed will fail `npm run typecheck:test` loudly — fix it by adding `executedToolBatches: 0`, never by making the field optional.

### Task 3: Move `FAILED_COMMAND_TAIL_CAP_TOKENS` into the budget layer

Fixes finding 5: the failure tail cap (`tool-result-budgeter.ts:12`) is the only budget number not owned by `turn-budget.ts`, the designated leaf module for budget constants (see its comment at `:10-13`).

**Files:**
- Modify: `src/repo-search/engine/turn-budget.ts` (after `DEFAULT_MAX_TURNS`, `:13`)
- Modify: `src/repo-search/engine/tool-result-budgeter.ts:5-12`
- Modify: `tests/engine-tool-result-budgeter.test.ts:5` (the `FAILED_COMMAND_TAIL_CAP_TOKENS` import)

This is a pure move — no re-export shim, no behavior change; TDD red state is the broken import, caught by the existing tests.

- [ ] **Step 1: Move the constant**

In `turn-budget.ts`, after `DEFAULT_MAX_TURNS`, add (comment moves with it):

```ts
// A failing command's tail is still evidence — test runners and compilers print
// their verdicts and failure summaries last — but failure dumps are low-density,
// so the kept tail gets a small fixed budget instead of the growing per-tool cap.
// ~75-125 lines: enough for a runner summary plus failing-test names, never
// enough for repeated failures to starve the remaining allowance.
export const FAILED_COMMAND_TAIL_CAP_TOKENS = 1_024;
```

In `tool-result-budgeter.ts`, delete the constant and its five comment lines (`:7-12`) and add to the imports:

```ts
import { FAILED_COMMAND_TAIL_CAP_TOKENS } from './turn-budget.js';
```

- [ ] **Step 2: Update the test import**

In `tests/engine-tool-result-budgeter.test.ts`, move `FAILED_COMMAND_TAIL_CAP_TOKENS` out of the `tool-result-budgeter.js` import into:

```ts
import { FAILED_COMMAND_TAIL_CAP_TOKENS } from '../src/repo-search/engine/turn-budget.js';
```

- [ ] **Step 3: Verify no other importer remains**

Run: `npx tsx --test tests/engine-tool-result-budgeter.test.ts`
Expected: PASS. Also confirm `FAILED_COMMAND_TAIL_CAP_TOKENS` is referenced only via `turn-budget.js` imports (one definition, two importers: budgeter + test).

---

## Final validation (after all tasks)

1. `npm run typecheck:test` and the main `npm run typecheck` (includes `npm run lint`).
2. `npm run build:test` then `npm test` — full suite.
3. `git diff --stat` — only the eight files in the file map may change.
