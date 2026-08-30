# Budget Drift Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
> **Do NOT commit at any step.** The orchestrator reviews and commits.

**Goal:** Fix the five drift findings from the 2026-08-29 tool-batch-budget review: share the limit-reached message between the rejection error and the in-band notice; never drop a budget notice when a batch collapses onto a duplicate replay; pin the percent/countdown boundary behavior with tests; derive slack-turn arithmetic in tests from `POST_LIMIT_ANSWER_SLACK_TURNS`; hoist the duplicated `toolCallLimit` literal in the test helper.

**Architecture:** A `buildToolLimitReachedSummary(used, limit)` helper in `task-loop-support.ts` becomes the single source of the `Tool-call limit reached (X/Y batches used).` sentence, consumed by both `enforceToolCallLimit` (task-loop.ts) and `buildToolBudgetNotice`. In `executeBatch`, when a batch produced no `batchOutcomes` (all actions took the duplicate-replay path, which replaces a transcript message instead of pushing an outcome), the notice is delivered through the existing `state.pendingModeChangeUserMessages` → `transcript.pushUser` flush instead of being silently dropped. Test files that encode the finishing-headroom turn count import `POST_LIMIT_ANSWER_SLACK_TURNS` from `src/repo-search/engine/task-loop-support.ts` (value `3`) and derive their numbers.

> **2026-08-30 revision after commit `07a121b6`:** a parallel session already landed the shared helper (as `formatToolCallLimitReached`), moved the batch tally into `LoopCounters.executedToolBatches` (deleting `ToolBatchTally`), and replaced the `FORCED_FINISH_MAX_ATTEMPTS` borrow with `POST_LIMIT_ANSWER_SLACK_TURNS`. Task 1 is therefore just the rename to `buildToolLimitReachedSummary`; Tasks 2 and 4 below are updated to the post-`07a121b6` code shapes.

**Tech Stack:** TypeScript (strict, inferred end-to-end, no `any`/assertions/non-null), `node:test` + `node:assert/strict`.

**Background facts (verified 2026-08-30):**
- `enforceToolCallLimit` lives at `src/repo-search/engine/task-loop.ts:123-135`; `buildToolBudgetNotice` at `src/repo-search/engine/task-loop-support.ts:39-54`.
- The duplicate-replay path (`src/repo-search/engine/tool-action-processor.ts:640-641`, `transcript.replaceToolMessage`) fires on the **3rd** identical call of a duplicate-screened tool (1 success + 2 duplicate rejections in separate batches); it pushes **no** `batchOutcomes` entry, so the notice block at `:238-244` skips and the budget notice is lost even at 100%.
- `ls` calls ARE duplicate-screened (only repeated `read`, and a granted `run` full-output retry, are exempt — `tool-action-processor.ts:564-569`).
- `state.pendingModeChangeUserMessages` entries are flushed via `transcript.pushUser(userMessage)` at `tool-action-processor.ts:275-277`, after `appendBatchExchange`.
- The test harness is `makeProcessor(root, tools?, profile?, approval?, mockCommandResults?)` from `tests/helpers/tool-action-processor.ts`; it returns `{ processor, commands, counters, tokenUsage, budget, events, transcript }`, with `toolCallLimit: 5` in deps and in its `ProgressReporter`. Tool actions are `{ kind: 'tool', callId: string, toolName: string, args: {...} }`; `executeBatch(turn, actions, '', { reported: 0, budgeted: 0 }, false)`. Transcript is read with `transcript.getMessages()` (returns `ChatMessage[]` with `role` / `content`).
- `export const POST_LIMIT_ANSWER_SLACK_TURNS = 3;` at `src/repo-search/engine/task-loop-support.ts:46` (introduced by `07a121b6`; it, not `FORCED_FINISH_MAX_ATTEMPTS`, now feeds the AgentLoop headroom at `task-loop.ts:417`). None of the three test files in Task 4 import it yet.

---

### Task 1: Shared limit-reached summary

**Files:**
- Modify: `src/repo-search/engine/task-loop-support.ts:39-54`
- Modify: `src/repo-search/engine/task-loop.ts:123-135`
- Test: `tests/tool-call-limit.test.ts` (existing tests pin the strings; behavior-preserving refactor)

- [ ] **Step 1: Run the pinning suites first (must be green)**

Run: `npx tsx --test tests/tool-call-limit.test.ts tests/tool-budget-notice.test.ts`
Expected: PASS.

- [ ] **Step 2: Add the shared helper and use it in the notice**

In `src/repo-search/engine/task-loop-support.ts`, the current code is:

