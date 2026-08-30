# Tool-Batch Budget, Budget Notices, and Restricted-Prompt Shell Note — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
> **Do NOT commit at any step.** The orchestrator reviews and commits.

**Goal:** A planner response with multiple tool calls consumes 1 unit of the tool-call budget (not N); the model receives in-band budget notices at 25/50/75% used and a countdown over the last 10 units (limit-reached message at 100%, with slack turns to deliver the final answer); the restricted fallback system prompt declares that `run` executes in PowerShell.

**Architecture:** The budget unit becomes the executed tool batch, tracked in a `{ executed: number }` tally owned by `TaskLoop` and shared by reference with `ToolActionProcessor` (same pattern as the shared `commands` array). Notices are appended to the last tool result of a batch inside `executeBatch`. `AgentLoop` gets `FORCED_FINISH_MAX_ATTEMPTS` slack turns beyond the budget so the model can finish after exhaustion. The PowerShell guidance becomes a shared constant used by both the rich agent prompt and the restricted fallback prompt.

**Tech Stack:** TypeScript (strict, inferred end-to-end, no `any`/assertions/non-null), `node:test` + `node:assert/strict`.

**Background (why):** Today `toolCallLimit === maxTurns` (task-loop.ts:207) and `enforceToolCallLimit` counts individual tool calls, so batching 2 calls/turn exhausts the budget ~25 turns early, with zero warning, and the rejection message is contradictory. Two real repo-agent runs on 2026-08-29 died at exactly 100 commands with `invalid_response_limit` at their final verification step. Separately, `buildAgentSystemPrompt`'s PowerShell note (prompts.ts:347) is silently dropped whenever the tool surface is not exactly `INTERACTIVE_REPO_TOOL_NAMES` (e.g. web tools disabled), because the fallback `buildRestrictedToolSystemPrompt` has no shell note.

---

### Task 1: Count a batch as one budget unit, with finishing headroom

**Files:**
- Modify: `src/repo-search/engine/task-loop-support.ts` (add `ToolBatchTally` type)
- Modify: `src/repo-search/engine/task-loop.ts:122-135` (`enforceToolCallLimit`), `:182` area (tally field), `:410-416` (AgentLoop headroom), `:313-355` (`buildToolActionProcessor` deps), `:547-549` (`validateActions`)
- Modify: `src/repo-search/engine/tool-action-processor.ts:150-187` (deps type), `:196-222` (`executeBatch` increment)
- Modify: `tests/helpers/tool-action-processor.ts` (deps construction — add new fields)
- Test: `tests/tool-call-limit.test.ts` (rewrite), `tests/repo-search-loop.core.test.ts` (new E2E)

- [ ] **Step 1: Rewrite the unit tests to pin batch semantics (failing first)**

Replace the two existing tests in `tests/tool-call-limit.test.ts` (keep the imports and the `tool()` helper):

```ts
test('a multi-call batch is one budget unit: allowed with exactly one batch remaining', () => {
  const actions = [tool('a'), tool('b'), tool('c')];
  assert.equal(enforceToolCallLimit(actions, 44, 45), actions);
});

test('tool calls are rejected once the batch budget is exhausted', () => {
  assert.throws(
    () => enforceToolCallLimit([tool('a')], 45, 45),
    /Tool-call limit reached \(45\/45 batches used\)/u,
  );
});

test('content-only responses pass even at the limit', () => {
  const actions: AgentLoopAction[] = [];
  assert.equal(enforceToolCallLimit(actions, 45, 45), actions);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx tsx --test tests/tool-call-limit.test.ts`
Expected: FAIL — first test throws (`3 tool calls with 1 remaining`), second test message mismatch.

- [ ] **Step 3: Implement the new `enforceToolCallLimit`**

In `src/repo-search/engine/task-loop.ts:122-135`, replace the function body:

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

- [ ] **Step 4: Add the shared tally**

In `src/repo-search/engine/task-loop-support.ts`, next to the exported counters/limits (near `DEFAULT_MAX_INVALID_RESPONSES`):

```ts
/** Executed tool batches (one per planner response that ran tools); shared by reference between TaskLoop and ToolActionProcessor. */
export type ToolBatchTally = { executed: number };
```

