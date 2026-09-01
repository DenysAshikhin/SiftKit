# Turn-Based Tool Budget — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Gate the repo-search tool budget on the loop's turn number instead of the executed-tool-batch counter, so a turn that spends no tool batch can no longer buy back a tool-calling turn past the configured cap.

**Architecture:** `enforceToolCallLimit` currently compares `counters.executedToolBatches` (incremented once per tool-bearing turn) against `toolCallLimit` (= `maxTurns`). Turns that produce no tool batch — rejected finishes, invalid responses, content-only replies — advance `turnNumber` without advancing the counter, so the two drift apart and the model earns one extra tool-calling turn per wasted turn, inside the `POST_LIMIT_ANSWER_SLACK_TURNS` window that is supposed to be answer-only. The fix reads the current 1-based turn (`TaskLoop.turnsUsed`, set in `prepareTurn` before `validateActions` runs) and rejects tool calls once `turn - 1 >= toolCallLimit`. The in-band budget notice migrates to the same turn basis so the model never sees two disagreeing counts, which makes `counters.executedToolBatches` reader-less and therefore dead — it is removed.

**Tech Stack:** TypeScript (ESM, NodeNext), `node:test` + `node:assert/strict`, custom runner at `dist/test-runner/run-tests.js`.

**Background (why):** Observed in a live run — the CLI printed `t46/45` and `t47/45` while still executing `read`/`grep` tool calls. The turn cap handed to `AgentLoop` is `maxTurns + POST_LIMIT_ANSWER_SLACK_TURNS` (48), and the tool gate that is meant to make turns 46-48 answer-only was keyed to a counter that lagged the turn number by the number of wasted turns.

**Validation commands (run from repo root):**
- Single test file: `npm run build:test && node .\dist\test-runner\run-tests.js <file-stem>` (e.g. `tool-call-limit`)
- Full suite: `npm run build:test && node .\dist\test-runner\run-tests.js`
- `npm run typecheck` (this script also runs `npm run lint` at the end)

---

### Task 1: Switch the gate and the notice to turn counting

**Files:**
- Modify: `src/repo-search/engine/task-loop-support.ts:36-39` (`buildToolLimitReachedSummary`), `:48-63` (`buildToolBudgetNotice`)
- Modify: `src/repo-search/engine/task-loop.ts:124-136` (`enforceToolCallLimit`), `:209` (comment), `:597-599` (`validateActions`)
- Modify: `src/repo-search/engine/tool-action-processor.ts:236` (notice call)
- Test: `tests/tool-call-limit.test.ts`, `tests/tool-budget-notice.test.ts`
- Test (expectation updates only): `tests/engine-tool-action-processor.test.ts:578`, `tests/repo-search-loop.core.test.ts:1617-1657`

- [ ] **Step 1: Rewrite `tests/tool-call-limit.test.ts` to the turn basis (failing test)**

Replace the whole file with:

```ts
import assert from 'node:assert/strict';
import test from 'node:test';

import type { AgentLoopAction } from '../src/agent-loop/types.js';
import { enforceToolCallLimit } from '../src/repo-search/engine/task-loop.js';
import {
  buildToolBudgetNotice,
  buildToolLimitReachedSummary,
  POST_LIMIT_ANSWER_SLACK_TURNS,
} from '../src/repo-search/engine/task-loop-support.js';

function tool(callId: string): AgentLoopAction {
  return { kind: 'tool', callId, toolName: 'read', args: { path: 'README.md' } };
}

test('a multi-call batch is one turn: allowed on the final tool turn', () => {
  const actions = [tool('a'), tool('b'), tool('c')];
  assert.equal(enforceToolCallLimit(actions, 45, 45), actions);
});

test('tool calls are rejected on the first turn past the budget', () => {
  assert.throws(
    () => enforceToolCallLimit([tool('a')], 46, 45),
    /Tool-call limit reached \(45\/45 turns used\)/u,
  );
});

test('turns that spend no tool batch do not earn extra tool turns', () => {
  // The gate reads the turn number, so a turn wasted on a rejected finish or an
  // invalid response cannot buy back a tool-calling turn inside the answer slack.
  for (const turn of [47, 48]) {
    assert.throws(
      () => enforceToolCallLimit([tool('a')], turn, 45),
      /Tool-call limit reached \(45\/45 turns used\)/u,
    );
  }
});

test('content-only responses pass even past the limit', () => {
  const actions: AgentLoopAction[] = [];
  assert.equal(enforceToolCallLimit(actions, 48, 45), actions);
});

test('the limit-reached notice and the enforcement error share one prefix', () => {
  const prefix = buildToolLimitReachedSummary(45, 45);
  assert.equal(prefix, 'Tool-call limit reached (45/45 turns used).');
  assert.ok(String(buildToolBudgetNotice(45, 45)).startsWith(`[tool budget] ${prefix}`));
  assert.throws(
    () => enforceToolCallLimit([tool('a')], 46, 45),
    { message: /^Tool-call limit reached \(45\/45 turns used\)\. Do not call tools again/u },
  );
});

test('the post-limit answer slack is its own named constant', () => {
  assert.equal(POST_LIMIT_ANSWER_SLACK_TURNS, 3);
});
```

- [ ] **Step 2: Rewrite `tests/tool-budget-notice.test.ts` to the turn basis (failing test)**

Replace the whole file with:

```ts
import assert from 'node:assert/strict';
import test from 'node:test';

import { buildToolBudgetNotice } from '../src/repo-search/engine/task-loop-support.js';

test('percent notices fire exactly at 25/50/75% used', () => {
  assert.match(String(buildToolBudgetNotice(25, 100)), /25% of the tool-call budget used \(25\/100/u);
  assert.match(String(buildToolBudgetNotice(50, 100)), /50% of the tool-call budget used/u);
  assert.match(String(buildToolBudgetNotice(75, 100)), /75% of the tool-call budget used/u);
  assert.equal(buildToolBudgetNotice(24, 100), null);
  assert.equal(buildToolBudgetNotice(26, 100), null);
});

test('countdown covers the last ten turns and the limit-reached message', () => {
  assert.match(String(buildToolBudgetNotice(91, 100)), /9 tool-call turns remaining \(91\/100 used\)/u);
  assert.match(String(buildToolBudgetNotice(99, 100)), /1 tool-call turn remaining \(99\/100 used\)/u);
  assert.match(String(buildToolBudgetNotice(100, 100)), /Tool-call limit reached \(100\/100 turns used\)/u);
  assert.equal(buildToolBudgetNotice(90, 100), null);
});

test('a full run at limit 100 emits exactly 13 notices', () => {
  let count = 0;
  for (let used = 1; used <= 100; used += 1) {
    if (buildToolBudgetNotice(used, 100) !== null) count += 1;
  }
  assert.equal(count, 13);
});

test('countdown outranks percent thresholds at small limits', () => {
  // limit 8: 75% threshold is ceil(6) but remaining 2 is inside the countdown window.
  assert.match(String(buildToolBudgetNotice(6, 8)), /2 tool-call turns remaining/u);
});

test('percent notices only fire while more than the countdown window remains', () => {
  // limit 14: the 25% threshold is ceil(3.5) = 4 with remaining 10 (> window 9) → percent notice.
  assert.match(String(buildToolBudgetNotice(4, 14)), /25% of the tool-call budget used \(4\/14/u);
  // one more turn: remaining 9 enters the countdown window, which outranks percents.
  assert.match(String(buildToolBudgetNotice(5, 14)), /9 tool-call turns remaining \(5\/14 used\)/u);
});

test('tiny limits never mislabel: percent collisions are covered by the countdown window', () => {
  // ceil(percent·limit) collisions require limit < 4, where remaining is always ≤ 9, so the
  // countdown or limit-reached message wins and the percent loop is never consulted.
  assert.match(String(buildToolBudgetNotice(1, 2)), /1 tool-call turn remaining \(1\/2 used\)/u);
  assert.match(String(buildToolBudgetNotice(1, 3)), /2 tool-call turns remaining \(1\/3 used\)/u);
  assert.match(String(buildToolBudgetNotice(2, 2)), /Tool-call limit reached \(2\/2 turns used\)/u);
});
```

