# Finish-Based Run Verdict Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A task-loop run is `passed` iff it ended with `reason === 'finish'`; command exit codes become pure telemetry, and the dead task-signals mechanism is removed end-to-end.

**Architecture:** `runTaskLoop` currently computes `passed = reason==='finish' && signalCheck.passed && !hasExecutedCommandFailure` (`src/repo-search/engine/task-loop.ts:821`). Signals are hardcoded `[]` for every production run (`src/repo-search/engine.ts:205`), so `signalCheck` always passes — dead code. The exit-code gate falsely fails runs that do TDD red/green or recover from intermediate breaks (runs `ac543c1c`, `ceeedb28`). Fix: `passed = reason === 'finish'`, delete `countExecutedCommandFailures` and the entire signals mechanism (`TaskDefinition.signals`, `evaluateTaskSignals`, `missingSignals` in every schema/log/fixture). `classifyRepoAgentExecutionResult` (`src/repo-agent/run-output.ts:41-61`) needs no change — with the new invariant its existing conditions map finish→`completed`, eviction→`failed`. Per-task/totals `commandFailures` counters stay as informational metadata.

**Tech Stack:** TypeScript, zod, `node:test`.

**Constraints (from user rules):**
- Do NOT commit anything. Leave all changes uncommitted. The tree already contains unrelated dirty files (assistant/* etc.) — never touch, revert, or stage them.
- No `any`, no type assertions, no non-null assertions. No compat shims or parallel paths — removals are complete; stragglers must fail typecheck loudly.
- No temp files; if a scratch file is needed, put it in `.plan-scratch/` and delete it before finishing.

**Validation commands** (run from repo root):
- Targeted tests: `npm test -- <file>` if supported, otherwise `node --test <file>` per repo convention — check `package.json` `scripts.test` first and use the established runner.
- Full: `npm test`, `npm run typecheck`, `npm run lint`.

---

## File Structure

| File | Change |
|---|---|
| `src/repo-search/engine/task-loop.ts` | `passed` = finish-only; drop signal/exit-gate computation, imports, re-export; drop `missingSignals` from `task_done` log + result |
| `src/repo-search/engine/task-loop-support.ts` | Delete `countExecutedCommandFailures`, `evaluateTaskSignals`, `TaskDefinition.signals`, `TaskResultSchema.missingSignals` |
| `src/repo-search/engine.ts` | Drop exit/command-failure/missing-signals failure reasons; drop `signals: []` task field; fix imports/re-exports |
| `src/status-server/repo-search-scorecard-types.ts` | Drop `missingSignals` from strict schema + `normalizeTask` |
| `src/status-server/chat.ts` | Critical-review prompt: remove `missingSignals` branch |
| `tests/task-end-reason-verdict.test.ts` | Replace exit-code-verdict test with new regression tests |
| `tests/repo-search-loop.core.test.ts` | Two tests: non-zero exits no longer fail the run |
| `tests/mock-repo-search-loop.test.ts` | Aggregation fixture coherence + literal cleanup |
| `tests/_test-helpers.ts` + ~13 test files | Remove `signals:` / `missingSignals:` literals (typecheck-driven) |

---

### Task 1: Verdict = finish-only (TDD)

**Files:**
- Modify: `src/repo-search/engine/task-loop.ts:815-821`, `src/repo-search/engine/task-loop-support.ts:125-133`, `src/repo-search/engine.ts` (imports + `buildScorecard` failure reasons)
- Test: `tests/task-end-reason-verdict.test.ts`, `tests/repo-search-loop.core.test.ts:735-796`, `tests/mock-repo-search-loop.test.ts:1940-1980`

- [ ] **Step 1: Update the two loop-level tests to the new expectations (failing tests)**

In `tests/repo-search-loop.core.test.ts`, the test at line 735 currently ends with:

```ts
  assert.equal(task.invalidResponses, 0);
  assert.equal(task.commandFailures, 1);
  assert.equal(task.passed, false);

  const scorecard = buildScorecard({
    runId: 'run-command-failure',
    model: 'model-x',
    tasks: [task],
  });
  assert.equal(scorecard.totals.commandFailures, 1);
  assert.equal(scorecard.verdict, 'fail');
```

Change the test name (line 735) to `'runTaskLoop counts non-zero command exits as command failures without failing the run'` and the assertions to:

```ts
  assert.equal(task.invalidResponses, 0);
  assert.equal(task.commandFailures, 1);
  assert.equal(task.passed, true);

  const scorecard = buildScorecard({
    runId: 'run-command-failure',
    model: 'model-x',
    tasks: [task],
  });
  assert.equal(scorecard.totals.commandFailures, 1);
  assert.equal(scorecard.verdict, 'pass');
  assert.deepEqual(scorecard.failureReasons, []);
```

The test at line 771 currently ends with:

```ts
  assert.equal(task.commandFailures, 1);
  assert.equal(task.passed, false);
```

Change its name to `'runTaskLoop counts exit code 1 from non-search commands as a command failure without failing the run'` and the assertions to:

```ts
  assert.equal(task.commandFailures, 1);
  assert.equal(task.passed, true);
```

Leave both tests' mock setup (mockResponses / mockCommandResults / `signals: []`) untouched — `signals` is removed in Task 2.

- [ ] **Step 2: Replace the exit-code scorecard test and add the pass regression**

In `tests/task-end-reason-verdict.test.ts`, replace the entire last test (lines 53-74, `'buildScorecard names the non-zero command exit instead of a bare "task failed"'`) with these two tests:

```ts
test('buildScorecard reports only the end reason for an evicted run with non-zero exits', () => {
  const scorecard = buildScorecard({
    runId: 'r4',
    model: 'm',
    tasks: [buildMockTaskResult({
      reason: 'max_turns',
      passed: false,
      commandFailures: 1,
      commands: [{
        command: 'grep pattern="x"',
        activityKind: 'search',
        activitySubject: { kind: 'none' },
        turn: 1,
        safe: true,
        reason: null,
        exitCode: 2,
        output: 'boom',
      }],
    })],
  });
  assert.equal(scorecard.verdict, 'fail');
  assert.deepEqual(scorecard.failureReasons, ['repo-search: ended with reason max_turns']);
});

test('buildScorecard passes a finished run whose commands exited non-zero', () => {
  const scorecard = buildScorecard({
    runId: 'r5',
    model: 'm',
    tasks: [buildMockTaskResult({
      reason: 'finish',
      passed: true,
      commandFailures: 2,
      commands: [{
        command: 'grep pattern="x"',
        activityKind: 'search',
        activitySubject: { kind: 'none' },
        turn: 1,
        safe: true,
        reason: null,
        exitCode: 1,
        output: 'red run',
      }],
    })],
  });
  assert.equal(scorecard.verdict, 'pass');
  assert.deepEqual(scorecard.failureReasons, []);
});
```

(The command object shape is copied from the deleted test; keep any additional fields the existing literal carries if `TaskCommandSchema` requires them.)

- [ ] **Step 3: Make the aggregation fixture coherent with the new invariant**

In `tests/mock-repo-search-loop.test.ts`, the `'buildScorecard aggregates totals and verdict'` test (line 1940): task `b` (line 1955) has `reason: 'finish', passed: false`. Under the new semantics `passed:false` implies a non-finish reason. Change line 1957 from `reason: 'finish',` to `reason: 'max_turns',`. Leave `missingSignals: ['signal-1']` (line 1966) and the `assert.equal(scorecard.failureReasons.length, 2)` (line 1979) untouched in this task — after this task's implementation the two reasons are `ended with reason max_turns` + `missing signals [signal-1]`. (Task 2 reduces this to 1.)

- [ ] **Step 4: Run the three test files to verify they fail**

Run the repo's test runner on `tests/task-end-reason-verdict.test.ts`, `tests/repo-search-loop.core.test.ts`, `tests/mock-repo-search-loop.test.ts`.
Expected: the modified/new tests FAIL (e.g. `passed` is `false` not `true`, verdict `'fail'` not `'pass'`, `failureReasons` contains `commands exited non-zero 1` / `command failures 1`). Pre-existing tests still pass.

- [ ] **Step 5: Implement — task-loop verdict**

In `src/repo-search/engine/task-loop.ts`, replace lines 815-821:

```ts
    const evidenceParts = [this.finalOutput, ...this.commands.map((item) => item.output)];
    const signalCheck = evaluateTaskSignals(this.task, evidenceParts.join('\n'));
    const hasExecutedCommandFailure = countExecutedCommandFailures(this.commands) > 0;
    // A run that stopped on a turn, invalid-response or forced-finish limit did not answer the
    // question. Scoring it as a pass is how run 100b487d reported verdict=pass while its own
    // terminal synthesis said "Incomplete".
    const passed = this.counters.reason === 'finish' && signalCheck.passed && !hasExecutedCommandFailure;
```

with:

```ts
    const evidenceParts = [this.finalOutput, ...this.commands.map((item) => item.output)];
    const signalCheck = evaluateTaskSignals(this.task, evidenceParts.join('\n'));
    // A run that stopped on a turn, invalid-response or forced-finish limit did not answer the
    // question. Scoring it as a pass is how run 100b487d reported verdict=pass while its own
    // terminal synthesis said "Incomplete". Command exit codes are telemetry, not verdict
    // input: TDD red runs and recovered failures are normal work (runs ac543c1c, ceeedb28
    // were falsely failed by the old exit-code gate).
    const passed = this.counters.reason === 'finish';
```

Then remove `countExecutedCommandFailures,` from the import block at `task-loop.ts:65-81` (currently line 69). `evaluateTaskSignals` stays imported for now (still used on the line above; removed in Task 2).

- [ ] **Step 6: Implement — buildScorecard failure reasons**

In `src/repo-search/engine.ts`, `buildScorecard` (lines ~100-108), replace:

```ts
  const failureReasons: string[] = [];
  for (const task of options.tasks) {
    if (task.passed) continue;
    if (task.reason !== 'finish') failureReasons.push(`${task.id}: ended with reason ${task.reason}`);
    if (task.missingSignals.length > 0) failureReasons.push(`${task.id}: missing signals [${task.missingSignals.join(', ')}]`);
    if (Number(task.commandFailures || 0) > 0) failureReasons.push(`${task.id}: command failures ${Number(task.commandFailures || 0)}`);
    const exitFailures = countExecutedCommandFailures(task.commands);
    if (exitFailures > 0) failureReasons.push(`${task.id}: commands exited non-zero ${exitFailures}`);
  }
```

with:

```ts
  const failureReasons: string[] = [];
  for (const task of options.tasks) {
    if (task.passed) continue;
    if (task.reason !== 'finish') failureReasons.push(`${task.id}: ended with reason ${task.reason}`);
    if (task.missingSignals.length > 0) failureReasons.push(`${task.id}: missing signals [${task.missingSignals.join(', ')}]`);
  }
```

Remove `countExecutedCommandFailures` from the import list at `engine.ts:22`.

- [ ] **Step 7: Implement — delete the dead counter**

In `src/repo-search/engine/task-loop-support.ts`, delete lines 125-133 (the doc comment plus `countExecutedCommandFailures`):

```ts
/**
 * A rejected call (`safe: false`, `exitCode: null`) is a screening decision, not an executed
 * failure — only a command that actually ran and exited non-zero counts here.
 */
export function countExecutedCommandFailures(
  commands: readonly { safe: boolean; exitCode: number | null }[],
): number {
  return commands.filter((command) => command.safe && command.exitCode !== null && command.exitCode !== 0).length;
}
```

Note: the per-command counter increment in `src/repo-search/engine/tool-action-processor.ts:851-853` (`counters.commandFailures += 1`) and the `commandFailures` fields in schemas/totals are **kept** — they are telemetry, not verdict input. Do not touch `tool-action-processor.ts`.

- [ ] **Step 8: Run tests to verify they pass**

Run the three files from Step 4 plus `tests/repo-agent-run-store.test.ts` (repo-agent status mapping — must stay green unchanged; the `{reason:'finish', passed:false}` table row remains valid because `classifyRepoAgentExecutionResult` is untouched robustness logic).
Expected: ALL PASS.

- [ ] **Step 9: Typecheck**

Run: `npm run typecheck`
Expected: clean (no remaining references to `countExecutedCommandFailures` — it had no test references).

---

### Task 2: Remove the signals mechanism end-to-end

**Files:**
- Modify: `src/repo-search/engine/task-loop-support.ts`, `src/repo-search/engine/task-loop.ts`, `src/repo-search/engine.ts`, `src/status-server/repo-search-scorecard-types.ts`, `src/status-server/chat.ts:877-882`
- Test (fixture/literal updates): `tests/_test-helpers.ts:48`, `tests/mock-repo-search-loop.test.ts`, `tests/repo-search-loop.core.test.ts`, `tests/repo-search-chat-loop.test.ts`, `tests/repo-agent-finish-verification.test.ts`, `tests/repo-search-terminal-synthesis-retry.test.ts`, `tests/repo-search-prompt-accounting.test.ts`, `tests/rejected-command-transcript.test.ts`, `tests/llm-auto-approval.test.ts`, `tests/llama-cpp-client-thinking-budget.test.ts`, `tests/image-input-surfaces.e2e.test.ts`, `tests/approval-verdict-request.test.ts`, `tests/helpers/tool-action-processor.ts:60`, `tests/repo-search-status-server.test.ts:~1200`, `tests/status-server-chat-routes.test.ts:~154`, `tests/live-run-snapshot-collector.test.ts:~258`

This is a complete removal refactor; existing green tests are the harness and `npm run typecheck` is the loud-failure net for missed call sites.

- [ ] **Step 1: Remove signals from the engine types and loop**

`src/repo-search/engine/task-loop-support.ts`:
- In `TaskDefinition` (lines 83-87) delete the `signals: string[];` field, leaving `{ id: string; question: string; }`.
- Delete `evaluateTaskSignals` entirely (lines 89-104).
- In `TaskResultSchema` delete the `missingSignals: z.array(z.string()),` field (line 157).

`src/repo-search/engine/task-loop.ts`:
- Import block (65-81): remove `evaluateTaskSignals,` (line 72).
- Re-export block (97-104): remove `evaluateTaskSignals,` (line 100).
- In `buildAgentLoopResult`, delete the now-unused lines:
  ```ts
      const evidenceParts = [this.finalOutput, ...this.commands.map((item) => item.output)];
      const signalCheck = evaluateTaskSignals(this.task, evidenceParts.join('\n'));
  ```
- In the `task_done` log write (lines 823-827): change line 826 from
  ```ts
        finishChallenges: this.finishVerification.issuedCount, passed, missingSignals: signalCheck.missingSignals,
  ```
  to
  ```ts
        finishChallenges: this.finishVerification.issuedCount, passed,
  ```
- In the returned result (lines 829-841): delete the `missingSignals: signalCheck.missingSignals,` line (837).

`src/repo-search/engine.ts`:
- Re-export at line 46: change
  ```ts
  export { evaluateTaskSignals, type RunTaskLoopOptions, type TaskDefinition, type TaskResult } from './engine/task-loop.js';
  ```
  to
  ```ts
  export { type RunTaskLoopOptions, type TaskDefinition, type TaskResult } from './engine/task-loop.js';
  ```
- In `buildScorecard` failure reasons (as left by Task 1), delete the line:
  ```ts
      if (task.missingSignals.length > 0) failureReasons.push(`${task.id}: missing signals [${task.missingSignals.join(', ')}]`);
  ```
  leaving only the `ended with reason` line inside the loop.
- In `tasksToRun` (lines 202-206) delete `signals: [],`:
  ```ts
    const tasksToRun: TaskDefinition[] = [{
      id: 'repo-search',
      question: options.taskPrompt,
    }];
  ```

- [ ] **Step 2: Remove missingSignals from the status-server surface**

`src/status-server/repo-search-scorecard-types.ts`:
- Delete `missingSignals: z.array(z.string()),` from `RepoSearchTaskResultSchema` (line 34).
- In `normalizeTask` (lines 100-122): delete `const missingSignalsRaw = reader.value('missingSignals');` (line 103) and the parse entry (lines 118-120):
  ```ts
      missingSignals: Array.isArray(missingSignalsRaw)
        ? missingSignalsRaw.map((entry) => String(entry)).filter((entry) => entry.length > 0)
        : [],
  ```
  (Old persisted artifacts that still contain a `missingSignals` key are unaffected: `normalizeTask` builds the parsed object explicitly from named reads, and the engine's own `ScorecardSchema` uses non-strict `z.object`, which strips unknown keys.)

`src/status-server/chat.ts` (lines 877-882): replace

```ts
  const missingSignals = primaryTask?.missingSignals || [];
  if (missingSignals.length > 0) {
    lines.push(`- Missing expected evidence signals: ${missingSignals.join(', ')}`);
  } else {
    lines.push('- Verify that proposed changes preserve existing behavior and test coverage.');
  }
```

with

```ts
  lines.push('- Verify that proposed changes preserve existing behavior and test coverage.');
```

If `primaryTask` becomes unused as a result, remove its declaration too; if it is still used elsewhere in the function, leave it.

- [ ] **Step 3: Typecheck to enumerate every stale test literal**

Run: `npm run typecheck`
Expected: FAILURES at every object literal that still passes `signals:` to a `TaskDefinition` or `missingSignals:` to a `TaskResult` — this is the complete migration worklist. Known sites (line numbers approximate after earlier edits):
- `signals:` in TaskDefinition literals: `tests/mock-repo-search-loop.test.ts` (~43 sites), `tests/repo-search-loop.core.test.ts` (~27), `tests/repo-search-chat-loop.test.ts` (7+), `tests/repo-agent-finish-verification.test.ts` (4), `tests/repo-search-terminal-synthesis-retry.test.ts` (4), `tests/repo-search-prompt-accounting.test.ts:64`, `tests/rejected-command-transcript.test.ts:56`, `tests/llm-auto-approval.test.ts:123`, `tests/llama-cpp-client-thinking-budget.test.ts:250,315`, `tests/image-input-surfaces.e2e.test.ts:169`, `tests/approval-verdict-request.test.ts:146`, `tests/helpers/tool-action-processor.ts:60`.
- `missingSignals:` in fixtures: `tests/_test-helpers.ts:48`, `tests/mock-repo-search-loop.test.ts:1953,1966`, `tests/repo-search-status-server.test.ts:~1200`, `tests/status-server-chat-routes.test.ts:~154`, `tests/live-run-snapshot-collector.test.ts:~258`.
Do NOT ignore any unrelated errors — they indicate a missed production call site; fix at the source.

- [ ] **Step 4: Delete every flagged property**

Remove the `signals: [...]` line from each TaskDefinition literal and the `missingSignals: [...]` line from each fixture flagged in Step 3. Do not change anything else in those literals. Note: `tests/live-instance-guard.test.ts:26` and `tests/repo-agent-sessions.test.ts:447,495` mention OS process signals — unrelated, leave alone. Strict-schema fixtures (`repo-search-status-server`, `status-server-chat-routes`, `live-run-snapshot-collector`) MUST drop the key or `z.strictObject` parsing fails at runtime — if typecheck doesn't flag one of them, remove it anyway.

- [ ] **Step 5: Update the aggregation expectation**

In `tests/mock-repo-search-loop.test.ts` `'buildScorecard aggregates totals and verdict'`: with `missingSignals` gone, task `b` (now `reason: 'max_turns'` from Task 1) produces exactly one failure reason. Change

```ts
  assert.equal(scorecard.failureReasons.length, 2);
```

to

```ts
  assert.deepEqual(scorecard.failureReasons, ['b: ended with reason max_turns']);
```

- [ ] **Step 6: Typecheck clean, then run the touched test files**

Run: `npm run typecheck` → expected clean.
Run the test files touched in Steps 4-5 plus `tests/task-end-reason-verdict.test.ts`, `tests/repo-search-loop.core.test.ts`.
Expected: ALL PASS.

- [ ] **Step 7: Grep guard for stragglers**

Search the whole repo (`src/`, `tests/`) for `evaluateTaskSignals`, `countExecutedCommandFailures`, `missingSignals`, `signalCheck`. Expected: zero matches outside `docs/` and `.siftkit/` historical records. Any live match is a missed migration — fix it, do not shim it.

---

### Task 3: Full-suite validation

**Files:** none (verification only).

- [ ] **Step 1: Full test suite**

Run: `npm test 2>&1 | siftkit summary --question "Return pass/fail, failing test names, root errors, and relevant file:line anchors."`
Expected: pass, 0 failures. Investigate any failure at its root (systematic-debugging); do not weaken tests.

- [ ] **Step 2: Typecheck and lint**

Run: `npm run typecheck` then `npm run lint`.
Expected: both clean.

- [ ] **Step 3: Behavior invariants spot-check**

Confirm by reading the final code (no new tests needed — covered above):
1. `task-loop.ts`: `passed` derives only from `this.counters.reason === 'finish'`.
2. `engine.ts` `buildScorecard`: `verdict` = `totals.failed === 0`; `failureReasons` only ever contains `ended with reason` entries; `totals.commandFailures` still aggregated.
3. `run-output.ts` `classifyRepoAgentExecutionResult`: untouched; finish→`completed` with the agent's `output`, eviction→`failed` with the end reason in `error`.
4. `execute.ts:424` transcript foldering (`successful/` vs `failed/`) now follows finish/eviction — intended consequence, no change needed.
5. Working tree: `git status` shows ONLY the files listed in this plan's File Structure plus this plan file; every pre-existing dirty file is untouched. Nothing committed.