In `src/repo-search/engine/task-loop.ts`:
- Add `ToolBatchTally` to the existing `./task-loop-support.js` import.
- Add a field next to `private readonly commands: TaskCommand[] = [];` (line 182):

```ts
private readonly toolBatchTally: ToolBatchTally = { executed: 0 };
```

- In `validateActions` (:547-549):

```ts
validateActions(actions: AgentLoopAction[]): AgentLoopAction[] {
  return enforceToolCallLimit(actions, this.toolBatchTally.executed, this.toolCallLimit);
}
```

- In `buildToolActionProcessor` (:313-355), add to the deps object next to `commands: this.commands,`:

```ts
toolBatchTally: this.toolBatchTally,
toolCallLimit: this.toolCallLimit,
```

- [ ] **Step 5: Increment in `executeBatch`**

In `src/repo-search/engine/tool-action-processor.ts`:
- Add to `ToolActionProcessorDeps` (:150-187), next to `commands: TaskCommand[];`:

```ts
toolBatchTally: ToolBatchTally;
toolCallLimit: number;
```

  Add `ToolBatchTally` to the existing `./task-loop-support.js` type import in this file (the file already imports `TaskCommand`/`LoopCounters` types — extend that import).

- At the top of `executeBatch` (:196), immediately after the `const { transcript, duplicates, counters } = this.deps;` line (AgentLoop only calls `executeTools` with a non-empty batch, agent-loop.ts:108-111):

```ts
this.deps.toolBatchTally.executed += 1;
```

- [ ] **Step 6: Give AgentLoop finishing headroom**

Without headroom, a model that runs tools every turn hits the turn cap (`AgentLoop` `maxTurns`, agent-loop.ts:41) in the same turn the batch budget empties and can never deliver its final answer. In `src/repo-search/engine/task-loop.ts:410-416`:

```ts
await new AgentLoop({
  // Tool batches consume the budget (1 per tool-bearing turn); the slack turns
  // exist so the model can still deliver its final answer after the
  // limit-reached notice instead of dying on the turn cap.
  maxTurns: this.maxTurns + FORCED_FINISH_MAX_ATTEMPTS,
  promptAdapter,
  actionAdapter,
  toolAdapter,
  modelClient: new RepoSearchPlannerModelClient(this),
}).run();
```

Import `FORCED_FINISH_MAX_ATTEMPTS` from `./forced-finish.js` (the file already imports `ForcedFinishController` from there).

- [ ] **Step 7: Fix the test helper**

`tests/helpers/tool-action-processor.ts` constructs `ToolActionProcessorDeps`; add the two new fields to that construction:

```ts
toolBatchTally: { executed: 0 },
toolCallLimit: 5,
```