- [ ] **Step 3: Run both test files to verify they fail**

Run: `npm run build:test && node .\dist\test-runner\run-tests.js tool-call-limit`
Expected: FAIL — assertions expect `turns used` / `tool-call turn(s) remaining`, source still emits `batches used` / `tool-call batch(es) remaining`.

Run: `npm run build:test && node .\dist\test-runner\run-tests.js tool-budget-notice`
Expected: FAIL for the same reason.

- [ ] **Step 4: Migrate the two message builders in `src/repo-search/engine/task-loop-support.ts`**

Replace lines 36-39 with:

```ts
/** The one sentence shared by the rejection error and the in-band notice, so the model never sees two disagreeing limit messages. */
export function buildToolLimitReachedSummary(usedTurns: number, toolCallLimit: number): string {
  return `Tool-call limit reached (${usedTurns}/${toolCallLimit} turns used).`;
}
```

Replace lines 48-63 with:

```ts
/**
 * In-band budget notice appended to the last tool result of a turn; null when no threshold was
 * crossed. `usedTurns` is the turn that just executed tools, so the notice the model reads on
 * turn N+1 always agrees with the gate that will run on turn N+1.
 */
export function buildToolBudgetNotice(usedTurns: number, toolCallLimit: number): string | null {
  const remaining = toolCallLimit - usedTurns;
  if (remaining <= 0) {
    return `[tool budget] ${buildToolLimitReachedSummary(usedTurns, toolCallLimit)} You must finish now: reply with your final answer as content only — any further tool call will be rejected.`;
  }
  if (remaining <= TOOL_BUDGET_COUNTDOWN_WINDOW) {
    return `[tool budget] ${remaining} tool-call turn${remaining === 1 ? '' : 's'} remaining (${usedTurns}/${toolCallLimit} used). Prioritize verification and finishing.`;
  }
  for (const percent of TOOL_BUDGET_PERCENT_NOTICES) {
    if (usedTurns === Math.ceil((percent / 100) * toolCallLimit)) {
      return `[tool budget] ${percent}% of the tool-call budget used (${usedTurns}/${toolCallLimit} turns).`;
    }
  }
  return null;
}
```

- [ ] **Step 5: Migrate the gate in `src/repo-search/engine/task-loop.ts`**

Replace lines 124-136 with:

```ts
/**
 * The tool budget is counted in turns, not in executed batches: a turn spent on a rejected finish
 * or an invalid response must not hand back a tool-calling turn. `turn` is the 1-based turn about
 * to run, so the turns already consumed are `turn - 1`, clamped so the message never reports more
 * than the budget once the run is inside the post-limit answer slack.
 */
export function enforceToolCallLimit(
  actions: AgentLoopAction[],
  turn: number,
  toolCallLimit: number,
): AgentLoopAction[] {
  const requestsTools = actions.some((action) => action.kind === 'tool');
  const usedTurns = Math.min(turn - 1, toolCallLimit);
  if (requestsTools && usedTurns >= toolCallLimit) {
    throw new NativePlannerResponseError(
      `${buildToolLimitReachedSummary(usedTurns, toolCallLimit)} Do not call tools again; return your final answer as content.`,
    );
  }
  return actions;
}
```

Replace line 209 with:

```ts
    // The budget is turn-counted, so the tool limit is the turn cap itself.
    this.toolCallLimit = this.maxTurns;
```

Replace lines 597-599 with:

```ts
  validateActions(actions: AgentLoopAction[]): AgentLoopAction[] {
    // `turnsUsed` is set to the current 1-based turn by prepareTurn, which runs earlier in the
    // same turn than parseActions → validateActions.
    return enforceToolCallLimit(actions, this.turnsUsed, this.toolCallLimit);
  }
```

- [ ] **Step 6: Migrate the notice call in `src/repo-search/engine/tool-action-processor.ts`**

Replace line 236 with:

```ts
    const notice = buildToolBudgetNotice(turn, this.deps.toolCallLimit);
```

- [ ] **Step 7: Run both test files to verify they pass**

Run: `npm run build:test && node .\dist\test-runner\run-tests.js tool-call-limit`
Expected: PASS (6 tests)

Run: `npm run build:test && node .\dist\test-runner\run-tests.js tool-budget-notice`
Expected: PASS (6 tests)

- [ ] **Step 8: Update the two downstream message expectations**

In `tests/engine-tool-action-processor.test.ts`, replace line 578:

```ts
  assert.match(String(last?.content ?? ''), /2 tool-call turns remaining \(3\/5 used\)/u);
```

and replace the comment on line 574-575 with:

```ts
  // Batch 3 took the replay path (no batchOutcomes); with the helper's toolCallLimit of 5
  // the countdown notice for turn 3 of 5 must land as a trailing user message.
```

In `tests/repo-search-loop.core.test.ts`, rename the test on line 1617 to:

```ts
test('runTaskLoop counts a multi-call batch as one tool-budget turn and leaves a finishing turn after exhaustion', async () => {
```

and replace the trailing comment block and assertions (currently lines 1646-1657) with:

```ts
  // The 2-call batch is one turn, not two budget units: turn 1 and turn 2 both call tools,
  // then turn 3 finishes inside the answer slack.
  assert.equal(result.reason, 'finish');
  assert.equal(result.commands.length, 3);
  assert.equal(result.rejectedCalls, 0);

  // Budget notices land at the end of each turn's last tool result and reach the transcript
  // (logged via turn_new_messages on the following turn).
  const logText = logger.getText();
  assert.match(logText, /1 tool-call turn remaining \(1\/2 used\)/u);
  assert.match(logText, /Tool-call limit reached \(2\/2 turns used\)/u);
```

- [ ] **Step 9: Run the two updated files**

Run: `npm run build:test && node .\dist\test-runner\run-tests.js engine-tool-action-processor`
Expected: PASS

Run: `npm run build:test && node .\dist\test-runner\run-tests.js repo-search-loop.core`
Expected: PASS

- [ ] **Step 10: Commit**

```bash
git add src/repo-search/engine/task-loop-support.ts src/repo-search/engine/task-loop.ts src/repo-search/engine/tool-action-processor.ts tests/tool-call-limit.test.ts tests/tool-budget-notice.test.ts tests/engine-tool-action-processor.test.ts tests/repo-search-loop.core.test.ts
git commit -m "fix(repo-search): gate the tool budget on turn number instead of executed batches"
```

---

### Task 2: Loop-level regression test for the drift

**Files:**
- Test: `tests/repo-search-loop.core.test.ts` (append a new test immediately after the `runTaskLoop counts a multi-call batch as one tool-budget turn...` test)

**Scenario:** `maxTurns: 3` (so `toolCallLimit` is 3) and `minToolCallsBeforeFinish: 2`. Turn 1 calls a tool. Turn 2 is a content-only finish that is rejected because only 1 tool call has run — it consumes a turn and executes no tool batch. Turn 3 calls a tool. Turn 4 asks for a third tool call: under the old batch-counted budget only 2 batches had run, so it was allowed; under turn counting it must be rejected. Turn 5 finishes.

- [ ] **Step 1: Write the failing test**

