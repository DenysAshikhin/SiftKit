# Collapse the derived task verdict and split the conflated failure counter

## Context

`passed` on a task result became fully derivable when the verdict gate changed to
`passed = reason === 'finish'` (`src/repo-search/engine/task-loop.ts:817`). The bit is still
stored in `TaskResultSchema`, so incoherent pairs like `reason:'finish', passed:false` remain
representable and every fixture has to keep the two in sync by hand. The same fact is then
re-derived twice more downstream (`totals.failed` -> `verdict`), producing a triple-redundant
gate in `classifyRepoAgentExecutionResult`.

Separately, `commandFailures` conflates pre-execution rejections with real non-zero exits. The
engine counts both; the live-snapshot collector counts only non-zero exits (rejections carry
`exitCode: null`), so the dashboard number and the scorecard number disagree for the same run.

Established facts (verified before writing this plan):

- No code anywhere reads `passed` off the `task_done` log event.
- `LiveRunSnapshotSchema` is never re-parsed on read; the snapshot file is deleted at teardown.
- The transcript JSONL is parsed generically per line with no field-level schema, so removing or
  renaming fields does not break replay of old transcripts.
- No dashboard, desktop, or package source references `commandFailures`.
- `turn_command_result` already carries optional `rejected` / `rejectionReason`
  (`src/repo-search/live-snapshot/schemas.ts:178-187`); the collector currently drops them.

There are therefore no compatibility constraints. Both changes are complete replacements: no
shims, no parallel fields.

## Task 1 - Remove the stored `passed` bit; derive it from `reason`

### Steps

1. In `src/repo-search/engine/task-loop-support.ts`:
   - Delete `passed: z.boolean(),` (line 128) from `TaskResultSchema`.
   - After `export type TaskResult = ...`, add the single derivation, carrying the rationale
     comment currently at `task-loop.ts:812-816`:

     ```ts
     /**
      * A task passed iff it ended by finishing. A run that stopped on a turn, invalid-response or
      * forced-finish limit did not answer the question; scoring it as a pass is how run 100b487d
      * reported verdict=pass while its own terminal synthesis said "Incomplete". Command exit codes
      * are telemetry, not verdict input: TDD red runs and recovered failures are normal work (runs
      * ac543c1c, ceeedb28 were falsely failed by the old exit-code gate).
      */
     export function taskPassed(task: Pick<TaskResult, 'reason'>): boolean {
       return task.reason === 'finish';
     }
     ```

2. In `src/repo-search/engine/task-loop.ts`:
   - Delete the `const passed = this.counters.reason === 'finish';` statement and the comment
     block above it (lines 812-817); the comment now lives on `taskPassed`.
   - Remove `passed` from the `task_done` logger payload (line 822). `reason` is already emitted
     there and is the sole source of truth.
   - Remove `passed` from the returned task result object (line 831).

3. In `src/repo-search/engine.ts`, import `taskPassed` and use it:
   - Line 75: `passed: options.tasks.filter((t) => taskPassed(t)).length,`
   - Line 76: `failed: options.tasks.filter((t) => !taskPassed(t)).length,`
   - Lines 100-104: collapse the two-level guard, which is now one condition:

     ```ts
     const failureReasons: string[] = [];
     for (const task of options.tasks) {
       if (!taskPassed(task)) failureReasons.push(`${task.id}: ended with reason ${task.reason}`);
     }
     ```

   `totals.passed` / `totals.failed` / `verdict` stay as scorecard aggregates - they are consumed
   downstream and are not per-task duplication.

4. Update every test that asserts or sets the removed field. Assert on the cause (`reason`), not
   the removed derived bit:
   - `tests/_test-helpers.ts` - drop `passed: true` from `buildMockTaskResult`.
   - `tests/mock-repo-search-loop.test.ts:622` and
     `tests/repo-search-loop.core.test.ts:200,567,613,662,747,782,807` - replace
     `assert.equal(result.passed, true)` with `assert.equal(result.reason, 'finish')`. Where the
     surrounding test already asserts `reason`, delete the redundant assertion instead.
   - `tests/repo-agent-sessions.test.ts:66` - replace `task.passed = false;` with
     `task.reason = 'max_turns';`.
   - Any fixture literal that sets `passed` must drop it; a leftover extra key must not be
     silently accepted.