```ts
/** In-band budget notice appended to the last tool result of a batch; null when no threshold was crossed. */
export function buildToolBudgetNotice(executedBatches: number, toolCallLimit: number): string | null {
  const remaining = toolCallLimit - executedBatches;
  if (remaining <= 0) {
    return `[tool budget] Tool-call limit reached (${executedBatches}/${toolCallLimit} batches used). You must finish now: reply with your final answer as content only — any further tool call will be rejected.`;
  }
```

Insert a helper above `buildToolBudgetNotice` and rewrite the `remaining <= 0` branch:

```ts
/** The one sentence shared by the rejection error and the in-band notice, so the model never sees two disagreeing limit messages. */
export function buildToolLimitReachedSummary(executedBatches: number, toolCallLimit: number): string {
  return `Tool-call limit reached (${executedBatches}/${toolCallLimit} batches used).`;
}

/** In-band budget notice appended to the last tool result of a batch; null when no threshold was crossed. */
export function buildToolBudgetNotice(executedBatches: number, toolCallLimit: number): string | null {
  const remaining = toolCallLimit - executedBatches;
  if (remaining <= 0) {
    return `[tool budget] ${buildToolLimitReachedSummary(executedBatches, toolCallLimit)} You must finish now: reply with your final answer as content only — any further tool call will be rejected.`;
  }
```

(The countdown and percent branches below are unchanged.)

- [ ] **Step 3: Use it in `enforceToolCallLimit`**

In `src/repo-search/engine/task-loop.ts:123-135`, the current code is:

```ts
export function enforceToolCallLimit(
  actions: AgentLoopAction[],
  executedToolBatches: number,
  toolCallLimit: number,
): AgentLoopAction[] {
  const requestsTools = actions.some((action) => action.kind === 'tool');
  if (requestsTools && executedToolBatches >= toolCallLimit) {
    throw new NativePlannerResponseError(
      `Tool-call limit reached (${executedToolBatches}/${toolCallLimit} batches used). Do not call tools again; return your final answer as content.`,
    );
  }
  return actions;
}
```

Replace the thrown message with:

```ts
    throw new NativePlannerResponseError(
      `${buildToolLimitReachedSummary(executedToolBatches, toolCallLimit)} Do not call tools again; return your final answer as content.`,
    );
```

Add `buildToolLimitReachedSummary` to the existing `./task-loop-support.js` import in `task-loop.ts` (around line 78, the import that already contains `ToolBatchTally`).

- [ ] **Step 4: Re-run the pinning suites**

Run: `npx tsx --test tests/tool-call-limit.test.ts tests/tool-budget-notice.test.ts`
Expected: PASS — identical messages, so no test changes.

### Task 2: Never drop the budget notice on an outcome-less (replay) batch

**Files:**
- Modify: `src/repo-search/engine/tool-action-processor.ts:238-244`
- Test: `tests/engine-tool-action-processor.test.ts` (new regression test)

- [ ] **Step 1: Write the failing regression test**

Append to `tests/engine-tool-action-processor.test.ts` (it already imports `fs`, `path`, `createManagedTempDir`, and `makeProcessor`):

```ts
// The duplicate-replay path (3rd identical call) replaces a transcript message instead of
// pushing a batchOutcome, so the batch ends with batchOutcomes empty — yet it still consumed
// a budget unit. The notice must then arrive as a user message, not vanish.
test('budget notice still reaches the model when a batch collapses onto a duplicate replay', async () => {
  const root = createManagedTempDir('siftkit-replay-budget-notice-');
  fs.writeFileSync(path.join(root, 'a.ts'), 'alpha\n', 'utf8');
  const { processor, transcript } = makeProcessor(root);

  await processor.executeBatch(1, [{ kind: 'tool', callId: 'replay_1', toolName: 'ls', args: { path: '.' } }], '', { reported: 0, budgeted: 0 }, false);
  await processor.executeBatch(2, [{ kind: 'tool', callId: 'replay_2', toolName: 'ls', args: { path: '.' } }], '', { reported: 0, budgeted: 0 }, false);
  await processor.executeBatch(3, [{ kind: 'tool', callId: 'replay_3', toolName: 'ls', args: { path: '.' } }], '', { reported: 0, budgeted: 0 }, false);

  // Batch 3 took the replay path (no batchOutcomes); with the helper's toolCallLimit of 5
  // the countdown notice for 3/5 used must land as a trailing user message.
  const messages = transcript.getMessages();
  const last = messages[messages.length - 1];
  assert.equal(last?.role, 'user');
  assert.match(String(last?.content ?? ''), /2 tool-call batches remaining \(3\/5 used\)/u);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx tsx --test tests/engine-tool-action-processor.test.ts`
Expected: the new test FAILS (the notice is dropped, so the last message is not the countdown notice); all pre-existing tests PASS.

- [ ] **Step 3: Implement the fallback delivery**