```ts
test('runTaskLoop does not hand back tool turns for turns that spent no tool batch', async () => {
  const result = await runTaskLoop(
    { id: 'task-turn-budget-drift', question: 'Exercise the turn budget.' },
    {
      ...MOCK_LOOP_DEFAULTS,
      maxTurns: 3,
      maxInvalidResponses: 5,
      minToolCallsBeforeFinish: 2,
      mockResponses: [
        { toolCalls: [{ name: 'git', arguments: { operation: 'grep', pattern: 'alpha', path: 'src' } }] },
        // Turn 2 is spent on a finish rejected for too few tool calls: it executes no tool
        // batch, and must not buy back a tool-calling turn later.
        { content: 'too early' },
        { toolCalls: [{ name: 'git', arguments: { operation: 'grep', pattern: 'beta', path: 'src' } }] },
        // Turn 4 is past the 3-turn budget, even though only 2 batches have run.
        { toolCalls: [{ name: 'git', arguments: { operation: 'grep', pattern: 'gamma', path: 'src' } }] },
        { content: 'final answer' },
        { content: '{"verdict":"pass","reason":"supported"}' },
      ],
      mockCommandResults: {
        'git operation="grep" path="src" pattern="alpha"': { exitCode: 0, stdout: 'alpha hit', stderr: '' },
        'git operation="grep" path="src" pattern="beta"': { exitCode: 0, stdout: 'beta hit', stderr: '' },
        'git operation="grep" path="src" pattern="gamma"': { exitCode: 0, stdout: 'gamma hit', stderr: '' },
      },
    },
  );

  assert.equal(result.reason, 'finish');
  assert.equal(result.finalOutput, 'final answer');
  assert.equal(result.commands.length, 2);
  assert.equal(result.commands.some((command) => JSON.stringify(command).includes('gamma')), false);
});
```

- [ ] **Step 2: Run it against the new implementation**

Run: `npm run build:test && node .\dist\test-runner\run-tests.js repo-search-loop.core`
Expected: PASS.

If the mock-response sequence is off by one because the rejected finish consumes an extra mock response (finish verification), shift the sequence until the run reaches `reason === 'finish'`, but do **not** relax these four assertions — they are the acceptance criteria: the run finishes, the final output is `final answer`, exactly 2 commands ran, and no command contains `gamma`.

- [ ] **Step 3: Prove the test is a real regression guard**

Temporarily revert the gate in `src/repo-search/engine/task-loop.ts` to the batch basis by changing `validateActions` back to `enforceToolCallLimit(actions, this.counters.executedToolBatches + 1, this.toolCallLimit)`.

Run: `npm run build:test && node .\dist\test-runner\run-tests.js repo-search-loop.core`
Expected: FAIL on `result.commands.length` (3, not 2) and on the `gamma` assertion.

Restore `validateActions` to `enforceToolCallLimit(actions, this.turnsUsed, this.toolCallLimit)` and re-run.
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add tests/repo-search-loop.core.test.ts
git commit -m "test(repo-search): guard against wasted turns buying back tool turns"
```

---

### Task 3: Remove the now-dead `executedToolBatches` counter

**Rationale:** After Task 1 the counter has no readers — `task-loop.ts:598` and `tool-action-processor.ts:236` were its only two, and both now read the turn. A write-only counter is dead code.

**Files:**
- Modify: `src/repo-search/engine/task-loop-support.ts:273-284` (`LoopCounters`)
- Modify: `src/repo-search/engine/task-loop.ts:185-192` (counters initializer)
- Modify: `src/repo-search/engine/tool-action-processor.ts:206-207` (destructure + increment)
- Test: `tests/helpers/tool-action-processor.ts:50`, `tests/engine-tool-action-processor.test.ts:200`, `:311-323`

- [ ] **Step 1: Update the test that asserts the counter (failing test)**

In `tests/engine-tool-action-processor.test.ts`, replace lines 311-323 with:

```ts
// A tool-bearing response is one turn of budget even when every call in it is screened out —
// the turn-counted gate makes that structural, so what still needs asserting is that the
// screened call is recorded as a rejection rather than silently dropped.
test('a batch whose only call is screened as a duplicate records the rejection', async () => {
  const root = createManagedTempDir('siftkit-batch-budget-unit-');
  fs.writeFileSync(path.join(root, 'a.ts'), 'alpha\n', 'utf8');
  const { processor, counters } = makeProcessor(root);

  await processor.executeBatch(1, [{ kind: 'tool', callId: 'test_call_60', toolName: 'ls', args: { path: '.' } }], '', { reported: 0, budgeted: 0 }, false);
  await processor.executeBatch(2, [{ kind: 'tool', callId: 'test_call_61', toolName: 'ls', args: { path: '.' } }], '', { reported: 0, budgeted: 0 }, false);

  assert.equal(counters.rejectedCalls, 1);
});
```

In the same file, replace the `LoopCounters` literal on line 200 by deleting the `executedToolBatches: 0,` entry from it.

In `tests/helpers/tool-action-processor.ts`, replace line 50 with:

```ts
  const counters: LoopCounters = { invalidResponses: 0, rejectedCalls: 0, nonZeroExits: 0, safetyRejects: 0, reason: 'max_turns' };