### Tests

- Add a regression test in `tests/task-end-reason-verdict.test.ts` asserting that for every
  member of `TASK_END_REASONS`, `buildScorecard` reports `verdict === 'pass'` exactly when the
  reason is `'finish'`, and that `totals.passed + totals.failed === totals.tasks`.
- Existing suites must stay green.

### Acceptance criteria

- `passed` does not appear as a field of `TaskResult`, of the `task_done` log payload, or of any
  test fixture.
- `taskPassed` is the only place in `src/` comparing a task reason to `'finish'` for verdict
  purposes.
- `npm run typecheck` and `npm run lint` pass.

## Task 2 - Collapse `classifyRepoAgentExecutionResult` to one predicate

### Steps

1. In `src/repo-agent/run-output.ts` (lines 41-61), import `taskPassed` and rewrite the body so
   the outcome is decided once:

   ```ts
   const taskFailures = result.scorecard.tasks
     .filter((task) => !taskPassed(task))
     .map((task) => `${task.id}: ended with reason ${task.reason}`);
   if (taskFailures.length === 0) {
     return RepoAgentExecutionOutcomeSchema.parse({ status: 'completed', output });
   }
   const failureDetails = [...taskFailures, ...result.scorecard.failureReasons];
   ```

   Drop the `result.scorecard.verdict === 'pass'` gate and the `'scorecard verdict=fail'` detail
   string. `verdict === 'fail'` holds exactly when `taskFailures` is non-empty, so both were
   restatements of the same fact. Keep the existing de-duplication and error formatting at
   lines 56-60 unchanged.

### Tests

- `tests/repo-agent-run-store.test.ts` must still prove that a non-`finish` reason yields
  `status: 'failed'` with the reason named in the error string.

### Acceptance criteria

- `classifyRepoAgentExecutionResult` reads `scorecard.verdict` zero times.
- Failure text still names each failing task's end reason.

## Task 3 - Retire the fixture that constructs an unrepresentable state

### Steps

1. In `tests/repo-agent-run-store.test.ts`, change `buildExecutionResult` (lines 45-64) to take
   only `reason: TaskEndReason`. Delete the `passed` and `verdict` parameters and the
   `task.passed = passed;` / `scorecard.verdict = verdict;` assignments. Derive the scorecard
   instead, so a fixture cannot express a state the engine cannot produce - rebuild it with
   `buildScorecard({ runId, model, tasks: scorecard.tasks })` after setting `task.reason`, and
   return that.

2. Rewrite the case table (lines 67-72) to drop the `passed` / `verdict` columns and to delete
   the `{ reason: 'finish', passed: false }` row, which the engine can no longer produce:

   ```ts
   const cases = [
     { reason: 'finish' as const, expected: 'completed' },
     { reason: 'invalid_response_limit' as const, expected: 'failed' },
     { reason: 'max_turns' as const, expected: 'failed' },
     { reason: 'forced_finish_attempt_limit' as const, expected: 'failed' },
   ];
   ```

3. Add the case that encodes the *actual* new contract, which no test currently covers: a task
   with `reason: 'finish'` whose commands include a non-zero exit code classifies as
   `completed`. Assert `outcome.status === 'completed'` explicitly.

### Acceptance criteria

- No test fixture sets a task `passed` or a scorecard `verdict` directly.
- A finished task with failing commands is proven to classify as `completed`.

## Task 4 - Split `commandFailures` into `rejectedCalls` and `nonZeroExits`

The single counter mixes screening decisions with real command outcomes, and the two producers
already disagree. Replace it with two counters; do not keep a combined field.

### Steps

1. `src/repo-search/engine/task-loop-support.ts` - in `TaskResultSchema` (line 114) and in the
   counters type (line 228), replace `commandFailures: z.number()` with:

   ```ts
   /** Tool calls refused before execution: forced-finish budget, duplicate call, duplicate web tool. */
   rejectedCalls: z.number(),
   /** Commands that actually ran and returned a non-zero exit code. */
   nonZeroExits: z.number(),
   ```

2. `src/repo-search/engine/task-loop.ts` - initialise both to `0` (line 186) and emit both in the
   `task_done` payload (line 821) and the returned result (line 827).

