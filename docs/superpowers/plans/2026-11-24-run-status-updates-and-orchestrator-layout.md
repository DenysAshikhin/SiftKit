# Run Status Updates and Orchestrator Layout Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A person watching a dashboard run reads, in plain sentences, what it is doing and why, in an orchestrator panel whose two panes never grow without limit.

**Architecture:** The orchestrator says where the whole run is in a required `update` on each dispatch, and each task says why it exists; both are stored. A worker's update is a short unthinking reply on top of its executing planner request, written only while a command leaves the engine idle, and delivered as a display event that never enters the run's history. The panel becomes a header over two panes that scroll on their own.

**Tech Stack:** TypeScript (type-stripped by Node), zod, better-sqlite3, React, node:test, vitest, headless Chrome for the layout test.

**Spec:** `docs/superpowers/specs/2026-11-24-run-status-updates-and-orchestrator-layout-design.md`
**Mockup:** `docs/superpowers/specs/assets/status-updates.html`

---

## Before you start

- **Base:** `904137b6` with the plan `2026-11-24-agent-command-containment-and-background-jobs.md` applied. Part 1's hunks also apply to `904137b6` alone; Part 2's do not, because the scheduler treats `job` as a window and the tool tests carry `backgroundJobs`.
- **Order:** Part 1 ships alone. In Part 2, **Task 5 is a gate: if it fails, stop, report the numbers, and do not start Task 6.** Task 4 alone changes nothing a run does.
- **No commits.** Each task ends with a green tree, not a commit.
- **No live run:** the code must not change while a watched server is running an agent. Check first.
- **Schema:** Part 1 takes version 99. If another change took it first, use the next number in `runtime-db.ts`, the upgrade and the five schema tests.
- Vitest runs from PowerShell in the repository root. The layout test needs Chrome or Edge, like the existing `chat-overflow` test.
- All code below ran in a scratch copy. Results are in "What was measured".

## Where the plan differs from the spec

| Spec | Plan | Why |
|---|---|---|
| Class `StatusUpdateScheduler` | `StatusUpdates` | It also writes, checks and reports the update; scheduling is half of it |
| A window is a `run` or `job wait` call | Any `run` or `job` call | `job list`, `output` and `stop` end long before 3 seconds, so naming `wait` adds a rule that never decides anything |
| Fold state kept per run | Per run while the panel is mounted (`key={runId}`) | Nothing else in the panel survives a tab change either |
| "Each pane follows its newest content" | The tasks pane follows the running task | Its newest content is not its bottom |
| — | Opening a fold, like scrolling, stops following until the reader scrolls back | Otherwise the pane moves away from what was just opened |
| "Request cancelled when the command ends" | Also about 10 seconds in total, set explicitly | A stalled engine would otherwise hold the request, and the client would otherwise derive a 3-second deadline from 60 tokens |
| `thinkingEnabled` false | The planner's flags, and a response prefix that closes the thinking block | Turning thinking off changes the head of the prompt (see the gate result) |
| 40 updates measured | 40 completed and 40 cancelled, each against a control | A cancelled update is the common case for the delay and for the re-read, and a completed one cannot measure it |

The orchestrator parent writes no status updates: its dispatches already say where the run is.

## File structure

| File | Responsibility |
|---|---|
| `src/repo-search/status-text.ts` (new) | The wording rules that code can check, shared by the run-wide line and status updates |
| `src/state/schema-upgrades/orchestrator-task-purpose.ts` (new) | 98 to 99: `why` and `statusLines` in every stored copy |
| `src/repo-search/engine/status-updates.ts` (new) | When an update is due, the request, the reply check, and its cancellation |
| `src/repo-search/planner-protocol.ts` | `requestStatusUpdate`, a derived request on the executing prompt |
| `tests/live-status-update-gate.test.ts` (new) | The live acceptance gate, opt-in |
| `dashboard/src/components/OrchestratorRunLine.tsx` (new) | The run-wide line at the bottom of the orchestrator pane |
| `dashboard/src/components/StatusUpdates.tsx` (new) | The update block, shared by the chat turn and the agent card |
| `dashboard/src/hooks/usePaneFollow.ts` (new) | A pane follows its newest content until the reader scrolls away |

---

## Part 1: layout, task purpose and the run-wide line

### Task 1: The wording rules code can check

One paragraph line, no path, no backticks, no tool name that has an underscore. "run" and "read" are ordinary words and stay allowed.

**Files:**
- `tests/status-text.test.ts`
- `src/repo-search/status-text.ts`

- [ ] **Step 1: Write the tests**

Create `tests/status-text.test.ts`:

````ts
import test from 'node:test';
import assert from 'node:assert/strict';

import { findStatusTextProblem } from '../src/repo-search/status-text.ts';

test('a status line is one paragraph with no code, path or tool name', () => {
  for (const [text, problem] of [
    ['First line.\nSecond line.', /one paragraph/u],
    ['Running `npm test` now.', /code or backticks/u],
    ['Reading src/cli/args.ts for the bug.', /path/u],
    ['Reading src/cli now/', null],
    ['Reading src/cli/input next.', /path/u],
    ['Looking at C:\\repo now.', /path/u],
    ['Looking at ..\\other now.', /path/u],
    ['Looking in ./scratch now.', /path/u],
    ['Checking with run_check again.', /run_check/u],
    ['Next is record_review for this.', /record_review/u],
  ] as const) {
    const found = findStatusTextProblem(text);
    if (problem === null) assert.equal(found, null, text);
    else assert.match(found ?? '', problem, text);
  }
});

test('ordinary prose passes, including words that are also tool names', () => {
  for (const text of [
    'Confirming a suspected problem with how bad input is handled, before calling it a real bug.',
    'Going to read and run the remaining checks, then edit what they find.',
    'Comparing the before/after numbers and/or asking for more.',
    'Node.js starts cleanly at 24/7 load; 5 of 13 areas are done.',
  ]) assert.equal(findStatusTextProblem(text), null, text);
});
````

- [ ] **Step 2: Run them and see them fail**

Run: `node .\src\test-runner\run-tests.ts status-text`
Expected: FAIL (cannot find `src/repo-search/status-text.ts`)

- [ ] **Step 3: Implement**

Create `src/repo-search/status-text.ts`:

````ts
import { REPO_TOOL_ARGUMENT_SCHEMAS } from './repo-tool-arguments.ts';

/** A path: a drive or a backslash, or a slash inside a word that also has an extension or a second slash. "and/or" is prose. */
const PATH = /[A-Za-z]:[\\/]|\\|(?:^|\s)\.{0,2}\/\w|\w[\w.-]*\/[\w.-]+(?:\/|\.\w)/u;
const TOOL_NAMES = Object.keys(REPO_TOOL_ARGUMENT_SCHEMAS).filter((name) => name.includes('_'));

/** Why `text` cannot be shown as a status line, or null. Only what code can tell is checked; the prompt states the rest. */
export function findStatusTextProblem(text: string): string | null {
  if (/[\r\n]/u.test(text)) return 'it must be one paragraph';
  if (text.includes('`')) return 'it must not contain code or backticks';
  if (PATH.test(text)) return 'it must not contain a path';
  const tool = TOOL_NAMES.find((name) => text.includes(name));
  return tool === undefined ? null : `it must not name a tool (${tool})`;
}
````

- [ ] **Step 4: Run the tests and the checks**

Run: `node .\src\test-runner\run-tests.ts status-text`
Expected: every test passes.

Run: `npx tsc -p tsconfig.test.json`, then `npx eslint tests/status-text.test.ts src/repo-search/status-text.ts`
Expected: all exit 0 with no output.

**Acceptance:** the tests of this task pass, type-check and lint are clean, and no file outside the list above changed.

### Task 2: Task purpose, the run-wide line and schema 99

A new task needs `why` (one sentence, at most 160 characters); a stored one may hold `null`. `dispatch` needs `update` (at most 240), and a refused one says why and records nothing. The newest 100 lines are kept.

The upgrade rewrites every stored copy: `state_json.plan.tasks`, and each attempt's `work.task`. Approaches hold no copy of a plan today. On a copy of the real database, 49 of 49 runs and 247 of 247 attempts parse after it; before it, none did.

**Files:**
- `tests/contracts-orchestrator.test.ts`
- `tests/orchestrator-run-store.test.ts`
- `tests/orchestrator-runs.test.ts`
- `tests/orchestrator-prompts.test.ts`
- `tests/repo-search-orchestrator-tools.test.ts`
- `tests/runtime-db-schema-orchestrator-task-purpose.test.ts`
- `tests/runtime-db-schema-orchestrator-attempt-results.test.ts`
- `tests/runtime-db-schema-orchestrator-check-digests.test.ts`
- `tests/runtime-db-schema-orchestrator-search-reports.test.ts`
- `tests/runtime-db-schema-orchestrator-single-worker.test.ts`
- `tests/helpers/orchestrator-plan.ts`
- `tests/process/orchestrator-run.e2e.test.ts`
- `tests/process/chat-overflow.test.ts`
- `dashboard/tests/orchestrator-fixture.ts`
- `dashboard/tests/chat-tab.test.tsx`
- `dashboard/tests/orchestrator-run-panel.test.tsx`
- `dashboard/tests/orchestrator-view.test.ts`
- `packages/contracts/src/orchestrator.ts`
- `src/orchestrator/plan.ts`
- `src/orchestrator/prompts.ts`
- `src/orchestrator/run-store.ts`
- `src/orchestrator/run.ts`
- `src/repo-search/planner-protocol.ts`
- `src/state/schema-upgrades/orchestrator-task-purpose.ts`
- `src/state/runtime-db.ts`

- [ ] **Step 1: Write the tests**

Modify `tests/contracts-orchestrator.test.ts`:

````diff
@@ -29,6 +29,7 @@ import {
   OrchestratorRetiredTaskSchema,
   OrchestratorStartRequestSchema,
   OrchestratorTaskSchema,
+  OrchestratorNewTaskSchema,
   OrchestratorUpdateTasksArgsSchema,
   OrchestratorVerificationCheckSchema,
   SiftPresetCollectionSchema,
@@ -79,7 +80,7 @@ test('a handoff report is a status with its deviations, never free text or a kin
 });
 
 test('a dispatch starts exactly one child and a review judges every criterion with code evidence', () => {
-  const child = { taskId: 'inspect', purpose: 'implementation', instruction: 'Do it.' };
+  const child = { taskId: 'inspect', purpose: 'implementation', instruction: 'Do it.', update: 'The run is under way.' };
   assert.equal(OrchestratorDispatchArgsSchema.safeParse(child).success, true);
   assert.equal(OrchestratorDispatchArgsSchema.safeParse({ children: [child] }).success, false);
   assert.equal(OrchestratorDispatchArgsSchema.safeParse({ taskId: 'a' }).success, false);
@@ -254,7 +255,7 @@ test('a stored plan may hold no task after a rollback, but save_plan needs at le
 
 // Real case (run e85529c8): a first save_plan without temporaryPaths cost a round trip at the plan deadline.
 test('a plan task may omit its dependency, read, and temporary lists; wrong types are still refused', () => {
-  const minimal = { id: 'a', title: 'A', workerPresetId: 'repo-agent', writePaths: ['src/a.ts'],
+  const minimal = { id: 'a', title: 'A', why: 'It is needed.', workerPresetId: 'repo-agent', writePaths: ['src/a.ts'],
     steps: [{ instruction: 'Change it.', expectedResult: 'Changed.' }],
     verification: [{ kind: 'command', command: 'npm test', cwd: '.', expectedExitCode: 0 }], acceptance: ['Changed.'] };
   const task = OrchestratorTaskSchema.parse(minimal);
@@ -262,3 +263,26 @@ test('a plan task may omit its dependency, read, and temporary lists; wrong type
   assert.equal(OrchestratorTaskSchema.safeParse({ ...minimal, temporaryPaths: 'scratch' }).success, false);
   assert.equal(OrchestratorTaskSchema.safeParse({ ...minimal, extra: true }).success, false, 'still strict');
 });
+
+test('a new task says why it exists; only a stored one may lack it', () => {
+  const task = { id: 'a', title: 'A', why: 'x'.repeat(160), workerPresetId: 'repo-agent', writePaths: ['src/a.ts'],
+    steps: [{ instruction: 'Change it.', expectedResult: 'Changed.' }],
+    verification: [{ kind: 'command', command: 'npm test', cwd: '.', expectedExitCode: 0 }], acceptance: ['Changed.'] };
+  const { why: _why, ...without } = task;
+  assert.equal(OrchestratorNewTaskSchema.safeParse(task).success, true);
+  for (const bad of [without, { ...task, why: null }, { ...task, why: ' ' }, { ...task, why: 'x'.repeat(161) }]) {
+    assert.equal(OrchestratorNewTaskSchema.safeParse(bad).success, false);
+    assert.equal(OrchestratorUpdateTasksArgsSchema.safeParse({ add: [bad] }).success, false);
+  }
+  assert.equal(OrchestratorTaskSchema.safeParse({ ...task, why: null }).success, true);
+  assert.equal(OrchestratorTaskSchema.safeParse(without).success, false);
+  assert.equal(OrchestratorUpdateTasksArgsSchema.safeParse({ update: [{ taskId: 'a', set: { why: 'It still is.' } }] }).success, true);
+});
+
+test('a dispatch says where the run stands, in at most 240 characters', () => {
+  const dispatch = { taskId: 'a', purpose: 'implementation', instruction: 'Do it.' };
+  assert.equal(OrchestratorDispatchArgsSchema.safeParse({ ...dispatch, update: 'x'.repeat(240) }).success, true);
+  for (const bad of [dispatch, { ...dispatch, update: ' ' }, { ...dispatch, update: 'x'.repeat(241) }]) {
+    assert.equal(OrchestratorDispatchArgsSchema.safeParse(bad).success, false);
+  }
+});
````

Modify `tests/orchestrator-run-store.test.ts`:

````diff
@@ -52,36 +52,36 @@ test('the same submission and payload returns the same parent; a different paylo
 test('two reservations against one revision cannot both succeed', (t) => {
   const { store } = openStore(t);
   const state = planned(store);
-  store.reserveAttempt(state.runId, state.revision, 'inspect', work());
-  assert.throws(() => store.reserveAttempt(state.runId, state.revision, 'inspect', work()), /stale revision/u);
+  store.reserveAttempt(state.runId, state.revision, 'inspect', work(), 'The run is under way.');
+  assert.throws(() => store.reserveAttempt(state.runId, state.revision, 'inspect', work(), 'The run is under way.'), /stale revision/u);
 });
 
 test('each purpose allows two attempts and implementation attempts never consume the correction pool', (t) => {
   const { store } = openStore(t);
   let state = planned(store);
-  const firstAttempt = store.reserveAttempt(state.runId, state.revision, 'inspect', work());
+  const firstAttempt = store.reserveAttempt(state.runId, state.revision, 'inspect', work(), 'The run is under way.');
   state = store.read(state.runId);
-  const secondAttempt = store.reserveAttempt(state.runId, state.revision, 'inspect', work());
+  const secondAttempt = store.reserveAttempt(state.runId, state.revision, 'inspect', work(), 'The run is under way.');
   state = store.read(state.runId);
   assert.equal(firstAttempt.attempt, 1);
   assert.equal(secondAttempt.attempt, 2);
   assert.notEqual(firstAttempt.childRunId, secondAttempt.childRunId);
-  assert.throws(() => store.reserveAttempt(state.runId, state.revision, 'inspect', work()), /attempt limit/u);
+  assert.throws(() => store.reserveAttempt(state.runId, state.revision, 'inspect', work(), 'The run is under way.'), /attempt limit/u);
 
-  const firstFix = store.reserveAttempt(state.runId, state.revision, 'inspect', work('fix'));
+  const firstFix = store.reserveAttempt(state.runId, state.revision, 'inspect', work('fix'), 'The run is under way.');
   state = store.read(state.runId);
-  const secondFix = store.reserveAttempt(state.runId, state.revision, 'inspect', work('fix'));
+  const secondFix = store.reserveAttempt(state.runId, state.revision, 'inspect', work('fix'), 'The run is under way.');
   state = store.read(state.runId);
   assert.deepEqual([firstFix.purpose, firstFix.attempt, secondFix.attempt], ['fix', 1, 2]);
   assert.equal(secondFix.work.instruction, 'Fix the finding.');
-  assert.throws(() => store.reserveAttempt(state.runId, state.revision, 'inspect', work('fix')),
+  assert.throws(() => store.reserveAttempt(state.runId, state.revision, 'inspect', work('fix'), 'The run is under way.'),
     /Task 'inspect' reached the fix attempt limit/u);
 });
 
 test('attempt results settle exactly once and must name a reserved child', (t) => {
   const { store } = openStore(t);
   let state = planned(store);
-  const attempt = store.reserveAttempt(state.runId, state.revision, 'inspect', work());
+  const attempt = store.reserveAttempt(state.runId, state.revision, 'inspect', work(), 'The run is under way.');
   state = store.markAttemptRunning(state.runId, store.read(state.runId).revision, attempt.childRunId);
   const result = { taskId: 'inspect', purpose: 'implementation' as const, attempt: 1, childRunId: attempt.childRunId,
     workerStatus: 'completed' as const, workerOutput: 'done', report: null, outcome: 'passed' as const, submissions: 1,
@@ -98,7 +98,7 @@ test('attempt results settle exactly once and must name a reserved child', (t) =
 test('committed events replay in increasing sequence from any cursor', (t) => {
   const { store } = openStore(t);
   const state = planned(store);
-  const attempt = store.reserveAttempt(state.runId, state.revision, 'inspect', work());
+  const attempt = store.reserveAttempt(state.runId, state.revision, 'inspect', work(), 'The run is under way.');
   const events = store.readEvents(state.runId, 0);
   assert.deepEqual(events.map((event) => event.sequence), [1, 2, 3]);
   assert.equal(events[2]?.childRunId, attempt.childRunId);
@@ -108,7 +108,7 @@ test('committed events replay in increasing sequence from any cursor', (t) => {
 test('a restart keeps both budgets; interrupted runs reject further changes', (t) => {
   const { store, dbPath } = openStore(t);
   let state = planned(store);
-  store.reserveAttempt(state.runId, state.revision, 'inspect', work());
+  store.reserveAttempt(state.runId, state.revision, 'inspect', work(), 'The run is under way.');
   closeAllRuntimeDatabases();
   const reopened = new OrchestratorRunStore(getRuntimeDatabase(dbPath));
   state = reopened.read(state.runId);
@@ -119,7 +119,7 @@ test('a restart keeps both budgets; interrupted runs reject further changes', (t
   assert.equal(state.failure?.code, 'interrupted');
   assert.equal(state.attempts.length, 1, 'an uncertain attempt is kept, never redispatched');
   assert.deepEqual(reopened.listActive(), []);
-  assert.throws(() => reopened.reserveAttempt(state.runId, state.revision, 'inspect', work()), /is interrupted/u);
+  assert.throws(() => reopened.reserveAttempt(state.runId, state.revision, 'inspect', work(), 'The run is under way.'), /is interrupted/u);
 });
 
 test('a first plan starts every task pending, and a revision keeps the state of the tasks it still names', (t) => {
@@ -137,7 +137,7 @@ test('a first plan starts every task pending, and a revision keeps the state of
 test('a plan state that loses a task with attempts is refused; retiring that task keeps it on record', (t) => {
   const { store } = openStore(t);
   let state = planned(store);
-  store.reserveAttempt(state.runId, state.revision, 'inspect', work());
+  store.reserveAttempt(state.runId, state.revision, 'inspect', work(), 'The run is under way.');
   state = store.read(state.runId);
   const { plan } = state;
   assert.ok(plan);
@@ -165,7 +165,7 @@ test('a stopped run aborts its open tasks and abandons unsettled attempts; untou
   let state = planned(store);
   state = store.update(state.runId, state.revision, { tasks: state.tasks.map((task) => (task.taskId === 'inspect'
     ? { ...task, status: 'running' } : task)) }, { message: 'Task inspect: running.' });
-  const attempt = store.reserveAttempt(state.runId, state.revision, 'inspect', work());
+  const attempt = store.reserveAttempt(state.runId, state.revision, 'inspect', work(), 'The run is under way.');
   state = store.markAttemptRunning(state.runId, store.read(state.runId).revision, attempt.childRunId);
 
   const aborted = store.update(state.runId, state.revision, { phase: 'aborted' }, { message: 'Aborted by user.' });
@@ -180,7 +180,7 @@ test('a run reports the merged throughput of its own conversation runs and its c
   const state = planned(store);
   const parentRunId = randomUUID();
   store.update(state.runId, state.revision, { parentRunIds: [parentRunId] }, { message: 'Parent run recorded.' });
-  const attempt = store.reserveAttempt(state.runId, state.revision + 1, 'inspect', work());
+  const attempt = store.reserveAttempt(state.runId, state.revision + 1, 'inspect', work(), 'The run is under way.');
   const database = getRuntimeDatabase(dbPath);
   seedRunLogThroughput(database, parentRunId, [1_000, 1_000], [100, 2_000]);
   seedRunLogThroughput(database, attempt.childRunId, [3_000, 1_000], [300, 2_000]);
@@ -205,8 +205,28 @@ test('a new run has its budget and no approaches or retired tasks; its first pla
 test('a reservation past the dispatch budget is refused', (t) => {
   const { store } = openStore(t);
   let state = planned(store, startRequest({ budget: { minutes: 60, dispatches: 1 } }));
-  store.reserveAttempt(state.runId, state.revision, 'inspect', work());
+  store.reserveAttempt(state.runId, state.revision, 'inspect', work(), 'The run is under way.');
   state = store.read(state.runId);
-  assert.throws(() => store.reserveAttempt(state.runId, state.revision, 'follow-up', work('implementation', 'follow-up')),
+  assert.throws(() => store.reserveAttempt(state.runId, state.revision, 'follow-up', work('implementation', 'follow-up'), 'The run is under way.'),
     /The run's dispatch budget is spent \(1 of 1\)\./u);
 });
+
+test('every reservation records where the run stands, and the newest hundred lines are kept', (t) => {
+  const { store } = openStore(t);
+  const tasks = Array.from({ length: 26 }, (_, index) => makeOrchestratorTask({ id: `task-${index}` }));
+  const created = store.create(startRequest({ budget: { minutes: 10, dispatches: 200 } }));
+  assert.deepEqual(created.statusLines, []);
+  let state = savePlanned(store, created, makeOrchestratorPlan(tasks), 'hash-1');
+  let count = 0;
+  for (const task of tasks) {
+    for (const kind of ['implementation', 'implementation', 'fix', 'fix'] as const) {
+      count += 1;
+      if (count > 101) break;
+      store.reserveAttempt(state.runId, state.revision, task.id, { kind, planPath: 'docs/plan.md', planHash: 'hash-1', task, instruction: 'Do it.' }, `Line ${count}.`);
+      state = store.read(state.runId);
+    }
+  }
+  assert.equal(state.statusLines.length, 100);
+  assert.deepEqual([state.statusLines.at(0)?.text, state.statusLines.at(-1)?.text], ['Line 2.', 'Line 101.']);
+  assert.equal(state.statusLines.at(-1)?.atUtc, state.attempts.at(-1)?.reservedAtUtc);
+});
````

Modify `tests/orchestrator-runs.test.ts`:

````diff
@@ -147,7 +147,7 @@ test('startup marks the running children of an interrupted parent not resumable'
   const task = plan.tasks[0];
   assert.ok(task);
   const attempt = store.reserveAttempt(state.runId, state.revision, task.id,
-    { kind: 'implementation', planPath: 'docs/plan.md', planHash: 'hash', task, instruction: 'Implement it.' });
+    { kind: 'implementation', planPath: 'docs/plan.md', planHash: 'hash', task, instruction: 'Implement it.' }, 'The run is under way.');
   state = store.markAttemptRunning(state.runId, store.read(state.runId).revision, attempt.childRunId);
   const marked: string[] = [];
 
````

Modify `tests/orchestrator-prompts.test.ts`:

````diff
@@ -188,3 +188,10 @@ test('the orchestrator reads the named spec whole first, batches independent rea
     assert.ok(prompt.includes(rule), rule);
   }
 });
+
+test('a child is told why its task exists; a task saved without a reason says nothing', () => {
+  const build = (why: string | null): string => buildChildInstruction({ work: { ...work('implementation'), task: { ...work('implementation').task, why } },
+    attempt: 1, repoRoot: 'C:/work/repo', scratchPath: 's', preexistingDirtyPaths: [] });
+  assert.match(build('Make sure the install steps work.'), /^Why this task exists: Make sure the install steps work\.$/mu);
+  assert.doesNotMatch(build(null), /Why this task exists/u);
+});
````

Modify `tests/repo-search-orchestrator-tools.test.ts`:

````diff
@@ -17,7 +17,7 @@ import { mockOfflineSiftConfig } from './helpers/mock-config.ts';
 
 const MOCK_LOOP_DEFAULTS = createMockLoopDefaults('siftkit-orchestrator-tools-');
 const TOOLS = resolveRepoSearchPlannerToolDefinitions(['read', ...ORCHESTRATOR_TOOL_NAMES]);
-const DISPATCH = { taskId: 'greeting', purpose: 'implementation', instruction: 'Create src/greeting.ts.' };
+const DISPATCH = { update: 'The run is under way.', taskId: 'greeting', purpose: 'implementation', instruction: 'Create src/greeting.ts.' };
 
 class RecordingHost implements OrchestratorToolHost {
   readonly calls: OrchestratorToolCall[] = [];
````

Create `tests/runtime-db-schema-orchestrator-task-purpose.test.ts`:

````ts
import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';

import { JsonObjectSchema, type JsonObject } from '../src/lib/json-types.ts';
import { z } from '../src/lib/zod.ts';
import { OrchestratorRunStore } from '../src/orchestrator/run-store.ts';
import { CURRENT_SCHEMA_VERSION, closeAllRuntimeDatabases, getRuntimeDatabase, getSchemaVersion } from '../src/state/runtime-db.ts';
import { writeConfig } from '../src/status-server/config-store.ts';
import { getDefaultServerConfig } from './helpers/mock-config.ts';
import { makeOrchestratorPlan, makeOrchestratorRequest, makeOrchestratorTask, savePlanned } from './helpers/orchestrator-plan.ts';
import { withRuntimeDatabaseConnection } from './helpers/runtime-database-probe.ts';
import { createManagedTempDir } from './helpers/temp-dirs.ts';

const StateRowSchema = z.object({ state_json: z.string() });
const AttemptRowSchema = z.object({ attempt_json: z.string() });
const TaskListSchema = z.array(JsonObjectSchema);

function withoutWhy(task: JsonObject): JsonObject {
  const { why: _why, ...rest } = task;
  return rest;
}

/** A schema-98 file with two runs: one planned and dispatched, one without a plan. `damage` rewrites the first run's state. */
function seedSchema98(damage: (state: JsonObject) => JsonObject): { dbPath: string; planned: string; unplanned: string } {
  const dbPath = path.join(createManagedTempDir('siftkit-task-purpose-'), 'runtime.sqlite');
  writeConfig(dbPath, getDefaultServerConfig());
  const store = new OrchestratorRunStore(getRuntimeDatabase(dbPath));
  const repoRoot = createManagedTempDir('siftkit-task-purpose-repo-');
  const task = makeOrchestratorTask({ id: 'greeting' });
  const state = savePlanned(store, store.create(makeOrchestratorRequest({ repoRoot })), makeOrchestratorPlan([task]));
  const attempt = store.reserveAttempt(state.runId, state.revision, 'greeting',
    { kind: 'implementation', planPath: 'docs/plan.md', planHash: 'hash', task, instruction: 'Do it.' }, 'The run is under way.');
  const unplanned = store.create(makeOrchestratorRequest({ repoRoot })).runId;
  closeAllRuntimeDatabases();
  withRuntimeDatabaseConnection(dbPath, (database) => {
    for (const runId of [state.runId, unplanned]) {
      const { statusLines: _lines, ...stored } = JsonObjectSchema.parse(JSON.parse(StateRowSchema.parse(
        database.prepare('SELECT state_json FROM orchestrator_runs WHERE run_id = ?').get(runId)).state_json));
      const plan = stored.plan === null ? null : JsonObjectSchema.parse(stored.plan);
      const legacy = { ...stored, plan: plan === null ? null : { ...plan, tasks: TaskListSchema.parse(plan.tasks).map(withoutWhy) } };
      database.prepare('UPDATE orchestrator_runs SET state_json = ? WHERE run_id = ?')
        .run(JSON.stringify(runId === state.runId ? damage(legacy) : legacy), runId);
    }
    const stored = JsonObjectSchema.parse(JSON.parse(AttemptRowSchema.parse(
      database.prepare('SELECT attempt_json FROM orchestrator_attempts WHERE child_run_id = ?').get(attempt.childRunId)).attempt_json));
    const work = JsonObjectSchema.parse(stored.work);
    database.prepare('UPDATE orchestrator_attempts SET attempt_json = ? WHERE child_run_id = ?')
      .run(JSON.stringify({ ...stored, work: { ...work, task: withoutWhy(JsonObjectSchema.parse(work.task)) } }), attempt.childRunId);
    database.exec('UPDATE runtime_schema SET version = 98 WHERE id = 1');
  });
  return { dbPath, planned: state.runId, unplanned };
}

test('the 98 to 99 upgrade gives every stored copy of a task a null why, and every run an empty list of lines', (t) => {
  t.after(closeAllRuntimeDatabases);
  const { dbPath, planned, unplanned } = seedSchema98((state) => state);
  const database = getRuntimeDatabase(dbPath);
  assert.equal(getSchemaVersion(database), CURRENT_SCHEMA_VERSION);
  // Reading parses the run and each of its attempts with the current schemas.
  const state = new OrchestratorRunStore(database).read(planned);
  assert.deepEqual(state.plan?.tasks.map((task) => task.why), [null]);
  assert.deepEqual(state.attempts.map((attempt) => attempt.work.task.why), [null]);
  assert.deepEqual(state.statusLines, []);
  assert.deepEqual(new OrchestratorRunStore(database).read(unplanned).statusLines, []);
});

test('the 98 to 99 upgrade fails loudly on an unreadable stored run, naming it, and leaves the file at 98', (t) => {
  t.after(closeAllRuntimeDatabases);
  const { dbPath, planned } = seedSchema98((state) => ({ ...state, plan: 'not a plan' }));
  assert.throws(() => getRuntimeDatabase(dbPath), new RegExp(`Orchestrator run ${planned} has an unreadable stored state`, 'u'));
  assert.equal(withRuntimeDatabaseConnection(dbPath, (database) => getSchemaVersion(database)), 98);
});
````

Modify `tests/runtime-db-schema-orchestrator-attempt-results.test.ts`:

````diff
@@ -24,9 +24,9 @@ function seedSchema84(): { dbPath: string; runId: string } {
     approval: 'off', task: 'Add greeting.' }));
   const state = savePlanned(store, created, makeOrchestratorPlan([TASK, OTHER]));
   const blocked = store.reserveAttempt(state.runId, state.revision, 'greeting',
-    { kind: 'implementation', planPath: 'docs/plan.md', planHash: 'hash', task: TASK, instruction: 'Implement it.' });
+    { kind: 'implementation', planPath: 'docs/plan.md', planHash: 'hash', task: TASK, instruction: 'Implement it.' }, 'The run is under way.');
   const failed = store.reserveAttempt(state.runId, store.read(state.runId).revision, 'farewell',
-    { kind: 'implementation', planPath: 'docs/plan.md', planHash: 'hash', task: OTHER, instruction: 'Implement it.' });
+    { kind: 'implementation', planPath: 'docs/plan.md', planHash: 'hash', task: OTHER, instruction: 'Implement it.' }, 'The run is under way.');
   closeAllRuntimeDatabases();
   withRuntimeDatabaseConnection(dbPath, (database) => {
     const settle = database.prepare('UPDATE orchestrator_attempts SET attempt_json = ? WHERE child_run_id = ?');
````

Modify `tests/runtime-db-schema-orchestrator-check-digests.test.ts`:

````diff
@@ -24,7 +24,7 @@ function seedSchema89(checks: JsonValue): { dbPath: string; runId: string } {
     approval: 'off', task: 'Add greeting.' }));
   const state = savePlanned(store, created, makeOrchestratorPlan([WRITE]));
   const attempt = store.reserveAttempt(state.runId, state.revision, 'greeting',
-    { kind: 'implementation', planPath: 'docs/plan.md', planHash: 'hash', task: WRITE, instruction: 'Write it.' });
+    { kind: 'implementation', planPath: 'docs/plan.md', planHash: 'hash', task: WRITE, instruction: 'Write it.' }, 'The run is under way.');
   closeAllRuntimeDatabases();
   withRuntimeDatabaseConnection(dbPath, (database) => {
     database.prepare('UPDATE orchestrator_attempts SET attempt_json = ? WHERE child_run_id = ?').run(JSON.stringify({ ...attempt, status: 'settled', result: {
````

Modify `tests/runtime-db-schema-orchestrator-search-reports.test.ts`:

````diff
@@ -20,9 +20,9 @@ function seedSchema85(): { dbPath: string; runId: string } {
     approval: 'off', task: 'Add greeting.' }));
   const state = savePlanned(store, created, makeOrchestratorPlan([SURVEY, WRITE]));
   const survey = store.reserveAttempt(state.runId, state.revision, 'survey',
-    { kind: 'implementation', planPath: 'docs/plan.md', planHash: 'hash', task: SURVEY, instruction: 'Find it.' });
+    { kind: 'implementation', planPath: 'docs/plan.md', planHash: 'hash', task: SURVEY, instruction: 'Find it.' }, 'The run is under way.');
   const write = store.reserveAttempt(state.runId, store.read(state.runId).revision, 'greeting',
-    { kind: 'implementation', planPath: 'docs/plan.md', planHash: 'hash', task: WRITE, instruction: 'Write it.' });
+    { kind: 'implementation', planPath: 'docs/plan.md', planHash: 'hash', task: WRITE, instruction: 'Write it.' }, 'The run is under way.');
   closeAllRuntimeDatabases();
   withRuntimeDatabaseConnection(dbPath, (database) => {
     const settle = database.prepare('UPDATE orchestrator_attempts SET attempt_json = ? WHERE child_run_id = ?');
````

Modify `tests/runtime-db-schema-orchestrator-single-worker.test.ts`:

````diff
@@ -26,9 +26,9 @@ function seedSchema88(description: string, catalogIndent = 0): { dbPath: string;
     approval: 'off', task: 'Add greeting.' }));
   const state = savePlanned(store, created, makeOrchestratorPlan([SURVEY, WRITE]));
   const survey = store.reserveAttempt(state.runId, state.revision, 'survey',
-    { kind: 'implementation', planPath: 'docs/plan.md', planHash: 'hash', task: SURVEY, instruction: 'Find it.' });
+    { kind: 'implementation', planPath: 'docs/plan.md', planHash: 'hash', task: SURVEY, instruction: 'Find it.' }, 'The run is under way.');
   const write = store.reserveAttempt(state.runId, store.read(state.runId).revision, 'greeting',
-    { kind: 'implementation', planPath: 'docs/plan.md', planHash: 'hash', task: WRITE, instruction: 'Write it.' });
+    { kind: 'implementation', planPath: 'docs/plan.md', planHash: 'hash', task: WRITE, instruction: 'Write it.' }, 'The run is under way.');
   closeAllRuntimeDatabases();
   const catalogText = withRuntimeDatabaseConnection(dbPath, (database) => {
     const settle = database.prepare('UPDATE orchestrator_attempts SET attempt_json = ? WHERE child_run_id = ?');
````

Modify `tests/helpers/orchestrator-plan.ts`:

````diff
@@ -3,10 +3,11 @@ import { randomUUID } from 'node:crypto';
 
 import {
   DEFAULT_ORCHESTRATOR_BUDGET,
+  OrchestratorNewTaskSchema,
   OrchestratorPlanSchema,
   OrchestratorRunStateSchema,
   OrchestratorStartRequestSchema,
-  OrchestratorTaskSchema,
+  type OrchestratorNewTask,
   type OrchestratorPlan,
   type OrchestratorRunState,
   type OrchestratorStartRequest,
@@ -18,9 +19,9 @@ import {
 import { startPlan, type PlanTransition } from '../../src/orchestrator/plan-state.ts';
 import type { OrchestratorRunStore } from '../../src/orchestrator/run-store.ts';
 
-export function makeOrchestratorTask(overrides: Partial<OrchestratorTask> = {}): OrchestratorTask {
-  return OrchestratorTaskSchema.parse({
-    id: 'inspect', title: 'Inspect README', dependsOn: [],
+export function makeOrchestratorTask(overrides: Partial<OrchestratorNewTask> = {}): OrchestratorNewTask {
+  return OrchestratorNewTaskSchema.parse({
+    id: 'inspect', title: 'Inspect README', why: 'Make sure the install steps work.', dependsOn: [],
     workerPresetId: 'repo-agent', readPaths: ['README.md'], writePaths: ['README.md'],
     steps: [{ instruction: 'Read README.md and report its installation commands.',
       expectedResult: 'Commands with file and line evidence.' }],
@@ -58,7 +59,7 @@ export function makeOrchestratorRunState(overrides: Partial<OrchestratorRunState
   return OrchestratorRunStateSchema.parse({
     runId: randomUUID(), request: makeOrchestratorRequest(), revision: 1, phase: 'executing', planPath: null, planHash: null,
     plan: null, tasks: [], attempts: [], parentRunIds: [], approval: null, failure: null,
-    approaches: [], retiredTasks: [], createdAtUtc: FIXTURE_AT, updatedAtUtc: FIXTURE_AT, ...overrides,
+    approaches: [], retiredTasks: [], statusLines: [], createdAtUtc: FIXTURE_AT, updatedAtUtc: FIXTURE_AT, ...overrides,
   });
 }
 
````

Modify `tests/process/orchestrator-run.e2e.test.ts`:

````diff
@@ -78,8 +78,8 @@ function tool(name: string, args: JsonObject): MockPlannerResponseInput {
 
 const savePlan = (plan: OrchestratorPlan = planOf()) => tool('save_plan', { plan });
 
-function dispatch(child: { taskId: string; purpose?: OrchestratorChildPurpose; instruction?: string }) {
-  return tool('dispatch', { taskId: child.taskId, purpose: child.purpose ?? 'implementation',
+function dispatch(child: { taskId: string; purpose?: OrchestratorChildPurpose; instruction?: string; update?: string }) {
+  return tool('dispatch', { update: child.update ?? 'The run is under way.', taskId: child.taskId, purpose: child.purpose ?? 'implementation',
     instruction: child.instruction ?? `Do task ${child.taskId}.` });
 }
 
@@ -294,6 +294,18 @@ test('a fifth invalid response in a row ends the orchestrator conversation', asy
   assert.equal(state.plan, null, 'the save_plan after the fifth slip never ran');
 });
 
+test('a dispatch whose update names a path is refused and records no line; the next one is recorded', async (t) => {
+  const context = await startHarness(t, 'siftkit-orchestrator-update-');
+  const { engine } = context;
+  engine.parent.push([savePlan(), dispatch({ taskId: 'greeting', update: 'Working on src/greeting.ts now.' }),
+    dispatch({ taskId: 'greeting', update: 'Building the greeting first.' }), review('greeting', 'pass'), COMPLETE]);
+  engine.children.push(WRITER);
+  const { state } = await followRun(context, (await startRun(context, 'off')).runId);
+  assertCompleted(state, engine);
+  assert.deepEqual(state.statusLines.map((line) => line.text), ['Building the greeting first.']);
+  assert.equal(state.attempts.length, 1);
+});
+
 test('a child out of resubmits reports its failing checks, and the orchestrator dispatches a fresh second attempt', async (t) => {
   const context = await startHarness(t, 'siftkit-orchestrator-retry-');
   const { engine } = context;
````

Modify `tests/process/chat-overflow.test.ts`:

````diff
@@ -8,7 +8,7 @@ import { HOSTILE_PATH, OVERFLOW_PRESENT, OverflowReportSchema, UNBROKEN } from '
 
 const AT = '2026-09-23T12:00:00.000Z';
 const CHECK = { kind: 'command', command: `npm test -- ${UNBROKEN}`, cwd: '.', expectedExitCode: 0 } as const;
-const TASK = { id: 'task', title: UNBROKEN, dependsOn: [], workerPresetId: 'repo-agent', readPaths: [], writePaths: [HOSTILE_PATH],
+const TASK = { id: 'task', title: UNBROKEN, why: UNBROKEN.slice(0, 160), dependsOn: [], workerPresetId: 'repo-agent', readPaths: [], writePaths: [HOSTILE_PATH],
   steps: [{ instruction: 'Write it.', expectedResult: 'It exists.' }], verification: [CHECK], acceptance: ['Done.'], temporaryPaths: [] };
 const RUN_ID = '00000000-0000-4000-8000-000000000001';
 const CHILD_ID = '00000000-0000-4000-8000-000000000002';
````

Modify `dashboard/tests/orchestrator-fixture.ts`:

````diff
@@ -25,6 +25,6 @@ export function orchestratorRunState(overrides: Partial<OrchestratorRunState> =
   return OrchestratorRunStateSchema.parse({
     runId: FIXTURE_RUN_ID, request: orchestratorRequest(), revision: 1, phase: 'executing', planPath: null, planHash: null,
     plan: null, tasks: [], attempts: [], parentRunIds: [], approval: null, failure: null,
-    approaches: [], retiredTasks: [], createdAtUtc: FIXTURE_AT, updatedAtUtc: FIXTURE_AT, ...overrides,
+    approaches: [], retiredTasks: [], statusLines: [], createdAtUtc: FIXTURE_AT, updatedAtUtc: FIXTURE_AT, ...overrides,
   });
 }
````

Modify `dashboard/tests/chat-tab.test.tsx`:

````diff
@@ -575,7 +575,7 @@ test('orchestrator mode hands the live activity and the last work phase to the r
   const originalFetch = globalThis.fetch;
   const childRunId = '4f9c1f9a-0000-4000-8000-0000000000bb';
   const check = { kind: 'command', command: 'npm test', cwd: '.', expectedExitCode: 0 } as const;
-  const task = { id: 'greet', title: 'Greet', dependsOn: [], workerPresetId: 'repo-agent', readPaths: [], writePaths: ['src/a.ts'],
+  const task = { id: 'greet', title: 'Greet', why: null, dependsOn: [], workerPresetId: 'repo-agent', readPaths: [], writePaths: ['src/a.ts'],
     steps: [{ instruction: 'Write it.', expectedResult: 'It exists.' }], verification: [check], acceptance: ['Greets.'], temporaryPaths: [] };
   const running = orchestratorRunState({
     runId: ORCHESTRATOR_RUN_ID,
````

Modify `dashboard/tests/orchestrator-run-panel.test.tsx`:

````diff
@@ -12,7 +12,7 @@ const APPROVAL_ID = '00000000-0000-4000-8000-000000000003';
 const AT = '2026-09-23T12:00:00.000Z';
 const CHECK = { kind: 'command', command: 'npm test', cwd: '.', expectedExitCode: 0 } as const;
 const TASK = {
-  id: 'add-greeting', title: 'Add greeting', dependsOn: [], workerPresetId: 'repo-agent', readPaths: [], writePaths: ['src/a.ts'],
+  id: 'add-greeting', title: 'Add greeting', why: 'Greet people the same way everywhere.', dependsOn: [], workerPresetId: 'repo-agent', readPaths: [], writePaths: ['src/a.ts'],
   steps: [{ instruction: 'Write it.', expectedResult: 'It exists.' }], verification: [CHECK], acceptance: ['Greets.'], temporaryPaths: [],
 };
 
````

Modify `dashboard/tests/orchestrator-view.test.ts`:

````diff
@@ -32,7 +32,7 @@ const AT = '2026-10-11T12:00:00.000Z';
 const CHECK = { kind: 'command', command: 'npm test', cwd: '.', expectedExitCode: 0 } as const;
 
 function planTask(id: string, workerPresetId: string, dependsOn: string[] = []) {
-  return { id, title: id, dependsOn, workerPresetId, readPaths: [], writePaths: [], temporaryPaths: [],
+  return { id, title: id, why: null, dependsOn, workerPresetId, readPaths: [], writePaths: [], temporaryPaths: [],
     steps: [{ instruction: 'Do it.', expectedResult: 'Done.' }], verification: [CHECK], acceptance: ['Done.'] };
 }
 
````

- [ ] **Step 2: Run them and see them fail**

Run: `node .\src\test-runner\run-tests.ts contracts-orchestrator orchestrator-run-store orchestrator-prompts runtime-db-schema-orchestrator`
Expected: FAIL (unknown keys `why` and `update`, no schema 99)

- [ ] **Step 3: Implement**

Modify `packages/contracts/src/orchestrator.ts`:

````diff
@@ -45,10 +45,14 @@ export const OrchestratorVerificationCheckSchema = z.discriminatedUnion('kind',
 ]);
 export type OrchestratorVerificationCheck = z.infer<typeof OrchestratorVerificationCheckSchema>;
 
+/** Why a task exists, in one sentence a person reads on the board. */
+const ORCHESTRATOR_WHY_MAX_CHARS = 160;
+
 /** A plan task's fields exactly as written; update_tasks patches use this shape so a patch never gains a default. */
 const OrchestratorTaskFieldsSchema = z.object({
   id: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u),
   title: z.string().trim().min(1),
+  why: z.string().trim().min(1).max(ORCHESTRATOR_WHY_MAX_CHARS),
   dependsOn: z.array(z.string().min(1)),
   workerPresetId: z.string().trim().min(1),
   readPaths: z.array(z.string().min(1)),
@@ -61,12 +65,18 @@ const OrchestratorTaskFieldsSchema = z.object({
   temporaryPaths: z.array(z.string().min(1)),
 }).strict();
 
-/** A plan task; omitted dependency, read, and temporary lists mean none. */
-export const OrchestratorTaskSchema = OrchestratorTaskFieldsSchema.extend({
+/** A new plan task as the orchestrator writes it; omitted dependency, read, and temporary lists mean none. */
+export const OrchestratorNewTaskSchema = OrchestratorTaskFieldsSchema.extend({
   dependsOn: OrchestratorTaskFieldsSchema.shape.dependsOn.default([]),
   readPaths: OrchestratorTaskFieldsSchema.shape.readPaths.default([]),
   temporaryPaths: OrchestratorTaskFieldsSchema.shape.temporaryPaths.default([]),
 }).strict();
+export type OrchestratorNewTask = z.infer<typeof OrchestratorNewTaskSchema>;
+
+/** A stored plan task; `why` is null only for a task saved before tasks had one. */
+export const OrchestratorTaskSchema = OrchestratorNewTaskSchema.extend({
+  why: OrchestratorTaskFieldsSchema.shape.why.nullable(),
+}).strict();
 export type OrchestratorTask = z.infer<typeof OrchestratorTaskSchema>;
 
 /** The stored plan. After a rollback it may hold no task until the next approach adds some. */
@@ -257,12 +267,20 @@ export const OrchestratorTaskStateSchema = z.object({
 }).strict();
 export type OrchestratorTaskState = z.infer<typeof OrchestratorTaskStateSchema>;
 
+/** How many run-wide lines a run keeps, above the default dispatch budget. */
+export const ORCHESTRATOR_STATUS_LINE_LIMIT = 100;
+
+/** Where the whole run stood at one dispatch, in the orchestrator's words. */
+export const OrchestratorStatusLineSchema = z.object({ text: z.string().trim().min(1).max(240), atUtc: z.string().datetime() }).strict();
+export type OrchestratorStatusLine = z.infer<typeof OrchestratorStatusLineSchema>;
+
 export const OrchestratorRunStateSchema = z.object({
   runId: z.string().uuid(), request: OrchestratorStartRequestSchema, revision: z.number().int().nonnegative(),
   phase: OrchestratorPhaseSchema, planPath: z.string().min(1).nullable(), planHash: z.string().min(1).nullable(),
   plan: OrchestratorPlanSchema.nullable(), tasks: z.array(OrchestratorTaskStateSchema),
   approaches: z.array(OrchestratorApproachSchema), retiredTasks: z.array(OrchestratorRetiredTaskSchema),
   attempts: z.array(OrchestratorAttemptSchema), parentRunIds: z.array(z.string().uuid()),
+  statusLines: z.array(OrchestratorStatusLineSchema).max(ORCHESTRATOR_STATUS_LINE_LIMIT),
   approval: OrchestratorPendingApprovalSchema.nullable(), failure: OrchestratorFailureSchema.nullable(),
   createdAtUtc: z.string().datetime(), updatedAtUtc: z.string().datetime(),
 }).strict();
@@ -287,7 +305,7 @@ export type OrchestratorProgress = z.infer<typeof OrchestratorProgressSchema>;
 
 /** The first plan, as save_plan takes it: at least one task. */
 export const OrchestratorSavePlanArgsSchema = z.object({
-  plan: OrchestratorPlanSchema.extend({ tasks: OrchestratorPlanSchema.shape.tasks.min(1) }).strict(),
+  plan: OrchestratorPlanSchema.extend({ tasks: z.array(OrchestratorNewTaskSchema).min(1) }).strict(),
 }).strict();
 export type OrchestratorSavePlanArgs = z.infer<typeof OrchestratorSavePlanArgsSchema>;
 
@@ -296,7 +314,7 @@ export const OrchestratorUpdateTasksArgsSchema = z.object({
   update: z.array(z.object({
     taskId: z.string().min(1), set: OrchestratorTaskFieldsSchema.omit({ id: true }).partial().strict(),
   }).strict()).default([]),
-  add: z.array(OrchestratorTaskSchema).default([]),
+  add: z.array(OrchestratorNewTaskSchema).default([]),
   retire: z.array(z.object({ taskId: z.string().min(1), reason: z.string().trim().min(1) }).strict()).default([]),
   finalVerification: OrchestratorPlanSchema.shape.finalVerification.optional(),
 }).strict();
@@ -311,6 +329,7 @@ export type OrchestratorChangeApproachArgs = z.infer<typeof OrchestratorChangeAp
 /** Starts one fresh child for one saved task; children run one at a time. */
 export const OrchestratorDispatchArgsSchema = z.object({
   taskId: z.string().min(1), purpose: OrchestratorChildPurposeSchema, instruction: z.string().trim().min(1),
+  update: OrchestratorStatusLineSchema.shape.text,
 }).strict();
 export type OrchestratorDispatchArgs = z.infer<typeof OrchestratorDispatchArgsSchema>;
 
````

Modify `src/orchestrator/plan.ts`:

````diff
@@ -135,6 +135,7 @@ export function renderOrchestratorPlan(plan: OrchestratorPlan): string {
     '## Constraints', ...renderList(plan.constraints, 'None.'), '',
     ...plan.tasks.flatMap((task) => [
       `## Task ${task.id}: ${task.title}`, '',
+      ...(task.why === null ? [] : [task.why, '']),
       `- Worker: \`${task.workerPresetId}\``,
       `- Depends on: ${task.dependsOn.length === 0 ? 'none' : task.dependsOn.map((id) => `\`${id}\``).join(', ')}`,
       `- Reads: ${task.readPaths.length === 0 ? 'none' : task.readPaths.map((entry) => `\`${entry}\``).join(', ')}`,
````

Modify `src/orchestrator/prompts.ts`:

````diff
@@ -81,11 +81,15 @@ export function buildOrchestratorPrompt(brief: OrchestratorBrief): string {
     '     plus the project\'s typecheck and lint commands, using the exact commands the request names, flags included.',
     '   - finalVerification always includes the project\'s typecheck and lint commands and every relevant test suite.',
     '   - dependsOn names every task whose output or changes a task needs.',
+    '   - why is one plain sentence, at most 160 characters, for the person watching: what the task is for, with no file,',
+    '     command, or tool names.',
     '3. Dispatch one task at a time, with its dependencies complete. Every child starts fresh and knows only its instruction:',
     '   include what it must change, the files and lines you found, what earlier tasks changed that matters to it, and the',
     '   pitfalls you already know. Write each instruction as final decisions, each step stated once: never leave a corrected',
     `   option ("— actually") in it. dispatch waits until the child reports. Code runs a child's checks each time it finishes;`,
     `   it fixes its own failures up to ${ORCHESTRATOR_MAX_RESUBMITS} times before its report reaches you.`,
+    '   Its update tells the person watching where the whole run is and what comes next: one or two plain sentences, at most',
+    '   240 characters, with no file names, paths, commands, code, or tool names, and nothing you have not confirmed.',
     '4. Review every reported task with record_review, and only that task: completed tasks were already reviewed, so do not',
     '   re-check them. A report gives the child\'s status, where it departed from the plan, the gate\'s last check results, and',
     '   what changed as line counts, not the code. This run makes no commits: every task\'s changes stay uncommitted in the',
@@ -138,6 +142,7 @@ export function buildChildInstruction(input: {
     `${input.work.kind === 'fix' ? 'Fix' : 'Implement'} ONLY task '${task.id}' — ${task.title} — from plan ${input.work.planPath}`
       + ` (hash ${input.work.planHash}); ${input.work.kind} attempt ${input.attempt} of ${ORCHESTRATOR_MAX_ATTEMPTS}.`,
     `Repository root: ${input.repoRoot}. Your tools and shell already run there; keep every command and path inside it.`,
+    ...(task.why === null ? [] : [`Why this task exists: ${task.why}`]),
     'Instruction from the orchestrator:', input.work.instruction,
     `Read: ${task.readPaths.join(', ') || '(as needed)'}`,
     `Expected to change: ${task.writePaths.join(', ')}`,
````

Modify `src/orchestrator/run-store.ts`:

````diff
@@ -2,6 +2,7 @@ import { randomUUID } from 'node:crypto';
 
 import {
   InferenceThroughputSchema,
+  ORCHESTRATOR_STATUS_LINE_LIMIT,
   ORCHESTRATOR_TERMINAL_PHASES,
   OrchestratorAttemptResultSchema,
   OrchestratorAttemptSchema,
@@ -81,7 +82,7 @@ export class OrchestratorRunStore {
       const now = new Date().toISOString();
       const state: StoredRunState = StoredRunStateSchema.parse({
         runId: randomUUID(), request, revision: 0, phase: 'preparing_plan', planPath: null, planHash: null, plan: null,
-        tasks: [], approaches: [], retiredTasks: [], parentRunIds: [], approval: null, failure: null, createdAtUtc: now, updatedAtUtc: now,
+        tasks: [], approaches: [], retiredTasks: [], statusLines: [], parentRunIds: [], approval: null, failure: null, createdAtUtc: now, updatedAtUtc: now,
       });
       this.database.prepare(`
         INSERT INTO orchestrator_runs (run_id, submission_id, request_digest, revision, phase, state_json, created_at_utc, updated_at_utc)
@@ -133,8 +134,8 @@ export class OrchestratorRunStore {
     return this.mutate(runId, revision, (state) => ({ stored: { ...state, ...changes }, event }));
   }
 
-  /** Reserves the next attempt of the work's purpose and its child ID before anything starts. */
-  reserveAttempt(runId: string, revision: number, taskId: string, work: OrchestratorChildWork): OrchestratorAttempt {
+  /** Reserves the next attempt of the work's purpose and its child ID before anything starts, and records where the run stands. */
+  reserveAttempt(runId: string, revision: number, taskId: string, work: OrchestratorChildWork, update: string): OrchestratorAttempt {
     const purpose: OrchestratorChildPurpose = work.kind;
     const childRunId = randomUUID();
     const state = this.mutate(runId, revision, (current) => {
@@ -151,7 +152,8 @@ export class OrchestratorRunStore {
       this.database.prepare(`
         INSERT INTO orchestrator_attempts (run_id, task_id, purpose, attempt, child_run_id, attempt_json) VALUES (?, ?, ?, ?, ?, ?)
       `).run(runId, taskId, purpose, attempt.attempt, childRunId, JSON.stringify(attempt));
-      return { stored: current, event: { message: `Reserved ${purpose} attempt ${attempt.attempt}.`, taskId, purpose,
+      const statusLines = [...current.statusLines, { text: update, atUtc: attempt.reservedAtUtc }].slice(-ORCHESTRATOR_STATUS_LINE_LIMIT);
+      return { stored: { ...current, statusLines }, event: { message: `Reserved ${purpose} attempt ${attempt.attempt}.`, taskId, purpose,
         attempt: attempt.attempt, childRunId } };
     });
     return this.requireAttempt(state, childRunId);
````

Modify `src/orchestrator/run.ts`:

````diff
@@ -43,6 +43,7 @@ import { PresetSystemContextBuilder } from '../preset-system-context.ts';
 import type { OrchestratorToolHost, OrchestratorToolOutcome } from '../repo-search/engine/orchestrator-tool-host.ts';
 import { resolveRepoScopedPath } from '../repo-search/engine/repo-paths.ts';
 import { findPathsOutsideRepo } from '../repo-search/engine/shell-command-policy.ts';
+import { findStatusTextProblem } from '../repo-search/status-text.ts';
 import type { SubmissionGate, SubmissionVerdict } from '../repo-search/engine/submission-gate.ts';
 import { taskPassed } from '../repo-search/engine/task-loop-support.ts';
 import type { OrchestratorToolCall } from '../repo-search/repo-tool-arguments.ts';
@@ -593,14 +594,16 @@ export class OrchestratorRun implements OrchestratorLiveRun, OrchestratorToolHos
       return this.refuse([`The instruction names ${outside.join(', ')}, outside the repository root ${this.request.repoRoot}; `
         + 'a child works only in this repository, so name repository-relative paths.']);
     }
+    const wording = findStatusTextProblem(args.update);
+    if (wording !== null) return this.refuse([`Rewrite update: ${wording}. Say in one or two plain sentences where the whole run is and what comes next.`]);
     this.activity.setSchedule(describeSchedule(this.workers, plan, this.state.tasks));
-    await this.startChild(task, { kind: args.purpose, planPath, planHash, task, instruction: args.instruction });
+    await this.startChild(task, { kind: args.purpose, planPath, planHash, task, instruction: args.instruction }, args.update);
     return this.waitForChild();
   }
 
-  private async startChild(task: OrchestratorTask, work: OrchestratorAttempt['work']): Promise<void> {
+  private async startChild(task: OrchestratorTask, work: OrchestratorAttempt['work'], update: string): Promise<void> {
     const repository = await this.acquireRepository();
-    const attempt = this.ctx.orchestratorRunStore.reserveAttempt(this.runId, this.state.revision, task.id, work);
+    const attempt = this.ctx.orchestratorRunStore.reserveAttempt(this.runId, this.state.revision, task.id, work, update);
     this.publish(this.ctx.orchestratorRunStore.read(this.runId));
     this.setTaskStatus(task.id, 'running');
     // The child changes the tree, so a check that passed before it proves nothing about its work.
````

Modify `src/repo-search/planner-protocol.ts`:

````diff
@@ -163,7 +163,7 @@ const REPO_TOOL_REGISTRY: Record<string, PlannerToolDefinition> = {
     description: 'Validate and save the first run plan. Invalid plans come back with their problems; once a plan is saved, revise it with update_tasks.',
     exampleArgs: { plan: {
       goal: 'Add the greeting module.', constraints: [],
-      tasks: [{ id: 'greeting', title: 'Add src/greeting.ts', dependsOn: [], workerPresetId: 'repo-agent',
+      tasks: [{ id: 'greeting', title: 'Add src/greeting.ts', why: 'Give every part of the app one shared greeting.', dependsOn: [], workerPresetId: 'repo-agent',
         readPaths: ['src/app.ts'], writePaths: ['src/greeting.ts'],
         steps: [{ instruction: 'Create src/greeting.ts exporting greeting.', expectedResult: 'The module exists.' }],
         verification: [{ kind: 'command', command: 'npm run typecheck', cwd: '.', expectedExitCode: 0 }],
@@ -184,7 +184,8 @@ const REPO_TOOL_REGISTRY: Record<string, PlannerToolDefinition> = {
   dispatch: buildRepoToolDefinition({
     toolName: 'dispatch',
     description: 'Start a fresh subagent for one saved plan task, then wait. Returns its report once it finishes, or earlier when it needs your approval decision. One child runs at a time.',
-    exampleArgs: { taskId: 'greeting', purpose: 'implementation', instruction: 'Create src/greeting.ts exporting greeting; keep src/app.ts unchanged.' },
+    exampleArgs: { taskId: 'greeting', purpose: 'implementation', instruction: 'Create src/greeting.ts exporting greeting; keep src/app.ts unchanged.',
+      update: 'The plan is ready. Building the shared greeting first, because the rest depends on it.' },
   }),
   decide: buildRepoToolDefinition({
     toolName: 'decide',
````

Create `src/state/schema-upgrades/orchestrator-task-purpose.ts`:

````ts
import { parseJsonObjectText } from '../../lib/json.ts';
import { JsonValueSchema } from '../../lib/json-types.ts';
import { z } from '../../lib/zod.ts';
import type { RuntimeDatabase } from '../database-handle.ts';

const RunRowsSchema = z.array(z.object({ run_id: z.string(), state_json: z.string() }));
const AttemptRowsSchema = z.array(z.object({ child_run_id: z.string(), attempt_json: z.string() }));
// Pins only what this step reads. A task or run that already has the new field was written by current code.
const Stored98TaskSchema = z.object({ why: JsonValueSchema.optional() }).catchall(JsonValueSchema);
const Stored98RunSchema = z.object({
  plan: z.object({ tasks: z.array(Stored98TaskSchema) }).catchall(JsonValueSchema).nullable(),
  statusLines: JsonValueSchema.optional(),
}).catchall(JsonValueSchema);
const Stored98AttemptSchema = z.object({
  work: z.object({ task: Stored98TaskSchema }).catchall(JsonValueSchema),
}).catchall(JsonValueSchema);

function withWhy(task: z.infer<typeof Stored98TaskSchema>) {
  return { ...task, why: task.why ?? null };
}

/** Schema 98 -> 99: every stored copy of a plan task gains `why`, and every run its run-wide lines. */
export function upgradeOrchestratorTaskPurpose(database: RuntimeDatabase): void {
  const updateRun = database.prepare('UPDATE orchestrator_runs SET state_json = ? WHERE run_id = ?');
  for (const row of RunRowsSchema.parse(database.prepare('SELECT run_id, state_json FROM orchestrator_runs').all())) {
    const parsed = Stored98RunSchema.safeParse(parseJsonObjectText(row.state_json));
    if (!parsed.success) throw new Error(`Orchestrator run ${row.run_id} has an unreadable stored state: ${parsed.error.message}`);
    const { plan } = parsed.data;
    updateRun.run(JSON.stringify({
      ...parsed.data, statusLines: parsed.data.statusLines ?? [],
      plan: plan === null ? null : { ...plan, tasks: plan.tasks.map(withWhy) },
    }), row.run_id);
  }
  const updateAttempt = database.prepare('UPDATE orchestrator_attempts SET attempt_json = ? WHERE child_run_id = ?');
  for (const row of AttemptRowsSchema.parse(database.prepare('SELECT child_run_id, attempt_json FROM orchestrator_attempts').all())) {
    const parsed = Stored98AttemptSchema.safeParse(parseJsonObjectText(row.attempt_json));
    if (!parsed.success) throw new Error(`Orchestrator attempt ${row.child_run_id} has an unreadable stored state: ${parsed.error.message}`);
    const { work } = parsed.data;
    updateAttempt.run(JSON.stringify({ ...parsed.data, work: { ...work, task: withWhy(work.task) } }), row.child_run_id);
  }
}
````

Modify `src/state/runtime-db.ts`:

````diff
@@ -33,6 +33,7 @@ import { upgradeExl3RamDiskBundledTool } from './schema-upgrades/exl3-ram-disk-b
 import { upgradeOrchestratorSearchReports } from './schema-upgrades/orchestrator-search-reports.ts';
 import { upgradeOrchestratorSingleWorker } from './schema-upgrades/orchestrator-single-worker.ts';
 import { upgradeOrchestratorOpenEndedRuns } from './schema-upgrades/orchestrator-open-ended-runs.ts';
+import { upgradeOrchestratorTaskPurpose } from './schema-upgrades/orchestrator-task-purpose.ts';
 import { upgradeVaultCutoverJobs } from './schema-upgrades/vault-cutover-jobs.ts';
 import { upgradeVaultValidation } from './schema-upgrades/vault-validation.ts';
 import type { RuntimeDatabase } from './database-handle.ts';
@@ -45,7 +46,7 @@ const PageCountRowSchema = z.object({ page_count: z.number().nullable() });
 const ObjectCountRowSchema = z.object({ object_count: z.number() });
 const RuntimeSchemaTableRowSchema = z.object({ type: z.literal('table') });
 
-export const CURRENT_SCHEMA_VERSION = 98;
+export const CURRENT_SCHEMA_VERSION = 99;
 const RUNTIME_DATABASE_FILE = 'runtime.sqlite';
 
 type SchemaUpgradeStep = { from: number; apply(database: RuntimeDatabase): void };
@@ -88,6 +89,7 @@ const SCHEMA_UPGRADES: readonly SchemaUpgradeStep[] = [
   { from: 95, apply: upgradeEngineEventDiskCacheFull },
   { from: 96, apply: upgradeExl3RamDiskBundledTool },
   { from: 97, apply: upgradeOrchestratorOpenEndedRuns },
+  { from: 98, apply: upgradeOrchestratorTaskPurpose },
 ];
 
 function findUpgradeChain(fromVersion: number): SchemaUpgradeStep[] | null {
````

- [ ] **Step 4: Run the tests and the checks**

Run: `node .\src\test-runner\run-tests.ts contracts-orchestrator orchestrator repo-search-orchestrator-tools runtime-db-schema`
Run: `node .\src\test-runner\run-tests.ts --process orchestrator-run.e2e`
Run: `npx vitest run --config .\dashboard\vitest.config.ts chat-tab orchestrator`
Expected: every test passes.

Run: `npx tsc -p tsconfig.test.json`, `npx tsc -p dashboard/tsconfig.json`, `npx tsc -p dashboard/tsconfig.test.json`, then `npx eslint tests/contracts-orchestrator.test.ts tests/orchestrator-run-store.test.ts tests/orchestrator-runs.test.ts tests/orchestrator-prompts.test.ts tests/repo-search-orchestrator-tools.test.ts tests/runtime-db-schema-orchestrator-task-purpose.test.ts tests/runtime-db-schema-orchestrator-attempt-results.test.ts tests/runtime-db-schema-orchestrator-check-digests.test.ts tests/runtime-db-schema-orchestrator-search-reports.test.ts tests/runtime-db-schema-orchestrator-single-worker.test.ts tests/helpers/orchestrator-plan.ts tests/process/orchestrator-run.e2e.test.ts tests/process/chat-overflow.test.ts dashboard/tests/orchestrator-fixture.ts dashboard/tests/chat-tab.test.tsx dashboard/tests/orchestrator-run-panel.test.tsx dashboard/tests/orchestrator-view.test.ts packages/contracts/src/orchestrator.ts src/orchestrator/plan.ts src/orchestrator/prompts.ts src/orchestrator/run-store.ts src/orchestrator/run.ts src/repo-search/planner-protocol.ts src/state/schema-upgrades/orchestrator-task-purpose.ts src/state/runtime-db.ts`
Expected: all exit 0 with no output.

**Acceptance:** the tests of this task pass, type-check and lint are clean, and no file outside the list above changed.

### Task 3: The two-pane panel

`OrchestratorConversation` shows 3 turns and 3 calls per turn, keeps the other turns in a box of their own, and pins the run-wide line at the bottom. `OrchestratorTaskRow` shows `why` and the activity kind, and names the worker preset in the agent line.

The panel leaves `content-visibility: auto`, which is the main suspect for the repaint glitch. That is not claimed as a fix.

**Files:**
- `dashboard/tests/orchestrator-run-panel.test.tsx`
- `dashboard/tests/orchestrator-view.test.ts`
- `dashboard/tests/orchestrator-layout-content.ts`
- `dashboard/tests/orchestrator-layout-page.tsx`
- `tests/process/orchestrator-layout.test.ts`
- `dashboard/src/hooks/usePaneFollow.ts`
- `dashboard/src/orchestrator-view.ts`
- `dashboard/src/components/OrchestratorRunLine.tsx`
- `dashboard/src/components/OrchestratorConversation.tsx`
- `dashboard/src/components/OrchestratorTaskRow.tsx`
- `dashboard/src/components/OrchestratorRunPanel.tsx`
- `dashboard/src/tabs/ChatTab.tsx`
- `dashboard/src/styles/orchestrator.css`
- `dashboard/src/styles/chat.css`

- [ ] **Step 1: Write the tests**

Modify `dashboard/tests/orchestrator-run-panel.test.tsx`:

````diff
@@ -121,7 +121,7 @@ const PARENT: OrchestratorParentActivity = {
 
 test('the orchestrator view shows its prompt, its latest thinking, and every tool call with its result', () => {
   renderPanel(runState({}), { ...liveActivity([LIVE_CHILD]), parent: PARENT });
-  const view = screen.getByLabelText('Orchestrator conversation');
+  const view = screen.getByRole('region', { name: 'Orchestrator' });
   assert.ok(view.textContent?.includes('released its model while children work'));
   screen.getByText('context 52,000 / 200,000 (26%)');
   screen.getByText('turn 14');
@@ -172,14 +172,19 @@ test('an orchestrator check approval names the command and its working directory
 test('a running task opens its agent card with turn, context, recent tool calls, write scope, and a transcript link', () => {
   renderPanel(runState({ attempts: [attempt('implementation', 1, null)] }), liveActivity([LIVE_CHILD]));
   screen.getByLabelText(`Agent ${CHILD_ID}`);
-  screen.getByText('command npm test');
+  screen.getByText('command · turn 9');
+  const calls = screen.getByText('Latest calls (2)').closest('details');
+  assert.ok(calls instanceof window.HTMLDetailsElement);
+  assert.equal(calls.open, false, 'the rows are folded');
   screen.getByText('write src/a.ts');
   screen.getByText('31%');
   screen.getByText('src/a.ts', { selector: 'code' });
   const transcript = screen.getByRole('link', { name: 'Transcript' });
   assert.ok(transcript instanceof window.HTMLAnchorElement);
   assert.equal(transcript.getAttribute('href'), `?tab=runs&run=${CHILD_ID}`);
-  screen.getByText(`${TASK.id} · repo-agent`);
+  screen.getByText('Greet people the same way everywhere.');
+  assert.match(screen.getByLabelText(`Agent ${CHILD_ID}`).textContent ?? '', /^repo-agent 00000000/u);
+  assert.equal(screen.queryByText(new RegExp(TASK.id, 'u')), null, 'the row names the task, not its id');
 });
 
 test('a pending task says which dependencies it waits for, and the panel shows no slot meter', () => {
@@ -242,3 +247,81 @@ test('the panel shows the budget used, the active approach, what earlier approac
   assert.match(screen.getByRole('list', { name: 'Retired tasks' }).textContent ?? '',
     /cache\s+Cache responses · approach 1 · failed: Out of attempts\./u);
 });
+
+test('a task saved without a reason shows its title alone', () => {
+  renderPanel(runState({ plan: { goal: 'Greet', constraints: [], tasks: [{ ...TASK, why: null }], finalVerification: [CHECK] } }));
+  assert.equal(screen.getByText('Add greeting').closest('.orch-task-name')?.textContent, 'Add greeting');
+});
+
+function statusLines(count: number): OrchestratorRunState['statusLines'] {
+  return Array.from({ length: count }, (_, index) => ({ text: `Line ${index + 1}.`, atUtc: AT }));
+}
+
+function shownLines(): string[] {
+  return [...screen.getByRole('region', { name: 'Where the run is' }).querySelectorAll('p')].map((line) => line.textContent ?? '');
+}
+
+test('the run-wide bar shows the goal, then the current line with at most three past ones above it', () => {
+  const view = (count: number) => (
+    <OrchestratorRunPanel state={runState({ statusLines: statusLines(count) })} activity={null} workPhase={null} lastMessage={null}
+      onDecide={() => undefined} onAbort={() => undefined} />
+  );
+  const { rerender } = render(view(0));
+  assert.deepEqual(shownLines(), ['Greet']);
+  rerender(view(1));
+  assert.deepEqual(shownLines(), ['Line 1.']);
+  rerender(view(4));
+  assert.deepEqual(shownLines(), ['Line 1.', 'Line 2.', 'Line 3.', 'Line 4.']);
+  assert.equal(screen.queryByRole('button', { name: /updates/u }), null, 'nothing is hidden');
+  rerender(view(100));
+  assert.deepEqual(shownLines(), ['Line 97.', 'Line 98.', 'Line 99.', 'Line 100.']);
+  fireEvent.click(screen.getByRole('button', { name: 'Show all 100 updates' }));
+  assert.equal(shownLines().length, 100);
+  rerender(view(99));
+  assert.equal(shownLines().length, 99, 'a new frame leaves it expanded');
+  fireEvent.click(screen.getByRole('button', { name: 'Show fewer' }));
+  assert.deepEqual(shownLines(), ['Line 96.', 'Line 97.', 'Line 98.', 'Line 99.']);
+});
+
+test('a run with no plan and no line has no run-wide bar', () => {
+  renderPanel(runState({ plan: null, planPath: null, planHash: null, tasks: [] }));
+  assert.equal(screen.queryByRole('region', { name: 'Where the run is' }), null);
+});
+
+function parentTurn(turn: number, calls: number): OrchestratorParentActivity['turns'][number] {
+  return { turn, thinking: `Thinking ${turn}.`, text: '',
+    tools: Array.from({ length: calls }, (_, index) => ({ toolCallId: `c${turn}-${index}`, command: `call ${turn}.${index}`, status: 'succeeded' as const, output: '' })) };
+}
+
+test('the conversation shows three turns and three calls each, folds the rest, and links to the whole transcript', () => {
+  const turns = Array.from({ length: 12 }, (_, index) => parentTurn(index + 21, index === 11 ? 5 : 1));
+  renderPanel(runState({ parentRunIds: [CHILD_ID] }), { ...liveActivity([]), parent: { ...PARENT, turnCount: 32, turns } });
+  const pane = screen.getByRole('region', { name: 'Orchestrator' });
+  assert.deepEqual([...pane.querySelectorAll('.orch-parent-turn-head')].map((head) => head.textContent), ['turn 30', 'turn 31', 'turn 32']);
+  assert.deepEqual([...pane.querySelectorAll('details')].filter((fold) => fold.open), [], 'every fold starts closed, the newest thinking too');
+  const older = screen.getByText('Earlier turns (9)').closest('details');
+  assert.deepEqual([...older?.querySelectorAll('.orch-older-turn > summary') ?? []].map((turn) => turn.textContent).slice(0, 2),
+    ['turn 21 · 1 call', 'turn 22 · 1 call']);
+  assert.deepEqual([...screen.getByText('2 earlier calls').closest('details')?.querySelectorAll('.orch-tool-command') ?? []].map((call) => call.textContent),
+    ['call 32.0', 'call 32.1']);
+  const transcript = screen.getByRole('link', { name: 'Full transcript (20 older turns)' });
+  assert.equal(transcript.getAttribute('href'), `?tab=runs&run=${CHILD_ID}`);
+});
+
+test('a fold the user opened stays open when the next turn arrives', () => {
+  const view = (last: number) => (
+    <OrchestratorRunPanel state={runState({})} activity={{ ...liveActivity([LIVE_CHILD]), parent: { ...PARENT, turnCount: last,
+      turns: Array.from({ length: 12 }, (_, index) => parentTurn(last - 11 + index, 1)) } }}
+    workPhase={null} lastMessage={null} onDecide={() => undefined} onAbort={() => undefined} />
+  );
+  const isOpen = (summary: string): boolean => {
+    const fold = screen.getByText(summary).closest('details');
+    assert.ok(fold instanceof window.HTMLDetailsElement);
+    return fold.open;
+  };
+  const { rerender } = render(view(12));
+  fireEvent.click(screen.getByText('Earlier turns (9)'));
+  fireEvent.click(screen.getByText('Latest calls (2)'));
+  rerender(view(13));
+  assert.deepEqual([isOpen('Earlier turns (9)'), isOpen('Latest calls (2)')], [true, true]);
+});
````

Modify `dashboard/tests/orchestrator-view.test.ts`:

````diff
@@ -21,6 +21,8 @@ import {
   orchestratorSteps,
   phaseTone,
   runElapsedMs,
+  runLine,
+  taskCounts,
   taskTone,
   waitReason,
 } from '../src/orchestrator-view.ts';
@@ -99,7 +101,7 @@ test('attempt summary counts each purpose against the attempt limit', () => {
 test('now doing prefers the running tool, then the model wait, then the turn, then the task status', () => {
   const running = runState({ write: 'running' });
   const tool = { toolCallId: 't1', turn: 3, activityKind: 'command', command: 'npm test', status: 'running' } as const;
-  assert.equal(nowDoing(taskOf(running, 'write'), { ...CHILD, tools: [tool] }), 'command npm test');
+  assert.equal(nowDoing(taskOf(running, 'write'), { ...CHILD, tools: [tool] }), 'command · turn 3');
   assert.equal(nowDoing(taskOf(running, 'write'), { ...CHILD, waitingForModel: true }), 'waiting for model');
   assert.equal(nowDoing(taskOf(running, 'write'), CHILD), 'thinking · turn 3');
   assert.equal(nowDoing(taskOf(running, 'write'), { ...CHILD, turn: 0 }), 'starting');
@@ -139,3 +141,18 @@ test('budget summary, active approach, and ended approaches read from the run st
     { number: 2, title: 'Cache the index', outcome: 'kept', lesson: 'Works; needs eviction.' },
   ]);
 });
+
+test('the run line is the latest dispatch, with the earlier ones before it, or the goal until there is one', () => {
+  const line = (text: string) => ({ text, atUtc: AT });
+  assert.deepEqual(runLine(runState({}, { plan: null })), { current: null, past: [] });
+  assert.deepEqual(runLine(runState({})), { current: { text: 'Go', atUtc: null }, past: [] });
+  assert.deepEqual(runLine(runState({}, { statusLines: [line('One.')] })), { current: line('One.'), past: [] });
+  assert.deepEqual(runLine(runState({}, { statusLines: [line('One.'), line('Two.'), line('Three.')] })),
+    { current: line('Three.'), past: [line('One.'), line('Two.')] });
+});
+
+test('task counts name only the kinds that have a task', () => {
+  assert.equal(taskCounts(runState({}).tasks), '4 waiting');
+  assert.equal(taskCounts(runState({ read: 'completed', write: 'reviewing', 'write-2': 'failed' }).tasks), '1 done · 1 running · 1 waiting · 1 failed');
+  assert.equal(taskCounts([]), '');
+});
````

Create `dashboard/tests/orchestrator-layout-content.ts`:

````ts
import { z } from 'zod';

export const PaneBoxSchema = z.object({ height: z.number(), scrollHeight: z.number(), scrollTop: z.number() });
export const LayoutReportSchema = z.object({
  wide: z.object({ sideBySide: z.boolean(), conversation: PaneBoxSchema, tasks: PaneBoxSchema, runLineVisible: z.boolean(), panelFillsColumn: z.boolean() }),
  grown: z.object({ conversation: PaneBoxSchema, runLineVisible: z.boolean() }),
  scrolledAway: z.object({ conversationTop: z.number(), tasksMoved: z.boolean() }),
  expanded: z.object({ runLineVisible: z.boolean(), listHeight: z.number(), listAtEnd: z.boolean() }),
  narrow: z.object({ stacked: z.boolean() }),
});
export type LayoutReport = z.infer<typeof LayoutReportSchema>;
````

Create `dashboard/tests/orchestrator-layout-page.tsx`:

````tsx
// Loaded by the browser test: renders the panel at several sizes and reports where its panes are.
import React from 'react';
import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';

import type { OrchestratorActivity, OrchestratorRunState } from '@siftkit/contracts';

import '../src/styles/global.css';
import '../src/styles/chat.css';
import '../src/styles/orchestrator.css';
import { OrchestratorRunPanel } from '../src/components/OrchestratorRunPanel.tsx';
import { orchestratorRunState, orchestratorTaskState } from './orchestrator-fixture.ts';
import type { LayoutReport } from './orchestrator-layout-content.ts';

const AT = '2026-09-23T12:00:00.000Z';
const CHECK = { kind: 'command', command: 'npm test', cwd: '.', expectedExitCode: 0 } as const;
const IDS = Array.from({ length: 30 }, (_, index) => `task-${index}`);
const LONG = 'Five of thirteen areas are done. The web server is being checked now, because everything else talks through it. '.repeat(2).trim();

const STATE: OrchestratorRunState = orchestratorRunState({
  planPath: 'plan.md', planHash: 'h', parentRunIds: ['00000000-0000-4000-8000-000000000009'],
  plan: { goal: 'Audit', constraints: [], finalVerification: [CHECK], tasks: IDS.map((id) => ({ id, title: `Title of ${id}`, why: 'Make sure it is safe.', dependsOn: [],
    workerPresetId: 'repo-agent', readPaths: [], writePaths: ['a.md'], steps: [{ instruction: 'x', expectedResult: 'y' }], verification: [CHECK], acceptance: ['z'], temporaryPaths: [] })) },
  tasks: IDS.map((id, index) => orchestratorTaskState(id, index < 12 ? 'completed' : index === 12 ? 'running' : 'pending')),
  statusLines: Array.from({ length: 40 }, (_, index) => ({ text: `${index} ${LONG}`.slice(0, 240), atUtc: AT })),
});

function activity(turnCount: number): OrchestratorActivity {
  const first = Math.max(1, turnCount - 11);
  return { runId: STATE.runId, schedule: null, children: [], parent: { waitingForModel: false, parked: false, promptTokens: 1, contextTokens: 2, prompt: null, turnCount,
    turns: Array.from({ length: turnCount - first + 1 }, (_, index) => ({ turn: first + index, thinking: 'x '.repeat(400), text: 'Working. '.repeat(120),
      tools: Array.from({ length: 6 }, (_call, call) => ({ toolCallId: `${first + index}-${call}`, command: `read path="${call}"`, status: 'succeeded' as const, output: 'o' })) })) } };
}

const host = document.createElement('div');
host.className = 'msgs-content';
document.body.append(host);
const root = createRoot(host);

async function show(turnCount: number, widthPx: number): Promise<void> {
  host.style.width = `${widthPx}px`;
  flushSync(() => root.render(<OrchestratorRunPanel state={STATE} activity={activity(turnCount)} workPhase={null} lastMessage={null}
    onDecide={() => undefined} onAbort={() => undefined} />));
  await settle();
}

async function settle(): Promise<void> {
  for (let frame = 0; frame < 3; frame += 1) await new Promise((resolve) => { requestAnimationFrame(resolve); });
}

function find(selector: string): HTMLElement {
  const element = document.querySelector(selector);
  if (!(element instanceof HTMLElement)) throw new Error(`Nothing matches ${selector}.`);
  return element;
}

const pane = (name: string): HTMLElement => find(`.orch-pane[aria-label="${name}"]`);
const box = (element: HTMLElement) => ({ height: element.clientHeight, scrollHeight: element.scrollHeight, scrollTop: element.scrollTop });

function runLineVisible(): boolean {
  const line = find('.orch-now').getBoundingClientRect();
  const frame = pane('Orchestrator').getBoundingClientRect();
  return line.height > 0 && line.top >= frame.top - 1 && line.bottom <= frame.bottom + 1;
}

declare global {
  interface Window { runLayout(): Promise<LayoutReport> }
}

window.runLayout = async (): Promise<LayoutReport> => {
  await show(12, 1300);
  const [left, right] = [pane('Orchestrator').getBoundingClientRect(), pane('Tasks').getBoundingClientRect()];
  const wide = { sideBySide: left.top === right.top && left.right <= right.left + 1, conversation: box(pane('Orchestrator')), tasks: box(pane('Tasks')),
    runLineVisible: runLineVisible(), panelFillsColumn: find('.orchestrator-run').getBoundingClientRect().width === 1300 };
  await show(212, 1300);
  const grown = { conversation: box(pane('Orchestrator')), runLineVisible: runLineVisible() };
  const tasksTop = pane('Tasks').scrollTop;
  pane('Orchestrator').scrollTop = 0;
  await settle();
  await show(213, 1300);
  const scrolledAway = { conversationTop: pane('Orchestrator').scrollTop, tasksMoved: pane('Tasks').scrollTop !== tasksTop };
  find('.orch-now-all').click();
  await settle();
  const list = find('.orch-now-past');
  const expanded = { runLineVisible: runLineVisible(), listHeight: list.clientHeight, listAtEnd: list.scrollHeight - list.clientHeight - list.scrollTop <= 1 };
  await show(213, 600);
  const narrow = { stacked: pane('Tasks').getBoundingClientRect().top >= pane('Orchestrator').getBoundingClientRect().bottom - 1 };
  return { wide, grown, scrolledAway, expanded, narrow };
};
````

Create `tests/process/orchestrator-layout.test.ts`:

````ts
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';

import { HeadlessChrome, bundleBrowserPage, bundleResponse } from '../helpers/browser-page.ts';
import { LayoutReportSchema } from '../../dashboard/tests/orchestrator-layout-content.ts';

function serve(bundles: ReadonlyMap<string, Map<string, string>>): Promise<http.Server> {
  const server = http.createServer((request, response) => {
    const route = bundleResponse(bundles, new URL(request.url ?? '/', 'http://localhost').pathname);
    if (route === null) response.writeHead(404).end();
    else response.writeHead(200, { 'Content-Type': route.contentType }).end(route.body);
  });
  return new Promise((resolve) => { server.listen(0, '127.0.0.1', () => resolve(server)); });
}

test('the panes sit side by side, keep their size, scroll alone, and keep the run-wide bar in view', { timeout: 120_000 }, async () => {
  const server = await serve(new Map([['page', await bundleBrowserPage(path.join('dashboard', 'tests', 'orchestrator-layout-page.tsx'))]]));
  const chrome = await HeadlessChrome.launch();
  try {
    const address = server.address();
    if (address === null || typeof address === 'string') assert.fail('The page server has no TCP port.');
    const page = await chrome.open(`http://127.0.0.1:${String(address.port)}/page/`, 'runLayout');
    const { wide, grown, scrolledAway, expanded, narrow } = await page.evaluate('window.runLayout()', true, LayoutReportSchema);
    assert.deepEqual([wide.sideBySide, wide.panelFillsColumn, wide.runLineVisible], [true, true, true]);
    assert.ok(wide.conversation.scrollHeight > wide.conversation.height, 'the conversation scrolls inside its pane');
    assert.ok(wide.tasks.scrollHeight > wide.tasks.height, 'and so do the tasks');
    assert.ok(wide.tasks.scrollTop > 0, 'the tasks pane follows the running task');
    assert.equal(wide.conversation.scrollTop, wide.conversation.scrollHeight - wide.conversation.height, 'the conversation follows its end');
    assert.equal(grown.conversation.height, wide.conversation.height, '200 more turns leave the pane its size');
    assert.equal(grown.runLineVisible, true);
    assert.deepEqual(scrolledAway, { conversationTop: 0, tasksMoved: false }, 'a pane the user scrolled stays put, and the other does not move');
    assert.equal(expanded.runLineVisible, true);
    assert.ok(expanded.listHeight <= 230, String(expanded.listHeight));
    assert.equal(expanded.listAtEnd, true, 'the expanded list opens at the newest line');
    assert.equal(narrow.stacked, true);
  } finally {
    await chrome.close();
    server.close();
  }
});
````

- [ ] **Step 2: Run them and see them fail**

Run: `npx vitest run --config .\dashboard\vitest.config.ts orchestrator`
Expected: FAIL (no "Earlier turns", no run-wide line, the task id still in the row)

- [ ] **Step 3: Implement**

Create `dashboard/src/hooks/usePaneFollow.ts`:

````ts
import React from 'react';

/** How far from its target a pane may be and still count as following it. */
const FOLLOW_THRESHOLD_PX = 24;

/** Where a following pane sits: at the element `selector` names, under the pane's sticky header, or at its end. */
function followTop(pane: HTMLElement, selector: string | null): number {
  const end = Math.max(0, pane.scrollHeight - pane.clientHeight);
  const target = selector === null ? null : pane.querySelector(selector);
  if (target === null) return selector === null ? end : pane.scrollTop;
  const header = pane.firstElementChild?.getBoundingClientRect().height ?? 0;
  return Math.max(0, Math.min(end, pane.scrollTop + target.getBoundingClientRect().top - pane.getBoundingClientRect().top - header));
}

/** Keeps a scrolling pane on its newest content until the user scrolls away or opens something in it; scrolling back resumes. */
export function usePaneFollow(selector: string | null) {
  const paneRef = React.useRef<HTMLElement>(null);
  const followingRef = React.useRef(true);
  React.useLayoutEffect(() => {
    const pane = paneRef.current;
    if (pane !== null && followingRef.current) pane.scrollTop = followTop(pane, selector);
  });
  return {
    paneRef,
    onScroll: (event: React.UIEvent<HTMLElement>) => {
      const pane = event.currentTarget;
      followingRef.current = Math.abs(pane.scrollTop - followTop(pane, selector)) <= FOLLOW_THRESHOLD_PX;
    },
    onClick: (event: React.MouseEvent<HTMLElement>) => {
      if (event.target instanceof Element && event.target.closest('summary') !== null) followingRef.current = false;
    },
  };
}
````

Modify `dashboard/src/orchestrator-view.ts`:

````diff
@@ -8,6 +8,7 @@ import {
   type OrchestratorChildPurpose,
   type OrchestratorPhase,
   type OrchestratorRunState,
+  type OrchestratorStatusLine,
   type OrchestratorTaskClaim,
   type OrchestratorTaskState,
   type OrchestratorTaskStatus,
@@ -71,7 +72,7 @@ export function nowDoing(task: OrchestratorTaskState, child: OrchestratorChildAc
   if (child === null) return STATUS_ACTIVITY[task.status];
   if (child.waitingForModel) return 'waiting for model';
   const running = child.tools.filter((tool) => tool.status === 'running').at(-1);
-  if (running !== undefined) return `${running.activityKind} ${running.command}`;
+  if (running !== undefined) return `${running.activityKind} · turn ${running.turn}`;
   return child.turn === 0 ? 'starting' : `thinking · turn ${child.turn}`;
 }
 
@@ -117,6 +118,27 @@ export function endedApproaches(state: OrchestratorRunState): EndedApproach[] {
   }]));
 }
 
+export type RunLine = { text: string; atUtc: string | null };
+
+/** The run's current line and the ones before it, oldest first. Until the first dispatch the plan's goal stands in. */
+export function runLine(state: OrchestratorRunState): { current: RunLine | null; past: readonly OrchestratorStatusLine[] } {
+  const current = state.statusLines.at(-1);
+  if (current !== undefined) return { current, past: state.statusLines.slice(0, -1) };
+  return { current: state.plan === null ? null : { text: state.plan.goal, atUtc: null }, past: [] };
+}
+
+/** e.g. "14:02", in the viewer's time zone. */
+export function formatClock(atUtc: string): string {
+  return new Date(atUtc).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
+}
+
+/** e.g. "5 done · 1 running · 7 waiting"; a kind with no task is left out. */
+export function taskCounts(tasks: readonly OrchestratorTaskState[]): string {
+  const count = (statuses: readonly OrchestratorTaskStatus[]): number => tasks.filter((task) => statuses.includes(task.status)).length;
+  return ([['done', count(['completed'])], ['running', count(['running', 'reviewing'])], ['waiting', count(['pending'])],
+    ['failed', count(['failed', 'aborted'])]] as const).flatMap(([label, total]) => (total === 0 ? [] : [`${total} ${label}`])).join(' · ');
+}
+
 export function taskTone(status: OrchestratorTaskStatus): StatusTone {
   return TASK_TONES[status];
 }
````

Create `dashboard/src/components/OrchestratorRunLine.tsx`:

````tsx
import React from 'react';

import type { OrchestratorRunState } from '@siftkit/contracts';

import { usePaneFollow } from '../hooks/usePaneFollow.ts';
import { formatClock, runLine } from '../orchestrator-view.ts';

/** Past lines shown while folded; CSS fades them with age. */
const PAST_SHOWN = 3;

/** Where the whole run is, in the orchestrator's words: the current line, with the past ones above it. */
export function OrchestratorRunLine({ state }: { state: OrchestratorRunState }) {
  const { current, past } = runLine(state);
  const [expanded, setExpanded] = React.useState(false);
  const [cut, setCut] = React.useState(false);
  const { paneRef, onScroll } = usePaneFollow(null);
  const listRef = React.useRef<HTMLOListElement>(null);
  React.useLayoutEffect(() => {
    const lines = [...listRef.current?.querySelectorAll('p') ?? []];
    if (!expanded) setCut(lines.some((line) => line.scrollWidth > line.clientWidth));
  });
  if (current === null) return null;
  const shown = expanded ? past : past.slice(-PAST_SHOWN);
  return (
    <section className="orch-now" aria-label="Where the run is">
      {past.length > PAST_SHOWN || cut || expanded ? (
        <button type="button" className="orch-now-all" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>
          {expanded ? 'Show fewer' : `Show all ${past.length + 1} updates`}
        </button>
      ) : null}
      {past.length === 0 ? null : (
        <div className={expanded ? 'orch-now-past all' : 'orch-now-past'} ref={(element) => { paneRef.current = element; }} onScroll={onScroll}
          {...(expanded ? { tabIndex: 0, role: 'region', 'aria-label': 'All updates' } : {})}>
          <ol ref={listRef}>
            {shown.map((line, index) => (
              <li key={`${past.length - shown.length + index}`}><p title={line.text}>{line.text}</p><time>{formatClock(line.atUtc)}</time></li>
            ))}
          </ol>
        </div>
      )}
      <div className="orch-now-current">
        <p>{current.text}</p>
        {current.atUtc === null ? null : <time>{formatClock(current.atUtc)}</time>}
      </div>
    </section>
  );
}
````

Modify `dashboard/src/components/OrchestratorConversation.tsx`:

````diff
@@ -3,6 +3,11 @@ import React from 'react';
 import type { OrchestratorParentActivity, OrchestratorParentTurn } from '@siftkit/contracts';
 
 import { toLiveContextUsage } from '../lib/contextBar.ts';
+import { runLogsHref } from '../lib/format.ts';
+
+/** Turns shown in full, and tool calls shown in each; the rest fold. */
+const TURNS_SHOWN = 3;
+const CALLS_SHOWN = 3;
 
 function parentStatus(parent: OrchestratorParentActivity, live: boolean): string {
   if (!live) return 'finished';
@@ -11,45 +16,68 @@ function parentStatus(parent: OrchestratorParentActivity, live: boolean): string
   return 'thinking';
 }
 
-function ParentTurn({ turn, latest }: { turn: OrchestratorParentTurn; latest: boolean }) {
+function plural(count: number, noun: string): string {
+  return `${count} ${noun}${count === 1 ? '' : 's'}`;
+}
+
+function ParentCalls({ tools }: { tools: OrchestratorParentTurn['tools'] }) {
+  return tools.map((tool) => (
+    <details key={tool.toolCallId} className={`orch-parent-tool ${tool.status}`}>
+      <summary>
+        {tool.status === 'running' ? <span className="sp" /> : <span className={`dot ${tool.status === 'failed' ? 'bad' : 'ok'}`} />}
+        <span className="orch-tool-command">{tool.command}</span>
+      </summary>
+      {tool.output === '' ? null : <pre>{tool.output}</pre>}
+    </details>
+  ));
+}
+
+function TurnBody({ turn }: { turn: OrchestratorParentTurn }) {
+  const earlier = turn.tools.slice(0, -CALLS_SHOWN);
   return (
-    <li className="orch-parent-turn">
-      <div className="orch-parent-turn-head">turn {turn.turn}</div>
+    <>
       {turn.thinking === '' ? null : (
-        <details className="orch-parent-thinking" open={latest}>
+        <details className="orch-parent-thinking">
           <summary>Thinking</summary>
           <pre>{turn.thinking}</pre>
         </details>
       )}
       {turn.text === '' ? null : <pre className="orch-parent-text">{turn.text}</pre>}
-      {turn.tools.map((tool) => (
-        <details key={tool.toolCallId} className={`orch-parent-tool ${tool.status}`}>
-          <summary>
-            {tool.status === 'running' ? <span className="sp" /> : <span className={`dot ${tool.status === 'failed' ? 'bad' : 'ok'}`} />}
-            <span className="orch-tool-command">{tool.command}</span>
-          </summary>
-          {tool.output === '' ? null : <pre>{tool.output}</pre>}
+      {earlier.length === 0 ? null : (
+        <details className="orch-parent-more">
+          <summary>{plural(earlier.length, 'earlier call')}</summary>
+          <ParentCalls tools={earlier} />
         </details>
-      ))}
-    </li>
+      )}
+      <ParentCalls tools={turn.tools.slice(-CALLS_SHOWN)} />
+    </>
   );
 }
 
-/** The orchestrator's own conversation as it happens: its prompt, then each recent turn's thinking and tool calls. */
-export function OrchestratorConversation({ parent, live }: { parent: OrchestratorParentActivity; live: boolean }) {
-  const latestTurn = parent.turns.at(-1)?.turn ?? null;
-  const hidden = parent.turnCount - parent.turns.length;
+export function OrchestratorConversationHeader({ parent, live }: { parent: OrchestratorParentActivity | null; live: boolean }) {
   return (
-    <section className="orch-parent" aria-label="Orchestrator conversation">
-      <header className="orch-parent-head">
-        {live && !parent.parked ? <span className="sp" /> : <span className="dot idle" />}
-        <span className="orch-title">Orchestrator</span>
-        <span className="hint">{parentStatus(parent, live)}</span>
-        <span className="hint">{parent.turnCount} turns</span>
-        <span className="hint">
-          context {parent.promptTokens.toLocaleString()} / {parent.contextTokens.toLocaleString()} ({Math.round(toLiveContextUsage(parent.promptTokens, parent.contextTokens, true).ratio * 100)}%)
-        </span>
-      </header>
+    <header className="orch-pane-head">
+      {live && parent !== null && !parent.parked ? <span className="sp" /> : <span className="dot idle" />}
+      <span className="orch-title">Orchestrator</span>
+      {parent === null ? null : (
+        <>
+          <span className="hint">{parentStatus(parent, live)}</span>
+          <span className="hint">{plural(parent.turnCount, 'turn')}</span>
+          <span className="hint">
+            context {parent.promptTokens.toLocaleString()} / {parent.contextTokens.toLocaleString()} ({Math.round(toLiveContextUsage(parent.promptTokens, parent.contextTokens, true).ratio * 100)}%)
+          </span>
+        </>
+      )}
+    </header>
+  );
+}
+
+/** The orchestrator's own conversation as it happens: its prompt, its earlier turns folded, and its latest ones. */
+export function OrchestratorConversation({ parent, parentRunId }: { parent: OrchestratorParentActivity; parentRunId: string | null }) {
+  const older = parent.turns.slice(0, -TURNS_SHOWN);
+  const dropped = parent.turnCount - parent.turns.length;
+  return (
+    <div className="orch-parent">
       {parent.prompt === null ? null : (
         <details className="orch-parent-prompt">
           <summary>Prompt</summary>
@@ -59,10 +87,28 @@ export function OrchestratorConversation({ parent, live }: { parent: Orchestrato
           <pre>{parent.prompt.user}</pre>
         </details>
       )}
-      {hidden > 0 ? <p className="hint">{hidden} earlier turns are in the run transcript.</p> : null}
+      {dropped > 0 && parentRunId !== null ? <a className="hint" href={runLogsHref(parentRunId)}>Full transcript ({plural(dropped, 'older turn')})</a> : null}
+      {older.length === 0 ? null : (
+        <details className="orch-parent-older">
+          <summary>Earlier turns ({older.length})</summary>
+          <div className="orch-older-box">
+            {older.map((turn) => (
+              <details key={turn.turn} className="orch-older-turn">
+                <summary>turn {turn.turn} · {plural(turn.tools.length, 'call')}</summary>
+                <TurnBody turn={turn} />
+              </details>
+            ))}
+          </div>
+        </details>
+      )}
       <ol className="orch-parent-turns">
-        {parent.turns.map((turn) => <ParentTurn key={turn.turn} turn={turn} latest={turn.turn === latestTurn} />)}
+        {parent.turns.slice(-TURNS_SHOWN).map((turn) => (
+          <li key={turn.turn} className="orch-parent-turn">
+            <div className="orch-parent-turn-head">turn {turn.turn}</div>
+            <TurnBody turn={turn} />
+          </li>
+        ))}
       </ol>
-    </section>
+    </div>
   );
 }
````

Modify `dashboard/src/components/OrchestratorTaskRow.tsx`:

````diff
@@ -37,10 +37,11 @@ function ReviewSummary({ review }: { review: OrchestratorReviewRecord }) {
   );
 }
 
-function AgentCard({ child, claim, attempt, writePaths, now }: {
+function AgentCard({ child, claim, attempt, workerPresetId, writePaths, now }: {
   child: OrchestratorChildActivity;
   claim: OrchestratorTaskClaim | undefined;
   attempt: OrchestratorAttempt | undefined;
+  workerPresetId: string | undefined;
   writePaths: readonly string[];
   now: number;
 }) {
@@ -48,23 +49,27 @@ function AgentCard({ child, claim, attempt, writePaths, now }: {
   return (
     <div className="orch-agent" aria-label={`Agent ${child.childRunId}`}>
       <div className="orch-agent-head">
-        <span>agent <b>{child.childRunId.slice(0, 8)}</b></span>
+        <span>{workerPresetId ?? 'agent'} <b>{child.childRunId.slice(0, 8)}</b></span>
         <span>turn <b>{child.turn}</b>/{child.maxTurns ?? '?'}</span>
         {claim === undefined ? null : <span>ctx <b>{contextPercent(child, claim)}%</b></span>}
         {attempt === undefined ? null : <span>{formatElapsed(now - Date.parse(attempt.reservedAtUtc))}</span>}
         <a className="mini-btn" href={runLogsHref(child.childRunId)}>Transcript</a>
       </div>
       <div className="orch-turnbar"><i style={{ width: `${turnWidth}%` }} /></div>
-      <div className="orch-agent-tools">
-        {child.tools.length === 0 ? <div className="hint">{child.waitingForModel ? 'Waiting for the model…' : 'No tool calls yet.'}</div> : null}
-        {child.tools.map((tool) => (
-          <div key={tool.toolCallId} className={`tcall-summary orch-tool ${tool.status}`}>
-            {tool.status === 'running' ? <span className="sp" /> : <span className={`dot ${tool.status === 'failed' ? 'bad' : 'ok'}`} />}
-            <span className="orch-tool-kind">{tool.activityKind}</span>
-            <span className="orch-tool-command">{tool.command}</span>
+      {child.tools.length === 0 ? <div className="hint orch-agent-idle">{child.waitingForModel ? 'Waiting for the model…' : 'No tool calls yet.'}</div> : (
+        <details className="orch-agent-calls">
+          <summary>Latest calls ({child.tools.length})</summary>
+          <div className="orch-agent-tools">
+            {child.tools.map((tool) => (
+              <div key={tool.toolCallId} className={`tcall-summary orch-tool ${tool.status}`}>
+                {tool.status === 'running' ? <span className="sp" /> : <span className={`dot ${tool.status === 'failed' ? 'bad' : 'ok'}`} />}
+                <span className="orch-tool-kind">{tool.activityKind}</span>
+                <span className="orch-tool-command">{tool.command}</span>
+              </div>
+            ))}
           </div>
-        ))}
-      </div>
+        </details>
+      )}
       <div className="orch-agent-foot">
         writes <code>{writePaths.join(' · ')}</code>
       </div>
@@ -112,14 +117,14 @@ export function OrchestratorTaskRow({ task, state, activity, now }: {
           {open ? <span className="sp" /> : <span className={`dot ${taskTone(task.status)}`} />}
           <span className="orch-task-name">
             {planned?.title ?? task.taskId}
-            <small>{[task.taskId, planned?.workerPresetId].filter((part) => part !== undefined).join(' · ')}</small>
+            {planned === undefined || planned.why === null ? null : <small>{planned.why}</small>}
           </span>
           <span className="orch-task-doing">{nowDoing(task, child) ?? waitReason(task, state, activity)}</span>
           <span className="orch-task-attempts">{attemptSummary(task.taskId, state.attempts)}</span>
           <span className={`bdg ${taskTone(task.status)}`}>{task.status}</span>
         </summary>
         {child !== null ? (
-          <AgentCard child={child} claim={claim} now={now} writePaths={planned?.writePaths ?? []}
+          <AgentCard child={child} claim={claim} now={now} workerPresetId={planned?.workerPresetId} writePaths={planned?.writePaths ?? []}
             attempt={state.attempts.find((attempt) => attempt.childRunId === child.childRunId)} />
         ) : null}
         {child === null && latest !== undefined ? <AttemptResult attempt={latest} /> : null}
````

Modify `dashboard/src/components/OrchestratorRunPanel.tsx`:

````diff
@@ -9,8 +9,10 @@ import {
   type RepoAgentDecision,
 } from '@siftkit/contracts';
 import { useNow } from '../hooks/useNow.ts';
-import { approachLabel, budgetSummary, endedApproaches, formatElapsed, orchestratorSteps, phaseTone, runElapsedMs } from '../orchestrator-view.ts';
-import { OrchestratorConversation } from './OrchestratorConversation.tsx';
+import { usePaneFollow } from '../hooks/usePaneFollow.ts';
+import { approachLabel, budgetSummary, endedApproaches, formatElapsed, orchestratorSteps, phaseTone, runElapsedMs, taskCounts } from '../orchestrator-view.ts';
+import { OrchestratorConversation, OrchestratorConversationHeader } from './OrchestratorConversation.tsx';
+import { OrchestratorRunLine } from './OrchestratorRunLine.tsx';
 import { OrchestratorTaskRow } from './OrchestratorTaskRow.tsx';
 
 function ApprovalRequest({ pending, onDecide }: { pending: OrchestratorPendingApproval; onDecide(decision: RepoAgentDecision): void }) {
@@ -48,11 +50,14 @@ export function OrchestratorRunPanel({ state, activity, workPhase, lastMessage,
   const completed = state.tasks.filter((task) => task.status === 'completed').length;
   const approach = approachLabel(state);
   const ended = endedApproaches(state);
+  const parent = activity?.parent ?? null;
+  const conversation = usePaneFollow(null);
+  const tasks = usePaneFollow('.orch-task.open');
   return (
     <section className="orchestrator-run" aria-label="Orchestrator run">
       <header className="orch-head">
         {live ? <span className="live-dot" /> : null}
-        <span className="orch-title">Orchestrator</span>
+        <span className="orch-title">Run</span>
         <span className={`bdg ${phaseTone(state.phase)}`}>{state.phase}</span>
         {state.tasks.length > 0 ? <span className="hint">{completed} of {state.tasks.length} tasks complete</span> : null}
         {live ? <button type="button" className="send stop orch-stop" onClick={onAbort}>Stop</button> : null}
@@ -72,26 +77,39 @@ export function OrchestratorRunPanel({ state, activity, workPhase, lastMessage,
           </li>
         ))}
       </ol>
-      <ol className="orch-tasks">
-        {state.tasks.map((task) => <OrchestratorTaskRow key={task.taskId} task={task} state={state} activity={activity} now={now} />)}
-      </ol>
-      {ended.length > 0 ? (
-        <ol className="orch-history" aria-label="Earlier approaches">
-          {ended.map((entry) => (
-            <li key={entry.number}><b>{entry.number}. {entry.title}</b> {entry.outcome}: {entry.lesson}</li>
-          ))}
-        </ol>
-      ) : null}
-      {state.retiredTasks.length > 0 ? (
-        <ul className="orch-history" aria-label="Retired tasks">
-          {state.retiredTasks.map((task) => (
-            <li key={task.taskId}><b>{task.taskId}</b> {task.title} · approach {task.approach} · {task.status}: {task.reason}</li>
-          ))}
-        </ul>
-      ) : null}
-      {activity?.parent ? <OrchestratorConversation parent={activity.parent} live={live} /> : null}
       {state.approval ? <ApprovalRequest key={state.approval.approvalId} pending={state.approval} onDecide={onDecide} /> : null}
       {state.failure ? <div className="err-banner"><span>{state.failure.message}</span></div> : null}
+      <div className="orch-panes">
+        <section className="orch-pane" aria-label="Orchestrator" tabIndex={0}
+          ref={conversation.paneRef} onScroll={conversation.onScroll} onClick={conversation.onClick}>
+          <OrchestratorConversationHeader parent={parent} live={live} />
+          {parent === null ? null : <OrchestratorConversation parent={parent} parentRunId={state.parentRunIds.at(-1) ?? null} />}
+          <OrchestratorRunLine state={state} />
+        </section>
+        <section className="orch-pane" aria-label="Tasks" tabIndex={0} ref={tasks.paneRef} onScroll={tasks.onScroll} onClick={tasks.onClick}>
+          <header className="orch-pane-head">
+            <span className="orch-title">Tasks</span>
+            <span className="hint">{taskCounts(state.tasks)}</span>
+          </header>
+          <ol className="orch-tasks">
+            {state.tasks.map((task) => <OrchestratorTaskRow key={task.taskId} task={task} state={state} activity={activity} now={now} />)}
+          </ol>
+          {ended.length > 0 ? (
+            <ol className="orch-history" aria-label="Earlier approaches">
+              {ended.map((entry) => (
+                <li key={entry.number}><b>{entry.number}. {entry.title}</b> {entry.outcome}: {entry.lesson}</li>
+              ))}
+            </ol>
+          ) : null}
+          {state.retiredTasks.length > 0 ? (
+            <ul className="orch-history" aria-label="Retired tasks">
+              {state.retiredTasks.map((task) => (
+                <li key={task.taskId}><b>{task.taskId}</b> {task.title} · approach {task.approach} · {task.status}: {task.reason}</li>
+              ))}
+            </ul>
+          ) : null}
+        </section>
+      </div>
     </section>
   );
 }
````

Modify `dashboard/src/tabs/ChatTab.tsx`:

````diff
@@ -497,6 +497,7 @@ export function ChatTab({
                 retainedIds={retainedIds} {...transcriptRows} />
               {chatMode === 'orchestrator' && orchestrator.state ? (
                 <OrchestratorRunPanel
+                  key={orchestrator.state.runId}
                   state={orchestrator.state}
                   activity={orchestrator.activity}
                   workPhase={orchestrator.workPhase}
````

Modify `dashboard/src/styles/orchestrator.css`:

````diff
@@ -1,5 +1,5 @@
 /* ---- orchestrator agent board; state markers stay static, see chat.css ---- */
-.orchestrator-run { border: 1px solid var(--line); border-radius: 10px; background: var(--panel); max-width: 900px; overflow: hidden; }
+.orchestrator-run { border: 1px solid var(--line); border-radius: 10px; background: var(--panel); overflow: hidden; container-type: inline-size; }
 .orch-head { display: flex; align-items: center; gap: 10px; padding: 9px 12px; border-bottom: 1px solid var(--line); }
 .orch-title { font-weight: 600; }
 .orch-stop { margin-left: auto; padding: 4px 11px; }
@@ -21,14 +21,25 @@
 .orch-phase.failed i { background: var(--ch-red); }
 
 
-.orch-tasks { list-style: none; margin: 0; padding: 0; border-top: 1px solid var(--line); }
+.orch-panes { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1.15fr); border-top: 1px solid var(--line); }
+.orch-pane { display: flex; flex-direction: column; min-width: 0; height: clamp(360px, 68vh, 900px); overflow-y: auto; overscroll-behavior: contain; scrollbar-width: thin; scrollbar-color: var(--idle) transparent; }
+.orch-pane > * { flex: none; }
+.orch-pane + .orch-pane { border-left: 1px solid var(--line); }
+.orch-pane-head { position: sticky; top: 0; z-index: 1; display: flex; flex-wrap: wrap; align-items: center; gap: 4px 10px; padding: 8px 12px; border-bottom: 1px solid var(--line); background: var(--panel); }
+@container (max-width: 639px) {
+  .orch-panes { grid-template-columns: minmax(0, 1fr); }
+  .orch-pane { height: auto; max-height: 520px; }
+  .orch-pane + .orch-pane { border-left: none; border-top: 1px solid var(--line); }
+}
+
+.orch-tasks { list-style: none; margin: 0; padding: 0; }
 .orch-task { border-bottom: 1px solid var(--line); }
 .orch-task:last-child { border-bottom: none; }
 .orch-task.open { background: var(--row-live); box-shadow: inset 2px 0 0 var(--acc); }
 .orch-task-summary { list-style: none; display: grid; grid-template-columns: 14px minmax(0, 1fr) auto auto auto; gap: 10px; align-items: center; padding: 8px 12px; cursor: pointer; }
 .orch-task-summary::-webkit-details-marker { display: none; }
 .orch-task-summary:hover { background: var(--row-hover); }
-.orch-task-name small { display: block; color: var(--dim); font-size: 0.66rem; font-family: ui-monospace, "Cascadia Code", Consolas, monospace; }
+.orch-task-name small { display: block; color: var(--dim); font-size: 0.74rem; line-height: 1.4; }
 .orch-task-doing { font-family: ui-monospace, "Cascadia Code", Consolas, monospace; font-size: 0.68rem; color: var(--ink); max-width: 260px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
 .orch-task-attempts { font-family: ui-monospace, "Cascadia Code", Consolas, monospace; font-size: 0.66rem; color: var(--dim); }
 
@@ -38,7 +49,9 @@
 .orch-agent-head .mini-btn { margin-left: auto; }
 .orch-turnbar { height: 3px; background: var(--track); }
 .orch-turnbar i { display: block; height: 100%; background: var(--acc); }
-.orch-agent-tools { padding: 6px 5px; display: grid; gap: 2px; }
+.orch-agent-idle, .orch-agent-calls { padding: 6px 10px; font-size: 0.72rem; }
+.orch-agent-calls > summary { cursor: pointer; color: var(--dim); }
+.orch-agent-tools { padding: 6px 0 0; display: grid; gap: 2px; }
 .orch-tool .orch-tool-kind { color: var(--sky-ink); min-width: 54px; }
 .orch-tool .orch-tool-command { color: var(--code-ink); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; }
 .orch-tool.running { color: var(--ink); background: var(--row-running); border-radius: 5px; }
@@ -55,16 +68,34 @@
 .orch-review .ok { color: var(--ok); }
 .orch-review .bad { color: var(--bad); }
 .orch-review .orchestrator-findings { margin: 4px 0 0; }
-.orch-parent { border-top: 1px solid var(--line); padding: 10px 12px; display: grid; gap: 8px; }
-.orch-parent-head { display: flex; align-items: center; gap: 10px; }
+.orch-parent { padding: 10px 12px; display: grid; gap: 8px; }
+.orch-parent summary { cursor: pointer; }
+.orch-parent-more > summary, .orch-parent-older > summary { font-size: 0.74rem; color: var(--dim); }
+.orch-older-box { max-height: 200px; overflow-y: auto; scrollbar-width: thin; margin-top: 5px; padding: 5px 10px; border-left: 2px solid var(--line); display: grid; gap: 3px; }
+.orch-older-turn { font-size: 0.74rem; }
 .orch-parent pre { margin: 4px 0 0; max-height: 320px; overflow: auto; white-space: pre-wrap; font-family: ui-monospace, "Cascadia Code", Consolas, monospace; font-size: 0.68rem; }
 .orch-parent-prompt h4 { margin: 8px 0 0; font-size: 0.7rem; color: var(--dim); }
 .orch-parent-turns { list-style: none; margin: 0; padding: 0; display: grid; gap: 8px; }
 .orch-parent-turn { display: grid; gap: 4px; }
 .orch-parent-turn-head { font-size: 0.68rem; color: var(--dim); }
-.orch-parent-tool summary { display: flex; align-items: center; gap: 6px; font-size: 0.72rem; }
+.orch-parent-tool summary { display: flex; align-items: center; gap: 6px; min-width: 0; font-size: 0.72rem; }
+.orch-parent-tool .orch-tool-command { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
 .orch-parent-tool.failed summary { color: var(--bad); }
 .orch-history { list-style: none; margin: 0; padding: 6px 12px; font-size: 0.68rem; color: var(--dim); border-bottom: 1px solid var(--line); }
 .orch-history b { color: var(--ink); font-weight: 500; }
 .orch-budget { display: inline-flex; align-items: center; gap: 4px; font-size: 0.68rem; color: var(--dim); }
 .orch-budget input { width: 5.5em; }
+
+/* Where the whole run is, pinned under the conversation. Past lines fade with age and never push it past four. */
+.orch-now { position: sticky; bottom: 0; margin-top: auto; padding: 8px 12px 10px; border-top: 1px solid #234a44; background: #0f1f1e; }
+.orch-now p { margin: 0; overflow-wrap: anywhere; }
+.orch-now time { font: 0.64rem ui-monospace, "Cascadia Code", Consolas, monospace; color: var(--dim); }
+.orch-now li, .orch-now-current { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 11px; align-items: baseline; }
+.orch-now-current p { font-size: 0.84rem; color: #d3efe8; }
+.orch-now-past ol { list-style: none; margin: 0 0 6px; padding: 0; display: grid; gap: 4px; font-size: 0.78rem; }
+.orch-now-past:not(.all) p { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
+.orch-now-past:not(.all) li:nth-last-child(1) { opacity: 0.75; }
+.orch-now-past:not(.all) li:nth-last-child(2) { opacity: 0.55; }
+.orch-now-past:not(.all) li:nth-last-child(3) { opacity: 0.4; }
+.orch-now-past.all { max-height: 230px; overflow-y: auto; overscroll-behavior: contain; scrollbar-width: thin; }
+.orch-now-all { border: none; background: none; padding: 0 0 4px; color: var(--acc); font: inherit; font-size: 0.7rem; cursor: pointer; }
````

Modify `dashboard/src/styles/chat.css`:

````diff
@@ -23,6 +23,8 @@
 .msgs-content > * + *, .msgs-chunk > * + * { margin-top: 10px; }
 /* Off-screen boxes skip layout, paint and compositing; history is chunked so that work follows chunks, not rows. */
 .msgs-content > * { content-visibility: auto; contain-intrinsic-block-size: auto var(--row-estimate); }
+/* Its panes bound it, and it repaints many times a second while it is on screen. */
+.msgs-content > .orchestrator-run { content-visibility: visible; }
 /* --chunk-rows comes from ChatTab's chunk size; until a chunk has rendered once, this is its height. */
 .msgs-chunk { contain-intrinsic-block-size: auto calc(var(--row-estimate) * var(--chunk-rows)); }
 .jump-to-bottom {
````

- [ ] **Step 4: Run the tests and the checks**

Run: `npx vitest run --config .\dashboard\vitest.config.ts orchestrator chat-tab`
Run: `node .\src\test-runner\run-tests.ts --process orchestrator-layout chat-overflow`
Expected: every test passes.

Run: `npx tsc -p tsconfig.test.json`, `npx tsc -p dashboard/tsconfig.json`, `npx tsc -p dashboard/tsconfig.test.json`, then `npx eslint dashboard/tests/orchestrator-run-panel.test.tsx dashboard/tests/orchestrator-view.test.ts dashboard/tests/orchestrator-layout-content.ts dashboard/tests/orchestrator-layout-page.tsx tests/process/orchestrator-layout.test.ts dashboard/src/hooks/usePaneFollow.ts dashboard/src/orchestrator-view.ts dashboard/src/components/OrchestratorRunLine.tsx dashboard/src/components/OrchestratorConversation.tsx dashboard/src/components/OrchestratorTaskRow.tsx dashboard/src/components/OrchestratorRunPanel.tsx dashboard/src/tabs/ChatTab.tsx`
Expected: all exit 0 with no output.

- [ ] **Step 5: Look at it**

Run the dashboard against a run with a plan, and compare it with the mockup at 1280 px and at 600 px. Check that the bar stays at the bottom of the orchestrator pane while it is folded and expanded.

**Acceptance:** the tests of this task pass, type-check and lint are clean, and no file outside the list above changed.


## Part 2: status updates

### Task 4: The request, the rules, the scheduler and the gate test

Nothing calls this code yet. The request repeats the executing prompt byte for byte and adds one user message; only `thinkingEnabled` may differ from it, and only for this stage. `statusUpdates` in `types.ts` is read in Task 6.

Three things are deliberate: a pending timer is cleared when the command ends, so a quick check costs nothing; a cancelled update is not asked again until something makes the next one due; and `settle` never waits longer than a second.

**Files:**
- `tests/status-updates.test.ts`
- `tests/repo-search-planner-protocol.test.ts`
- `tests/live-status-update-gate.test.ts`
- `src/repo-search/types.ts`
- `src/repo-search/engine/progress-reporter.ts`
- `src/status-server/dashboard-runs.ts`
- `src/repo-search/planner-protocol.ts`
- `src/repo-search/engine/status-updates.ts`

- [ ] **Step 1: Write the tests**

Create `tests/status-updates.test.ts`:

````ts
import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';

import { ProgressReporter } from '../src/repo-search/engine/progress-reporter.ts';
import {
  buildStatusUpdateInstruction, parseStatusUpdate, StatusUpdates, type StatusUpdateRequester,
} from '../src/repo-search/engine/status-updates.ts';
import type { PlannerActionResponse } from '../src/repo-search/planner-protocol.ts';
import type { JsonLogger, RepoSearchProgressEvent } from '../src/repo-search/types.ts';
import { JsonObjectSchema, type JsonObject } from '../src/lib/json-types.ts';
import { parseJsonValueText } from '../src/lib/json.ts';
import { emptyInferenceThroughput } from '../src/lib/inference-throughput.ts';
import { completeLiveContent } from '../src/llm-protocol/live-content-classifier.ts';
import { CLEAN_STREAM_STOP, type InferenceToolCall } from '../src/llm-protocol/types.ts';
import { CollectingProgressWriter } from './helpers/collecting-progress-writer.ts';

type Pending = { instruction: string; abortSignal: AbortSignal; resolve(response: PlannerActionResponse): void; reject(error: Error): void };

/** An engine whose answers the test gives by hand. */
class ScriptedEngine implements StatusUpdateRequester {
  readonly requests: Pending[] = [];
  /** A stalled engine does not react to the cancellation. */
  stalled = false;

  requestStatusUpdate(instruction: string, abortSignal: AbortSignal): Promise<PlannerActionResponse> {
    return new Promise((resolve, reject) => {
      this.requests.push({ instruction, abortSignal, resolve, reject });
      if (!this.stalled) abortSignal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    });
  }

  latest(): Pending {
    const pending = this.requests.at(-1);
    assert.ok(pending);
    return pending;
  }
}

function reply(text: string, toolCalls: InferenceToolCall[] = []): PlannerActionResponse {
  return {
    ...completeLiveContent(text, toolCalls.length > 0), thinkingText: '', toolCalls, mockExhausted: false,
    throughput: emptyInferenceThroughput(), stop: CLEAN_STREAM_STOP, promptCacheTokens: 900, promptEvalTokens: 40,
  };
}

function setUp(): { engine: ScriptedEngine; updates: StatusUpdates; shown: RepoSearchProgressEvent[]; log: JsonObject[] } {
  const engine = new ScriptedEngine();
  const progress = new CollectingProgressWriter<RepoSearchProgressEvent>();
  const log: JsonObject[] = [];
  const logger: JsonLogger = { path: 'memory', write(event) { log.push(JsonObjectSchema.parse(parseJsonValueText(JSON.stringify(event)))); } };
  const updates = new StatusUpdates({
    requester: engine, logger,
    progress: new ProgressReporter({ progressWriter: progress, taskId: 'task', maxTurns: 10, taskStartedAt: 0 }),
  });
  return { engine, updates, shown: progress.events, log };
}

function start(updates: StatusUpdates, command = 'npm test'): void {
  updates.toolStarted({ turn: 4, toolName: 'run', activityKind: 'validate', command });
}

function read(updates: StatusUpdates): void {
  updates.toolStarted({ turn: 4, toolName: 'read', activityKind: 'read', command: 'read path="a"' });
  updates.toolFinished();
}

async function flush(): Promise<void> {
  for (let index = 0; index < 10; index += 1) await Promise.resolve();
}

function mockClock(context: TestContext): void {
  context.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
}

test('a check is written about after 3 seconds, once a minute, and never when it ends sooner', async (context) => {
  mockClock(context);
  const { engine, updates, shown, log } = setUp();

  start(updates);
  context.mock.timers.tick(2_999);
  updates.toolFinished();
  context.mock.timers.tick(10_000);
  assert.equal(engine.requests.length, 0);

  // Still due: a plain command is enough to carry the update the check asked for.
  updates.toolStarted({ turn: 5, toolName: 'run', activityKind: 'command', command: 'git status' });
  context.mock.timers.tick(3_000);
  assert.equal(engine.requests.length, 1);
  assert.match(engine.latest().instruction, /^This command is running now: git status\nYour latest steps, oldest first:\n- validate: npm test\n/u);
  engine.latest().resolve(reply('Making sure the fix holds before moving on.'));
  await flush();
  updates.toolFinished();
  assert.equal(shown.length, 1);
  const [event] = shown;
  assert.ok(event && event.kind === 'status_update');
  assert.deepEqual([event.turn, event.text], [5, 'Making sure the fix holds before moving on.']);

  // Requests start at least a minute apart; a window opening sooner waits for the minute.
  start(updates);
  context.mock.timers.tick(56_000);
  assert.equal(engine.requests.length, 1);
  context.mock.timers.tick(4_000);
  assert.equal(engine.requests.length, 2);
  assert.match(engine.latest().instruction, /Your last update was: "Making sure the fix holds before moving on\." Do not repeat it\./u);
  assert.deepEqual(log.map((entry) => [entry.kind, entry.outcome, entry.promptCacheTokens, entry.promptEvalTokens]),
    [['status_update', 'shown', 900, 40]]);
});

test('ten finished calls make an update due, and reads alone never ask for one', (context) => {
  mockClock(context);
  const { engine, updates } = setUp();
  for (let index = 0; index < 9; index += 1) read(updates);
  updates.toolStarted({ turn: 4, toolName: 'run', activityKind: 'command', command: 'node build.js' });
  context.mock.timers.tick(30_000);
  assert.equal(engine.requests.length, 0);
  updates.toolFinished();
  updates.toolStarted({ turn: 4, toolName: 'read', activityKind: 'read', command: 'read path="big"' });
  context.mock.timers.tick(30_000);
  updates.toolFinished();
  assert.equal(engine.requests.length, 0);
  updates.toolStarted({ turn: 4, toolName: 'job', activityKind: 'command', command: 'job action="wait"' });
  context.mock.timers.tick(3_000);
  assert.equal(engine.requests.length, 1);
  // The five newest steps are named, not the running command itself.
  assert.equal(engine.latest().instruction.split('\n').filter((line) => line.startsWith('- ')).length, 5);
});

test('the command ending cancels the request, shows nothing, and asks again only for a later cause', async (context) => {
  mockClock(context);
  const { engine, updates, shown, log } = setUp();
  start(updates);
  context.mock.timers.tick(3_000);
  updates.toolFinished();
  assert.equal(engine.latest().abortSignal.aborted, true);
  await updates.settle();
  assert.equal(shown.length, 0);
  assert.deepEqual(log.map((entry) => entry.outcome), ['cancelled']);
  updates.toolStarted({ turn: 5, toolName: 'run', activityKind: 'command', command: 'node build.js' });
  context.mock.timers.tick(120_000);
  assert.equal(engine.requests.length, 1);
});

test('a stalled engine holds the run up for a second at most, and its late answer is dropped', async () => {
  const { engine, updates, shown, log } = setUp();
  engine.stalled = true;
  start(updates);
  while (engine.requests.length === 0) await new Promise((resolve) => setTimeout(resolve, 100));
  // Nothing more is asked while that request is out.
  updates.toolFinished();
  const startedAt = performance.now();
  await updates.settle();
  const waitedMs = performance.now() - startedAt;
  assert.ok(waitedMs >= 900 && waitedMs < 1_500, `waited ${waitedMs} ms`);
  engine.latest().resolve(reply('Too late.'));
  await updates.settle();
  assert.equal(shown.length, 0);
  assert.deepEqual(log.map((entry) => entry.outcome), ['late']);
});

test('one request is out at a time, however long the engine holds it', (context) => {
  mockClock(context);
  const { engine, updates } = setUp();
  engine.stalled = true;
  start(updates);
  context.mock.timers.tick(3_000);
  updates.toolFinished();
  context.mock.timers.tick(120_000);
  start(updates);
  context.mock.timers.tick(120_000);
  assert.equal(engine.requests.length, 1);
});

test('a failed request, a tool call and a broken rule show nothing', async (context) => {
  mockClock(context);
  const { engine, updates, shown, log } = setUp();
  const answers: Array<PlannerActionResponse | Error> = [
    new Error('engine down'),
    reply('Reading on.', [{ id: 'call_1', type: 'function', function: { name: 'read', arguments: '{}' } }]),
    reply('Editing src/a.ts now.'),
  ];
  for (const answer of answers) {
    start(updates);
    context.mock.timers.tick(60_000);
    if (answer instanceof Error) engine.latest().reject(answer);
    else engine.latest().resolve(answer);
    await flush();
    updates.toolFinished();
  }
  assert.equal(engine.requests.length, 3);
  assert.equal(shown.length, 0);
  assert.deepEqual(log.map((entry) => entry.outcome).slice(0, 2), ['failed: engine down', 'rejected: it called a tool']);
  assert.match(String(log[2]?.outcome), /^rejected: /u);
});

test('a reply is shown only as one short plain paragraph', () => {
  assert.deepEqual(parseStatusUpdate('  Making sure the two\nparts agree. '), { ok: true, text: 'Making sure the two parts agree.' });
  assert.equal(parseStatusUpdate('I will read the rest and run the check again.').ok, true);
  assert.equal(parseStatusUpdate(Array(45).fill('word').join(' ')).ok, true);
  for (const refused of [
    ' \n ', Array(46).fill('word').join(' '), 'One thing.\n\nAnother thing.', 'Checking `total` now.', 'Editing src/a.ts now.', 'Waiting for run_check.',
  ]) assert.equal(parseStatusUpdate(refused).ok, false, refused);
});

test('the instruction leaves out what there is nothing to say about', () => {
  const bare = buildStatusUpdateInstruction({ command: 'npm test', recent: [], previous: null });
  assert.doesNotMatch(bare, /latest steps|last update/u);
  assert.match(bare, /at most 30 words/u);
  assert.match(bare, /Do not call a tool/u);
});
````

Modify `tests/repo-search-planner-protocol.test.ts`:

````diff
@@ -9,7 +9,7 @@ import { JsonObjectSchema, type JsonObject, type JsonSerializable } from '../src
 import type { ModelRuntimePreset, SiftConfig } from '../src/config/types.ts';
 import { DEAD_BASE_URL } from './helpers/dead-endpoints.ts';
 import { asObject, asObjectArray, getAddressInfo } from './helpers/dashboard-http.ts';
-import { buildTabbyUsage, sendChatCompletionSse } from './helpers/streaming-client.ts';
+import { buildTabbyUsage, contentFrame, sendChatCompletionSse } from './helpers/streaming-client.ts';
 import { serverLogger } from '../src/status-server/server-logger.ts';
 import { mockSiftConfig } from './helpers/mock-config.ts';
 import { getSupportedImageExtensions } from '../src/llm-protocol/image-attachments.ts';
@@ -28,6 +28,7 @@ import {
   type PlannerActionResponse,
   type PlannerDerivedRequestOptions,
   type PlannerThinkingFlags,
+  requestStatusUpdate,
 } from '../src/repo-search/planner-protocol.ts';
 import type { ChatMessage } from '../src/repo-search/planner-chat-message.ts';
 import type { JsonLogger } from '../src/repo-search/types.ts';
@@ -722,6 +723,77 @@ test('requestRepoSearchPlannerProtocolAction sends the active preset sampler val
   assert.equal(captured.max_tokens, 2048);
 });
 
+test('a status update repeats the planner request byte for byte and adds only its question', async () => {
+  const flags: PlannerThinkingFlags = { thinkingEnabled: true, reasoningContentEnabled: true, preserveThinking: true };
+  const tools = toProtocolTools(resolveRepoSearchPlannerToolDefinitions(['read']));
+  const messages = serializeProtocolMessages([
+    { role: 'system', content: 'system' },
+    { role: 'user', content: [{ type: 'text', text: 'look' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,AA==' } }] },
+    { role: 'assistant', content: '', reasoning_content: 'think', tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'read', arguments: '{"path":"a"}' } }] },
+    { role: 'tool', content: 'result', tool_call_id: 'call_1' },
+  ], true);
+  const captured = await captureChatRequestBody((baseUrl) => requestStatusUpdate({
+    config: buildTestConfig(), baseUrl, model: 'test-model', throughputAudit: TEST_THROUGHPUT_AUDIT_OPERATION,
+    executing: captureExecutingPlannerRequest(messages, flags, tools, 1_000),
+    instruction: 'Say what you are doing.', abortSignal: new AbortController().signal,
+  }), 'Reading on.');
+  assert.equal(JSON.stringify(captured.messages), JSON.stringify([...messages, { role: 'user', content: 'Say what you are doing.' }]));
+  assert.equal(JSON.stringify(captured.tools), JSON.stringify(tools));
+  assert.deepEqual([captured.tool_choice, captured.max_tokens], ['none', 60]);
+});
+
+test('a status update ends with its command', async () => {
+  const command = new AbortController();
+  await withServer(
+    (_req, _res) => { command.abort(new Error('command over')); },
+    async (baseUrl) => {
+      await assert.rejects(requestStatusUpdate({
+        config: buildTestConfig(), baseUrl, model: 'test-model', throughputAudit: TEST_THROUGHPUT_AUDIT_OPERATION,
+        executing: captureExecutingPlannerRequest(serializeProtocolMessages([{ role: 'user', content: 'q' }], true),
+          { thinkingEnabled: true, reasoningContentEnabled: true, preserveThinking: true }, [], 10),
+        instruction: 'Say.', abortSignal: command.signal,
+      }), /command over/u);
+    },
+  );
+});
+
+test('a status update has five seconds to read its prompt, though its 60 tokens alone would allow three', async () => {
+  let response: PlannerActionResponse | null = null;
+  await withServer(
+    (_req, res) => { setTimeout(() => { sendChatCompletionSse(res, { choices: [{ message: { content: 'Reading on.' } }] }); }, 5_000); },
+    async (baseUrl) => {
+      response = await requestStatusUpdate({
+        config: buildTestConfig(), baseUrl, model: 'test-model', throughputAudit: TEST_THROUGHPUT_AUDIT_OPERATION,
+        executing: captureExecutingPlannerRequest(serializeProtocolMessages([{ role: 'user', content: 'q' }], true),
+          { thinkingEnabled: true, reasoningContentEnabled: true, preserveThinking: true }, [], 10),
+        instruction: 'Say.', abortSignal: new AbortController().signal,
+      });
+    },
+  );
+  assert.partialDeepStrictEqual(response, { text: 'Reading on.' });
+});
+
+test('a status update gives up after ten seconds in total, even while the engine still sends something', async () => {
+  const startedAt = performance.now();
+  await withServer(
+    (_req, res) => {
+      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
+      const trickle = setInterval(() => { res.write(`data: ${contentFrame('.')}\n\n`); }, 1_000);
+      res.on('close', () => { clearInterval(trickle); });
+    },
+    async (baseUrl) => {
+      await assert.rejects(requestStatusUpdate({
+        config: buildTestConfig(), baseUrl, model: 'test-model', throughputAudit: TEST_THROUGHPUT_AUDIT_OPERATION,
+        executing: captureExecutingPlannerRequest(serializeProtocolMessages([{ role: 'user', content: 'q' }], true),
+          { thinkingEnabled: true, reasoningContentEnabled: true, preserveThinking: true }, [], 10),
+        instruction: 'Say.', abortSignal: new AbortController().signal,
+      }));
+    },
+  );
+  const elapsedMs = performance.now() - startedAt;
+  assert.ok(elapsedMs >= 9_500 && elapsedMs < 13_000, `gave up after ${elapsedMs} ms`);
+});
+
 test('derived planner requests reject every cache-contract divergence before logging or HTTP', async () => {
   let requestCount = 0;
   const loggerEvents: JsonObject[] = [];
````

Create `tests/live-status-update-gate.test.ts`:

````ts
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

import Database from 'better-sqlite3';

import { JsonObjectSchema } from '../src/lib/json-types.ts';
import { parseJsonValueText } from '../src/lib/json.ts';
import { SilentProgressWriter } from '../src/lib/progress-writer.ts';
import { z } from '../src/lib/zod.ts';
import { ProgressReporter } from '../src/repo-search/engine/progress-reporter.ts';
import { PromptCacheWatch } from '../src/repo-search/engine/prompt-cache-watch.ts';
import { buildStatusUpdateInstruction, parseStatusUpdate, StatusUpdates, type StatusUpdateRequester } from '../src/repo-search/engine/status-updates.ts';
import { resolvePlannerThinkingFlags } from '../src/repo-search/engine/task-loop-support.ts';
import { PlannerChatMessagesSchema, type ChatMessage } from '../src/repo-search/planner-chat-message.ts';
import {
  captureExecutingPlannerRequest, requestRepoSearchPlannerProtocolAction, requestStatusUpdate, serializeProtocolMessages,
  type ExecutingPlannerRequest, type PlannerActionResponse,
} from '../src/repo-search/planner-protocol.ts';
import { TEST_THROUGHPUT_AUDIT_OPERATION } from './_test-helpers.ts';
import { LIVE_REQUEST_TIMEOUT_MS, loadLivePlannerFixture, type LivePlannerFixture } from './helpers/live-planner-fixture.ts';

const GATE_ENABLED = process.env.SIFTKIT_TEST_LIVE_STATUS_UPDATES === '1';
const PRESET_ID = 'exl3-3-8-27b-5bpw';
const CONVERSATIONS = 10;
/** Prompt sizes measured in each conversation, with how far past each a turn may lie. */
const PROMPT_SIZES = [20_000, 50_000, 80_000, 110_000] as const;
const SIZE_TOLERANCE = 1.09;
const PLANNER_MAX_TOKENS = 8;
const WINDOW_MS = 3_000;
const COMMAND = 'npm test';

const TurnSchema = z.object({ kind: z.literal('turn_new_messages'), turn: z.number().int().positive(), messages: PlannerChatMessagesSchema, promptTokenCount: z.number().positive() });
const RunRowSchema = z.object({ run_id: z.string(), transcript: z.string() });
const RUN_LOGS_SQL = `SELECT run_id, repo_search_transcript_jsonl AS transcript FROM run_logs
  WHERE operation_type = 'repo-agent' AND (model IS NULL OR model NOT IN ('mock', 'test-model')) AND length(repo_search_transcript_jsonl) > 500000
  ORDER BY started_at_utc DESC`;

/** One place in a recorded run: the planner request sent there, and the next one, after its command. */
type Point = { before: ChatMessage[]; after: ChatMessage[]; beforeTokens: number; afterTokens: number };
type Arm = 'none' | 'completed' | 'cancelled';
type Sample = { size: number; arm: Arm; evalTokens: number; nextElapsedMs: number; updateElapsedMs: number; settleMs: number; broke: boolean; shown: boolean };

/** The points a recorded run offers before its first compaction, or null when it misses a size. */
function pointsOf(transcript: string): Point[] | null {
  const turns: z.infer<typeof TurnSchema>[] = [];
  for (const line of transcript.split('\n')) {
    if (line.trim() === '') continue;
    const event = JsonObjectSchema.parse(parseJsonValueText(line));
    if (event.kind === 'prompt_cache_epoch_reset') break;
    const turn = TurnSchema.safeParse(event);
    if (turn.success) turns.push(turn.data);
  }
  const points: Point[] = [];
  for (const size of PROMPT_SIZES) {
    const index = turns.findIndex((turn) => turn.promptTokenCount >= size);
    const before = turns[index];
    const after = turns[index + 1];
    if (before === undefined || after === undefined || before.promptTokenCount > size * SIZE_TOLERANCE) return null;
    points.push({
      before: turns.slice(0, index + 1).flatMap((turn) => turn.messages), after: turns.slice(0, index + 2).flatMap((turn) => turn.messages),
      beforeTokens: before.promptTokenCount, afterTokens: after.promptTokenCount,
    });
  }
  return points;
}

function recordedConversations(): Point[][] {
  const database = new Database(path.resolve('.siftkit/runtime.sqlite'), { readonly: true });
  try {
    const found: Point[][] = [];
    for (const row of database.prepare(RUN_LOGS_SQL).iterate()) {
      const points = pointsOf(RunRowSchema.parse(row).transcript);
      if (points !== null) found.push(points);
      if (found.length === CONVERSATIONS) break;
    }
    return found;
  } finally {
    database.close();
  }
}

/** One copy of a recorded conversation against the live engine; its tag keeps it apart from every other copy's cache. */
class Replay implements StatusUpdateRequester {
  private readonly fixture: LivePlannerFixture;
  private readonly tag = `Copy ${randomUUID()}.\n`;
  private executing: ExecutingPlannerRequest | null = null;

  constructor(fixture: LivePlannerFixture) {
    this.fixture = fixture;
  }

  async plan(messages: readonly ChatMessage[], promptTokens: number): Promise<PlannerActionResponse> {
    const [system, ...rest] = messages;
    assert.ok(system && typeof system.content === 'string');
    const { config, baseUrl, model, tools } = this.fixture;
    const flags = resolvePlannerThinkingFlags(config);
    const serialized = serializeProtocolMessages([{ ...system, content: this.tag + system.content }, ...rest], flags.reasoningContentEnabled);
    this.executing = captureExecutingPlannerRequest(serialized, flags, tools, promptTokens);
    return requestRepoSearchPlannerProtocolAction({ config, baseUrl, model, throughputAudit: TEST_THROUGHPUT_AUDIT_OPERATION, messages: serialized,
      timeoutMs: LIVE_REQUEST_TIMEOUT_MS, totalDeadlineMs: LIVE_REQUEST_TIMEOUT_MS, maxTokens: PLANNER_MAX_TOKENS, ...flags, stage: 'planner_action', responseSchema: null, tools });
  }

  requestStatusUpdate(instruction: string, abortSignal: AbortSignal): Promise<PlannerActionResponse> {
    assert.ok(this.executing);
    const { config, baseUrl, model } = this.fixture;
    return requestStatusUpdate({ config, baseUrl, model, throughputAudit: TEST_THROUGHPUT_AUDIT_OPERATION, executing: this.executing, instruction, abortSignal });
  }
}

function evalTokens(response: PlannerActionResponse): number {
  assert.ok(typeof response.promptEvalTokens === 'number', 'the engine reports how many prompt tokens it read');
  return response.promptEvalTokens;
}

/** The planner turn, its three-second command with or without an update, and the planner turn after it. */
async function measure(replay: Replay, point: Point, size: number, arm: Arm): Promise<Sample> {
  const watch = new PromptCacheWatch();
  const first = await replay.plan(point.before, point.beforeTokens);
  watch.observe({ turn: 1, promptTokens: point.beforeTokens, promptEvalTokens: evalTokens(first), promptCacheTokens: null });
  let updateElapsedMs = 0;
  let settleMs = 0;
  let shown = false;
  if (arm === 'completed') {
    await delay(WINDOW_MS);
    const startedAt = performance.now();
    const reply = await replay.requestStatusUpdate(buildStatusUpdateInstruction({ command: COMMAND, recent: [], previous: null }), new AbortController().signal);
    updateElapsedMs = performance.now() - startedAt;
    shown = reply.toolCalls.length === 0 && parseStatusUpdate(reply.text).ok;
  } else if (arm === 'cancelled') {
    const progress = new ProgressReporter({ progressWriter: new SilentProgressWriter(), taskId: 'gate', maxTurns: 1, taskStartedAt: Date.now() });
    const updates = new StatusUpdates({ requester: replay, progress, logger: null });
    updates.toolStarted({ turn: 1, toolName: 'run', activityKind: 'validate', command: COMMAND });
    await delay(WINDOW_MS + 250 + Math.random() * 1_750);
    updates.toolFinished();
    const endedAt = performance.now();
    await updates.settle();
    settleMs = performance.now() - endedAt;
  } else {
    await delay(WINDOW_MS);
  }
  const startedAt = performance.now();
  const next = await replay.plan(point.after, point.afterTokens);
  const broke = watch.observe({ turn: 2, promptTokens: point.afterTokens, promptEvalTokens: evalTokens(next), promptCacheTokens: null }) !== null;
  return { size, arm, evalTokens: evalTokens(next), nextElapsedMs: performance.now() - startedAt, updateElapsedMs, settleMs, broke, shown };
}

function p90(values: readonly number[]): number {
  const value = [...values].sort((left, right) => left - right)[Math.ceil(values.length * 0.9) - 1];
  assert.ok(value !== undefined, 'nothing was measured');
  return Math.round(value);
}

test('status updates cost the run nothing it can notice', {
  timeout: 6 * 3_600_000,
  skip: GATE_ENABLED ? false : 'set SIFTKIT_TEST_LIVE_STATUS_UPDATES=1 with the engine idle',
}, async (t) => {
  const fixture = await loadLivePlannerFixture();
  assert.equal(fixture.preset.id, PRESET_ID, 'the gate is defined for this preset');
  const conversations = recordedConversations();
  assert.equal(conversations.length, CONVERSATIONS, 'enough recorded runs reach every size before compacting');
  const samples: Sample[] = [];
  for (const points of conversations) {
    for (const arm of ['none', 'completed', 'cancelled'] as const) {
      const replay = new Replay(fixture);
      for (const [index, point] of points.entries()) {
        const sample = await measure(replay, point, PROMPT_SIZES[index] ?? 0, arm);
        samples.push(sample);
        t.diagnostic(JSON.stringify(sample));
      }
    }
  }

  const of = (arm: Arm): Sample[] => samples.filter((sample) => sample.arm === arm);
  const baseline = of('none');
  const extra = (arm: Arm, value: (sample: Sample) => number): number => p90(of(arm).map((sample, index) => {
    const control = baseline[index];
    assert.ok(control && control.size === sample.size);
    return value(sample) - value(control);
  }));
  const result = {
    completeP90Ms: p90(of('completed').map((sample) => sample.updateElapsedMs)),
    extraReadAfterCompletedP90: extra('completed', (sample) => sample.evalTokens),
    extraReadAfterCancelledP90: extra('cancelled', (sample) => sample.evalTokens),
    delayP90Ms: p90(of('cancelled').map((sample) => sample.settleMs)),
    breaks: samples.filter((sample) => sample.arm !== 'none' && sample.broke).length,
    // Reported, not gated: how much longer the next planner turn took, and how many replies could be shown.
    nextTurnExtraP90Ms: { completed: extra('completed', (sample) => sample.nextElapsedMs), cancelled: extra('cancelled', (sample) => sample.nextElapsedMs) },
    shown: of('completed').filter((sample) => sample.shown).length,
  };
  t.diagnostic(JSON.stringify(result, null, 2));
  assert.equal(of('completed').length, 40);
  assert.ok(result.completeP90Ms <= 6_000, `an update takes ${result.completeP90Ms} ms`);
  assert.ok(result.extraReadAfterCompletedP90 <= 500 && result.extraReadAfterCancelledP90 <= 500,
    `the next turn reads ${result.extraReadAfterCompletedP90} / ${result.extraReadAfterCancelledP90} tokens more`);
  assert.ok(result.delayP90Ms <= 250, `the next turn starts ${result.delayP90Ms} ms later`);
  assert.equal(result.breaks, 0, 'no update breaks the prompt cache');
});
````

- [ ] **Step 2: Run them and see them fail**

Run: `node .\src\test-runner\run-tests.ts status-updates repo-search-planner-protocol`
Expected: FAIL (cannot find `status-updates.ts`, no export `requestStatusUpdate`)

- [ ] **Step 3: Implement**

Modify `src/repo-search/types.ts`:

````diff
@@ -122,6 +122,11 @@ export const ToolResultProgressEventSchema = z.object({
   elapsedMs: z.number(),
 });
 
+/** What the run is doing, in a sentence or two, for the person watching; never part of the run's own history. */
+export const StatusUpdateProgressEventSchema = z.object({
+  ...taskScopedFields, kind: z.literal('status_update'), updateId: z.string().uuid(), text: z.string().min(1), createdAtUtc: z.string().datetime(),
+});
+
 export const RepoSearchProgressEventSchema = z.discriminatedUnion('kind', [
   z.object({ kind: z.literal('model_inventory_start'), elapsedMs: z.number() }),
   z.object({ kind: z.literal('model_inventory_done'), modelCount: z.number(), elapsedMs: z.number() }),
@@ -157,6 +162,7 @@ export const RepoSearchProgressEventSchema = z.discriminatedUnion('kind', [
   z.object({ ...turnScopedFields, kind: z.literal('narration'), narrationText: z.string() }),
   z.object({ ...turnScopedFields, kind: z.literal('answer'), answerText: z.string() }),
   z.object({ ...taskScopedFields, kind: z.literal('progress_update'), progressText: z.string() }),
+  StatusUpdateProgressEventSchema,
   // turn comes from the break itself; the remaining task fields are the shared ones.
   PromptCacheBreakSchema.extend({
     kind: z.literal('prompt_cache_break'),
@@ -249,6 +255,8 @@ export type RepoSearchExecutionRequest = {
   submissionGate?: SubmissionGate;
   /** The run's background jobs; its presence is what offers `job`. The caller that made it disposes it. */
   backgroundJobs?: BackgroundJobs;
+  /** Someone watches this run in the dashboard, so it writes status updates. */
+  statusUpdates?: boolean;
   /** The orchestrator run that executes its parent's own tools; its presence is what offers them. */
   orchestratorTools?: OrchestratorToolHost;
   /** A fixed system context used instead of one built from the preset: an orchestrator parent's run-start snapshot. */
````

Modify `src/repo-search/engine/progress-reporter.ts`:

````diff
@@ -139,6 +139,10 @@ export class ProgressReporter {
     this.emit({ kind: 'progress_update', taskId: this.taskId, turn, maxTurns: this.maxTurns, progressText, elapsedMs: this.elapsedMs() });
   }
 
+  statusUpdate(turn: number, updateId: string, text: string, createdAtUtc: string): void {
+    this.emit({ kind: 'status_update', taskId: this.taskId, turn, maxTurns: this.maxTurns, updateId, text, createdAtUtc, elapsedMs: this.elapsedMs() });
+  }
+
   toolStart(
     toolCallId: string,
     turn: number,
````

Modify `src/status-server/dashboard-runs.ts`:

````diff
@@ -233,6 +233,7 @@ const LIVE_TEXT_PROGRESS_KINDS: Record<RepoSearchProgressEvent['kind'], boolean>
   prompt: false,
   queued_user_message: false,
   prompt_cache_break: false,
+  status_update: false,
 };
 
 export function isLiveTextProgressEvent(event: RepoSearchProgressEvent): boolean {
````

Modify `src/repo-search/planner-protocol.ts`:

````diff
@@ -6,7 +6,7 @@ import { InferenceClient } from '../llm-protocol/inference-client.ts';
 import { completeLiveContent, type LiveContentSnapshot } from '../llm-protocol/live-content-classifier.ts';
 import type { InferenceActivityObserver } from '../lib/progress-writer.ts';
 import type { JsonObject, InferenceChatMessage, InferenceChatRequest, InferenceChatRole, InferenceToolCall, InferenceToolDefinition, StreamStop } from '../llm-protocol/types.ts';
-import { CLEAN_STREAM_STOP, InferenceToolDefinitionsSchema } from '../llm-protocol/types.ts';
+import { CLEAN_STREAM_STOP, InferenceChatMessageSchema, InferenceToolDefinitionsSchema } from '../llm-protocol/types.ts';
 import { parseJsonValueText } from '../lib/json.ts';
 import { JsonObjectSchema } from '../lib/json-types.ts';
 import { extractContentText } from '../llm-protocol/image-attachments.ts';
@@ -329,7 +329,8 @@ export type PlannerRequestStage =
   | 'planner_action'
   | 'approval_verdict'
   | 'terminal_synthesis'
-  | 'context_compaction';
+  | 'context_compaction'
+  | 'status_update';
 
 export type PlannerResponseConstraint =
   | { responseSchema: null; responseSchemaName?: never }
@@ -369,6 +370,8 @@ type PlannerRequestBase = PlannerThinkingFlags & {
   messages: InferenceChatMessage[];
   /** Per-attempt allowance, not a total wall clock: bounds the SSE idle gap and caps the retry window. */
   timeoutMs: number;
+  /** Overrides the deadline derived from `maxTokens`, which leaves a small reply no time to read its prompt. */
+  totalDeadlineMs?: number;
   maxTokens: number;
   onThinkingDelta?: (accumulatedThinking: string) => void;
   onContentDelta?: (snapshot: LiveContentSnapshot) => void;
@@ -484,6 +487,8 @@ function assertPromptCacheExtension(options: PlannerDerivedRequestOptions): void
     throw new Error(`${options.stage} prompt-cache contract violated: tools diverged`);
   }
   for (const key of ['thinkingEnabled', 'reasoningContentEnabled', 'preserveThinking'] as const) {
+    // A status update is the one derived request that answers without thinking; that changes only what follows the prefix.
+    if (options.stage === 'status_update' && key === 'thinkingEnabled') continue;
     if (prefix.flags[key] !== Boolean(options[key])) {
       throw new Error(`${options.stage} prompt-cache contract violated: ${key} diverged`);
     }
@@ -573,6 +578,7 @@ export async function requestRepoSearchPlannerProtocolAction(options: PlannerReq
         reasoningOverride: options.thinkingEnabled ? 'on' : 'off',
         allowedToolNames,
         idleTimeoutSeconds: options.timeoutMs / 1000,
+        totalDeadlineMs: options.totalDeadlineMs,
         retry: false,
         abortSignal: options.abortSignal,
         reasoningBudgetMessage: options.reasoningBudgetMessage,
@@ -790,6 +796,43 @@ export async function requestTerminalSynthesis(options: {
   });
 }
 
+const STATUS_UPDATE_MAX_TOKENS = 60;
+/** The command usually ends first and cancels it; this bounds a stalled engine. */
+const STATUS_UPDATE_TIMEOUT_MS = 10_000;
+
+/** A short unthinking reply on top of the executing planner prompt; nothing of it enters the run's history. */
+export async function requestStatusUpdate(options: {
+  config: SiftConfig;
+  baseUrl: string;
+  model: string;
+  throughputAudit: ThroughputAuditOperation;
+  executing: ExecutingPlannerRequest;
+  instruction: string;
+  abortSignal: AbortSignal;
+  logger?: JsonLogger | null;
+}): Promise<PlannerActionResponse> {
+  const prefix = options.executing.serializedMessageJson.map((message) => InferenceChatMessageSchema.parse(parseJsonValueText(message)));
+  return requestRepoSearchPlannerProtocolAction({
+    config: options.config,
+    baseUrl: options.baseUrl,
+    model: options.model,
+    throughputAudit: options.throughputAudit,
+    messages: [...prefix, { role: 'user', content: options.instruction }],
+    timeoutMs: STATUS_UPDATE_TIMEOUT_MS,
+    totalDeadlineMs: STATUS_UPDATE_TIMEOUT_MS,
+    maxTokens: STATUS_UPDATE_MAX_TOKENS,
+    ...options.executing.flags,
+    thinkingEnabled: false,
+    abortSignal: options.abortSignal,
+    logger: options.logger,
+    cachePrefix: options.executing,
+    stage: 'status_update',
+    responseSchema: null,
+    tools: options.executing.tools,
+    toolChoice: 'none',
+  });
+}
+
 function deriveCompactionBranch(
   executing: ExecutingPlannerRequest,
   serializedHistory: readonly InferenceChatMessage[],
````

Create `src/repo-search/engine/status-updates.ts`:

````ts
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

import type { ToolActivityKind } from '@siftkit/contracts';

import { toError } from '../../lib/errors.ts';
import type { PlannerActionResponse } from '../planner-protocol.ts';
import { findStatusTextProblem } from '../status-text.ts';
import type { JsonLogger } from '../types.ts';
import type { ProgressReporter } from './progress-reporter.ts';

const CALLS_PER_UPDATE = 10;
/** How long a command must have run before an update is written, so quick commands cost nothing. */
const WINDOW_MS = 3_000;
const SPACING_MS = 60_000;
/** How long the next planner request may wait for a cancelled update to let go of the engine. */
const SETTLE_MS = 1_000;
const RECENT_ACTIVITIES = 5;
const ACTIVITY_MAX_CHARS = 200;
const MAX_WORDS = 45;
/** The tools whose execution leaves the engine idle. */
const WINDOW_TOOLS = new Set(['run', 'job']);

export interface StatusUpdateRequester {
  requestStatusUpdate(instruction: string, abortSignal: AbortSignal): Promise<PlannerActionResponse>;
}

type RunningCommand = { turn: number; command: string };

/** The reply as it may be shown, or why it may not. */
export function parseStatusUpdate(reply: string): { ok: true; text: string } | { ok: false; problem: string } {
  const trimmed = reply.trim();
  if (trimmed === '') return { ok: false, problem: 'it was empty' };
  if (/\n\s*\n/u.test(trimmed)) return { ok: false, problem: 'it must be one paragraph' };
  const text = trimmed.replace(/\s*\n\s*/gu, ' ');
  if (text.split(/\s+/u).length > MAX_WORDS) return { ok: false, problem: `it was over ${MAX_WORDS} words` };
  const problem = findStatusTextProblem(text);
  return problem === null ? { ok: true, text } : { ok: false, problem };
}

export function buildStatusUpdateInstruction(input: { command: string; recent: readonly string[]; previous: string | null }): string {
  return [
    `This command is running now: ${input.command}`,
    ...(input.recent.length === 0 ? [] : ['Your latest steps, oldest first:', ...input.recent.map((activity) => `- ${activity}`)]),
    ...(input.previous === null ? [] : [`Your last update was: "${input.previous}" Do not repeat it.`]),
    'While it runs, tell the person watching what you are doing. Reply with only one or two short plain sentences, at most 30 words:',
    'the goal, why it matters now, and progress if it is clear. Do not name files, paths, commands, tools, code or tests. Say nothing',
    'you have not confirmed: "checking a suspected problem", not "found a bug". Do not call a tool. Your work continues afterwards.',
  ].join('\n');
}

/** Decides when a run writes an update, writes it while a command runs, and keeps it out of the run itself. */
export class StatusUpdates {
  private readonly requester: StatusUpdateRequester;
  private readonly progress: ProgressReporter;
  private readonly logger: JsonLogger | null;
  private due = false;
  private callsSinceUpdate = 0;
  private lastStartedAtMs: number | null = null;
  private previous: string | null = null;
  private readonly recent: string[] = [];
  private timer: NodeJS.Timeout | null = null;
  private request: { abort: AbortController; settled: Promise<void> } | null = null;

  constructor(options: { requester: StatusUpdateRequester; progress: ProgressReporter; logger: JsonLogger | null }) {
    this.requester = options.requester;
    this.progress = options.progress;
    this.logger = options.logger;
  }

  toolStarted(tool: RunningCommand & { toolName: string; activityKind: ToolActivityKind }): void {
    this.recent.push(`${tool.activityKind}: ${tool.command}`.slice(0, ACTIVITY_MAX_CHARS));
    if (this.recent.length > RECENT_ACTIVITIES + 1) this.recent.shift();
    if (tool.activityKind === 'validate') this.due = true;
    if (!this.due || !WINDOW_TOOLS.has(tool.toolName)) return;
    const spacingMs = this.lastStartedAtMs === null ? 0 : this.lastStartedAtMs + SPACING_MS - Date.now();
    this.timer = setTimeout(() => this.write(tool), Math.max(WINDOW_MS, spacingMs));
  }

  /** The command ended: an update not written by now would delay the run, so it is dropped. */
  toolFinished(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    this.request?.abort.abort(new Error('The command ended before its status update.'));
    this.callsSinceUpdate += 1;
    if (this.callsSinceUpdate >= CALLS_PER_UPDATE) this.due = true;
  }

  /** Waits for a cancelled update to let go of the engine, but never long. */
  async settle(): Promise<void> {
    if (this.request === null) return;
    const bound = new AbortController();
    await Promise.race([this.request.settled, delay(SETTLE_MS, undefined, { signal: bound.signal }).catch(() => undefined)]);
    bound.abort();
  }

  private write(command: RunningCommand): void {
    this.timer = null;
    if (this.request !== null) return;
    const abort = new AbortController();
    const instruction = buildStatusUpdateInstruction({ command: command.command, recent: this.recent.slice(0, -1), previous: this.previous });
    this.due = false;
    this.callsSinceUpdate = 0;
    this.lastStartedAtMs = Date.now();
    const settled = this.ask(command, instruction, abort.signal).finally(() => { this.request = null; });
    this.request = { abort, settled };
  }

  /** Never throws: an update that cannot be written shows nothing and changes nothing. */
  private async ask(command: RunningCommand, instruction: string, abortSignal: AbortSignal): Promise<void> {
    const startedAtMs = Date.now();
    let outcome = 'shown';
    let usage: Pick<PlannerActionResponse, 'promptCacheTokens' | 'promptEvalTokens'> = {};
    try {
      const response = await this.requester.requestStatusUpdate(instruction, abortSignal);
      usage = { promptCacheTokens: response.promptCacheTokens, promptEvalTokens: response.promptEvalTokens };
      const parsed = response.toolCalls.length > 0 ? { ok: false as const, problem: 'it called a tool' } : parseStatusUpdate(response.text);
      if (abortSignal.aborted) outcome = 'late';
      else if (!parsed.ok) outcome = `rejected: ${parsed.problem}`;
      else {
        this.previous = parsed.text;
        this.progress.statusUpdate(command.turn, randomUUID(), parsed.text, new Date().toISOString());
      }
    } catch (error) {
      outcome = abortSignal.aborted ? 'cancelled' : `failed: ${toError(error).message}`;
    }
    this.logger?.write({ kind: 'status_update', turn: command.turn, outcome, elapsedMs: Date.now() - startedAtMs,
      promptCacheTokens: usage.promptCacheTokens ?? null, promptEvalTokens: usage.promptEvalTokens ?? null });
  }
}
````

- [ ] **Step 4: Run the tests and the checks**

Run: `node .\src\test-runner\run-tests.ts status-updates repo-search-planner-protocol live-status-update-gate`
Expected: every test passes.

Run: `npx tsc -p tsconfig.test.json`, then `npx eslint tests/status-updates.test.ts tests/repo-search-planner-protocol.test.ts tests/live-status-update-gate.test.ts src/repo-search/types.ts src/repo-search/engine/progress-reporter.ts src/status-server/dashboard-runs.ts src/repo-search/planner-protocol.ts src/repo-search/engine/status-updates.ts`
Expected: all exit 0 with no output.

The gate test reports one skip here. It runs in Task 5.

**Acceptance:** the tests of this task pass, type-check and lint are clean, and no file outside the list above changed.

### Task 5: The gate. Stop here if it fails

This task changes no file. It needs the engine for an estimated 1 to 2 hours and the owner's agreement, so **do not delegate it to `repo-agent`**, and do not start it while any run is live.

**What it does:** replays 10 recorded repo-agent conversations at about 20k, 50k, 80k and 110k prompt tokens, three times each under its own prefix: without an update, with a completed one, and with one cancelled 0.25 to 2 seconds in. It reads `.siftkit/runtime.sqlite` read-only. 11 recorded runs qualified on 2026-11-25; some come from runs of another model, which does not matter for what is measured. Startup retention removes runs older than 7 days, and the gate needs 10.

- [ ] **Step 1: Make the engine ready**

The active preset must be `exl3-3-8-27b-5bpw`, loaded, with no run executing or queued.

- [ ] **Step 2: Run it**

Run in PowerShell: `$env:SIFTKIT_TEST_LIVE_STATUS_UPDATES = '1'; node --test .\tests\live-status-update-gate.test.ts; Remove-Item Env:SIFTKIT_TEST_LIVE_STATUS_UPDATES`, not through the test runner: it ends a run after 15 minutes and forbids the live ports

- [ ] **Step 3: Read the result**

| Measure | Required |
|---|---|
| `completeP90Ms` | 6000 or less |
| `extraReadAfterCompletedP90`, `extraReadAfterCancelledP90` | 500 or less |
| `delayP90Ms` | 250 or less |
| `breaks` | 0 |

`nextTurnExtraP90Ms` and `shown` are reported and not gated. `nextTurnExtraP90Ms` is where an engine that is slow to drop a cancelled request would show: if it is over 1000 ms, report it to the owner even when the gate passes. `shown` counts replies that keep the writing rules.

- [ ] **Step 4: Decide**

- **Pass:** record the numbers in this file under "What was measured", then start Task 6.
- **Fail:** stop. Report every number and which limit it missed. Do not change a limit, do not retry with fewer conversations, and do not start Task 6. Part 1 stays, and Task 4's code is removed unless the owner decides otherwise.

**Acceptance:** the test passed on the live engine and its numbers are written down, or the plan stopped here and the numbers were reported.

### Task 6: Wiring and eligibility

The loop builds `StatusUpdates` only for a run that asked for it and has a real model, tells it when a command starts and ends, and settles it before the next planner request and before the result. The dashboard chat route and the children of a run with a `sessionId` ask for it; the CLI and the orchestrator parent do not.

**Files:**
- `tests/status-updates-loop.test.ts`
- `tests/admitted-model-routes.e2e.test.ts`
- `tests/process/orchestrator-run.e2e.test.ts`
- `tests/helpers/tool-action-processor.ts`
- `src/repo-search/execute.ts`
- `src/repo-search/engine.ts`
- `src/repo-search/engine/task-loop-support.ts`
- `src/repo-search/engine/task-loop.ts`
- `src/repo-search/engine/tool-action-processor.ts`
- `src/status-server/routes/repo-agent.ts`
- `src/status-server/routes/chat-repo-agent.ts`
- `src/orchestrator/workers.ts`
- `src/orchestrator/run.ts`

- [ ] **Step 1: Write the tests**

Create `tests/status-updates-loop.test.ts`:

````ts
import assert from 'node:assert/strict';
import http from 'node:http';
import test, { after, before } from 'node:test';

import { runTaskLoop } from '../src/repo-search/engine.ts';
import { RepoSearchRuntimeProfile } from '../src/repo-search/engine/runtime-profile.ts';
import type { TaskResult } from '../src/repo-search/engine/task-loop-support.ts';
import { resolveRepoSearchPlannerToolDefinitions } from '../src/repo-search/planner-protocol.ts';
import type { RepoSearchProgressEvent } from '../src/repo-search/types.ts';
import { parseJsonValueText } from '../src/lib/json.ts';
import { JsonObjectSchema, type JsonObject } from '../src/lib/json-types.ts';
import { z } from '../src/lib/zod.ts';
import { CollectingProgressWriter } from './helpers/collecting-progress-writer.ts';
import { getAddressInfo } from './helpers/dashboard-http.ts';
import { createEmptyPresetSystemContext } from './helpers/empty-preset-system-context.ts';
import { IsolatedRuntime } from './helpers/isolated-runtime.ts';
import { mockSiftConfig } from './helpers/mock-config.ts';
import { buildTabbyUsage, sendChatCompletionSse } from './helpers/streaming-client.ts';
import { tabbyTokenEncodeResponse } from './helpers/tabby-token-encode.ts';
import { createManagedTempDir } from './helpers/temp-dirs.ts';
import { TEST_THROUGHPUT_AUDIT_OPERATION } from './_test-helpers.ts';

const isolatedRuntime = new IsolatedRuntime();
before(() => isolatedRuntime.start());
after(() => isolatedRuntime.close());

const RequestSchema = z.looseObject({ messages: z.array(z.looseObject({ role: z.string(), content: z.json() })) });
const TOOL_CALL = { id: 'call_1', type: 'function', function: { name: 'run', arguments: '{"command":"npm test"}' } };
type Reply = 'text' | 'tool' | 'error' | 'path' | 'hang';
type Run = { result: TaskResult; planner: string[]; plannerAtMs: number[]; statusRequests: number; shown: string[]; logged: JsonObject[] };

/** One run in `repoRoot`: a four-second check, then the answer. The engine answers a status request as `reply` says. */
async function run(repoRoot: string, statusUpdates: boolean, reply: Reply): Promise<Run> {
  const planner: string[] = [];
  const plannerAtMs: number[] = [];
  let statusRequests = 0;
  const server = http.createServer((req, res) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      if (req.url === '/v1/token/encode') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(tabbyTokenEncodeResponse(Math.ceil(body.length / 4))));
        return;
      }
      const last = RequestSchema.parse(parseJsonValueText(body)).messages.at(-1);
      if (typeof last?.content === 'string' && last.content.startsWith('This command is running now')) {
        statusRequests += 1;
        if (reply === 'hang') return;
        if (reply === 'error') {
          res.writeHead(500);
          res.end('broken');
          return;
        }
        const content = reply === 'path' ? 'Editing src/a.ts.' : 'Checking that the change holds.';
        sendChatCompletionSse(res, {
          choices: [{ message: { role: 'assistant', ...(reply === 'tool' ? { content: '', tool_calls: [TOOL_CALL] } : { content }) } }],
          usage: buildTabbyUsage({ promptTokens: 900, cachedTokens: 880, completionTokens: 8 }),
        });
        return;
      }
      planner.push(body);
      plannerAtMs.push(performance.now());
      sendChatCompletionSse(res, {
        choices: [{ message: { role: 'assistant', ...(planner.length === 1 ? { content: '', tool_calls: [TOOL_CALL] } : { content: 'done' }) } }],
        usage: buildTabbyUsage({ promptTokens: 1_000, cachedTokens: planner.length === 1 ? 0 : 950, completionTokens: 4 }),
      });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${getAddressInfo(server).port}`;
  const progress = new CollectingProgressWriter<RepoSearchProgressEvent>();
  const logged: JsonObject[] = [];
  try {
    const result = await runTaskLoop({ id: 'status', question: 'Check it.' }, {
      throughputAudit: TEST_THROUGHPUT_AUDIT_OPERATION,
      plannerToolDefinitions: resolveRepoSearchPlannerToolDefinitions(['run', 'read']),
      repoRoot, model: 'mock-model', baseUrl,
      runtimeProfile: new RepoSearchRuntimeProfile('repo-agent'), systemContext: createEmptyPresetSystemContext(),
      config: mockSiftConfig({ Server: { ModelPresets: { Presets: [{ BaseUrl: baseUrl, NumCtx: 32_000 }] } } }),
      maxTurns: 4, minToolCallsBeforeFinish: 0, progressWriter: progress, statusUpdates,
      mockCommandResults: { 'run command="npm test"': { exitCode: 0, stdout: 'ok', stderr: '', delayMs: 4_000 } },
      logger: { path: 'memory', write(event) { logged.push(JsonObjectSchema.parse(parseJsonValueText(JSON.stringify(event)))); } },
    });
    return { result, planner, plannerAtMs, statusRequests, logged, shown: progress.ofKind('status_update').map((event) => event.text) };
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

/** What the run leaves behind, without what a clock or a port decides. */
function trace(value: Run): JsonObject {
  const { promptTokens, outputTokens, thinkingTokens, promptCacheTokens, promptEvalTokens, reason, finalOutput, turnsUsed, throughput } = value.result;
  return JsonObjectSchema.parse(parseJsonValueText(JSON.stringify({
    promptTokens, outputTokens, thinkingTokens, promptCacheTokens, promptEvalTokens, reason, finalOutput, turnsUsed,
    requests: throughput.pp.requestCount, planner: value.planner,
    breaks: value.logged.filter((event) => event.kind === 'prompt_cache_break'),
    messages: value.logged.filter((event) => event.kind === 'turn_new_messages'),
  })));
}

test('a status update leaves the run exactly as it would have been', async () => {
  const root = createManagedTempDir('siftkit-status-updates-');
  const [off, shown, refused, calling, broken, hung] = await Promise.all([
    run(root, false, 'text'), run(root, true, 'text'), run(root, true, 'path'), run(root, true, 'tool'), run(root, true, 'error'), run(root, true, 'hang'),
  ]);
  assert.equal(off.statusRequests, 0);
  assert.equal(off.planner.length, 2);
  assert.deepEqual(shown.shown, ['Checking that the change holds.']);
  for (const updated of [shown, refused, calling, broken, hung]) {
    assert.equal(updated.statusRequests, 1);
    assert.deepEqual(trace(updated), trace(off));
  }
  for (const silent of [off, refused, calling, broken, hung]) assert.deepEqual(silent.shown, []);
  assert.deepEqual(shown.logged.filter((event) => event.kind === 'status_update').map((event) => [event.outcome, event.promptCacheTokens]), [['shown', 880]]);
  assert.deepEqual(hung.logged.filter((event) => event.kind === 'status_update').map((event) => event.outcome), ['cancelled']);
  // The hung request went with its command; the next planner request did not wait for it.
  const gap = (value: Run): number => (value.plannerAtMs[1] ?? 0) - (value.plannerAtMs[0] ?? 0);
  assert.ok(gap(hung) < gap(off) + 1_000, `${gap(hung)} against ${gap(off)} ms`);
});
````

Modify `tests/admitted-model-routes.e2e.test.ts`:

````diff
@@ -1,5 +1,6 @@
 import test, { type TestContext } from 'node:test';
 import assert from 'node:assert/strict';
+import { randomUUID } from 'node:crypto';
 
 import { getActiveModelPreset } from '../src/config/getters.ts';
 import type { SiftConfig } from '../src/config/types.ts';
@@ -153,3 +154,18 @@ test('chat images are checked against the model the operation will run on', asyn
   assert.equal(engine.repoSearchRequests.length, 0);
   assert.deepEqual(harness.loadedModelNames, ['model-a'], 'a refused submission must not load B');
 });
+
+test('only a run started from the dashboard writes status updates', async (t) => {
+  const { harness, engine } = await startRoutingHarness(t, 'siftkit-status-updates-');
+  const sessionId = await harness.createChatSession('updates', 'model-a');
+  const agent = { repoRoot: process.cwd(), approval: 'off', mockResponses: repoAgentFinishResponses('done') };
+
+  const cli = await requestSse(`${harness.getBaseUrl()}/repo-agent`, { body: { prompt: 'from the terminal', maxTurns: 1, ...agent } });
+  assert.equal(cli.errorMessage, null, cli.rawBody);
+  await requestSse(`${harness.getBaseUrl()}/dashboard/chat/sessions/${sessionId}/repo-agent/stream`, {
+    body: { operationId: randomUUID(), submissionId: randomUUID(), content: 'from the dashboard', ...agent },
+  });
+
+  assert.equal(engine.requireRepoSearch('from the terminal').statusUpdates, false);
+  assert.equal(engine.requireRepoSearch('from the dashboard').statusUpdates, true);
+});
````

Modify `tests/process/orchestrator-run.e2e.test.ts`:

````diff
@@ -176,6 +176,24 @@ function assertCompleted(state: OrchestratorRunState, engine: ScriptedEngineServ
   assert.equal(state.phase, 'completed', [JSON.stringify(state.failure), ...engine.parentToolOutputs()].join('\n---\n'));
 }
 
+for (const { from, statusUpdates } of [{ from: 'the dashboard', statusUpdates: true }, { from: 'the terminal', statusUpdates: false }]) {
+  test(`a run started from ${from} has workers that ${statusUpdates ? 'write' : 'write no'} status updates`, async (t) => {
+    const context = await startHarness(t, 'siftkit-orchestrator-updates-');
+    const { engine } = context;
+    engine.parent.push([savePlan(), dispatch({ taskId: 'greeting', instruction: 'Create src/greeting.ts exporting greeting.' }),
+      review('greeting', 'pass'), COMPLETE]);
+    engine.children.push(WRITER);
+
+    const sessionId = statusUpdates ? await context.harness.createChatSession('orchestrator', 'model-a') : null;
+    const started = await startRun(context, 'off', { sessionId });
+    const { state } = await followRun(context, started.runId);
+
+    assertCompleted(state, engine);
+    const requests = engine.repoSearchRequests.map((request) => [request.taskKind === 'orchestrator', request.statusUpdates ?? false]);
+    assert.deepEqual(requests, [[true, false], [false, statusUpdates]], 'the orchestrator itself never does: its dispatches say where the run is');
+  });
+}
+
 test('one conversation plans, dispatches a writer, reviews it, and finishes; the parent releases its model while the child works',
   async (t) => {
     const context = await startHarness(t, 'siftkit-orchestrator-happy-');
````

Modify `tests/helpers/tool-action-processor.ts`:

````diff
@@ -89,6 +89,7 @@ export function makeProcessor(
     questionGate: options.questionGate ?? null,
     orchestratorTools: options.orchestratorTools ?? null,
     backgroundJobs: options.backgroundJobs ?? null,
+    statusUpdates: null,
     runtimeProfile: new RepoSearchRuntimeProfile(taskKind),
     chatWebGroundingEnabled: false,
     chatWebGroundingPolicy: new ChatGroundingPolicy({ enabled: false }),
````

- [ ] **Step 2: Run them and see them fail**

Run: `node .\src\test-runner\run-tests.ts status-updates-loop admitted-model-routes`
Expected: FAIL (`statusUpdates` is not a loop option; no status request is ever sent)

- [ ] **Step 3: Implement**

Modify `src/repo-search/execute.ts`:

````diff
@@ -489,6 +489,7 @@ export async function executeRepoSearchRequest(
       submissionGate: request.submissionGate,
       orchestratorTools: request.orchestratorTools,
       backgroundJobs: request.backgroundJobs,
+      statusUpdates: request.statusUpdates,
     });
     serverLogger.debug({ scope: 'rs', id: requestId, event: 'run_done', fields: '' });
     const targetFolder = scorecard?.verdict === 'pass' ? folders.successful : folders.failed;
````

Modify `src/repo-search/engine.ts`:

````diff
@@ -178,6 +178,7 @@ export async function runRepoSearch(options: {
   submissionGate?: SubmissionGate;
   orchestratorTools?: OrchestratorToolHost;
   backgroundJobs?: BackgroundJobs;
+  statusUpdates?: boolean;
 }): Promise<{ scorecard: Scorecard; turnRecords: TurnTokenRecord[] }> {
   throwIfAborted(options.abortSignal);
   if (options.taskPrompt === undefined) {
@@ -267,6 +268,7 @@ export async function runRepoSearch(options: {
       submissionGate: options.submissionGate,
       orchestratorTools: options.orchestratorTools,
       backgroundJobs: options.backgroundJobs,
+      statusUpdates: options.statusUpdates,
     });
     const result = await loop.run();
     tasks.push(result);
````

Modify `src/repo-search/engine/task-loop-support.ts`:

````diff
@@ -295,6 +295,7 @@ export type RunTaskLoopOptions = {
   orchestratorTools?: OrchestratorToolHost;
   /** The run's background jobs; absent wherever `job` is not offered. */
   backgroundJobs?: BackgroundJobs;
+  statusUpdates?: boolean;
 };
 
 function isPlannerReasoningEnabled(config: SiftConfig): boolean {
````

Modify `src/repo-search/engine/task-loop.ts`:

````diff
@@ -27,6 +27,7 @@ import {
   PLANNER_REASONING_BUDGET_MESSAGE,
   captureExecutingPlannerRequest,
   requestApprovalVerdict as requestApprovalVerdictRequest,
+  requestStatusUpdate as requestStatusUpdateRequest,
   requestRepoSearchPlannerProtocolAction,
   serializeProtocolMessages,
   toProtocolChatMessages,
@@ -93,6 +94,7 @@ import type { TurnTokenRecord } from './turn-token-record.ts';
 import { ToolStatsRecorder } from './tool-stats.ts';
 import { TranscriptManager } from './transcript-manager.ts';
 import { PromptCacheWatch } from './prompt-cache-watch.ts';
+import { StatusUpdates } from './status-updates.ts';
 import { RunStateCompactor } from './run-state-compactor.ts';
 import { TranscriptCompactor } from './transcript-compactor.ts';
 import { DEFAULT_MAX_TURNS, TurnBudget } from './turn-budget.ts';
@@ -208,6 +210,8 @@ export class TaskLoop {
   private finalOutput = '';
   private lastCompactionSummary = '';
   private readonly promptCacheWatch = new PromptCacheWatch();
+  /** Null when nobody watches the run, or when its model is mocked. */
+  private readonly statusUpdates: StatusUpdates | null;
   private turnsUsed = 0;
   private mockResponseIndex = 0;
   private executingPlannerRequest: ExecutingPlannerRequest | null = null;
@@ -276,6 +280,8 @@ export class TaskLoop {
       maxTurns: this.maxTurns,
       taskStartedAt: this.taskStartedAt,
     });
+    this.statusUpdates = options.statusUpdates === true && options.mockResponses === undefined
+      ? new StatusUpdates({ requester: this, progress: this.progress, logger: options.logger ?? null }) : null;
     const initialQueuedMessages = options.queueDelivery?.initial() ?? [];
     this.transcript = new TranscriptManager({
       systemPromptContent,
@@ -345,6 +351,7 @@ export class TaskLoop {
       evidenceRecorder: options.evidenceRecorder ?? null,
       questionGate: options.questionGate ?? null,
       backgroundJobs: options.backgroundJobs ?? null,
+      statusUpdates: this.statusUpdates,
       orchestratorTools: options.orchestratorTools ?? null,
       runtimeProfile: options.runtimeProfile,
       chatWebGroundingEnabled: this.chatWebGroundingEnabled,
@@ -428,6 +435,22 @@ export class TaskLoop {
     return response;
   }
 
+  /** A status update on top of the planner request whose command is running; the transcript never learns of it. */
+  async requestStatusUpdate(instruction: string, abortSignal: AbortSignal): Promise<PlannerActionResponse> {
+    const executing = this.executingPlannerRequest;
+    if (!executing) throw new Error('status_update requested before any planner request.');
+    return requestStatusUpdateRequest({
+      config: this.options.config,
+      baseUrl: this.options.baseUrl,
+      model: this.options.model,
+      throughputAudit: this.options.throughputAudit,
+      executing,
+      instruction,
+      abortSignal,
+      logger: this.options.logger ?? null,
+    });
+  }
+
   async run(): Promise<TaskResult> {
     const promptAdapter = new RepoSearchPromptAdapter(this);
     const actionAdapter = new RepoSearchActionAdapter(this.plannerToolDefinitions, this);
@@ -488,6 +511,7 @@ export class TaskLoop {
 
   async prepareTurn(turn: number): Promise<AgentLoopPreparedTurn> {
     throwIfAborted(this.options.abortSignal);
+    await this.statusUpdates?.settle();
     this.transcript.reconcileHistory();
     this.transcript.beginTurn(turn);
     this.turnsUsed = turn;
@@ -905,6 +929,7 @@ export class TaskLoop {
   }
 
   async buildAgentLoopResult(): Promise<TaskResult> {
+    await this.statusUpdates?.settle();
     await this.stopBackgroundJobs();
     const answerSchema = this.options.answerSchema;
     // Terminal synthesis if no final output — retry up to 3 times then hard-fail.
````

Modify `src/repo-search/engine/tool-action-processor.ts`:

````diff
@@ -79,6 +79,7 @@ import { findShellCommandProblem, findShellReadCommand } from './shell-command-p
 import type { RepoSearchRuntimeProfile } from './runtime-profile.ts';
 import type { OrchestratorToolHost } from './orchestrator-tool-host.ts';
 import type { BackgroundJobs, JobReply } from './background-jobs.ts';
+import type { StatusUpdates } from './status-updates.ts';
 import { buildAgentRunEnv } from '../../lib/agent-run-marker.ts';
 import { DEFAULT_BACKGROUND_TIMEOUT_MS, DEFAULT_JOB_WAIT_MS } from '../../lib/powershell.ts';
 import { TurnCommandResultFinalizedEventSchema } from '../live-snapshot/schemas.ts';
@@ -202,6 +203,7 @@ export type ToolActionProcessorDeps = {
   orchestratorTools: OrchestratorToolHost | null;
   /** The run's background jobs; null wherever `job` is not offered. */
   backgroundJobs: BackgroundJobs | null;
+  statusUpdates: StatusUpdates | null;
   runtimeProfile: RepoSearchRuntimeProfile;
   chatWebGroundingEnabled: boolean;
   chatWebGroundingPolicy: ChatGroundingPolicy;
@@ -1197,7 +1199,8 @@ export class ToolActionProcessor {
       commandChars: context.command.length,
       native: true,
     });
-    const nativeExecution = await this.executeTool(turn, state, context);
+    this.deps.statusUpdates?.toolStarted({ turn, toolName: normalizedToolName, activityKind: activity.activityKind, command: context.command });
+    const nativeExecution = await this.executeTool(turn, state, context).finally(() => { this.deps.statusUpdates?.toolFinished(); });
     const nativeContext: NativeExecutionContext = { ...context, nativeExecution };
     toolExecutionSpan?.end({
       exitCode: nativeExecution.ok ? nativeExecution.exitCode : -1,
````

Modify `src/status-server/routes/repo-agent.ts`:

````diff
@@ -71,6 +71,7 @@ export class RepoAgentStartEndpoint implements RouteEndpoint {
       return;
     }
     const { session } = startRepoWorkerRun(ctx, {
+      statusUpdates: false,
       taskKind: 'repo-agent',
       repositoryAccess: 'exclusive',
       presetId: 'repo-agent',
@@ -128,6 +129,8 @@ export type StartRepoWorkerRunInput = {
   modelQueueTimeout?: ModelQueueTimeout;
   /** An orchestrator child's checks, run by code on every finish before the run accepts it. */
   submissionGate?: SubmissionGate;
+  /** The run was started from the dashboard, so someone can read its status updates. */
+  statusUpdates: boolean;
 };
 
 /** The one server-side worker start: run-store record, session, model routing, and repository ownership. */
@@ -188,6 +191,7 @@ export function startRepoWorkerRun(ctx: ServerContext, input: StartRepoWorkerRun
       ...(input.evidenceRecorder === undefined ? {} : { evidenceRecorder: input.evidenceRecorder }),
       ...(input.questionGate === undefined ? {} : { questionGate: input.questionGate }),
       ...(input.submissionGate === undefined ? {} : { submissionGate: input.submissionGate }),
+      statusUpdates: input.statusUpdates,
       initialUserImages: repoSearchRequest.images.length > 0 ? repoSearchRequest.images : undefined,
       ...(input.queue
         ? {
````

Modify `src/status-server/routes/chat-repo-agent.ts`:

````diff
@@ -207,6 +207,7 @@ export async function executeChatRepoAgentOperation(options: {
   const settings = options.recorder.settings;
   const progressWriter = new ChatStreamProgressWriter(options.stream, null, true, options.recorder);
   const started = startRepoWorkerRun(options.ctx, {
+    statusUpdates: true,
     taskKind: 'repo-agent',
     repositoryAccess: 'exclusive',
     evidenceRecorder: options.recorder,
````

Modify `src/orchestrator/workers.ts`:

````diff
@@ -14,7 +14,7 @@ import { requireOrchestratorWorkerPreset } from './plan.ts';
  * every finish through `submission`, and the parent task already owns the repository.
  */
 export function startOrchestratorChild(ctx: ServerContext, config: SiftConfig, input: OrchestratorChildRequest,
-  submission: SubmissionGate): RepoAgentSession {
+  submission: SubmissionGate, statusUpdates: boolean): RepoAgentSession {
   const request = OrchestratorChildRequestSchema.parse(input);
   const preset = requireOrchestratorWorkerPreset(config, { id: request.taskId, workerPresetId: request.workerPresetId });
   return startRepoWorkerRun(ctx, {
@@ -31,6 +31,7 @@ export function startOrchestratorChild(ctx: ServerContext, config: SiftConfig, i
     allowedTools: [...preset.allowedTools],
     modelQueueTimeout: 'none',
     submissionGate: submission,
+    statusUpdates,
   }).session;
 }
 
````

Modify `src/orchestrator/run.ts`:

````diff
@@ -617,7 +617,7 @@ export class OrchestratorRun implements OrchestratorLiveRun, OrchestratorToolHos
     const session = startOrchestratorChild(this.ctx, this.config, {
       runId: this.runId, taskId: task.id, attempt: attempt.attempt, childRunId: attempt.childRunId,
       workerPresetId: task.workerPresetId, repoRoot: this.request.repoRoot, work, instruction,
-    }, submission);
+    }, submission, this.request.sessionId !== null);
     const source = { taskId: task.id, childRunId: attempt.childRunId };
     const detachWarnings = session.attach({ wantsLiveText: false, writeProgress: (event) => this.recordWarning(event, source) });
     const child: LiveChild = { attempt, task, baseline, repository, submission, session, detachWarnings };
````

- [ ] **Step 4: Run the tests and the checks**

Run: `node .\src\test-runner\run-tests.ts status-updates admitted-model-routes repo-search-loop tool-action-processor`
Run: `node .\src\test-runner\run-tests.ts --process orchestrator-run.e2e`
Expected: every test passes.

Run: `npx tsc -p tsconfig.test.json`, then `npx eslint tests/status-updates-loop.test.ts tests/admitted-model-routes.e2e.test.ts tests/process/orchestrator-run.e2e.test.ts tests/helpers/tool-action-processor.ts src/repo-search/execute.ts src/repo-search/engine.ts src/repo-search/engine/task-loop-support.ts src/repo-search/engine/task-loop.ts src/repo-search/engine/tool-action-processor.ts src/status-server/routes/repo-agent.ts src/status-server/routes/chat-repo-agent.ts src/orchestrator/workers.ts src/orchestrator/run.ts`
Expected: all exit 0 with no output.

The isolation test compares a run without updates with five that had one (shown, refused, tool call, engine error, hang): planner request bodies byte for byte, token totals, cache breaks and new messages are identical.

**Acceptance:** the tests of this task pass, type-check and lint are clean, and no file outside the list above changed.

### Task 7: Chat delivery

The update is a journal `display` event that projects to its own row kind. It is restored after a reload and kept by a finished or stopped run. It is not replayable, so no model history and no context replay ever sees it.

**Files:**
- `tests/chat-stream-progress-writer.test.ts`
- `tests/chat-transcript-reducer.test.ts`
- `tests/chat-run-projection.test.ts`
- `tests/chat-context-replay.test.ts`
- `packages/contracts/src/chat.ts`
- `packages/contracts/src/chat-transcript-reducer.ts`
- `src/status-server/chat-stream-progress-writer.ts`
- `src/status-server/chat-history-archive.ts`

- [ ] **Step 1: Write the tests**

Modify `tests/chat-stream-progress-writer.test.ts`:

````diff
@@ -19,7 +19,9 @@ function fixture() {
     }
     return events;
   };
-  return { writer, displayEvents, publishes: () => publishes };
+  const contextEvents = () => [...new ChatJournalStore(database).readAll(recorder.operationId)]
+    .filter(({ event }) => event.kind === 'context_initialized' || event.kind === 'context_spliced').length;
+  return { writer, displayEvents, contextEvents, publishes: () => publishes };
 }
 
 function progressUpdate(turn: number, progressText: string): RepoSearchProgressEvent {
@@ -87,3 +89,14 @@ test('asking and answering a question each publish to live viewers', async () =>
   assert.equal(publishes, 2);
   assert.equal(Array.from(new ChatJournalStore(database).readAll(recorder.operationId)).at(-1)?.event.kind, 'question_resolved');
 });
+
+test('a status update is journalled for readers and stays out of the model context', () => {
+  const { writer, displayEvents, publishes, contextEvents } = fixture();
+  const update = { updateId: '4f9c1f9a-0000-4000-8000-0000000000c1', text: 'Making sure the fix holds.', createdAtUtc: '2026-11-24T09:00:00.000Z' };
+  const before = contextEvents();
+  writer.write(progressUpdate(1, 'calling'));
+  writer.write({ kind: 'status_update', taskId: 'task', turn: 1, maxTurns: 200, elapsedMs: 2, ...update });
+  assert.deepEqual(displayEvents(), [{ kind: 'progress', delta: { turn: 1, offset: 0, text: 'calling' } }, { kind: 'status_update', ...update }]);
+  assert.equal(publishes(), 2);
+  assert.equal(contextEvents(), before);
+});
````

Modify `tests/chat-transcript-reducer.test.ts`:

````diff
@@ -418,3 +418,18 @@ test('injected memory is one display-only row that the model never replays and a
   assert.equal(messages.some(isReplayableChatMessage), false);
   assert.deepEqual(finalizeChatRunTranscript(messages, 'completed', metadata).map((message) => message.kind), ['memory_context']);
 });
+
+test('status updates are display-only rows that the model never replays and every finished run keeps', () => {
+  const first = { kind: 'status_update', updateId: '4f9c1f9a-0000-4000-8000-0000000000c1', text: 'Reading the parts involved.', createdAtUtc: '2026-11-24T09:00:00.000Z' } as const;
+  const second = { ...first, updateId: '4f9c1f9a-0000-4000-8000-0000000000c2', text: 'Making sure the fix holds.', createdAtUtc: '2026-11-24T09:02:00.000Z' };
+  let messages = reduceChatTranscript([], first, metadata);
+  messages = reduceChatTranscript(reduceChatTranscript(messages, second, metadata), second, metadata);
+  assert.deepEqual(messages.map((message) => [message.id, message.role, message.kind, message.content, message.createdAtUtc]), [
+    [`test-status-${first.updateId}`, 'assistant', 'assistant_status_update', first.text, first.createdAtUtc],
+    [`test-status-${second.updateId}`, 'assistant', 'assistant_status_update', second.text, second.createdAtUtc],
+  ]);
+  assert.equal(messages.some(isReplayableChatMessage), false);
+  assert.equal(finalizeChatRunTranscript(messages, 'completed', metadata).length, 2);
+  const stopped = finalizeChatRunTranscript(messages, 'user_stop', metadata);
+  assert.deepEqual(stopped.map((message) => message.runTerminalCause), [undefined, 'user_stop']);
+});
````

Modify `tests/chat-run-projection.test.ts`:

````diff
@@ -386,3 +386,15 @@ test('a retained history revision is checkpointed so later reconciliations stay
   assert.equal(messages.some(message => message.id === narration.id), false);
   assert.equal(messages.find(message => message.kind === 'assistant_answer')?.content, 'It lives in research/physics.py. More.');
 });
+
+test('a status update is restored with its run, between the call it was written in and the answer', () => {
+  const { runtimeRoot, database } = openSession('chat-run-projection-status-');
+  const update = { kind: 'status_update', updateId: '4f9c1f9a-0000-4000-8000-0000000000c1', text: 'Finding the right part first.', createdAtUtc: AT } as const;
+  const events = runEvents();
+  const operationId = writeRun(database, [...events.slice(0, 4), { kind: 'display', event: update }, ...events.slice(4)]);
+  assert.equal(reconcileChatRun(database, operationId).status, 'ok');
+  assert.deepEqual(projectedMessages(runtimeRoot).map((message) => [message.kind, message.kind === 'assistant_status_update' ? message.content : null]), [
+    ['user_text', null], ['assistant_narration', null], ['assistant_tool_call', null],
+    ['assistant_status_update', 'Finding the right part first.'], ['assistant_answer', null],
+  ]);
+});
````

Modify `tests/chat-context-replay.test.ts`:

````diff
@@ -783,3 +783,13 @@ test('a batch answered in context releases its result payload while an unanswere
   for (const envelope of envelopes(coalescingPrefix())) open.apply(envelope);
   assert.deepEqual(open.retainedToolPayloadIds(), ['tc_dup']);
 });
+
+test('a status update changes nothing in the replayed planner context', () => {
+  const { transcript, recorder } = runLiveTranscript();
+  const update: ChatJournalEvent = { kind: 'display', event: {
+    kind: 'status_update', updateId: '4f9c1f9a-0000-4000-8000-0000000000c1', text: 'Finding the right part first.', createdAtUtc: RECORDED_AT,
+  } };
+  const replayed = replayChatContext(envelopes([...recorder.events, update]));
+  assert.equal(replayed.status, 'ok');
+  assert.deepEqual(replayed.messages, transcript.getMessages());
+});
````

- [ ] **Step 2: Run them and see them fail**

Run: `node .\src\test-runner\run-tests.ts chat-stream-progress-writer chat-transcript-reducer chat-run-projection chat-context-replay`
Expected: FAIL (no transcript event `status_update`)

- [ ] **Step 3: Implement**

Modify `packages/contracts/src/chat.ts`:

````diff
@@ -151,6 +151,7 @@ export const ChatTranscriptMessageKindSchema = z.enum([
   'assistant_tool_call',
   'assistant_narration',
   'assistant_progress',
+  'assistant_status_update',
   'tool_image',
   'compaction_summary',
   'repo_agent_approval',
@@ -245,12 +246,19 @@ const ChatMemoryContextMessageSchema = ChatMessageBaseSchema.extend({
   kind: z.literal('memory_context'),
 });
 
+/** A sentence or two for the reader about what the run was doing; shown, never replayed. */
+const ChatStatusUpdateMessageSchema = ChatMessageBaseSchema.extend({
+  role: z.literal('assistant'),
+  kind: z.literal('assistant_status_update'),
+});
+
 export const ChatTranscriptMessageSchema = z.discriminatedUnion('kind', [
   ChatTranscriptToolCallMessageSchema,
   ChatRepoAgentApprovalMessageSchema,
   ChatTranscriptNonToolMessageSchema,
   ChatTranscriptStreamTextMessageSchema,
   ChatMemoryContextMessageSchema,
+  ChatStatusUpdateMessageSchema,
 ]);
 export type ChatTranscriptMessage = z.infer<typeof ChatTranscriptMessageSchema>;
 
@@ -304,6 +312,7 @@ export const PersistedChatTranscriptMessageSchema = z.discriminatedUnion('kind',
   ChatTranscriptNonToolMessageSchema,
   ChatTranscriptStreamTextMessageSchema,
   ChatMemoryContextMessageSchema,
+  ChatStatusUpdateMessageSchema,
 ]);
 export type PersistedChatTranscriptMessage = z.infer<typeof PersistedChatTranscriptMessageSchema>;
 
````

Modify `packages/contracts/src/chat-transcript-reducer.ts`:

````diff
@@ -54,6 +54,7 @@ export const ChatTranscriptEventSchema = z.discriminatedUnion('kind', [
   z.strictObject({ kind: z.literal('tool_outcome'), outcome: ChatToolOutcomeSchema }),
   z.strictObject({ kind: z.literal('submission'), message: ChatSubmittedUserMessageSchema }),
   z.strictObject({ kind: z.literal('memory_context'), content: z.string().min(1) }),
+  z.strictObject({ kind: z.literal('status_update'), updateId: z.string().uuid(), text: z.string().min(1), createdAtUtc: z.string().datetime() }),
 ]);
 export type ChatTranscriptEvent = z.infer<typeof ChatTranscriptEventSchema>;
 
@@ -85,6 +86,7 @@ const ChatMessageIdentitySchema = z.discriminatedUnion('kind', [
   z.strictObject({ kind: z.enum(['thinking', 'narration', 'answer']), turn: z.number().int().nonnegative() }),
   z.strictObject({ kind: z.literal('tool'), toolCallId: z.string().min(1) }),
   z.strictObject({ kind: z.literal('approval'), approvalId: z.string().min(1) }),
+  z.strictObject({ kind: z.literal('status'), updateId: z.string().uuid() }),
   z.strictObject({ kind: z.literal('summary'), revision: z.number().int().positive() }),
   z.strictObject({ kind: z.enum(['user', 'progress', 'memory', 'answer-final', 'answer-stopped']) }),
 ]);
@@ -95,6 +97,7 @@ export function buildChatMessageId(messageIdPrefix: string, input: z.infer<typeo
   if ('turn' in identity) return `${prefix}-${identity.kind}-${identity.turn}`;
   if (identity.kind === 'tool') return `${prefix}-tool-${identity.toolCallId}`;
   if (identity.kind === 'approval') return `${prefix}-approval-${identity.approvalId}`;
+  if (identity.kind === 'status') return `${prefix}-status-${identity.updateId}`;
   if (identity.kind === 'summary') return `${prefix}-summary-${identity.revision}`;
   return `${prefix}-${identity.kind}`;
 }
@@ -128,7 +131,7 @@ function upsertMessage(
 
 function textMessage(
   id: string,
-  kind: TextRowKind | 'memory_context',
+  kind: TextRowKind | 'memory_context' | 'assistant_status_update',
   content: string,
   metadata: ChatTranscriptMetadata,
 ): ChatTranscriptMessage {
@@ -344,6 +347,10 @@ export function reduceChatTranscript(
   if (event.kind === 'memory_context') {
     return upsertMessage(messages, textMessage(buildChatMessageId(metadata.messageIdPrefix, { kind: 'memory' }), 'memory_context', event.content, metadata));
   }
+  if (event.kind === 'status_update') {
+    return upsertMessage(messages, textMessage(buildChatMessageId(metadata.messageIdPrefix, { kind: 'status', updateId: event.updateId }),
+      'assistant_status_update', event.text, { ...metadata, createdAtUtc: event.createdAtUtc }));
+  }
   return reduceToolEvent(messages, event, metadata);
 }
 
````

Modify `src/status-server/chat-stream-progress-writer.ts`:

````diff
@@ -69,6 +69,8 @@ export class ChatStreamProgressWriter extends ProgressWriter<RepoSearchProgressE
       this.recorder.recordPresentation({ kind: 'prompt', prompt: toChatStreamPromptEvent(event) });
     } else if (event.kind === 'tool_start' || event.kind === 'tool_result') {
       this.recorder.recordDisplay({ kind: 'tool', tool: toChatStreamToolEvent(event) });
+    } else if (event.kind === 'status_update') {
+      this.recorder.recordDisplay({ kind: 'status_update', updateId: event.updateId, text: event.text, createdAtUtc: event.createdAtUtc });
     } else if (event.kind !== 'queued_user_message') return; // the recorder journaled the delivery when it claimed it
     this.broadcast.publish();
   }
````

Modify `src/status-server/chat-history-archive.ts`:

````diff
@@ -39,7 +39,7 @@ const ResponseSchema = z.object({ turn: z.number().int().positive(), text: z.str
 const DIAGNOSTIC_KINDS = new Set([
   'model_inventory', 'turn_preflight_start', 'turn_preflight_budget', 'turn_model_request',
   'provider_request_start', 'provider_request_done', 'provider_request_error',
-  'prompt_cache_epoch_reset', 'turn_progress',
+  'prompt_cache_epoch_reset', 'turn_progress', 'status_update',
 ]);
 const EVIDENCE_KINDS = new Set([
   'run_start', 'turn_new_messages', 'turn_model_response', 'turn_command_start',
````

- [ ] **Step 4: Run the tests and the checks**

Run: `node .\src\test-runner\run-tests.ts chat-stream-progress-writer chat-transcript-reducer chat-run-projection chat-context-replay chat-history`
Expected: every test passes.

Run: `npx tsc -p tsconfig.test.json`, `npx tsc -p dashboard/tsconfig.json`, `npx tsc -p dashboard/tsconfig.test.json`, then `npx eslint tests/chat-stream-progress-writer.test.ts tests/chat-transcript-reducer.test.ts tests/chat-run-projection.test.ts tests/chat-context-replay.test.ts packages/contracts/src/chat.ts packages/contracts/src/chat-transcript-reducer.ts src/status-server/chat-stream-progress-writer.ts src/status-server/chat-history-archive.ts`
Expected: all exit 0 with no output.

**Acceptance:** the tests of this task pass, type-check and lint are clean, and no file outside the list above changed.

### Task 8: The update block in the chat turn and the agent card

A live turn starts with the block: "Earlier updates (N)" closed, then the current update. A finished turn keeps all of them under "Updates (N)". An update is current while its command runs, and dimmed with "N tool calls ago" afterwards. A child's view keeps the last 10 in memory.

In `chatTurns.ts` the old local name `isStatusUpdate` meant narration; it becomes `isSpokenNarration`.

**Files:**
- `tests/contracts-orchestrator.test.ts`
- `tests/orchestrator-child-activity.test.ts`
- `tests/orchestrator-live-activity.test.ts`
- `dashboard/tests/lib/chatTurns.test.ts`
- `dashboard/tests/lib/turn-token-parity.test.ts`
- `dashboard/tests/chat-tab.test.tsx`
- `dashboard/tests/orchestrator-run-panel.test.tsx`
- `dashboard/tests/orchestrator-view.test.ts`
- `packages/contracts/src/orchestrator.ts`
- `src/orchestrator/child-activity.ts`
- `src/orchestrator/live-activity.ts`
- `dashboard/src/lib/chatTurns.ts`
- `dashboard/src/components/StatusUpdates.tsx`
- `dashboard/src/components/OrchestratorTaskRow.tsx`
- `dashboard/src/tabs/ChatTab.tsx`
- `dashboard/src/styles/chat.css`
- `dashboard/src/styles/orchestrator.css`

- [ ] **Step 1: Write the tests**

Modify `tests/contracts-orchestrator.test.ts`:

````diff
@@ -163,7 +163,7 @@ test('a stored failure carries one of the known failure codes', () => {
 
 const LIVE_CHILD = {
   childRunId: '00000000-0000-4000-8000-000000000002', taskId: 'greeting',
-  waitingForModel: false, turn: 3, maxTurns: 40, promptTokens: 1200, tools: [],
+  waitingForModel: false, turn: 3, maxTurns: 40, promptTokens: 1200, tools: [], updates: [],
 };
 const LIVE_TOOL = { toolCallId: 't1', turn: 3, activityKind: 'edit', command: 'write src/greeting.ts', status: 'running' };
 const SCHEDULE = {
````

Modify `tests/orchestrator-child-activity.test.ts`:

````diff
@@ -1,13 +1,13 @@
 import assert from 'node:assert/strict';
 import test from 'node:test';
 
-import { ORCHESTRATOR_RECENT_TOOL_LIMIT, type OrchestratorChildActivity } from '@siftkit/contracts';
+import { ORCHESTRATOR_RECENT_TOOL_LIMIT, ORCHESTRATOR_STATUS_UPDATE_LIMIT, type OrchestratorChildActivity } from '@siftkit/contracts';
 import { reduceChildActivity } from '../src/orchestrator/child-activity.ts';
 import type { OperationProgressEvent } from '../src/repo-search/types.ts';
 
 const START: OrchestratorChildActivity = {
   childRunId: '00000000-0000-4000-8000-000000000002', taskId: 'write',
-  waitingForModel: false, turn: 0, maxTurns: null, promptTokens: 0, tools: [],
+  waitingForModel: false, turn: 0, maxTurns: null, promptTokens: 0, tools: [], updates: [],
 };
 
 function toolStart(id: string): OperationProgressEvent {
@@ -42,3 +42,18 @@ test('tool calls start running, settle by exit code, and only the most recent ar
 test('events with nothing visible return the same view', () => {
   assert.equal(reduceChildActivity(START, { kind: 'thinking', turn: 1, maxTurns: 40, thinkingText: 'hmm' }), START);
 });
+
+test('status updates keep the newest ten and count the calls that ended since', () => {
+  const update = (index: number): OperationProgressEvent => ({ kind: 'status_update', taskId: 'write', turn: 2, maxTurns: 40, elapsedMs: 25,
+    updateId: `00000000-0000-4000-8000-0000000000${String(index).padStart(2, '0')}`, text: `Update ${index}.`, createdAtUtc: '2026-11-24T09:00:00.000Z' });
+  let activity = reduceChildActivity(START, toolStart('a'));
+  activity = reduceChildActivity(activity, update(1));
+  assert.deepEqual(activity.updates.map((entry) => [entry.text, entry.callsSince]), [['Update 1.', 0]]);
+  activity = reduceChildActivity(activity, toolResult('a', 0));
+  activity = reduceChildActivity(reduceChildActivity(activity, toolStart('b')), update(2));
+  activity = reduceChildActivity(activity, toolResult('b', 1));
+  assert.deepEqual(activity.updates.map((entry) => entry.callsSince), [2, 1]);
+  for (let index = 3; index <= 12; index += 1) activity = reduceChildActivity(activity, update(index));
+  assert.equal(ORCHESTRATOR_STATUS_UPDATE_LIMIT, 10);
+  assert.deepEqual([activity.updates.length, activity.updates[0]?.text, activity.updates.at(-1)?.text], [10, 'Update 3.', 'Update 12.']);
+});
````

Modify `tests/orchestrator-live-activity.test.ts`:

````diff
@@ -50,7 +50,7 @@ test('each scheduler pass is published as it was decided, and a snapshot is a co
   assert.deepEqual(published.at(-1), { runId: RUN_ID, schedule: SCHEDULE, parent: null, children: [] });
   const snapshot = live.snapshot();
   snapshot.schedule?.claims.pop();
-  snapshot.children.push({ childRunId: CHILD_ID, taskId: 'x', waitingForModel: false, turn: 0, maxTurns: null, promptTokens: 0, tools: [] });
+  snapshot.children.push({ childRunId: CHILD_ID, taskId: 'x', waitingForModel: false, turn: 0, maxTurns: null, promptTokens: 0, tools: [], updates: [] });
   assert.deepEqual(live.snapshot(), { runId: RUN_ID, schedule: SCHEDULE, parent: null, children: [] });
 });
 
````

Modify `dashboard/tests/lib/chatTurns.test.ts`:

````diff
@@ -497,3 +497,21 @@ test('injected memory belongs to its run turn but is never its main slot or an I
   const memoryOnly = groupMessagesIntoTurns(messages.slice(0, 2), new Set(['m1']));
   assert.equal(memoryOnly[1]?.main, null, 'before the answer streams, memory does not take the main slot');
 });
+
+test('status updates stand apart from steps and the main slot, and count the calls that ended since', () => {
+  const messages = [
+    message({ id: 'u1', role: 'user', kind: 'user_text', content: 'fix it' }),
+    message({ id: 'c1', kind: 'assistant_tool_call', sourceRunId: 'run-1' }),
+    message({ id: 's1', kind: 'assistant_status_update', content: 'Reading first.', sourceRunId: 'run-1' }),
+    message({ id: 'c2', kind: 'assistant_tool_call', sourceRunId: 'run-1', toolCallExecutionState: 'executing', toolCallStatus: 'running' }),
+    message({ id: 's2', kind: 'assistant_status_update', content: 'Checking it.', sourceRunId: 'run-1' }),
+  ];
+  const live = groupMessagesIntoTurns(messages, new Set(['c1', 's1', 'c2', 's2']))[1];
+  assert.deepEqual(live?.updates, [
+    { updateId: 's1', text: 'Reading first.', callsSince: 1 }, { updateId: 's2', text: 'Checking it.', callsSince: 0 },
+  ]);
+  assert.deepEqual([live?.main, live?.steps, live?.showRecentActivity], [null, [], true]);
+  const settled = groupMessagesIntoTurns([...messages, message({ id: 'a1', content: 'Done.', sourceRunId: 'run-1' })], new Set())[1];
+  assert.deepEqual([settled?.main?.id, settled?.steps.map((step) => step.id), settled?.updates.length], ['a1', ['c1', 'c2'], 2]);
+  assert.deepEqual(settled?.messages.map((row) => row.id), ['c1', 's1', 'c2', 's2', 'a1'], 'deleting the turn deletes its updates');
+});
````

Modify `dashboard/tests/lib/turn-token-parity.test.ts`:

````diff
@@ -86,7 +86,7 @@ test('the badge is identical across the live to settled transition', () => {
     [],
   );
   const live: ChatTurn = {
-    key: 'live', isLive: true, messages: liveMessages, main: null, memory: null, liveThinking: [],
+    key: 'live', isLive: true, messages: liveMessages, main: null, memory: null, updates: [], liveThinking: [],
     steps: [], shownImages: [], recentActivities: [], showRecentActivity: false,
   };
 
@@ -99,7 +99,7 @@ test('the badge is identical across the live to settled transition', () => {
     answerMessage('a1', 60),
   ];
   const settled: ChatTurn = {
-    key: 'run:run-1', isLive: false, messages: settledMessages, main: settledMessages[4] ?? null, memory: null,
+    key: 'run:run-1', isLive: false, messages: settledMessages, main: settledMessages[4] ?? null, memory: null, updates: [],
     liveThinking: [], steps: [], shownImages: [], recentActivities: [], showRecentActivity: false,
   };
 
@@ -115,7 +115,7 @@ test('the badge is identical across the live to settled transition', () => {
 test('a settled turn counts every per-step thinking row, not just the answer row', () => {
   const messages = [thinkingMessage('t1', 120), thinkingMessage('t2', 95), answerMessage('a1', 60)];
   const settled: ChatTurn = {
-    key: 'run:run-1', isLive: false, messages, main: messages[2] ?? null, memory: null, liveThinking: [],
+    key: 'run:run-1', isLive: false, messages, main: messages[2] ?? null, memory: null, updates: [], liveThinking: [],
     steps: [], shownImages: [], recentActivities: [], showRecentActivity: false,
   };
   assert.equal(getTurnTokenDisplay(settled, new Map()).tokenCount, 275);
@@ -124,7 +124,7 @@ test('a settled turn counts every per-step thinking row, not just the answer row
 test('the display is inexact when any contributing row is estimated', () => {
   const estimated = { ...thinkingMessage('t1', 120), thinkingTokensEstimated: true };
   const settled: ChatTurn = {
-    key: 'run:run-1', isLive: false, messages: [estimated], main: null, memory: null, liveThinking: [],
+    key: 'run:run-1', isLive: false, messages: [estimated], main: null, memory: null, updates: [], liveThinking: [],
     steps: [], shownImages: [], recentActivities: [], showRecentActivity: false,
   };
   assert.equal(getTurnTokenDisplay(settled, new Map()).exact, false);
````

Modify `dashboard/tests/chat-tab.test.tsx`:

````diff
@@ -588,7 +588,7 @@ test('orchestrator mode hands the live activity and the last work phase to the r
   const event = { runId: ORCHESTRATOR_RUN_ID, sequence: 1, atUtc: '2026-09-23T12:00:00.000Z', phase: 'executing', message: 'Executing.',
     taskId: null, purpose: null, attempt: null, childRunId: null };
   const activity = OrchestratorActivitySchema.parse({ runId: ORCHESTRATOR_RUN_ID, children: [{ childRunId, taskId: 'greet',
-    waitingForModel: false, turn: 2, maxTurns: 40, promptTokens: 100, tools: [] }], schedule: null,
+    waitingForModel: false, turn: 2, maxTurns: 40, promptTokens: 100, tools: [], updates: [] }], schedule: null,
     parent: { waitingForModel: false, parked: true, promptTokens: 52_000, contextTokens: 200_000, prompt: null, turnCount: 3, turns: [] } });
   const encoder = new TextEncoder();
   globalThis.fetch = async (input) => {
@@ -2121,3 +2121,32 @@ test('new handler identities from a controller re-render leave the stored histor
     assert.deepEqual(deleted, ['u1']);
   } finally { view.unmount(); }
 });
+
+test('status updates lead the live turn, the current one last, and fold together once the turn is finished', () => {
+  const update = (id: string, text: string): LiveTranscriptStep => ({ kind: 'status_update', updateId: `4f9c1f9a-0000-4000-8000-0000000000${id}`, text,
+    createdAtUtc: '2026-11-24T09:00:00.000Z' });
+  const command = { toolCallId: 't1', turn: 1, maxTurns: 45, activityKind: 'validate', activitySubject: { kind: 'none' }, command: 'npm test', promptTokenCount: 0 } as const;
+  const steps: LiveTranscriptStep[] = [{ kind: 'tool', tool: { kind: 'tool_start', ...command } }, update('c1', 'Reading first.'), update('c2', 'Making sure it holds.')];
+  const page = (live: readonly LiveTranscriptStep[]): Document => new window.DOMParser().parseFromString(render({ selectedSessionId: SESSION_B.id,
+    runtimeHub: new ChatRuntimeHub(buildThinkingStore({ content: 'fix it', images: [], operationKind: 'repo-agent', marker: 'THINK' }, live)) }), 'text/html');
+  const running = page(steps).querySelector('.status-updates');
+  assert.equal(running?.querySelector('summary')?.textContent, 'Earlier updates (1)');
+  assert.equal(running?.querySelector('li')?.textContent, 'Reading first.');
+  assert.equal(running?.querySelector('.status-update')?.textContent, 'Making sure it holds.');
+  assert.equal(running?.querySelector('small'), null, 'the command is still running');
+  assert.ok(running?.compareDocumentPosition(running.parentElement?.querySelector('.recent-activity') ?? running) === window.Node.DOCUMENT_POSITION_FOLLOWING);
+  const result: LiveTranscriptStep = { kind: 'tool', tool: { kind: 'tool_result', ...command, exitCode: 0, outputSnippet: 'ok', outputTokens: 0, outputTokensEstimated: false } };
+  const past = page([...steps, result]).querySelector('.status-updates');
+  assert.equal(past?.querySelector('.status-update.past')?.textContent, 'Making sure it holds.');
+  assert.equal(past?.querySelector('small')?.textContent, '1 tool call ago');
+
+  const row = (id: string, kind: 'assistant_status_update' | 'assistant_answer', content: string) => msg({ id, role: 'assistant', kind, content, sourceRunId: 'run-1' });
+  const finished = new window.DOMParser().parseFromString(render({ selectedSession: { ...SESSION_A,
+    messages: [row('s1', 'assistant_status_update', 'Reading first.'), row('s2', 'assistant_status_update', 'Making sure it holds.'), row('a1', 'assistant_answer', 'Done.')] } }), 'text/html');
+  const folded = finished.querySelector('details.status-updates');
+  assert.equal(folded?.querySelector('summary')?.textContent, 'Updates (2)');
+  assert.equal(folded?.hasAttribute('open'), false);
+  assert.deepEqual([...folded?.querySelectorAll('li') ?? []].map((item) => item.textContent), ['Reading first.', 'Making sure it holds.']);
+  const onlyUpdates = new window.DOMParser().parseFromString(render({ selectedSession: { ...SESSION_A, messages: [row('s1', 'assistant_status_update', 'Reading first.')] } }), 'text/html');
+  assert.equal(onlyUpdates.querySelector('details.status-updates summary')?.textContent, 'Updates (1)', 'a run stopped before its answer keeps them too');
+});
````

Modify `dashboard/tests/orchestrator-run-panel.test.tsx`:

````diff
@@ -54,7 +54,7 @@ function renderPanel(state: OrchestratorRunState, activity: OrchestratorActivity
 }
 
 const LIVE_CHILD: OrchestratorChildActivity = {
-  childRunId: CHILD_ID, taskId: TASK.id, waitingForModel: false, turn: 9, maxTurns: 40, promptTokens: 1240,
+  childRunId: CHILD_ID, taskId: TASK.id, waitingForModel: false, turn: 9, maxTurns: 40, promptTokens: 1240, updates: [],
   tools: [
     { toolCallId: 't1', turn: 8, activityKind: 'edit', command: 'write src/a.ts', status: 'succeeded' },
     { toolCallId: 't2', turn: 9, activityKind: 'command', command: 'npm test', status: 'running' },
@@ -325,3 +325,30 @@ test('a fold the user opened stays open when the next turn arrives', () => {
   rerender(view(13));
   assert.deepEqual([isOpen('Earlier turns (9)'), isOpen('Latest calls (2)')], [true, true]);
 });
+
+test('an agent card leads with its current update, earlier ones folded above it and its calls below', () => {
+  const update = (index: number, callsSince: number) => ({ updateId: `4f9c1f9a-0000-4000-8000-0000000000c${index}`, text: `Update ${index}.`,
+    createdAtUtc: '2026-11-24T09:00:00.000Z', callsSince });
+  const state = runState({ attempts: [attempt('implementation', 1, null)] });
+  const panel = (updates: ReturnType<typeof update>[]) => (
+    <OrchestratorRunPanel state={state} activity={liveActivity([{ ...LIVE_CHILD, updates }])} workPhase={null} lastMessage={null} onDecide={() => undefined} onAbort={() => undefined} />
+  );
+  const { rerender } = render(panel([]));
+  const card = screen.getByLabelText(`Agent ${CHILD_ID}`);
+  assert.equal(card.querySelector('.status-updates'), null);
+  rerender(panel([update(1, 0)]));
+  assert.equal(card.querySelector('.status-updates details'), null);
+  assert.equal(card.querySelector('.status-update')?.className, 'status-update');
+  rerender(panel([update(1, 5), update(2, 3)]));
+  const fold = screen.getByText('Earlier updates (1)').closest('details');
+  assert.ok(fold instanceof window.HTMLDetailsElement);
+  assert.equal(fold.open, false);
+  assert.deepEqual([...fold.querySelectorAll('li')].map((item) => item.textContent), ['Update 1.']);
+  assert.equal(card.querySelector('.status-update.past')?.textContent, 'Update 2.');
+  screen.getByText('3 tool calls ago');
+  fireEvent.click(screen.getByText('Earlier updates (1)'));
+  rerender(panel([update(1, 5), update(2, 3), update(3, 0)]));
+  assert.ok(fold.open, 'a new update never folds what the reader opened');
+  const order = [...card.querySelectorAll('summary, .status-update')].map((element) => element.textContent);
+  assert.deepEqual(order, ['Earlier updates (2)', 'Update 3.', 'Latest calls (2)']);
+});
````

Modify `dashboard/tests/orchestrator-view.test.ts`:

````diff
@@ -56,7 +56,7 @@ const SCHEDULE: OrchestratorSchedule = {
 const ACTIVITY: OrchestratorActivity = { runId: RUN_ID, schedule: SCHEDULE, parent: null, children: [] };
 
 const CHILD: OrchestratorChildActivity = {
-  childRunId: CHILD_ID, taskId: 'write', waitingForModel: false, turn: 3, maxTurns: 40, promptTokens: 1000, tools: [],
+  childRunId: CHILD_ID, taskId: 'write', waitingForModel: false, turn: 3, maxTurns: 40, promptTokens: 1000, tools: [], updates: [],
 };
 
 function taskOf(state: OrchestratorRunState, id: string) {
````

- [ ] **Step 2: Run them and see them fail**

Run: `node .\src\test-runner\run-tests.ts orchestrator-child-activity`
Expected: FAIL (no `updates` in the child activity)

- [ ] **Step 3: Implement**

Modify `packages/contracts/src/orchestrator.ts`:

````diff
@@ -389,12 +389,21 @@ export const OrchestratorToolCallActivitySchema = z.object({
 }).strict();
 export type OrchestratorToolCallActivity = z.infer<typeof OrchestratorToolCallActivitySchema>;
 
-/** A running child as the parent observes it; in memory only, dropped when the child settles. */
+export const ORCHESTRATOR_STATUS_UPDATE_LIMIT = 10;
+
+/** What a child said it was doing, and how many of its tool calls have ended since. */
+export const OrchestratorStatusUpdateSchema = z.object({
+  updateId: z.string().uuid(), text: z.string().min(1), createdAtUtc: z.string().datetime(), callsSince: z.number().int().nonnegative(),
+}).strict();
+export type OrchestratorStatusUpdate = z.infer<typeof OrchestratorStatusUpdateSchema>;
+
+/** A running child as the parent observes it; in memory only, dropped when the child settles. `updates` is oldest first. */
 export const OrchestratorChildActivitySchema = z.object({
   childRunId: z.string().uuid(), taskId: z.string().min(1),
   waitingForModel: z.boolean(), turn: z.number().int().nonnegative(), maxTurns: z.number().int().positive().nullable(),
   promptTokens: z.number().nonnegative(),
   tools: z.array(OrchestratorToolCallActivitySchema).max(ORCHESTRATOR_RECENT_TOOL_LIMIT),
+  updates: z.array(OrchestratorStatusUpdateSchema).max(ORCHESTRATOR_STATUS_UPDATE_LIMIT),
 }).strict();
 export type OrchestratorChildActivity = z.infer<typeof OrchestratorChildActivitySchema>;
 
````

Modify `src/orchestrator/child-activity.ts`:

````diff
@@ -1,4 +1,4 @@
-import { ORCHESTRATOR_RECENT_TOOL_LIMIT, type OrchestratorChildActivity, type OrchestratorToolCallActivity } from '@siftkit/contracts';
+import { ORCHESTRATOR_RECENT_TOOL_LIMIT, ORCHESTRATOR_STATUS_UPDATE_LIMIT, type OrchestratorChildActivity, type OrchestratorToolCallActivity } from '@siftkit/contracts';
 
 import type { OperationProgressEvent } from '../repo-search/types.ts';
 
@@ -17,8 +17,13 @@ export function reduceChildActivity(activity: OrchestratorChildActivity, event:
     }
     case 'tool_result': {
       if (!activity.tools.some((tool) => tool.toolCallId === event.toolCallId)) return activity;
+      const updates = activity.updates.map((update) => ({ ...update, callsSince: update.callsSince + 1 }));
       const status: OrchestratorToolCallActivity['status'] = event.exitCode === 0 ? 'succeeded' : 'failed';
-      return { ...activity, tools: activity.tools.map((tool) => (tool.toolCallId === event.toolCallId ? { ...tool, status } : tool)) };
+      return { ...activity, updates, tools: activity.tools.map((tool) => (tool.toolCallId === event.toolCallId ? { ...tool, status } : tool)) };
+    }
+    case 'status_update': {
+      const { updateId, text, createdAtUtc } = event;
+      return { ...activity, updates: [...activity.updates, { updateId, text, createdAtUtc, callsSince: 0 }].slice(-ORCHESTRATOR_STATUS_UPDATE_LIMIT) };
     }
     default:
       return activity;
````

Modify `src/orchestrator/live-activity.ts`:

````diff
@@ -53,7 +53,7 @@ export class OrchestratorLiveActivity {
 
   /** Subscribes to the child's progress beside any other subscriber the session has. */
   track(session: Pick<RepoAgentSession, 'attach'>, child: { childRunId: string; taskId: string }): void {
-    this.children.set(child.childRunId, { ...child, waitingForModel: false, turn: 0, maxTurns: null, promptTokens: 0, tools: [] });
+    this.children.set(child.childRunId, { ...child, waitingForModel: false, turn: 0, maxTurns: null, promptTokens: 0, tools: [], updates: [] });
     this.detachers.set(child.childRunId, session.attach({
       wantsLiveText: false,
       writeProgress: (event) => this.apply(child.childRunId, event),
````

Modify `dashboard/src/lib/chatTurns.ts`:

````diff
@@ -21,8 +21,12 @@ export type ChatTurn = {
   main: ChatMessage | null;
   /** The vault memory injected into this run's prompt; shown as its own bubble, never a step. */
   memory: ChatMessage | null;
+  /** What the run said it was doing while its commands ran, oldest first; never a step. */
+  updates: StatusUpdate[];
 };
 
+export type StatusUpdate = { updateId: string; text: string; callsSince: number };
+
 function isAnswerMessage(message: ChatMessage): boolean {
   return message.kind === 'assistant_answer';
 }
@@ -36,10 +40,14 @@ function isMemoryMessage(message: ChatMessage): boolean {
   return message.kind === 'memory_context';
 }
 
-function isStatusUpdate(message: ChatMessage): boolean {
+function isSpokenNarration(message: ChatMessage): boolean {
   return message.kind === 'assistant_narration' && message.content.trim() !== '';
 }
 
+function isStatusUpdate(message: ChatMessage): boolean {
+  return message.kind === 'assistant_status_update';
+}
+
 function isThinkingMessage(message: ChatMessage): boolean {
   return message.kind === 'assistant_thinking';
 }
@@ -69,14 +77,13 @@ function resolveTurnKey(message: ChatMessage, isLive: boolean): string {
 
 function pickMainMessage(turn: ChatTurn, answer: ChatMessage | undefined): ChatMessage | null {
   if (answer) return answer;
-  // The newest status update holds the slot until a newer one or the answer replaces it.
-  const statusUpdates = turn.messages.filter(isStatusUpdate);
-  const status = statusUpdates[statusUpdates.length - 1];
-  if (status) return status;
-  // No answer or status: surface the last non-step message (e.g. a lone user_text message,
+  // The newest narration holds the slot until a newer one or the answer replaces it.
+  const narration = turn.messages.filter(isSpokenNarration).at(-1);
+  if (narration) return narration;
+  // No answer or narration: surface the last non-step message (e.g. a lone user_text message,
   // or the live user bubble before the assistant side starts). A run that is
   // only thinking/tool steps has no main slot.
-  const nonStepMessages = turn.messages.filter((message) => !isStepMessage(message) && !isMemoryMessage(message));
+  const nonStepMessages = turn.messages.filter((message) => !isStepMessage(message) && !isMemoryMessage(message) && !isStatusUpdate(message));
   return nonStepMessages[nonStepMessages.length - 1] ?? null;
 }
 
@@ -91,6 +98,16 @@ function pickRecentActivities(turn: ChatTurn, liveUnanswered: boolean): ToolActi
   return buildToolActivityRing(turn.messages.filter(isToolCallMessage));
 }
 
+/** An update was written during the tool call before it, so that call counts once it has ended, with every call after. */
+function pickStatusUpdates(messages: ChatMessage[]): StatusUpdate[] {
+  return messages.flatMap((message, index) => {
+    if (!isStatusUpdate(message)) return [];
+    const command = messages.slice(0, index).filter(isToolCallMessage).slice(-1);
+    const calls = [...command, ...messages.slice(index).filter(isToolCallMessage)];
+    return [{ updateId: message.id, text: message.content, callsSince: calls.filter((call) => call.toolCallStatus !== 'running').length }];
+  });
+}
+
 function finalizeTurn(turn: ChatTurn): void {
   const answer = turn.messages.find(isAnswerMessage);
   // Once the answer streams, a live turn settles into the ordinary shape.
@@ -102,6 +119,7 @@ function finalizeTurn(turn: ChatTurn): void {
   turn.recentActivities = pickRecentActivities(turn, liveUnanswered);
   turn.showRecentActivity = liveUnanswered && turn.messages.some((message) => message.role === 'assistant');
   turn.memory = turn.messages.find(isMemoryMessage) ?? null;
+  turn.updates = pickStatusUpdates(turn.messages);
   // Live tools belong only to the recent ring. Everything else that is not the
   // main slot or thinking stack stays in Internal Logic.
   turn.shownImages = turn.messages.filter(isShownImageMessage);
@@ -110,6 +128,7 @@ function finalizeTurn(turn: ChatTurn): void {
     && message !== turn.memory
     && !liveThinking.includes(message)
     && !isShownImageMessage(message)
+    && !isStatusUpdate(message)
     && !(liveUnanswered && isToolCallMessage(message))
   ));
 }
@@ -148,6 +167,7 @@ export function groupMessagesIntoTurns(messages: ChatMessage[], liveMessageIds:
         showRecentActivity: false,
         main: null,
         memory: null,
+        updates: [],
       });
     }
     lastGroupingKey = key;
````

Create `dashboard/src/components/StatusUpdates.tsx`:

````tsx
import React from 'react';

import type { StatusUpdate } from '../lib/chatTurns.ts';

/** What the agent says it is doing: the current update last, the earlier ones folded above it. */
export function StatusUpdates({ updates }: { updates: readonly StatusUpdate[] }) {
  const current = updates.at(-1);
  if (current === undefined) return null;
  const earlier = updates.slice(0, -1);
  return (
    <section className="status-updates" aria-label="Status updates">
      {earlier.length === 0 ? null : (
        <details>
          <summary>Earlier updates ({earlier.length})</summary>
          <ol>{earlier.map((update) => <li key={update.updateId}>{update.text}</li>)}</ol>
        </details>
      )}
      <p className={current.callsSince === 0 ? 'status-update' : 'status-update past'}>{current.text}</p>
      {current.callsSince === 0 ? null : <small>{`${current.callsSince} tool call${current.callsSince === 1 ? '' : 's'} ago`}</small>}
    </section>
  );
}
````

Modify `dashboard/src/components/OrchestratorTaskRow.tsx`:

````diff
@@ -12,6 +12,7 @@ import {
   type OrchestratorTaskState,
 } from '@siftkit/contracts';
 import { runLogsHref } from '../lib/format.ts';
+import { StatusUpdates } from './StatusUpdates.tsx';
 import { attemptSummary, contextPercent, formatElapsed, nowDoing, taskTone, waitReason } from '../orchestrator-view.ts';
 
 const VISIBLE_FINDINGS = 3;
@@ -56,6 +57,7 @@ function AgentCard({ child, claim, attempt, workerPresetId, writePaths, now }: {
         <a className="mini-btn" href={runLogsHref(child.childRunId)}>Transcript</a>
       </div>
       <div className="orch-turnbar"><i style={{ width: `${turnWidth}%` }} /></div>
+      <StatusUpdates updates={child.updates} />
       {child.tools.length === 0 ? <div className="hint orch-agent-idle">{child.waitingForModel ? 'Waiting for the model…' : 'No tool calls yet.'}</div> : (
         <details className="orch-agent-calls">
           <summary>Latest calls ({child.tools.length})</summary>
````

Modify `dashboard/src/tabs/ChatTab.tsx`:

````diff
@@ -36,6 +36,7 @@ import { ChatQuestionCard } from '../components/ChatQuestionCard.tsx';
 import { RepoAgentApprovalModeControl } from '../components/RepoAgentApprovalModeControl.tsx';
 import { RepoAgentTurnsControl } from '../components/RepoAgentTurnsControl.tsx';
 import { OrchestratorRunPanel } from '../components/OrchestratorRunPanel.tsx';
+import { StatusUpdates } from '../components/StatusUpdates.tsx';
 import { useOrchestratorRun } from '../hooks/useOrchestratorRun.ts';
 import { PlanMaxTurnsOverrideSchema } from '../lib/chat-composer-inputs.ts';
 import type { LastTurnTelemetry } from '../lib/format.ts';
@@ -713,7 +714,8 @@ function TurnList({ messages, liveMessageIds, liveTokenDisplays, sessionId, pend
           && turn.liveThinking.length === 0
           && turn.recentActivities.length === 0
           && !turn.showRecentActivity
-          && turn.memory === null) {
+          && turn.memory === null
+          && turn.updates.length === 0) {
           const message = turn.main;
           if (!message) { return null; }
           if (message.kind === 'repo_agent_approval') {
@@ -1143,6 +1145,12 @@ function ChatTurnBubble({ turn, tokenDisplays, sessionId, isDirectChatMode, chat
         </span>
       </div>
       {turn.memory ? <MemoryContextRow content={turn.memory.content} /> : null}
+      {turn.showRecentActivity ? <StatusUpdates updates={turn.updates} /> : turn.updates.length === 0 ? null : (
+        <details className="status-updates">
+          <summary>Updates ({turn.updates.length})</summary>
+          <ol>{turn.updates.map((update) => <li key={update.updateId}>{update.text}</li>)}</ol>
+        </details>
+      )}
       {turn.steps.length > 0 ? (
         <details className="internal-logic" onToggle={(event) => setExpandedLogic(event.currentTarget.open)}>
           <summary>Internal Logic ({turn.steps.length})</summary>
````

Modify `dashboard/src/styles/chat.css`:

````diff
@@ -54,6 +54,11 @@
 .think { border-left: 2px solid var(--idle); color: var(--dim); padding: 2px 0 2px 10px; font-size: 0.74rem; margin-top: 8px; font-style: italic; white-space: pre-wrap; }
 .thinking-box, .system-context-bubble, .internal-logic { margin-top: 8px; font-size: 0.74rem; color: var(--dim); }
 .thinking-box > summary, .system-context-bubble > summary, .internal-logic > summary { cursor: pointer; color: var(--dim); }
+.status-updates { margin-top: 8px; font-size: 0.74rem; color: var(--dim); }
+.status-updates summary { cursor: pointer; }
+.status-updates ol { display: grid; gap: 4px; margin: 6px 0; padding: 0; list-style: none; max-height: 180px; overflow-y: auto; }
+.status-updates .status-update { margin: 4px 0 0; padding-left: 9px; border-left: 2px solid var(--acc); color: var(--ink); font-size: 0.82rem; overflow-wrap: anywhere; }
+.status-updates .status-update.past { border-left-color: var(--line); color: var(--dim); }
 .internal-logic-steps, .live-thinking-stack { display: grid; gap: 8px; margin-top: 8px; }
 
 /* ---- recent tool activity ---- */
````

Modify `dashboard/src/styles/orchestrator.css`:

````diff
@@ -49,6 +49,7 @@
 .orch-agent-head .mini-btn { margin-left: auto; }
 .orch-turnbar { height: 3px; background: var(--track); }
 .orch-turnbar i { display: block; height: 100%; background: var(--acc); }
+.orch-agent .status-updates { margin: 0; padding: 6px 10px 0; }
 .orch-agent-idle, .orch-agent-calls { padding: 6px 10px; font-size: 0.72rem; }
 .orch-agent-calls > summary { cursor: pointer; color: var(--dim); }
 .orch-agent-tools { padding: 6px 0 0; display: grid; gap: 2px; }
````

- [ ] **Step 4: Run the tests and the checks**

Run: `node .\src\test-runner\run-tests.ts contracts-orchestrator orchestrator-child-activity orchestrator-live-activity`
Run: `npx vitest run --config .\dashboard\vitest.config.ts chat orchestrator turn-token`
Run: `node .\src\test-runner\run-tests.ts --process orchestrator-layout chat-overflow`
Expected: every test passes.

Run: `npx tsc -p tsconfig.test.json`, `npx tsc -p dashboard/tsconfig.json`, `npx tsc -p dashboard/tsconfig.test.json`, then `npx eslint tests/contracts-orchestrator.test.ts tests/orchestrator-child-activity.test.ts tests/orchestrator-live-activity.test.ts dashboard/tests/lib/chatTurns.test.ts dashboard/tests/lib/turn-token-parity.test.ts dashboard/tests/chat-tab.test.tsx dashboard/tests/orchestrator-run-panel.test.tsx dashboard/tests/orchestrator-view.test.ts packages/contracts/src/orchestrator.ts src/orchestrator/child-activity.ts src/orchestrator/live-activity.ts dashboard/src/lib/chatTurns.ts dashboard/src/components/StatusUpdates.tsx dashboard/src/components/OrchestratorTaskRow.tsx dashboard/src/tabs/ChatTab.tsx`
Expected: all exit 0 with no output.

**Acceptance:** the tests of this task pass, type-check and lint are clean, and no file outside the list above changed.

### Task 9: Final validation

This task changes no file, except for this plan's "What was measured".

- [ ] **Step 1: Full validation**

Run, through `siftkit summary` per the repository rules:

| Command | Expected |
|---|---|
| `npm run typecheck` | exit 0 (it includes lint) |
| `npm run lint` | exit 0 |
| `npm test` | no failures |
| `npm run test:process` | no failures |
| `npm run test:dashboard` | no failures |

The flush-queue tests "an acknowledgement that arrives late…" and "an acknowledgement that is slow…" have tight limits and fail on a loaded machine. Rerun them alone before treating them as a regression.

- [ ] **Step 2: One live orchestrator run, watched in the dashboard**

Start an orchestrator run with two tasks from the dashboard. Check:

- The bar changes at each dispatch, and "Show all N updates" opens at the newest.
- A task shows why it exists, and its running agent shows an update while a check runs.
- The update dims with "N tool calls ago" after the check, and the next one appears below "Earlier updates".
- Reload the page: the bar and the tasks are back. The agent's earlier updates stay while the server keeps running.
- The panel never grows past its pane height, and no row repeats or is cut mid-text. The repaint glitch was seen in a long run, so look again after an hour.

- [ ] **Step 3: One live chat repo-agent run**

Start a repo-agent run from the chat that edits a file and runs the tests. Check that the live turn starts with the update, that the finished turn has "Updates (N)", and that they are still there after a reload. In the run's transcript, every `status_update` event names its outcome; no `prompt_cache_break` follows one.

**Acceptance:** all suites are green, both live runs behave as listed, and anything that does not is reported.

## Gate result (Task 5): failed, fixed, passed

### First run: failed

Run on 2026-11-25 on `exl3-3-8-27b-5bpw`, stopped by its first completed update. No limit was changed.

| Measure | Result |
|---|---|
| First completed update, 20k prompt | No output within 10 s; the request was cancelled. Limit: 6 s at p90 |
| Control samples | 4 of 40 (next turn 0.6, 3.2, 1.8 and 3.0 s at 20k, 50k, 80k and 110k) |
| Completed, cancelled, `breaks`, `delayP90Ms`, extra tokens | Not measured: 0 of 40 samples each |

Cause: with `ReasoningEffort` xhigh the template starts the system message with a reasoning-effort sentence, and with thinking off that sentence is gone. The two prompts share 19 characters, so the engine reads all of it again (about 21,500 tokens at about 2,100 tokens/s). Both presets have the same template and setting, so `exl3-3-8-next-4-18bpw-f16` would fail in the same way. Rendered offline: effort medium shares the whole prompt, xhigh and low share 19 characters.

The unit tests did not see it because they compare messages and exempt the thinking flag from the prefix check; the difference is made later, by the template.

### The fix, with the owner's agreement

The request keeps the planner's thinking flags, so its prompt is the planner's, and sends `CLOSE_OPENED_THINK_BLOCK` as `response_prefix`: the reply starts after the block the template opened, so it does not think. A planner that runs without thinking gets no prefix. The exemption in `assertPromptCacheExtension` is gone, so a status update whose thinking flag differs is rejected. This replaces `thinkingEnabled: false` in Task 4's code; the tree, not Task 4's blocks, is current for `planner-protocol.ts`, `inference-client.ts`, `inference-backend.ts`, `think-markers.ts` and `tests/repo-search-planner-protocol.test.ts`.

### Second run: passed

Same preset, same limits, all 120 samples, 47 minutes.

| Measure | Required | Result |
|---|---|---|
| `completeP90Ms` | 6000 or less | 1419 (median 1198, longest 1626) |
| `extraReadAfterCompletedP90` | 500 or less | 3 |
| `extraReadAfterCancelledP90` | 500 or less | 4 |
| `delayP90Ms` | 250 or less | 0 |
| `breaks` | 0 | 0 |
| `nextTurnExtraP90Ms` (reported) | 1000 to report | completed -95, cancelled 125 |
| `shown` (reported) | none | 39 of 40 |

## What was measured

In the scratch copy with the first plan applied, on this machine, while an orchestrator run was live:

| Check | Result |
|---|---|
| Node suite | 4,800 pass; 6 fail, all of which read files the copy does not have. Two tests were added and run afterwards |
| Process suite | 329 pass; 6 fail. Four read files the copy does not have. The two flush-queue tests pass alone (12 of 12) |
| Dashboard suite | 742 pass |
| Schema upgrade on a copy of the real database | 49 of 49 runs and 247 of 247 attempts parse afterwards; none before |
| Mutations | 12 in the status updates and 4 in the layout, all caught |
| Layout against the mockup | Screenshot compared; panes scroll on their own and the bar stays visible |
| Gate test against a stand-in engine | Runs end to end on one recorded conversation |
| This plan replayed task by task on a clean tree | Every Step 2 fails and every Step 4 passes; every task type-checks; the final tree is identical to the prototype |

A mutation that survived at first found a real fault: the client derives a stream deadline from `maxTokens`, so a 60-token update would have been cut after 3 seconds, reading its prompt included. `totalDeadlineMs` is now explicit, and two tests hold it.

Not run before the repository work: the live gate (see above), both live runs, and `npm run typecheck` as a whole (its parts ran separately).

In the repository, after Task 8:

| Check | Result |
|---|---|
| Suites | 4,810 node, 335 process and 742 dashboard tests pass, none fail; `npm run typecheck` and lint clean |
| Tree against the tested code | Identical, with the gate's fix on top. One misplaced banner in Task 3 was put back |
| Schema 99 on the real database | 49 runs and 407 plan tasks carry the new fields; the server runs on it |

Task 9's two live runs passed: the chat run (6193e123) showed its update at 10 s, took 0.8 s for it and kept it across a reload; the orchestrator run (96c00179) completed both tasks first time and showed 3 worker updates.

## After the plan

- The panes no longer use `68vh`. `.message-pane` is a size container and the panel fits the room inside it (420 to 1000 px), so its header stays in view. The layout test covers 560, 673 and 1800 px panes.
- The approval reviewer is shown what a check runs: the package.json script lines with pre and post scripts, the scripts they start, and the runner file. On the 27B, checks that had escalated went from 32 to 2 unsure of 111 verdicts; dangerous commands stayed at 0 approved of 40; scripts with harmless names and dangerous content were denied 21 of 21.
- The background guidance now says which checks may overlap.
