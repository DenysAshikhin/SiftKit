# Repo-Search Turn Tool Budget Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a parallel tool batch share one fixed per-turn context share (7.5% of usable prompt tokens) instead of granting every call in the batch its own full share.

**Architecture:** `TurnBudget.perToolCapTokens(commandCount)` currently computes `max(0.10, commandCount / maxTurns) * usablePromptTokens` and applies that **per call** with no turn-level aggregate bound, so an N-wide batch claims N full shares of usable prompt in a single turn. Give it the batch width and divide the turn share across the batch's members. The downstream truncation path (`ToolResultBudgeter.fit` → `ToolOutputFitter.fitSegments`) is unchanged — it already truncates successful output and rejects failed output.

> **AS-BUILT CORRECTION — read this before the task steps below.**
>
> Tasks 1 and 2 were written on a wrong premise and were corrected during execution. The steps below are kept as the historical record; where they conflict with this note, this note is what shipped (commit `af47db89`).
>
> 1. **`commandCount` at [tool-action-processor.ts:734](../../../src/repo-search/engine/tool-action-processor.ts#L734) was never the batch width.** It was `this.deps.commands.length` — the *task-cumulative* command log. So the old formula did not inflate with batch width; it gave every call a flat 10% early in a run, then **grew** the cap as the run progressed (at `maxTurns` cumulative commands, one tool result could claim 100% of usable context). The aggregate-unbounded-batch defect is real, but its mechanism was mis-stated.
> 2. **The progressive growth is deliberate and tested** — `tests/mock-repo-search-loop.test.ts:1064`, `runTaskLoop increases per-tool cap as tool-call progress grows`. The plan's deletion of `maxTurns` would have removed it. It is **preserved**; `maxTurns` stays on the constructor.
> 3. **Shipped signature:** `perToolCapTokens(completedCommandCount, batchCommandCount)`, computing `floor(usablePromptTokens * max(MIN_TURN_TOOL_RESULT_RATIO, completedCommandCount / maxTurns) / batchCommandCount)`.
> 4. **Constant is `MIN_TURN_TOOL_RESULT_RATIO = 0.075`**, not `TURN_TOOL_RESULT_RATIO`. With the progressive term retained it is still a floor — on the whole turn's share rather than on each call.
> 5. **New third defect found and fixed:** reading the cumulative counter live let it climb *inside* a batch (0, 1, 2, …), handing each successive member a larger cap than the one before and defeating the even split. It is now snapshotted into `TurnBatchState.completedCommandCountAtTurnStart` at the top of `executeBatch`. Covered by `every member of a batch is capped at the same share regardless of position`.
> 6. **Also updated:** `tests/mock-repo-search-loop.test.ts` had two tests hardcoding the `0.10` baseline; they now import `MIN_TURN_TOOL_RESULT_RATIO`.

**Tech Stack:** TypeScript (NodeNext ESM, `.js` import specifiers), `node:test` + `node:assert/strict`, c8 coverage.

---

## Interpretation of the requested 7.5%

The current `0.10` is written as a floor inside `Math.max(...)`. After this change there is no `Math.max` and no competing term, so `0.075` becomes the **per-turn share for the whole batch**, not a per-call minimum. A single call gets 7.5% of usable prompt; a 5-wide batch gets 1.5% each. A per-call floor of 7.5% would restore the exact over-allocation this plan removes, so the floor reading is rejected. The constant is renamed to `TURN_TOOL_RESULT_RATIO` to match its new role.

## File Structure

| File | Change | Responsibility after change |
| --- | --- | --- |
| `src/repo-search/engine/turn-budget.ts` | Modify | Owns context split + the per-turn tool share divided across a batch. No longer knows about `maxTurns`. |
| `src/repo-search/engine/task-loop.ts:175-178` | Modify | Constructs `TurnBudget` without `maxTurns`. |
| `tests/engine-turn-budget.test.ts` | Rewrite | Unit coverage of the budget math. |
| `tests/engine-prompt-preparer.test.ts:58,71,80,101` | Modify | Drop `maxTurns` from 4 `new TurnBudget({...})` calls. |
| `tests/engine-tool-action-processor.test.ts:45` | Modify | Drop `maxTurns`; add the batch aggregate-invariant E2E test. |

`docs/superpowers/plans/2026-07-23-repo-agent-runtime-limits.md` also contains `new TurnBudget({ ..., maxTurns: 45 })` in fenced code blocks. It is a historical plan document — **do not edit it.**

---

### Task 1: Divide one turn share across the batch

**Files:**
- Modify: `src/repo-search/engine/turn-budget.ts:1-29`
- Modify: `src/repo-search/engine/task-loop.ts:175-178`
- Test: `tests/engine-turn-budget.test.ts` (full rewrite)
- Modify: `tests/engine-prompt-preparer.test.ts:58,71,80,101`
- Modify: `tests/engine-tool-action-processor.test.ts:45`

Removing `maxTurns` from the constructor breaks every call site's types at once, so the source change and all call-site updates land in this single task. Reference numbers used throughout, for `totalContextTokens: 100_000`:

- `thinkingBufferTokens` = `max(ceil(100000 * 0.15), 4000)` = `15000`
- `usablePromptTokens` = `85000`
- turn share = `85000 * 0.075` = `6375`
- 1 call → `floor(6375 / 1)` = `6375`; 5 calls → `floor(6375 / 5)` = `1275`

- [ ] **Step 1: Rewrite the failing test file**

Replace the entire contents of `tests/engine-turn-budget.test.ts` with:

```ts
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  TURN_TOOL_RESULT_RATIO,
  THINKING_BUFFER_MIN_TOKENS,
  THINKING_BUFFER_RATIO,
  TurnBudget,
} from '../src/repo-search/engine/turn-budget.js';

test('TurnBudget splits context into thinking buffer and usable prompt tokens', () => {
  const budget = new TurnBudget({ totalContextTokens: 100_000 });
  assert.equal(budget.thinkingBufferTokens, Math.max(Math.ceil(100_000 * THINKING_BUFFER_RATIO), THINKING_BUFFER_MIN_TOKENS));
  assert.equal(budget.usablePromptTokens, 100_000 - budget.thinkingBufferTokens);
});

test('TurnBudget enforces the 4000-token minimum thinking buffer on small contexts', () => {
  const budget = new TurnBudget({ totalContextTokens: 8_000 });
  assert.equal(budget.thinkingBufferTokens, 4_000);
  assert.equal(budget.usablePromptTokens, 4_000);
});

test('usablePromptTokens never goes negative', () => {
  const budget = new TurnBudget({ totalContextTokens: 1_000 });
  assert.equal(budget.usablePromptTokens, 0);
});

test('a single tool call gets the whole turn share', () => {
  const budget = new TurnBudget({ totalContextTokens: 100_000 });
  assert.equal(budget.usablePromptTokens, 85_000);
  assert.equal(budget.perToolCapTokens(1), Math.floor(85_000 * TURN_TOOL_RESULT_RATIO));
  assert.equal(budget.perToolCapTokens(1), 6_375);
});

test('a batch divides the turn share so the batch total never exceeds a single call cap', () => {
  const budget = new TurnBudget({ totalContextTokens: 100_000 });
  const singleCallCap = budget.perToolCapTokens(1);
  for (const commandCount of [2, 3, 5, 9, 40]) {
    const perCall = budget.perToolCapTokens(commandCount);
    assert.equal(perCall, Math.max(1, Math.floor((85_000 * TURN_TOOL_RESULT_RATIO) / commandCount)));
    assert.ok(
      perCall * commandCount <= singleCallCap,
      `batch of ${commandCount} allowed ${perCall * commandCount} tokens, above the single-call cap ${singleCallCap}`,
    );
  }
});

test('a zero or negative command count is treated as a single call', () => {
  const budget = new TurnBudget({ totalContextTokens: 100_000 });
  assert.equal(budget.perToolCapTokens(0), budget.perToolCapTokens(1));
  assert.equal(budget.perToolCapTokens(-3), budget.perToolCapTokens(1));
});

test('a fractional command count is floored to whole calls before dividing', () => {
  const budget = new TurnBudget({ totalContextTokens: 100_000 });
  assert.equal(budget.perToolCapTokens(2.9), budget.perToolCapTokens(2));
});

test('perToolCapTokens never drops below one token', () => {
  const budget = new TurnBudget({ totalContextTokens: 8_000 });
  assert.equal(budget.perToolCapTokens(10_000), 1);
});

test('remainingToolAllowance subtracts prompt and accepted tool tokens, clamped at zero', () => {
  const budget = new TurnBudget({ totalContextTokens: 100_000 });
  assert.equal(budget.remainingToolAllowance(10_000, 5_000), budget.usablePromptTokens - 15_000);
  assert.equal(budget.remainingToolAllowance(budget.usablePromptTokens, 1), 0);
});

test('TurnBudget clamps invalid constructor values before deriving caps', () => {
  const budget = new TurnBudget({ totalContextTokens: -10 });
  assert.equal(budget.totalContextTokens, 1);
  assert.equal(budget.usablePromptTokens, 0);
  assert.equal(budget.perToolCapTokens(100), 1);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run build:test && node ./dist/scripts/run-tests.js engine-turn-budget`

Expected: FAIL. The build step reports `TURN_TOOL_RESULT_RATIO` is not exported by `src/repo-search/engine/turn-budget.ts`, and `maxTurns` is missing from the `TurnBudget` constructor argument.

- [ ] **Step 3: Rewrite `TurnBudget`**

Replace the entire contents of `src/repo-search/engine/turn-budget.ts` with:

```ts
export const THINKING_BUFFER_RATIO = 0.15;
export const THINKING_BUFFER_MIN_TOKENS = 4000;
// Share of usable prompt tokens one turn's tool results may consume in total.
// A batch splits this share; it is not granted per call.
export const TURN_TOOL_RESULT_RATIO = 0.075;

export class TurnBudget {
  readonly totalContextTokens: number;
  readonly thinkingBufferTokens: number;
  readonly usablePromptTokens: number;

  constructor(options: { totalContextTokens: number }) {
    this.totalContextTokens = Math.max(1, options.totalContextTokens);
    this.thinkingBufferTokens = Math.max(
      Math.ceil(this.totalContextTokens * THINKING_BUFFER_RATIO),
      THINKING_BUFFER_MIN_TOKENS,
    );
    this.usablePromptTokens = Math.max(this.totalContextTokens - this.thinkingBufferTokens, 0);
  }

  perToolCapTokens(commandCount: number): number {
    const calls = Math.max(1, Math.floor(commandCount));
    const turnShareTokens = this.usablePromptTokens * TURN_TOOL_RESULT_RATIO;
    return Math.max(1, Math.floor(turnShareTokens / calls));
  }

  remainingToolAllowance(promptTokenCount: number, acceptedToolPromptTokensThisTurn: number): number {
    return Math.max(this.usablePromptTokens - promptTokenCount - acceptedToolPromptTokensThisTurn, 0);
  }
}
```

- [ ] **Step 4: Drop `maxTurns` from the production call site**

In `src/repo-search/engine/task-loop.ts:175-178`, replace:

```ts
    this.budget = new TurnBudget({
      totalContextTokens: Math.max(1, Number(options.totalContextTokens || (options.config ? getConfiguredLlamaNumCtx(options.config) : 32000))),
      maxTurns: this.maxTurns,
    });
```

with:

```ts
    this.budget = new TurnBudget({
      totalContextTokens: Math.max(1, Number(options.totalContextTokens || (options.config ? getConfiguredLlamaNumCtx(options.config) : 32000))),
    });
```

Leave `this.maxTurns` itself alone — it is still used by `AgentLoop`, `ProgressReporter`, and the loop guard.

- [ ] **Step 5: Drop `maxTurns` from the remaining test call sites**

In `tests/engine-prompt-preparer.test.ts`, at lines 58, 71, 80 and 101:
- replace `new TurnBudget({ totalContextTokens: 32_000, maxTurns: 45 })` with `new TurnBudget({ totalContextTokens: 32_000 })`
- replace each `new TurnBudget({ totalContextTokens: 9_000, maxTurns: 45 })` with `new TurnBudget({ totalContextTokens: 9_000 })`

In `tests/engine-tool-action-processor.test.ts:45`, replace:

```ts
    budget: new TurnBudget({ totalContextTokens: 20000, maxTurns: 5 }),
```

with:

```ts
    budget: new TurnBudget({ totalContextTokens: 20000 }),
```

Do not touch `maxTurns: 5` on the `ProgressReporter` at line 56 — that is a different constructor.

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npm run build:test && node ./dist/scripts/run-tests.js engine-turn-budget`

Expected: PASS, 10 tests.

Then run the two neighbouring suites that construct a `TurnBudget`:

Run: `node ./dist/scripts/run-tests.js engine-prompt-preparer`
Expected: PASS.

Run: `node ./dist/scripts/run-tests.js engine-tool-action-processor`
Expected: PASS.

- [ ] **Step 7: Verify no `maxTurns` reference into `TurnBudget` survives**

Run: `npm run typecheck:test`
Expected: exit 0, no output errors.

Run: `grep -rn "new TurnBudget" src tests`
Expected: exactly 6 hits (1 in `src/repo-search/engine/task-loop.ts`, 4 in `tests/engine-prompt-preparer.test.ts`, 1 in `tests/engine-tool-action-processor.test.ts`), and none of them contains `maxTurns`.

Run: `grep -rn "PER_TOOL_RESULT_RATIO" src tests`
Expected: no output (exit code 1).

- [ ] **Step 8: Commit**

```bash
git add src/repo-search/engine/turn-budget.ts src/repo-search/engine/task-loop.ts tests/engine-turn-budget.test.ts tests/engine-prompt-preparer.test.ts tests/engine-tool-action-processor.test.ts
git commit -m "fix: share one 7.5% turn tool budget across a batch instead of per call"
```

---

### Task 2: End-to-end proof that a batch cannot outspend a single call

**Files:**
- Test: `tests/engine-tool-action-processor.test.ts` (append one test at the end of the file)

Task 1 proves the arithmetic. This task proves the arithmetic actually binds real tool output through `ToolActionProcessor` → `ToolResultBudgeter` → `ToolOutputFitter`, which is the path that failed to throttle the 5-grep turn 1.

Budget numbers for the existing `makeProcessor` harness (`totalContextTokens: 20000`):
- `thinkingBufferTokens` = `max(ceil(20000 * 0.15) = 3000, 4000)` = `4000`
- `usablePromptTokens` = `16000`
- turn share = `16000 * 0.075` = `1200`
- 1 call → `1200`; 3 calls → `floor(1200 / 3)` = `400`

`executeBatch` is called with `promptTokenCount: 0`, so `remainingToolAllowance` is `16000` and never binds — `perToolCapTokens` is the only active constraint, which is exactly what we want to measure.

The assertion compares the batch's total spend against the **single-call cap (1200)**, not against the single call's observed spend. Both truncate to ~50% of their own cap (`src/tool-output-fit.ts:58`), so single-spend ≈ 600 and batch-spend ≈ 3 × 200 = 600 — a knife-edge comparison that line-boundary rounding in the fitter's binary search could tip either way. Comparing against the cap keeps a ~2× margin while still failing hard under the old math (which allowed 9600 per call, untruncated). `TurnBudget` is already imported in this file at line 20.

- [ ] **Step 1: Write the failing test**

Append to `tests/engine-tool-action-processor.test.ts`:

```ts
// A 3-wide batch must not consume more prompt budget than one call would have been
// allowed on its own: the per-turn tool share is divided across the batch, not
// granted to each member. Regression guard for batches eating the context window.
test('a parallel batch spends no more tool budget in total than a single call is allowed', async () => {
  const root = createManagedTempDir('siftkit-batch-budget-');
  const lines: string[] = [];
  for (let index = 0; index < 4000; index += 1) {
    lines.push(`export const alpha${index} = 'beta${index} gamma${index} delta${index}';`);
  }
  fs.writeFileSync(path.join(root, 'big.ts'), `${lines.join('\n')}\n`, 'utf8');

  const singleCallCapTokens = new TurnBudget({ totalContextTokens: 20000 }).perToolCapTokens(1);

  const single = makeProcessor(root, ['grep']);
  await single.processor.executeBatch(
    1,
    [{ action: 'tool', tool_name: 'grep', args: { pattern: 'alpha', path: '.' } }],
    '',
    0,
    false,
  );
  const singleCallToolTokens = single.tokenUsage.snapshot().toolTokens;
  assert.ok(singleCallToolTokens > 0, 'the single grep produced no tool tokens');
  assert.ok(
    singleCallToolTokens <= singleCallCapTokens,
    `single grep spent ${singleCallToolTokens} tool tokens, above its own cap ${singleCallCapTokens}`,
  );

  const batch = makeProcessor(root, ['grep']);
  await batch.processor.executeBatch(
    1,
    [
      { action: 'tool', tool_name: 'grep', args: { pattern: 'alpha', path: '.' } },
      { action: 'tool', tool_name: 'grep', args: { pattern: 'beta', path: '.' } },
      { action: 'tool', tool_name: 'grep', args: { pattern: 'gamma', path: '.' } },
    ],
    '',
    0,
    false,
  );
  assert.equal(batch.commands.length, 3);
  for (const command of batch.commands) {
    assert.equal(command.safe, true);
  }
  const batchToolTokens = batch.tokenUsage.snapshot().toolTokens;

  assert.ok(
    batchToolTokens <= singleCallCapTokens,
    `batch of 3 spent ${batchToolTokens} tool tokens, above the single-call cap ${singleCallCapTokens}`,
  );
});
```

- [ ] **Step 2: Expose `tokenUsage` from the test harness**

The test above reads `tokenUsage`, which `makeProcessor` currently builds inline and discards. In `tests/engine-tool-action-processor.test.ts`, change the helper's signature and body.

Replace the signature at lines 25-28:

```ts
function makeProcessor(
  root: string,
  allowedPlannerToolNames: string[] = ['ls'],
): { processor: ToolActionProcessor; commands: TaskCommand[]; counters: LoopCounters } {
  const commands: TaskCommand[] = [];
  const counters: LoopCounters = { invalidResponses: 0, commandFailures: 0, safetyRejects: 0, reason: '' };
```

with:

```ts
function makeProcessor(
  root: string,
  allowedPlannerToolNames: string[] = ['ls'],
): { processor: ToolActionProcessor; commands: TaskCommand[]; counters: LoopCounters; tokenUsage: TokenUsageTracker } {
  const commands: TaskCommand[] = [];
  const counters: LoopCounters = { invalidResponses: 0, commandFailures: 0, safetyRejects: 0, reason: '' };
  const tokenUsage = new TokenUsageTracker(undefined, true);
```

Replace line 46 inside the `new ToolActionProcessor({...})` literal:

```ts
    tokenUsage: new TokenUsageTracker(undefined, true),
```

with:

```ts
    tokenUsage,
```

Replace the return at line 70:

```ts
  return { processor, commands, counters };
```

with:

```ts
  return { processor, commands, counters, tokenUsage };
```

Existing callers destructure only the fields they need, so they need no change.

- [ ] **Step 3: Run the test to verify it fails**

Run: `npm run build:test && node ./dist/scripts/run-tests.js engine-tool-action-processor`

Expected: FAIL on `a parallel batch spends no more tool budget in total than a single call is allowed`, with a message of the form `batch of 3 spent <N> tool tokens, above the single-call spend <M>`.

To confirm this test is a real guard and not vacuously true, temporarily revert `perToolCapTokens` in `src/repo-search/engine/turn-budget.ts` to the pre-Task-1 body (`Math.max(1, Math.floor(this.usablePromptTokens * 0.10))`, ignoring `commandCount`) and re-run: the test must fail. Restore the Task 1 body before continuing.

- [ ] **Step 4: Run the test to verify it passes**

With the Task 1 implementation in place:

Run: `node ./dist/scripts/run-tests.js engine-tool-action-processor`

Expected: PASS, all tests in the file.

There is no new production code in this task — Task 1 already made the invariant true. If Step 3 showed the test passing before the temporary revert, that is the expected order (test written after the fix); the revert check in Step 3 is what establishes the test would have caught the bug.

- [ ] **Step 5: Run the full suite and typecheck**

Run: `npm run typecheck`
Expected: exit 0.

Run: `npm test`
Expected: PASS, no regressions.

- [ ] **Step 6: Commit**

```bash
git add tests/engine-tool-action-processor.test.ts
git commit -m "test: prove a parallel batch cannot outspend a single tool call's budget"
```

---

## Out of scope

Deliberately not changed here, flagged because the tighter cap makes them more visible:

- **Head-biased truncation.** Grep results are fitted with `keep: 'head'` (`src/repo-search/engine/tool-action-processor.ts:746`), so a truncated broad grep returns a path-ordered prefix of matches, not a representative sample. A 3-wide batch at ~400 tokens per call will hit this routinely where a single call at 1200 did not. Separate fix.
- **The 50% truncation target.** `src/tool-output-fit.ts:58` cuts over-cap output to half the cap rather than to the cap. That hysteresis works in this change's favour and is left alone.
- **The system prompt's batching guidance.** `src/repo-search/prompts.ts:222,256` still encourages `tool_batch` for independent searches. That stays — turns are the expensive axis; this plan bounds the bytes, not the width.
