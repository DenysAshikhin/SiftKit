# repo-search answers on context overflow; repo-agent keeps compacting

## Problem

Today every loop kind reacts to a prompt-budget overflow the same way: `PromptPreparer.prepareTurn`
compacts the transcript (`src/repo-search/engine/prompt-preparer.ts`) and, if the rebuilt prompt is
still over budget, throws `planner_preflight_overflow`.

Wanted behaviour:

* `repo-search` (loop kind `repo-search`, i.e. task kinds `plan` and `repo-search`): do **not**
  compact. Stop the loop at the overflowing turn and let the existing `TerminalSynthesizer` produce
  a best-effort final answer from the transcript as it stands.
* `repo-agent` and `chat`: unchanged — compact and keep going; a post-compaction overflow still
  fails loudly.

The trigger point stays exactly where it is: `preflight.ok === false`, i.e. prompt tokens exceed
`totalContextTokens - responseReserveTokens`. `TurnBudget.compactionReserveTokens` keeps its current
value for every loop kind; for `repo-search` that slack is what guarantees the terminal-synthesis
request has prompt headroom.

## Task 1 — `context_overflow` end reason and the per-loop overflow policy

**Files:** `src/repo-search/engine/task-loop-support.ts`, `src/repo-search/engine/runtime-profile.ts`,
`tests/task-end-reason-verdict.test.ts`, `tests/repo-search-runtime-profile.test.ts`

Steps:

1. Add `'context_overflow'` to `TASK_END_REASONS`. It is an abort, not a completion: a final answer
   is still synthesized, but the run did not finish on its own, so `taskPassed`/`buildScorecard`
   must keep scoring it as a failure exactly like `max_turns`. Extend the enum's doc comment with
   one line naming the new reason.
2. Add to `RepoSearchRuntimeProfile`:

   ```ts
   get contextOverflowPolicy(): 'force_answer' | 'compact' {
     return this.loopKind === 'repo-search' ? 'force_answer' : 'compact';
   }
   ```

   Comment it with why: repo-search answers from the evidence it already has, repo-agent and chat
   have work left to do and must survive the overflow.

Tests (write first, watch them fail):

* `tests/task-end-reason-verdict.test.ts`: extend the exhaustive `TASK_END_REASONS` list assertion
  with `context_overflow`, and add a `buildScorecard` case asserting a `context_overflow` task
  scores `fail` with `failureReasons === ['repo-search: ended with reason context_overflow']`.
* `tests/repo-search-runtime-profile.test.ts`: extend the per-task-kind expectations table with
  `contextOverflowPolicy` — `plan` and `repo-search` → `'force_answer'`, `chat` and `repo-agent`
  → `'compact'`.

Acceptance criteria:

* `TaskEndReasonSchema.safeParse('context_overflow').success === true`.
* Both test files pass; no other production file changes in this task.

## Task 2 — `PromptPreparer` returns a context-overflow outcome instead of compacting

**Files:** `src/repo-search/engine/prompt-preparer.ts`, `tests/engine-prompt-preparer.test.ts`

Steps:

1. Turn `PreparedTurnBudget` into a discriminated union (no optional/boolean flags):

   ```ts
   export type PreparedTurnBudget =
     | {
         kind: 'ready';
         promptTokens: TurnPromptTokens;
         maxOutputTokens: number;
         /** The raw summary text when this turn compacted, else null. */
         compactionSummary: string | null;
         nextMockResponseIndex: number;
       }
     | {
         kind: 'context_overflow';
         promptTokenCount: number;
         maxPromptBudget: number;
         overflowTokens: number;
         maxOutputTokens: number;
       };
   ```

2. In `prepareTurn`, inside the existing `if (!preflight.ok)` branch, before any compaction:
   when `this.options.runtimeProfile.contextOverflowPolicy === 'force_answer'`, write a
   `turn_preflight_forced_answer` log event carrying `taskId`, `turn`, `promptTokenCount`,
   `transcriptPromptTokenCount`, `providerPromptReserveTokenCount`, `maxPromptBudget`,
   `overflowTokens`, `maxOutputTokens`, `totalContextTokens`, `responseReserveTokens`, and return
   the `context_overflow` variant. Do not call the compactor, do not mutate the transcript, do not
   advance `mockResponseIndex`, do not throw.
3. The `compact` path is otherwise untouched: it still compacts once, re-preflights, and calls
   `failOverflow` when the rebuilt prompt is still over budget.
4. All existing return sites must set `kind: 'ready'`.

Tests (write first):

* New: a `repo-search` preparer over an overflowing transcript returns `kind === 'context_overflow'`
  with `overflowTokens > 0` and `maxOutputTokens > 0`; the transcript is untouched
  (`transcript.generation === 0`, roles unchanged, no `prompt_cache_epoch_reset` and no
  `turn_preflight_compaction_applied` event); a `turn_preflight_forced_answer` event was written.
* New: the same setup with an empty `mockResponses` array still returns `context_overflow` rather
  than rejecting with `planner_compaction_failed` — proof the compactor is never called.
* Migrate every existing compaction test in this file to `taskKind: 'repo-agent'` (they currently
  rely on the `'repo-search'` default): the "compacts an overflowing transcript to system, summary,
  latest user", "compacts at most once per turn and then reports overflow", "releases image guards",
  "surfaces a summarizer failure as planner_compaction_failed" and "preserved reasoning mass
  triggers compaction" tests. `latest_user` retention is shared by `repo-agent`, so their
  assertions hold unchanged. The now-duplicate "compacts an overflowing repo-agent transcript" test
  is removed — the migrated cases cover it.
* Non-overflowing cases keep asserting `kind === 'ready'` and `compactionSummary === null`.

Acceptance criteria:

* `npx tsx --test tests/engine-prompt-preparer.test.ts` passes.
* No `any`, no type assertions, no non-null assertions; the union is discriminated on `kind`.
* `src/repo-search/engine/task-loop.ts` is **not** edited in this task (it is task 3) — it is
  expected to fail typecheck until then; say so in the report instead of patching it.

## Task 3 — the loop stops on overflow and terminal synthesis writes the answer

*(Primary agent implements this task; it is listed here so the plan is complete.)*

**Files:** `src/repo-search/engine/task-loop.ts`, `tests/mock-repo-search-loop.test.ts`

Steps:

1. In `RepoSearchTaskLoop.prepareTurn`, switch on `prepared.kind`. For `context_overflow`: set
   `this.counters.reason = 'context_overflow'`, write a `turn_context_overflow_forced_answer` log
   event, and return an `AgentLoopPreparedTurn` with `outcome: 'stop'` (prompt tokens taken from the
   overflow numbers, current messages and tool definitions, `inForcedFinishMode`). `AgentLoop.run`
   stops on that outcome without issuing a model request.
2. For `kind: 'ready'` the existing body is unchanged.
3. `buildAgentLoopResult` then finds an empty `finalOutput` and runs `TerminalSynthesizer` with
   `reason = 'context_overflow'`, which asks for a best-effort answer with tools removed and
   `maxTokens = min(responseReserve, totalContext - promptTokens)`.

Tests: a mock repo-search loop whose transcript overflows the window ends with
`reason === 'context_overflow'`, a non-empty `finalOutput` produced by terminal synthesis, and no
compaction summary; the equivalent repo-agent loop still compacts and keeps taking turns.

Acceptance criteria: `npm run typecheck` and the full `npm test` suite pass.