3. `src/repo-search/engine/tool-action-processor.ts` - route each increment to its real meaning:
   - line 296 (forced-finish rejection) -> `rejectedCalls`
   - line 556 (duplicate web tool) -> `rejectedCalls`
   - line 606 (`rejectAsDuplicate`) -> `rejectedCalls`
   - line 852 (executed command, non-zero exit) -> `nonZeroExits`

4. `src/repo-search/engine.ts:80` - replace the single total with two sums, `rejectedCalls` and
   `nonZeroExits`, using the same `reduce` shape.

5. `src/repo-search/live-snapshot/schemas.ts:103` - replace `commandFailures` in the `counters`
   object with `rejectedCalls` and `nonZeroExits`.

6. `src/repo-search/live-snapshot/collector.ts`:
   - line 129 - initialise both counters to `0`.
   - line 213 - report both in the snapshot.
   - line 471 - the existing `exitCode !== null && exitCode !== 0` branch increments
     `nonZeroExits`.
   - In the same `onCommandResult` handler, add the rejection tally the collector currently
     drops. The `rejected` flag alone is **not** sufficient: the approval-deny path
     (`tool-action-processor.ts:343`) and the safety screen (`:739`) also emit `rejected: true`
     but tally to `safetyRejects`, not `rejectedCalls`. Counting every `rejected: true` as a
     refused call re-creates the engine/snapshot mismatch this task exists to remove.

     Add a `rejectionKind` discriminator (`'budget' | 'duplicate' | 'safety'`) defined once in
     `task-loop-support.ts` and thread it through `logRejectedCommand` / `recordRejectedToolCall`
     so each of the five emit sites names its own kind. The collector maps `'safety'` to
     `safetyRejects` and the rest to `rejectedCalls` inline at its one call site. This also repairs
     the collector's `safetyRejects`, which was declared but never incremented and so always
     reported `0`.

     `TurnCommandResultEventSchema` becomes a union of `RejectedCommandResultSchema`
     (`exitCode: null`, `rejectionKind` **required**) and `ExecutedCommandResultSchema`
     (`exitCode: number`). Do **not** keep a separate `rejected: boolean` flag: it is derivable
     from the presence of `rejectionKind`, and storing both re-creates exactly the redundant
     parallel encoding Task 1 removed. Requiring the kind is also what makes a future rejection
     site that forgets it fail to parse rather than tally toward neither counter.

7. Update all `commandFailures` occurrences in `tests/` (28 sites across
   `engine-tool-action-processor.test.ts`, `live-run-snapshot-collector.test.ts`,
   `helpers/tool-action-processor.ts`, `mock-repo-search-loop.test.ts`,
   `repo-search-loop.core.test.ts`, `repo-search-status-server.test.ts`,
   `status-server-chat-routes.test.ts`, `task-end-reason-verdict.test.ts`, `_test-helpers.ts`),
   assigning each existing assertion to whichever counter that test's scenario actually
   exercises - a rejection test asserts `rejectedCalls`, an exit-code test asserts
   `nonZeroExits`. Do not blanket-rename.

### Tests

- Add a test proving a rejected tool call increments `rejectedCalls` and leaves `nonZeroExits`
  at `0`, and that a command executing with a non-zero exit does the reverse.
- Add a collector test proving that for one run the snapshot's `rejectedCalls` and `nonZeroExits`
  match the task result's counters (the mismatch this task fixes).

### Acceptance criteria

- The identifier `commandFailures` does not appear anywhere in `src/` or `tests/`.
- A rejected call never increments `nonZeroExits`, and a non-zero exit never increments
  `rejectedCalls`.
- Full suite, `npm run typecheck`, and `npm run lint` pass.

## Out of scope

- Finding 5 from the review ("two parallel task-result mock builders") is **not actionable as
  stated**: `tests/_test-helpers.ts:30` `buildMockTaskResult` is the only copy of the field list;
  `tests/mock-repo-search-loop.test.ts:80` `mockTaskResult` is a permissive
  `z.custom<TaskResult>` cast that carries no field list at all. They are not duplicates. The
  real defect there is that the `z.custom` predicate only checks `typeof value === 'object'`,
  which launders an arbitrary partial into `TaskResult` - a separate concern, not addressed here.