```

- [ ] **Step 2: Run typecheck to verify the tests now fail to compile**

Run: `npm run typecheck:test`
Expected: FAIL — `LoopCounters` still declares the required `executedToolBatches` property that the two literals no longer supply.

- [ ] **Step 3: Remove the field from the type and its writers**

In `src/repo-search/engine/task-loop-support.ts`, delete these lines from `LoopCounters` (the doc comment and the field):

```ts
  /**
   * Tool-bearing planner responses that consumed a batch-budget unit. Counted even when every
   * call in the batch was screened out (duplicate/unsafe) — a wasted response still spends budget.
   */
  executedToolBatches: number;
```

In `src/repo-search/engine/task-loop.ts`, delete `executedToolBatches: 0,` from the counters initializer at lines 185-192.

In `src/repo-search/engine/tool-action-processor.ts`, delete line 207 (`counters.executedToolBatches += 1;`). Then check whether `counters` is still referenced anywhere else inside `executeBatch`; if it is not, drop it from the destructure on line 206 so the line reads:

```ts
    const { transcript, duplicates } = this.deps;
```

(Leave `counters` in the destructure if later lines in the method still use it — `npm run lint` will flag an unused binding either way.)

- [ ] **Step 4: Verify**

Run: `npm run build:test && node .\dist\test-runner\run-tests.js engine-tool-action-processor`
Expected: PASS

Run: `npm run typecheck`
Expected: PASS (this also runs `npm run lint`)

- [ ] **Step 5: Full suite**

Run: `npm run build:test && node .\dist\test-runner\run-tests.js`
Expected: PASS. Any failure that mentions `batches used`, `tool-call batch remaining`, or `executedToolBatches` is a missed migration from Task 1 — fix it at the source rather than relaxing the assertion.

- [ ] **Step 6: Commit**

```bash
git add src/repo-search/engine/task-loop-support.ts src/repo-search/engine/task-loop.ts src/repo-search/engine/tool-action-processor.ts tests/helpers/tool-action-processor.ts tests/engine-tool-action-processor.test.ts
git commit -m "refactor(repo-search): drop the dead executedToolBatches counter"
```

---

## Out of scope

- The `toolCallLimit` field on the `tool_start` / `tool_result` progress events, the SSE payloads, and the `chat_messages` DB column. Its value is still `maxTurns` and its name is still accurate under turn counting, so no rename is warranted and the dashboard contract is untouched.
- The `t{n}/{max}` renderer denominator. It prints `TaskLoop.maxTurns` (45) while `AgentLoop` runs to `maxTurns + POST_LIMIT_ANSWER_SLACK_TURNS` (48), which is why the slack turns render as `t46/45`. That is a separate display decision.