In `src/repo-search/engine/tool-action-processor.ts:236-242`, the current code is:

```ts
    const lastOutcome = state.batchOutcomes[state.batchOutcomes.length - 1];
    if (lastOutcome !== undefined) {
      const notice = buildToolBudgetNotice(counters.executedToolBatches, this.deps.toolCallLimit);
      if (notice !== null) {
        lastOutcome.toolContent = `${lastOutcome.toolContent}\n\n${notice}`;
      }
    }
```

Replace with:

```ts
    const notice = buildToolBudgetNotice(counters.executedToolBatches, this.deps.toolCallLimit);
    if (notice !== null) {
      const lastOutcome = state.batchOutcomes[state.batchOutcomes.length - 1];
      if (lastOutcome !== undefined) {
        lastOutcome.toolContent = `${lastOutcome.toolContent}\n\n${notice}`;
      } else {
        // All actions took the duplicate-replay path, which replaces transcript messages
        // instead of pushing outcomes; the batch still consumed a budget unit, so the
        // notice rides the pending-user-message flush instead of being dropped.
        state.pendingModeChangeUserMessages.push(notice);
      }
    }
```

- [ ] **Step 4: Run to verify pass**

Run: `npx tsx --test tests/engine-tool-action-processor.test.ts`
Expected: PASS (all tests, including the new one).

- [ ] **Step 5: Run the neighbouring suites**

Run: `npx tsx --test tests/repo-search-loop.core.test.ts tests/image-retention.test.ts tests/image-read-tool.test.ts`
Expected: PASS.

### Task 3: Pin the percent/countdown boundary behavior

**Files:**
- Test: `tests/tool-budget-notice.test.ts` (additions only; no production change)

- [ ] **Step 1: Add the boundary tests**

Append to `tests/tool-budget-notice.test.ts`:

```ts
test('percent notices only fire while more than the countdown window remains', () => {
  // limit 14: the 25% threshold is ceil(3.5) = 4 with remaining 10 (> window 9) → percent notice.
  assert.match(String(buildToolBudgetNotice(4, 14)), /25% of the tool-call budget used \(4\/14/u);
  // one more batch: remaining 9 enters the countdown window, which outranks percents.
  assert.match(String(buildToolBudgetNotice(5, 14)), /9 tool-call batches remaining \(5\/14 used\)/u);
});

test('tiny limits never mislabel: percent collisions are covered by the countdown window', () => {
  // ceil(percent·limit) collisions require limit < 4, where remaining is always ≤ 9, so the
  // countdown or limit-reached message wins and the percent loop is never consulted.
  assert.match(String(buildToolBudgetNotice(1, 2)), /1 tool-call batch remaining \(1\/2 used\)/u);
  assert.match(String(buildToolBudgetNotice(1, 3)), /2 tool-call batches remaining \(1\/3 used\)/u);
  assert.match(String(buildToolBudgetNotice(2, 2)), /Tool-call limit reached \(2\/2 batches used\)/u);
});
```

- [ ] **Step 2: Run to verify pass**

Run: `npx tsx --test tests/tool-budget-notice.test.ts`
Expected: PASS (these pin already-correct behavior; if any fails, stop — that is a real bug, report it).

### Task 4: Derive slack-turn arithmetic from POST_LIMIT_ANSWER_SLACK_TURNS

**Files:**
- Modify: `tests/repo-search-chat-loop.test.ts` (~line 251)
- Modify: `tests/mock-repo-search-loop.test.ts` (~lines 1247-1281)
- Modify: `tests/repo-search-terminal-synthesis-retry.test.ts` (three tests)

- [ ] **Step 1: chat-loop — derive the empty-response turn count**

In `tests/repo-search-chat-loop.test.ts` add to the imports:

```ts
import { POST_LIMIT_ANSWER_SLACK_TURNS } from '../src/repo-search/engine/task-loop-support.js';
```

Then replace (around line 249-251):

```ts
        // Empty responses for every loop turn (maxTurns 1 + the finishing-headroom
        // slack turns) so the run exhausts and terminal synthesis streams the answer.
        if (requestCount <= 4) {
```

with:

```ts
        // Empty responses for every loop turn (maxTurns 1 + the finishing-headroom
        // slack turns) so the run exhausts and terminal synthesis streams the answer.
        if (requestCount <= 1 + POST_LIMIT_ANSWER_SLACK_TURNS) {
```

- [ ] **Step 2: mock-loop — derive the turn-count asserts**

In `tests/mock-repo-search-loop.test.ts` add to the imports:

```ts
import { POST_LIMIT_ANSWER_SLACK_TURNS } from '../src/repo-search/engine/task-loop-support.js';
```

In the test `runTaskLoop keeps reasoning disabled across max-turn exhaustion when runtime …` (around lines 1247-1281), replace:

```ts
      maxTurns: 3,
      // Above the post-budget strike count (3 slack turns) so the run reaches
      // the turn cap instead of the invalid-response limit.
      maxInvalidResponses: 4,
```

with:

```ts
      maxTurns: 3,
      // Above the post-budget strike count (the slack turns) so the run reaches
      // the turn cap instead of the invalid-response limit.
      maxInvalidResponses: POST_LIMIT_ANSWER_SLACK_TURNS + 1,
```

and replace:

```ts
  const turnRequests = events.filter((event) => event.kind === 'turn_model_request');
  // 3 budget turns + FORCED_FINISH_MAX_ATTEMPTS slack turns.
  assert.equal(turnRequests.length, 6);
  assert.equal(turnRequests[0].thinkingEnabled, false);
  assert.equal(turnRequests[5].thinkingEnabled, false);
```

with:

```ts
  const turnRequests = events.filter((event) => event.kind === 'turn_model_request');
  // 3 budget turns + POST_LIMIT_ANSWER_SLACK_TURNS slack turns.
  const expectedTurnRequests = 3 + POST_LIMIT_ANSWER_SLACK_TURNS;
  assert.equal(turnRequests.length, expectedTurnRequests);
  assert.equal(turnRequests[0].thinkingEnabled, false);
  assert.equal(turnRequests[expectedTurnRequests - 1].thinkingEnabled, false);
```

(The 6-entry `mockResponses` literal stays: it is data, and the derived assert now names the constant when the count drifts.)

- [ ] **Step 3: synthesis-retry — one shared strike constant with a loud coupling guard**

In `tests/repo-search-terminal-synthesis-retry.test.ts`, after the existing `const MOCK_LOOP_DEFAULTS = createMockLoopDefaults('siftkit-syn-loop-');` line, add (plus the import):

```ts
import { POST_LIMIT_ANSWER_SLACK_TURNS } from '../src/repo-search/engine/task-loop-support.js';
```

```ts
// Each test strikes out on empty responses at maxInvalidResponses, ending the loop inside
// the finishing-headroom turns; synthesis then consumes the remaining mocks. The strikes
// must fit inside the single budget turn plus the slack turns — fail loudly if not.
const MAX_INVALID_RESPONSES = 3;
assert.equal(MAX_INVALID_RESPONSES <= 1 + POST_LIMIT_ANSWER_SLACK_TURNS, true);
const EMPTY_STRIKES = Array.from({ length: MAX_INVALID_RESPONSES }, () => ({}));
```

In each of the three tests, replace `maxInvalidResponses: 3,` with `maxInvalidResponses: MAX_INVALID_RESPONSES,` and replace the block of three `{}` mock entries (and their per-test comment):

```ts
      mockResponses: [
        // Empty responses strike out at maxInvalidResponses (3), ending the loop
        // inside the finishing-headroom turns; synthesis consumes the next mock.
        {},
        {},
        {},
        { content: 'The definition lives in src/foo.ts:1.' },
      ],
```

with:

```ts
      mockResponses: [
        ...EMPTY_STRIKES,
        { content: 'The definition lives in src/foo.ts:1.' },
      ],
```

(Apply the same `...EMPTY_STRIKES,` replacement in the other two tests, keeping each test's own trailing `{ content: … }` entries exactly as they are.)

- [ ] **Step 4: Run the three suites**

Run: `npx tsx --test tests/repo-search-chat-loop.test.ts tests/mock-repo-search-loop.test.ts tests/repo-search-terminal-synthesis-retry.test.ts`
Expected: PASS.

### Task 5: Hoist the helper's duplicated toolCallLimit literal

**Files:**
- Modify: `tests/helpers/tool-action-processor.ts` (lines ~87-100)

- [ ] **Step 1: Hoist the constant**

In `tests/helpers/tool-action-processor.ts`, add near the top of the file (below the imports):

```ts
// Shared between the ProgressReporter display and the enforced deps budget — they must agree.
const TOOL_CALL_LIMIT = 5;
```

Then replace `toolCallLimit: 5,` inside the `ProgressReporter` options (line ~91) with `toolCallLimit: TOOL_CALL_LIMIT,` and the deps field `toolCallLimit: 5,` (line ~100) with `toolCallLimit: TOOL_CALL_LIMIT,`.

- [ ] **Step 2: Run the suites that use the helper**

Run: `npx tsx --test tests/engine-tool-action-processor.test.ts tests/image-retention.test.ts tests/image-read-tool.test.ts`
Expected: PASS.

---

**Final verification (all tasks):** `npm run typecheck:test`, `npm run lint`, then `npm run build:test` followed by `npm run test` must pass. Do not commit.