(Match the helper's existing limit of 5 — see its `toolCallLimit: 5` at line 91 area for the ProgressReporter; keep both consistent.)

- [ ] **Step 8: Add the E2E regression (failing under old semantics by construction)**

Append to `tests/repo-search-loop.core.test.ts` (imports of `createJsonLogger` from `../src/repo-search/logging.js` needed):

```ts
test('runTaskLoop counts a multi-call batch as one tool-budget unit and leaves a finishing turn after exhaustion', async () => {
  const logger = createJsonLogger('db://test-batch-budget');
  const result = await runTaskLoop(
    { id: 'task-batch-budget', question: 'Exercise the batch budget.' },
    {
      ...MOCK_LOOP_DEFAULTS,
      maxTurns: 2,
      maxInvalidResponses: 2,
      minToolCallsBeforeFinish: 0,
      logger,
      mockResponses: [
        {
          toolCalls: [
            { name: 'git', arguments: { operation: 'grep', pattern: 'alpha', path: 'src' } },
            { name: 'git', arguments: { operation: 'grep', pattern: 'beta', path: 'src' } },
          ],
        },
        { toolCalls: [{ name: 'git', arguments: { operation: 'grep', pattern: 'gamma', path: 'src' } }] },
        { content: 'done' },
        { content: '{"verdict":"pass","reason":"supported"}' },
      ],
      mockCommandResults: {
        'git operation="grep" path="src" pattern="alpha"': { exitCode: 0, stdout: 'alpha hit', stderr: '' },
        'git operation="grep" path="src" pattern="beta"': { exitCode: 0, stdout: 'beta hit', stderr: '' },
        'git operation="grep" path="src" pattern="gamma"': { exitCode: 0, stdout: 'gamma hit', stderr: '' },
      },
    },
  );

  // Old semantics: the 2-call batch consumed the whole budget (2/2) and the
  // second batch was rejected. New semantics: 2 batches used, then a slack turn
  // lets the model finish.
  assert.equal(result.reason, 'finish');
  assert.equal(result.commands.length, 3);
  assert.equal(result.rejectedCalls, 0);
});
```

- [ ] **Step 9: Run the touched suites**

Run: `npx tsx --test tests/tool-call-limit.test.ts tests/repo-search-loop.core.test.ts tests/image-retention.test.ts`
Expected: PASS (image-retention exercises the test helper you changed).

### Task 2: Budget notices (25/50/75% + last-10 countdown + limit-reached)

**Files:**
- Modify: `src/repo-search/engine/task-loop-support.ts` (add `buildToolBudgetNotice`)
- Modify: `src/repo-search/engine/tool-action-processor.ts` (`executeBatch` injection)
- Test: `tests/tool-budget-notice.test.ts` (new), `tests/repo-search-loop.core.test.ts` (extend Task 1's E2E)

- [ ] **Step 1: Write the failing unit tests**

Create `tests/tool-budget-notice.test.ts`:

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

test('countdown covers the last ten units and the limit-reached message', () => {
  assert.match(String(buildToolBudgetNotice(91, 100)), /9 tool-call batches remaining \(91\/100 used\)/u);
  assert.match(String(buildToolBudgetNotice(99, 100)), /1 tool-call batch remaining \(99\/100 used\)/u);
  assert.match(String(buildToolBudgetNotice(100, 100)), /Tool-call limit reached \(100\/100 batches used\)/u);
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
  assert.match(String(buildToolBudgetNotice(6, 8)), /2 tool-call batches remaining/u);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx tsx --test tests/tool-budget-notice.test.ts`
Expected: FAIL — `buildToolBudgetNotice` is not exported.

- [ ] **Step 3: Implement the helper**

In `src/repo-search/engine/task-loop-support.ts`, below the `ToolBatchTally` type:

```ts
const TOOL_BUDGET_PERCENT_NOTICES = [25, 50, 75] as const;
const TOOL_BUDGET_COUNTDOWN_WINDOW = 9;

/** In-band budget notice appended to the last tool result of a batch; null when no threshold was crossed. */
export function buildToolBudgetNotice(executedBatches: number, toolCallLimit: number): string | null {
  const remaining = toolCallLimit - executedBatches;
  if (remaining <= 0) {
    return `[tool budget] Tool-call limit reached (${executedBatches}/${toolCallLimit} batches used). You must finish now: reply with your final answer as content only — any further tool call will be rejected.`;
  }
  if (remaining <= TOOL_BUDGET_COUNTDOWN_WINDOW) {
    return `[tool budget] ${remaining} tool-call batch${remaining === 1 ? '' : 'es'} remaining (${executedBatches}/${toolCallLimit} used). Prioritize verification and finishing.`;
  }
  for (const percent of TOOL_BUDGET_PERCENT_NOTICES) {
    if (executedBatches === Math.ceil((percent / 100) * toolCallLimit)) {
      return `[tool budget] ${percent}% of the tool-call budget used (${executedBatches}/${toolCallLimit} batches).`;
    }
  }
  return null;
}
```

- [ ] **Step 4: Run unit tests to verify pass**

Run: `npx tsx --test tests/tool-budget-notice.test.ts`
Expected: PASS (all 4).

- [ ] **Step 5: Inject the notice in `executeBatch`**

In `src/repo-search/engine/tool-action-processor.ts` `executeBatch`, after the `for (const [batchIndex, toolAction] ...)` loop ends and **before** `this.collector.recordBatch(...)` (:233-234), append to the last outcome so the notice is the final thing the model reads in the batch:

```ts
const lastOutcome = state.batchOutcomes[state.batchOutcomes.length - 1];
if (lastOutcome !== undefined) {
  const notice = buildToolBudgetNotice(this.deps.toolBatchTally.executed, this.deps.toolCallLimit);
  if (notice !== null) {
    lastOutcome.toolContent = `${lastOutcome.toolContent}\n\n${notice}`;
  }
}
```

Import `buildToolBudgetNotice` from `./task-loop-support.js` (extend the existing import). If the outcome entry type declares `toolContent` readonly, replace the last array element with a spread copy instead of mutating — do not weaken the type.

- [ ] **Step 6: Extend the Task 1 E2E with notice assertions**

In the `runTaskLoop counts a multi-call batch as one tool-budget unit...` test added in Task 1, append after the existing asserts (notices reach the transcript and are logged by `turn_new_messages` on the following turn):

```ts
  const logText = logger.getText();
  assert.match(logText, /1 tool-call batch remaining \(1\/2 used\)/u);
  assert.match(logText, /Tool-call limit reached \(2\/2 batches used\)/u);
```

- [ ] **Step 7: Run the touched suites**

Run: `npx tsx --test tests/tool-budget-notice.test.ts tests/repo-search-loop.core.test.ts tests/tool-call-limit.test.ts`
Expected: PASS.

### Task 3: PowerShell note in the restricted fallback prompt

**Files:**
- Modify: `src/repo-search/prompts.ts:242-256` (`buildRestrictedToolSystemPrompt`), `:347` (extract shared constant)
- Test: `tests/repo-search-prompts.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `tests/repo-search-prompts.test.ts` (it already imports `buildAgentSystemPromptForTools`, `resolveRepoSearchPlannerToolDefinitions`, and defines `buildTestContext`):

```ts
test('restricted agent prompt with run declares the PowerShell shell and forbids nesting', () => {
  const context = buildTestContext(process.cwd(), false, true);
  const withRun = buildAgentSystemPromptForTools(context, resolveRepoSearchPlannerToolDefinitions(['read', 'run']));
  assert.match(withRun, /executes in PowerShell/u);
  assert.match(withRun, /never wrap them in `powershell -Command`/u);
  const withoutRun = buildAgentSystemPromptForTools(context, resolveRepoSearchPlannerToolDefinitions(['read']));
  assert.doesNotMatch(withoutRun, /executes in PowerShell/u);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx tsx --test tests/repo-search-prompts.test.ts`
Expected: FAIL — restricted prompt has no PowerShell line.

- [ ] **Step 3: Implement via a shared constant**

In `src/repo-search/prompts.ts`, next to `COMPLETION_REVIEW_INSTRUCTION` (:227-228):

```ts
const RUN_SHELL_GUIDANCE = `- \`run\` executes in ${RUN_SHELL_LABEL}: use PowerShell syntax (Select-Object -Last N, Select-String, Get-Content -Tail N). Unix (tail/head/grep) and cmd (\`&\`, \`%ERRORLEVEL%\`) are NOT available. Commands already run inside PowerShell — never wrap them in \`powershell -Command\`.`;
```

In `buildRestrictedToolSystemPrompt` (:242-256), insert after the file-listing line and before the `'Finish only when...'` line:

```ts
...(options.toolNames.includes('run') ? [RUN_SHELL_GUIDANCE] : []),
```

In `buildAgentSystemPrompt`, replace the line at :347 (the existing `- \`run\` executes in ${RUN_SHELL_LABEL}: ...` template literal) with:

```ts
RUN_SHELL_GUIDANCE,
```

- [ ] **Step 4: Run the prompt suite**

Run: `npx tsx --test tests/repo-search-prompts.test.ts`
Expected: PASS, including the pre-existing test at :284 (`buildAgentSystemPrompt tells the run tool it is PowerShell...`). If that test pins the exact old sentence end, update its regex to accept the appended "never wrap" sentence — do not delete its existing assertions.

---

**Final verification (all tasks):** `npm run typecheck:test`, `npm run lint`, then `npm run build:test` followed by `npm run test` must pass. Do not commit.
