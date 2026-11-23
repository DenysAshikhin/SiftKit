# Orchestrator Open-Ended Runs Implementation Plan

> **For whoever executes this:** one headless `claude -p` session (Opus or Sonnet, never Fable) implements each task, and the primary agent checks it. See "How this plan is executed" near the end. No SiftKit command is used anywhere. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The orchestrator keeps working an open-ended goal — replacing failed tasks, changing approach, rolling back dead ends — until final verification passes or the run's budget is spent.

**Architecture:** The plan lifecycle moves out of `OrchestratorRun` into pure transitions (`src/orchestrator/plan-state.ts`) over one `PlanState` value: plan, task states, approaches, retired tasks. `OrchestratorRun` keeps only IO and concurrency. A run budget (minutes and dispatches) in the start request replaces the finish cap and the parent turn cap. An *approach* is a savepoint: `change_approach` ends it with a lesson and can restore the tree to the checkpoint taken when it began.

**Tech Stack:** TypeScript on Node (node:test; vitest for the dashboard), Zod contracts in `packages/contracts`, SQLite runtime database with ordered schema upgrades.

---

## Why this plan exists

Today a run gives up in six places:

| Where | What happens |
|---|---|
| `src/orchestrator/run.ts:755` | A task with 2 implementation and 2 fix attempts becomes `failed`, for good. |
| `src/orchestrator/run-store.ts:123` | `update_tasks` cannot drop a task that has attempts. |
| `src/orchestrator/run.ts:806` | A finish needs every task `completed`, so one failed task leaves only `blocked`. |
| `src/orchestrator/run.ts:817` | Three failed final verifications end the run. |
| `src/orchestrator/run.ts:84` | The orchestrator's conversation stops at 600 turns. |
| `src/orchestrator/prompts.ts:94` | The prompt tells the model to finish `blocked` when work "cannot be completed". |

A failed attempt's edits also stay in the tree, so the next try builds on them.

## Design decisions (fixed for this plan)

1. **One behaviour, no mode.** Every run has a budget. The default is 720 minutes and 80 dispatches.
2. **Budget has two limits.**
   - `dispatches` counts children started. When it is spent, `dispatch` is refused and the next failing finish ends the run.
   - `minutes` is wall-clock time since the run was created, waits included. When it is spent the run stops wherever it is.
   - Both end the run as `failed` with code `budget_exhausted`.
3. **No finish cap.** A failed finish returns its findings. Code refuses another finish until a child has run since, so the model cannot spam it.
4. **The per-task attempt limit stays** (2 implementation, 2 fix). Running out is the signal to change something. Attempts are never refunded.
5. **A task that ran can be retired.** `update_tasks` takes `retire: [{ taskId, reason }]` in place of `remove`. A retired task that ran stays on record in `retiredTasks`; its id is never reused. One that never ran is dropped.
6. **Approaches are savepoints.**
   - `save_plan` opens approach 1. Tasks belong to the approach that was active when they were added.
   - `change_approach({ lesson, rollback, title })` ends the active approach and opens the next.
   - `rollback: true` restores the tree to how it was when the approach began and drops all its tasks.
   - `rollback: false` keeps the tree. The approach's completed tasks are closed (no more dispatch, update, or retire); the rest move to the next approach.
7. **Rollback restores files git does not ignore.** It refuses when HEAD moved since the approach began. The checkpoint lives in memory, like every other piece of live run state; runs do not resume after a server restart today.
8. **`blocked` stays the model's call.** Code does not judge it; the prompt limits it to goals no approach can meet.

**Not in this plan:** user-supplied locked goal checks (for example `--until "<command>"`), keeping the best result by a metric, and resuming a run after a server restart.

## File structure

| File | Responsibility | Tasks |
|---|---|---|
| `packages/contracts/src/orchestrator.ts` | Budget, approach, retired-task, and tool-argument schemas | 2, 3, 4, 7, 8 |
| `src/orchestrator/plan-state.ts` (new) | Pure plan transitions: start, revise, change approach, finish gate | 4, 9 |
| `src/orchestrator/budget.ts` (new) | Pure budget arithmetic and rendering | 8, 10 |
| `src/orchestrator/ledger.ts` (new) | The task ledger text the orchestrator reads | 2, 8, 9 |
| `src/orchestrator/workspace.ts` | Tree checkpoint and restore | 6 |
| `src/orchestrator/run-store.ts` | Persists a whole `PlanState`; enforces the dispatch budget | 3, 5, 8 |
| `src/orchestrator/run.ts` | IO shell: tools, children, deadline, finish | 2, 3, 5, 7, 8, 9 |
| `src/orchestrator/scheduler.ts` | Dispatch rules, including closed tasks | 2, 5 |
| `src/orchestrator/digest.ts`, `prompts.ts` | What the model is told | 8, 9 |
| `src/state/schema-upgrades/orchestrator-open-ended-runs.ts` (new) | Schema 97 to 98 | 3 |
| `src/repo-search/**`, `src/planner-protocol/repo-search.ts` | Registration of the `change_approach` tool | 7 |
| `src/cli/orchestrator-args.ts`, `run-orchestrator.ts`, `help.ts` | `--minutes`, `--dispatches` | 3, 10 |
| `dashboard/src/**` | Budget inputs; budget, approach, and retired tasks in the run panel | 3, 11 |
| `README.md` | The orchestrator section: budget, approaches, retiring | 12 |

## Rules for whoever executes this

- **Do not commit.** Do not create worktrees. Leave unrelated changes alone; the tree already holds uncommitted work that is not part of this plan.
- **No SiftKit commands, ever:** no `siftkit repo-search`, `summary`, `repo-agent`, or any other. This overrides any SiftKit-first policy in an agent's own instructions. Read files, search, and run commands directly.
- **CPU-only tests.** The commands this plan lists run on scripted engines and are fine to run. Never run anything that loads a real model or uses the GPU (`test:live*`, `benchmark*`, `bench:*`, `probe:*`, `redteam:*`).
- Write a long command's output to a log in `C:/tmp/rsx/scratch`, read the totals and the failures from it, then delete it.
- After every task the tree is green: the task's own commands, then `npm run typecheck` (it runs lint too).
- Test commands:
  - Unit test file: `node ./src/test-runner/run-tests.ts <file stem>` (for example `orchestrator-plan-state`).
  - Process test file: `node ./src/test-runner/run-tests.ts --process <file stem>`.
  - Dashboard tests, from **PowerShell** (they fail under Git Bash): `npx vitest run --config .\dashboard\vitest.config.ts <file stem>`.
- A unit test must not spawn a process (git, PowerShell). Such tests live in `tests/process/`.
- TypeScript rules of this repository: no `any`, no type assertions (`as const` and `satisfies` are fine), no `!`, no namespace imports, Zod at every IO boundary, types derived with `z.infer`. Comments are one or two lines.
- A refactor replaces what it touches. Leave no old path, alias, or fallback behind.
- Never start, stop, or restart the SiftKit server. If the server on port 4765 is running in watch mode, the primary agent asks the user before any task edits `src/` or `packages/contracts/src/`: an edit restarts it and kills a live run.

---

### Task 1: Shared orchestrator test fixtures

Twenty-odd test files spell out the same start request, task state, and run state. Every later task adds a field to one of them. This task moves those literals into builders, with no behaviour change, so later tasks edit one place.

**Files:**
- Modify: `tests/helpers/orchestrator-plan.ts`
- Create: `dashboard/tests/orchestrator-fixture.ts`
- Modify: every test file in the two tables below

- [ ] **Step 1: Add the backend builders**

Replace the import line of `tests/helpers/orchestrator-plan.ts` and append the builders:

```ts
import { randomUUID } from 'node:crypto';

import {
  OrchestratorPlanSchema,
  OrchestratorRunStateSchema,
  OrchestratorStartRequestSchema,
  OrchestratorTaskSchema,
  type OrchestratorPlan,
  type OrchestratorRunState,
  type OrchestratorStartRequest,
  type OrchestratorTask,
  type OrchestratorTaskState,
  type OrchestratorTaskStatus,
} from '@siftkit/contracts';

import type { OrchestratorRunStore } from '../../src/orchestrator/run-store.ts';
```

```ts
const FIXTURE_AT = '2026-10-11T12:00:00.000Z';

/** A start request with a fresh submission; a test overrides only what it asserts on. */
export function makeOrchestratorRequest(overrides: Partial<OrchestratorStartRequest> = {}): OrchestratorStartRequest {
  return OrchestratorStartRequestSchema.parse({
    submissionId: randomUUID(), sessionId: null, repoRoot: process.cwd(), presetId: 'orchestrator', approval: 'auto',
    task: 'Inspect the README.', planPath: null, ...overrides,
  });
}

export function makeTaskState(taskId: string, status: OrchestratorTaskStatus = 'pending',
  overrides: Partial<OrchestratorTaskState> = {}): OrchestratorTaskState {
  return { taskId, status, review: null, ...overrides };
}

/** A whole run state for tests that render or parse one without a store. */
export function makeOrchestratorRunState(overrides: Partial<OrchestratorRunState> = {}): OrchestratorRunState {
  return OrchestratorRunStateSchema.parse({
    runId: randomUUID(), request: makeOrchestratorRequest(), revision: 1, phase: 'executing', planPath: null, planHash: null,
    plan: null, tasks: [], attempts: [], parentRunIds: [], approval: null, failure: null,
    createdAtUtc: FIXTURE_AT, updatedAtUtc: FIXTURE_AT, ...overrides,
  });
}

/** Saves `plan` as the run's first plan through the store, as the run does. */
export function savePlanned(store: OrchestratorRunStore, state: OrchestratorRunState, plan: OrchestratorPlan,
  contentHash = 'hash'): OrchestratorRunState {
  return store.savePlan(state.runId, state.revision, plan, 'docs/plan.md', contentHash);
}
```

- [ ] **Step 2: Use the backend builders**

Replace each literal with the expression in the table. Keep every value the literal had; pass only the values that differ from the builder's defaults.

| File | Replace | With |
|---|---|---|
| `tests/orchestrator-events-stream.test.ts` | the `create({ submissionId: randomUUID(), … planPath: null })` argument | `makeOrchestratorRequest({ repoRoot: root, approval: 'off', task })` |
| `tests/orchestrator-run-store.test.ts` | body of `startRequest` | `return makeOrchestratorRequest({ repoRoot: REPO, ...overrides });` |
| `tests/orchestrator-run-store.test.ts` | every `store.savePlan(x.runId, x.revision, plan, 'docs/plan.md', hash)` | `savePlanned(store, x, plan, hash)` |
| `tests/orchestrator-run-store.test.ts` | `{ taskId: 'inspect', status: 'pending', review: null }` and its sibling | `makeTaskState('inspect')`, `makeTaskState('follow-up')` |
| `tests/orchestrator-runs.test.ts` | the `store.create({ … })` argument in `createRun` | `makeOrchestratorRequest({ repoRoot: createManagedTempDir('siftkit-orchestrator-runs-repo-') })` |
| `tests/orchestrator-runs.test.ts` | `store.savePlan(created.runId, created.revision, plan, 'docs/plan.md', 'hash')` | `savePlanned(store, created, plan)` |
| `tests/orchestrator-scheduler.test.ts` | `{ taskId: task.id, status: overrides[task.id] ?? 'pending', review: null }` | `makeTaskState(task.id, overrides[task.id] ?? 'pending')` |
| `tests/orchestrator-digest.test.ts` | the two task-state literals | `makeTaskState('locate', 'completed')`, `makeTaskState('store', 'reviewing', { review: { … } })` |
| `tests/process/orchestrator-chat-sessions.test.ts` | body of `startRequest` | `return makeOrchestratorRequest({ task: 'Add a greeting module.', ...overrides });` |
| `tests/process/orchestrator-run.e2e.test.ts` | the three `JSON.stringify({ submissionId, sessionId: null, … })` bodies | `JSON.stringify(makeOrchestratorRequest({ … }))` with the same `submissionId`, `repoRoot`, `presetId`, `approval`, `task` |
| `tests/process/chat-overflow.test.ts` | the `OrchestratorRunStateSchema.parse({ … })` literal | `makeOrchestratorRunState({ … })` with `request: makeOrchestratorRequest({ submissionId: RUN_ID, repoRoot: 'C:/repo', approval: 'interactive', task: UNBROKEN })` and `tasks: [makeTaskState(TASK.id, 'reviewing', { review: { … } })]` |
| `tests/runtime-db-schema-orchestrator-attempt-results.test.ts`, `-check-digests`, `-search-reports`, `-single-worker` | the `store.create({ … })` argument | `makeOrchestratorRequest({ repoRoot: <same dir>, approval: 'off', task: 'Add greeting.' })` |
| the same four files | `store.savePlan(created.runId, created.revision, <plan>, 'docs/plan.md', 'hash')` | `savePlanned(store, created, <plan>)` |
| `tests/runtime-db-schema-orchestrator-session-links.test.ts` | the `.create({ … })` argument | `makeOrchestratorRequest({ sessionId: sessionId ?? null, repoRoot })` |
| `tests/runtime-db-schema-orchestrator-single-parent.test.ts` | the `.create({ … })` argument | `makeOrchestratorRequest({ repoRoot, approval: 'off', task: 'Add greeting.' })` |
| `tests/runtime-db-schema-orchestrator-single-parent.test.ts` | `[{ taskId: 'greeting', status: 'failed', review: null }]` | `[makeTaskState('greeting', 'failed')]` |

`tests/contracts-orchestrator.test.ts` keeps its literals: it tests the schemas themselves.

Then find what the table missed and convert it the same way:

Run: `grep -rn "planPath: null\|review: null\|OrchestratorRunStateSchema.parse({" tests --include=*.ts`
Expected: no remaining match is a hand-written orchestrator start request, task state, or run state. Matches that stay: `tests/contracts-orchestrator.test.ts` (it tests the schemas), `tests/helpers/orchestrator-plan.ts` (the builders), `tests/orchestrator-args.test.ts` (CLI invocations), `planPath: null` inside digest and handoff inputs, and `review: null` on records that are not orchestrator task states.

- [ ] **Step 3: Add the dashboard builders**

Create `dashboard/tests/orchestrator-fixture.ts`:

```ts
import {
  OrchestratorRunStateSchema,
  type OrchestratorRunState,
  type OrchestratorStartRequest,
  type OrchestratorTaskState,
  type OrchestratorTaskStatus,
} from '@siftkit/contracts';

const FIXTURE_RUN_ID = '00000000-0000-4000-8000-000000000001';
const FIXTURE_AT = '2026-10-11T12:00:00.000Z';

/** A start request as a stored run records it; a test overrides only what it asserts on. */
export function orchestratorRequest(overrides: Partial<OrchestratorStartRequest> = {}): OrchestratorStartRequest {
  return { submissionId: FIXTURE_RUN_ID, sessionId: null, repoRoot: 'C:/repo', presetId: 'orchestrator', approval: 'interactive',
    task: 'Greet', planPath: null, ...overrides };
}

export function orchestratorTaskState(taskId: string, status: OrchestratorTaskStatus = 'pending',
  overrides: Partial<OrchestratorTaskState> = {}): OrchestratorTaskState {
  return { taskId, status, review: null, ...overrides };
}

export function orchestratorRunState(overrides: Partial<OrchestratorRunState> = {}): OrchestratorRunState {
  return OrchestratorRunStateSchema.parse({
    runId: FIXTURE_RUN_ID, request: orchestratorRequest(), revision: 1, phase: 'executing', planPath: null, planHash: null,
    plan: null, tasks: [], attempts: [], parentRunIds: [], approval: null, failure: null,
    createdAtUtc: FIXTURE_AT, updatedAtUtc: FIXTURE_AT, ...overrides,
  });
}
```

- [ ] **Step 4: Use the dashboard builders**

| File | Replace | With |
|---|---|---|
| `dashboard/tests/orchestrator-view.test.ts` | body of `runState` | `return orchestratorRunState({ runId: RUN_ID, request: orchestratorRequest({ approval: 'auto', task: 'Go' }), planPath: 'plan.md', planHash: 'h', plan: { goal: 'Go', constraints: [], tasks, finalVerification: [CHECK] }, tasks: tasks.map((task) => orchestratorTaskState(task.id, statuses[task.id] ?? 'pending')), createdAtUtc: AT, updatedAtUtc: '2026-10-11T12:14:02.000Z', ...overrides });` |
| `dashboard/tests/orchestrator-run-panel.test.tsx` | body of `runState`, and the three `{ taskId: …, status: …, review: null }` literals | `orchestratorRunState({ … same values … })`, `orchestratorTaskState(TASK.id, 'running')`, `orchestratorTaskState('second')`, `orchestratorTaskState(TASK.id, status)` |
| `dashboard/tests/use-orchestrator-run.test.tsx` | body of `runState` | `orchestratorRunState({ … same values … })` |
| `dashboard/tests/chat-tab.test.tsx` | the three inline run-state objects (near lines 536, 578, 616) | `orchestratorRunState({ runId: ORCHESTRATOR_RUN_ID, request: orchestratorRequest({ submissionId: ORCHESTRATOR_RUN_ID, sessionId: ORCHESTRATOR_SESSION.id, task: 'hi', … }), … })` keeping each object's other values |

Leave `dashboard/tests/vault-fixture.ts` alone; its `review: null` belongs to a vault record.

- [ ] **Step 5: Verify nothing changed**

Run: `npm test`
Expected: exit 0, 0 failures.

Run: `node ./src/test-runner/run-tests.ts --process orchestrator-run.e2e` and `--process orchestrator-chat-sessions` and `--process chat-overflow`
Expected: all pass.

Run (PowerShell): `npx vitest run --config .\dashboard\vitest.config.ts orchestrator chat-tab use-orchestrator-run`
Expected: all pass.

Run: `npm run typecheck`
Expected: exit 0.

**Acceptance:** no file under `src/`, `packages/`, or `dashboard/src/` changed; every suite passes; the grep in Step 2 shows only the kinds of match it lists.

---

### Task 2: Extract the task ledger and one attempt-limit predicate

The "two attempts per purpose" rule is written three times (`run.ts:753`, `scheduler.ts:52`, `run-store.ts:144`), and the ledger text is built inside `OrchestratorRun`. Both get one home before later tasks extend them. No behaviour changes.

**Files:**
- Modify: `packages/contracts/src/orchestrator.ts`
- Create: `src/orchestrator/ledger.ts`
- Modify: `src/orchestrator/run.ts`, `src/orchestrator/scheduler.ts`, `src/orchestrator/run-store.ts`
- Test: `tests/orchestrator-ledger.test.ts` (new), `tests/contracts-orchestrator.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `tests/orchestrator-ledger.test.ts`:

```ts
import assert from 'node:assert/strict';
import test from 'node:test';

import { OrchestratorAttemptSchema, type OrchestratorAttempt, type OrchestratorChildPurpose, type OrchestratorTask } from '@siftkit/contracts';
import { renderLedger } from '../src/orchestrator/ledger.ts';
import { makeOrchestratorPlan, makeOrchestratorTask, makeTaskState } from './helpers/orchestrator-plan.ts';

const A = makeOrchestratorTask({ id: 'a' });
const B = makeOrchestratorTask({ id: 'b' });

function attempt(task: OrchestratorTask, purpose: OrchestratorChildPurpose, number: number): OrchestratorAttempt {
  return OrchestratorAttemptSchema.parse({
    taskId: task.id, purpose, attempt: number, childRunId: `00000000-0000-4000-8000-00000000000${number}`, status: 'settled',
    result: null, reservedAtUtc: '2026-10-11T12:00:00.000Z',
    work: { kind: purpose, planPath: 'plan.md', planHash: 'h', task, instruction: 'Do it.' },
  });
}

test('the ledger lists every task with its status, the attempts used per purpose, and its last review', () => {
  const review: NonNullable<OrchestratorTaskState['review']> = { attempt: 1, purpose: 'fix', verdict: 'fail', criteria: [], findings: [] };
  assert.equal(renderLedger({
    plan: makeOrchestratorPlan([A, B]),
    tasks: [makeTaskState('a', 'reviewing', { review }), makeTaskState('b')],
    attempts: [attempt(A, 'implementation', 1), attempt(A, 'implementation', 2), attempt(A, 'fix', 1)],
  }), [
    'Task ledger:',
    '- a: reviewing (implementation 2/2, fix 1/2, last review fail)',
    '- b: pending (implementation 0/2, fix 0/2)',
  ].join('\n'));
});

test('before a plan exists the ledger says so', () => {
  assert.equal(renderLedger({ plan: null, tasks: [], attempts: [] }), 'No plan saved yet.');
});
```

Append to `tests/contracts-orchestrator.test.ts` (add `orchestratorAttemptsSpent` to its contracts import):

```ts
test('a purpose is spent for a task after two attempts, counted per task and per purpose', () => {
  const attempts = [
    { taskId: 'a', purpose: 'implementation' }, { taskId: 'a', purpose: 'implementation' },
    { taskId: 'a', purpose: 'fix' }, { taskId: 'b', purpose: 'fix' },
  ] as const;
  assert.equal(orchestratorAttemptsSpent(attempts, 'a', 'implementation'), true);
  assert.equal(orchestratorAttemptsSpent(attempts, 'a', 'fix'), false);
  assert.equal(orchestratorAttemptsSpent(attempts, 'b', 'implementation'), false);
});
```

- [ ] **Step 2: Run them and see them fail**

Run: `node ./src/test-runner/run-tests.ts orchestrator-ledger`
Expected: FAIL, cannot find module `../src/orchestrator/ledger.ts`.

- [ ] **Step 3: Add the predicate to the contracts**

In `packages/contracts/src/orchestrator.ts`, directly after `export type OrchestratorAttempt = …`:

```ts
/** Whether `taskId` has used every attempt of `purpose`. Attempts are never refunded. */
export function orchestratorAttemptsSpent(attempts: readonly Pick<OrchestratorAttempt, 'taskId' | 'purpose'>[], taskId: string,
  purpose: OrchestratorChildPurpose): boolean {
  return attempts.filter((attempt) => attempt.taskId === taskId && attempt.purpose === purpose).length >= ORCHESTRATOR_MAX_ATTEMPTS;
}
```

- [ ] **Step 4: Create the ledger module**

Create `src/orchestrator/ledger.ts`:

```ts
import { ORCHESTRATOR_MAX_ATTEMPTS, OrchestratorChildPurposeSchema, type OrchestratorRunState } from '@siftkit/contracts';

/** One line per task: where it stands and what it has used, so the orchestrator never re-derives it. */
export function renderLedger(state: Pick<OrchestratorRunState, 'plan' | 'tasks' | 'attempts'>): string {
  if (state.plan === null) return 'No plan saved yet.';
  return ['Task ledger:', ...state.tasks.map((task) => {
    const used = OrchestratorChildPurposeSchema.options.map((purpose) => {
      const count = state.attempts.filter((attempt) => attempt.taskId === task.taskId && attempt.purpose === purpose).length;
      return `${purpose} ${count}/${ORCHESTRATOR_MAX_ATTEMPTS}`;
    });
    const review = task.review === null ? '' : `, last review ${task.review.verdict}`;
    return `- ${task.taskId}: ${task.status} (${used.join(', ')}${review})`;
  })].join('\n');
}
```

- [ ] **Step 5: Use both**

In `src/orchestrator/run.ts`:
- Delete the private method `renderLedger()` (lines 390-400) and replace its four calls (`this.renderLedger()`) with `renderLedger(this.state)`. Import `renderLedger` from `./ledger.ts`.
- In `recordReview`, replace the `exhausted` expression with:

```ts
    const exhausted = OrchestratorChildPurposeSchema.options.every((purpose) => orchestratorAttemptsSpent(this.state.attempts, args.taskId, purpose));
```

- Import `orchestratorAttemptsSpent` from `@siftkit/contracts`, and remove the `ORCHESTRATOR_MAX_ATTEMPTS` import, which is now unused.

In `src/orchestrator/scheduler.ts`, replace the attempt-count condition in `dispatchProblem`:

```ts
  if (orchestratorAttemptsSpent(input.attempts, task.id, purpose)) {
    return `Task '${task.id}' used all ${ORCHESTRATOR_MAX_ATTEMPTS} ${purpose} attempts.`;
  }
```

In `src/orchestrator/run-store.ts`, in `reserveAttempt`, replace the `if (used >= ORCHESTRATOR_MAX_ATTEMPTS)` line (keep `used`, which numbers the attempt):

```ts
      if (orchestratorAttemptsSpent(current.attempts, taskId, purpose)) throw new Error(`Task '${taskId}' reached the ${purpose} attempt limit.`);
```

Remove the `ORCHESTRATOR_MAX_ATTEMPTS` import there.

- [ ] **Step 6: Verify**

Run: `node ./src/test-runner/run-tests.ts orchestrator-ledger` and `contracts-orchestrator` and `orchestrator-scheduler` and `orchestrator-run-store`
Expected: PASS.

Run: `node ./src/test-runner/run-tests.ts --process orchestrator-run.e2e`
Expected: PASS (the ledger text the orchestrator reads is unchanged).

Run: `npm run typecheck`
Expected: exit 0.

**Acceptance:** `grep -rn "ORCHESTRATOR_MAX_ATTEMPTS" src` shows the constant only in `ledger.ts`, `scheduler.ts` (its message), and `prompts.ts`; `run.ts` has no `renderLedger` method.

---

### Task 3: Run state gains a budget, approaches, and retired tasks (schema 98)

This task changes what is stored, and nothing about how a run behaves. Every run gets a budget (not yet enforced), a list of approaches (approach 1 opens with the first plan), and an empty list of retired tasks. The finish limit's failure is renamed, because Task 8 turns it into a spent budget.

**Files:**
- Modify: `packages/contracts/src/orchestrator.ts`
- Modify: `src/orchestrator/run-store.ts`, `src/orchestrator/run.ts`
- Create: `src/state/schema-upgrades/orchestrator-open-ended-runs.ts`
- Modify: `src/state/runtime-db.ts`
- Modify: `src/cli/run-orchestrator.ts`, `dashboard/src/hooks/useOrchestratorRun.ts`
- Modify: `tests/helpers/orchestrator-plan.ts`, `dashboard/tests/orchestrator-fixture.ts`
- Test: `tests/contracts-orchestrator.test.ts`, `tests/orchestrator-run-store.test.ts`, `tests/runtime-db-schema-orchestrator-open-ended-runs.test.ts` (new), `tests/process/orchestrator-run.e2e.test.ts`, `dashboard/tests/chat-tab.test.tsx`

- [ ] **Step 1: Write the failing contract tests**

In `tests/contracts-orchestrator.test.ts`, add `budget: DEFAULT_ORCHESTRATOR_BUDGET` to the `request` literal of the test `a start request needs a task or a plan path…`, and append (import `DEFAULT_ORCHESTRATOR_BUDGET`, `ORCHESTRATOR_MAX_BUDGET_MINUTES`, `OrchestratorApproachSchema`, `OrchestratorFailureSchema`, `OrchestratorRetiredTaskSchema`):

```ts
test('a start request carries its budget: positive minutes up to two weeks, and a whole number of dispatches', () => {
  const request = { submissionId: RUN_ID, sessionId: null, repoRoot: 'C:/repo', presetId: 'orchestrator', approval: 'auto',
    task: 'Do it.', planPath: null };
  assert.equal(OrchestratorStartRequestSchema.safeParse(request).success, false, 'a start without a budget is not a start');
  assert.equal(OrchestratorStartRequestSchema.safeParse({ ...request, budget: DEFAULT_ORCHESTRATOR_BUDGET }).success, true);
  assert.equal(OrchestratorStartRequestSchema.safeParse({ ...request, budget: { minutes: 0.5, dispatches: 1 } }).success, true);
  for (const budget of [{ minutes: 0, dispatches: 1 }, { minutes: 10, dispatches: 0 }, { minutes: 10, dispatches: 1.5 },
    { minutes: ORCHESTRATOR_MAX_BUDGET_MINUTES + 1, dispatches: 1 }, { minutes: 10 }]) {
    assert.equal(OrchestratorStartRequestSchema.safeParse({ ...request, budget }).success, false, JSON.stringify(budget));
  }
});

test('an approach is active until it ends kept or rolled back with a lesson; a retired task records why it left', () => {
  const approach = { number: 1, title: 'Initial plan', startedAtUtc: '2026-11-21T10:00:00.000Z', outcome: null };
  assert.equal(OrchestratorApproachSchema.safeParse(approach).success, true);
  const ended = { kind: 'rolled_back', lesson: 'The cache cannot see headers.', endedAtUtc: '2026-11-21T11:00:00.000Z' };
  assert.equal(OrchestratorApproachSchema.safeParse({ ...approach, outcome: ended }).success, true);
  assert.equal(OrchestratorApproachSchema.safeParse({ ...approach, outcome: { ...ended, lesson: ' ' } }).success, false);
  assert.equal(OrchestratorApproachSchema.safeParse({ ...approach, outcome: { ...ended, kind: 'abandoned' } }).success, false);
  const retired = { taskId: 'cache', title: 'Cache responses', approach: 1, status: 'failed', reason: 'Out of attempts.',
    retiredAtUtc: '2026-11-21T11:00:00.000Z' };
  assert.equal(OrchestratorRetiredTaskSchema.safeParse(retired).success, true);
  assert.equal(OrchestratorRetiredTaskSchema.safeParse({ ...retired, reason: '' }).success, false);
});

test('a run can fail because its budget is spent; the old finish-limit failure code is gone', () => {
  assert.equal(OrchestratorFailureSchema.safeParse({ code: 'budget_exhausted', message: 'Spent.', taskId: null }).success, true);
  assert.equal(OrchestratorFailureSchema.safeParse({ code: 'final_verification_failed', message: 'x', taskId: null }).success, false);
});
```

Run: `node ./src/test-runner/run-tests.ts contracts-orchestrator`
Expected: FAIL, `DEFAULT_ORCHESTRATOR_BUDGET` is not exported.

- [ ] **Step 2: Change the contracts**

In `packages/contracts/src/orchestrator.ts`:

After `ORCHESTRATOR_MAX_FINISH_ATTEMPTS`, add:

```ts
/** Two weeks; it also keeps a run's deadline inside one timer. */
export const ORCHESTRATOR_MAX_BUDGET_MINUTES = 20_160;

/** A run's whole allowance: the minutes after which it is stopped, and how many children it may start. */
export const OrchestratorBudgetSchema = z.object({
  minutes: z.number().positive().max(ORCHESTRATOR_MAX_BUDGET_MINUTES), dispatches: z.number().int().positive(),
}).strict();
export type OrchestratorBudget = z.infer<typeof OrchestratorBudgetSchema>;

/** What a start uses when it names no budget: room for a long multi-task run. */
export const DEFAULT_ORCHESTRATOR_BUDGET: OrchestratorBudget = { minutes: 720, dispatches: 80 };
```

In `OrchestratorStartRequestSchema`, after `approval: ApprovalModeSchema,`:

```ts
  budget: OrchestratorBudgetSchema,
```

In `OrchestratorFailureCodeSchema`, replace `'final_verification_failed'` with `'budget_exhausted'`.

Replace `OrchestratorTaskStateSchema` and add the two new schemas before it:

```ts
/** One way of reaching the goal: the tasks added while it was active, and how it ended. */
export const OrchestratorApproachSchema = z.object({
  number: z.number().int().positive(), title: z.string().trim().min(1), startedAtUtc: z.string().datetime(),
  /** Null while active; `rolled_back` put the files back as they were when the approach began. */
  outcome: z.object({
    kind: z.enum(['kept', 'rolled_back']), lesson: z.string().trim().min(1), endedAtUtc: z.string().datetime(),
  }).strict().nullable(),
}).strict();
export type OrchestratorApproach = z.infer<typeof OrchestratorApproachSchema>;

/** A task taken out of the plan after it ran, kept so the same thing is not tried twice unknowingly. */
export const OrchestratorRetiredTaskSchema = z.object({
  taskId: z.string().min(1), title: z.string().trim().min(1), approach: z.number().int().positive(),
  status: OrchestratorTaskStatusSchema, reason: z.string().trim().min(1), retiredAtUtc: z.string().datetime(),
}).strict();
export type OrchestratorRetiredTask = z.infer<typeof OrchestratorRetiredTaskSchema>;

export const OrchestratorTaskStateSchema = z.object({
  taskId: z.string().min(1), status: OrchestratorTaskStatusSchema, review: OrchestratorReviewRecordSchema.nullable(),
  /** The approach that was active when the task was added, or the one it was carried into. */
  approach: z.number().int().positive(),
}).strict();
```

In `OrchestratorRunStateSchema`, after `plan: OrchestratorPlanSchema.nullable(), tasks: z.array(OrchestratorTaskStateSchema),`:

```ts
  approaches: z.array(OrchestratorApproachSchema), retiredTasks: z.array(OrchestratorRetiredTaskSchema),
```

- [ ] **Step 3: Update the fixtures**

`tests/helpers/orchestrator-plan.ts`: import `DEFAULT_ORCHESTRATOR_BUDGET`; in `makeOrchestratorRequest` add `budget: DEFAULT_ORCHESTRATOR_BUDGET,` before `...overrides`; in `makeTaskState` return `{ taskId, status, review: null, approach: 1, ...overrides }`; in `makeOrchestratorRunState` add `approaches: [], retiredTasks: [],` before `createdAtUtc`.

`dashboard/tests/orchestrator-fixture.ts`: the same three additions (`budget`, `approach: 1`, `approaches: [], retiredTasks: []`).

- [ ] **Step 4: Write the failing store and upgrade tests**

Append to `tests/orchestrator-run-store.test.ts` (import `DEFAULT_ORCHESTRATOR_BUDGET`):

```ts
test('a new run has its budget and no approaches or retired tasks; its first plan opens approach 1 for every task', (t) => {
  const { store } = openStore(t);
  const created = store.create(startRequest());
  assert.deepEqual([created.request.budget, created.approaches, created.retiredTasks], [DEFAULT_ORCHESTRATOR_BUDGET, [], []]);
  const state = savePlanned(store, created, PLAN, 'hash-1');
  assert.deepEqual(state.approaches.map((approach) => [approach.number, approach.title, approach.outcome]), [[1, 'Initial plan', null]]);
  assert.deepEqual(state.tasks.map((task) => task.approach), [1, 1]);
});
```

Create `tests/runtime-db-schema-orchestrator-open-ended-runs.test.ts`:

```ts
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
const TaskListSchema = z.array(JsonObjectSchema);

/** A schema-97 file holding one planned run that failed on the old finish limit; `damage` rewrites its stored state. */
function seedSchema97(damage: (state: JsonObject) => JsonObject): { dbPath: string; runId: string } {
  const dbPath = path.join(createManagedTempDir('siftkit-open-ended-'), 'runtime.sqlite');
  writeConfig(dbPath, getDefaultServerConfig());
  const store = new OrchestratorRunStore(getRuntimeDatabase(dbPath));
  const created = store.create(makeOrchestratorRequest({ repoRoot: createManagedTempDir('siftkit-open-ended-repo-') }));
  const { runId } = savePlanned(store, created, makeOrchestratorPlan([makeOrchestratorTask({ id: 'greeting' })]));
  closeAllRuntimeDatabases();
  withRuntimeDatabaseConnection(dbPath, (database) => {
    const stored = JsonObjectSchema.parse(JSON.parse(StateRowSchema.parse(
      database.prepare('SELECT state_json FROM orchestrator_runs WHERE run_id = ?').get(runId)).state_json));
    const { approaches: _approaches, retiredTasks: _retired, ...state } = stored;
    const { budget: _budget, ...request } = JsonObjectSchema.parse(state.request);
    const tasks = TaskListSchema.parse(state.tasks).map(({ approach: _approach, ...task }) => task);
    const legacy = { ...state, request, tasks, phase: 'failed',
      failure: { code: 'final_verification_failed', message: 'Final verification failed 3 times: boom', taskId: null } };
    database.prepare('UPDATE orchestrator_runs SET state_json = ?, phase = ? WHERE run_id = ?')
      .run(JSON.stringify(damage(legacy)), 'failed', runId);
    database.exec('UPDATE runtime_schema SET version = 97 WHERE id = 1');
  });
  return { dbPath, runId };
}

test('the 97 to 98 upgrade gives a stored run the default budget, approach 1, no retired tasks, and a spent-budget failure', (t) => {
  t.after(closeAllRuntimeDatabases);
  const { dbPath, runId } = seedSchema97((state) => state);
  const database = getRuntimeDatabase(dbPath);
  assert.equal(getSchemaVersion(database), CURRENT_SCHEMA_VERSION);
  const state = new OrchestratorRunStore(database).read(runId);
  assert.deepEqual(state.request.budget, { minutes: 720, dispatches: 80 });
  assert.deepEqual(state.approaches, [{ number: 1, title: 'Initial plan', startedAtUtc: state.createdAtUtc, outcome: null }]);
  assert.deepEqual(state.retiredTasks, []);
  assert.deepEqual(state.tasks.map((task) => [task.taskId, task.approach]), [['greeting', 1]]);
  assert.deepEqual(state.failure, { code: 'budget_exhausted', message: 'Final verification failed 3 times: boom', taskId: null });
});

test('the 97 to 98 upgrade gives a run that never saved a plan no approach', (t) => {
  t.after(closeAllRuntimeDatabases);
  const { dbPath, runId } = seedSchema97((state) => ({ ...state, plan: null, planPath: null, planHash: null, tasks: [] }));
  assert.deepEqual(new OrchestratorRunStore(getRuntimeDatabase(dbPath)).read(runId).approaches, []);
});

test('the 97 to 98 upgrade fails loudly on an unreadable stored run, naming it, and leaves the file at 97', (t) => {
  t.after(closeAllRuntimeDatabases);
  const { dbPath, runId } = seedSchema97((state) => ({ ...state, tasks: 'not a task list' }));
  assert.throws(() => getRuntimeDatabase(dbPath), new RegExp(`Orchestrator run ${runId} has an unreadable stored state`, 'u'));
  assert.equal(withRuntimeDatabaseConnection(dbPath, (database) => getSchemaVersion(database)), 97);
});
```

Run: `node ./src/test-runner/run-tests.ts runtime-db-schema-orchestrator-open-ended-runs`
Expected: FAIL (typecheck or assertion: no upgrade exists yet).

- [ ] **Step 5: Write the schema upgrade**

Create `src/state/schema-upgrades/orchestrator-open-ended-runs.ts`:

```ts
import { parseJsonObjectText } from '../../lib/json.ts';
import { JsonValueSchema } from '../../lib/json-types.ts';
import { z } from '../../lib/zod.ts';
import type { RuntimeDatabase } from '../database-handle.ts';

const RunRowsSchema = z.array(z.object({ run_id: z.string(), state_json: z.string() }));
// Pins only what this step reads from a schema-97 run. A row that already has `approaches` was written by current code.
const Stored97RunSchema = z.object({
  request: z.object({}).catchall(JsonValueSchema),
  plan: z.object({}).catchall(JsonValueSchema).nullable(),
  tasks: z.array(z.object({ taskId: z.string() }).catchall(JsonValueSchema)),
  failure: z.object({ code: z.string() }).catchall(JsonValueSchema).nullable(),
  createdAtUtc: z.string(),
  approaches: z.array(JsonValueSchema).optional(),
}).catchall(JsonValueSchema);

// Literals, so a later change to the defaults cannot change what this upgrade writes.
const BUDGET_98 = { minutes: 720, dispatches: 80 };
const FIRST_APPROACH_TITLE_98 = 'Initial plan';

/**
 * Schema 97 -> 98: every run gains a budget, its approaches, and its retired tasks; each task names approach 1.
 * A run that failed on the old finish limit failed on a spent budget.
 */
export function upgradeOrchestratorOpenEndedRuns(database: RuntimeDatabase): void {
  const update = database.prepare('UPDATE orchestrator_runs SET state_json = ? WHERE run_id = ?');
  for (const row of RunRowsSchema.parse(database.prepare('SELECT run_id, state_json FROM orchestrator_runs').all())) {
    const parsed = Stored97RunSchema.safeParse(parseJsonObjectText(row.state_json));
    if (!parsed.success) throw new Error(`Orchestrator run ${row.run_id} has an unreadable stored state: ${parsed.error.message}`);
    const run = parsed.data;
    if (run.approaches !== undefined) continue;
    const failure = run.failure === null ? null
      : { ...run.failure, code: run.failure.code === 'final_verification_failed' ? 'budget_exhausted' : run.failure.code };
    update.run(JSON.stringify({
      ...run, failure,
      request: { ...run.request, budget: BUDGET_98 },
      tasks: run.tasks.map((task) => ({ ...task, approach: 1 })),
      approaches: run.plan === null ? [] : [{ number: 1, title: FIRST_APPROACH_TITLE_98, startedAtUtc: run.createdAtUtc, outcome: null }],
      retiredTasks: [],
    }), row.run_id);
  }
}
```

In `src/state/runtime-db.ts`: import `upgradeOrchestratorOpenEndedRuns`, set `CURRENT_SCHEMA_VERSION = 98`, and append to `SCHEMA_UPGRADES`:

```ts
  { from: 97, apply: upgradeOrchestratorOpenEndedRuns },
```

- [ ] **Step 6: Store the new fields**

In `src/orchestrator/run-store.ts`:

In `create`, the initial state literal gains `approaches: [], retiredTasks: [],` after `tasks: [],`.

Replace the body of `savePlan` (Task 5 replaces this method again, with a whole plan state):

```ts
    return this.mutate(runId, revision, (state) => {
      const planned = new Set(plan.tasks.map((task) => task.id));
      for (const attempt of state.attempts) {
        if (!planned.has(attempt.taskId)) {
          throw new Error(`Plan changed: task '${attempt.taskId}' already has attempts; start a new run for the changed plan.`);
        }
      }
      const approaches: OrchestratorRunState['approaches'] = state.approaches.length > 0 ? state.approaches
        : [{ number: 1, title: 'Initial plan', startedAtUtc: new Date().toISOString(), outcome: null }];
      const previous = new Map(state.tasks.map((task) => [task.taskId, task]));
      const tasks: OrchestratorTaskState[] = plan.tasks.map((task) => previous.get(task.id)
        ?? { taskId: task.id, status: 'pending', review: null, approach: approaches.length });
      return { stored: { ...state, plan, planPath, planHash: contentHash, tasks, approaches }, event: { message: `Plan saved: ${planPath}.` } };
    });
```

- [ ] **Step 7: Send a budget from every caller, and rename the failure**

`src/orchestrator/run.ts`, in `converse`, the `verification_failed` branch: change the code `'final_verification_failed'` to `'budget_exhausted'` (the message stays).

`src/cli/run-orchestrator.ts`, the `start` case: add `budget: DEFAULT_ORCHESTRATOR_BUDGET` to the `api.startOrchestrator({ … })` argument and import it from `@siftkit/contracts`. Task 10 replaces it with flags.

`dashboard/src/hooks/useOrchestratorRun.ts`, in `start`: `startOrchestrator({ submissionId: crypto.randomUUID(), budget: DEFAULT_ORCHESTRATOR_BUDGET, ...input })`, importing the constant. Task 11 replaces it with inputs.

- [ ] **Step 8: Update the assertions this changes**

- `tests/process/orchestrator-run.e2e.test.ts`, test `a final verification that fails on every finish fails the run after the last one`: expect `state.failure?.code` to equal `'budget_exhausted'`.
- `dashboard/tests/chat-tab.test.tsx`, the expected start body (near line 565): add `budget: { minutes: 720, dispatches: 80 }`.

- [ ] **Step 9: Verify**

Run: `node ./src/test-runner/run-tests.ts contracts-orchestrator`, `orchestrator-run-store`, `runtime-db-schema-orchestrator-open-ended-runs`
Expected: PASS.

Run: `npm test`
Expected: exit 0, 0 failures (the older `runtime-db-schema-orchestrator-*` tests pass through the new step).

Run: `node ./src/test-runner/run-tests.ts --process orchestrator-run.e2e` and `--process orchestrator-chat-sessions`
Expected: PASS.

Run (PowerShell): `npx vitest run --config .\dashboard\vitest.config.ts orchestrator chat-tab use-orchestrator-run`
Expected: PASS.

Run: `npm run typecheck`
Expected: exit 0.

**Acceptance:** a database at schema 97 opens at 98 with the fields above; a run's behaviour is unchanged; `grep -rn "final_verification_failed" src packages dashboard/src` matches only the upgrade file.

---

### Task 4: Pure plan transitions

Everything that changes the plan becomes a pure function over one value. This task adds the module and its argument schemas; the run starts using it in Task 5.

**Files:**
- Modify: `packages/contracts/src/orchestrator.ts`
- Create: `src/orchestrator/plan-state.ts`
- Modify: `src/orchestrator/run.ts` (argument rename only), `src/repo-search/planner-protocol.ts` (example only)
- Test: `tests/orchestrator-plan-state.test.ts` (new), `tests/repo-search-orchestrator-tools.test.ts`, `tests/process/orchestrator-run.e2e.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `tests/orchestrator-plan-state.test.ts`:

```ts
import assert from 'node:assert/strict';
import test from 'node:test';

import { OrchestratorAttemptSchema, type OrchestratorAttempt, type OrchestratorTask, type OrchestratorTaskStatus } from '@siftkit/contracts';
import { activeApproach, changeApproach, finishProblem, reviseTasks, startPlan, type PlanState, type PlanTransition } from '../src/orchestrator/plan-state.ts';
import { makeOrchestratorPlan, makeOrchestratorTask } from './helpers/orchestrator-plan.ts';

const AT = '2026-11-21T10:00:00.000Z';
const LATER = '2026-11-21T11:00:00.000Z';
const A = makeOrchestratorTask({ id: 'a', title: 'Task A' });
const B = makeOrchestratorTask({ id: 'b', title: 'Task B', dependsOn: ['a'] });
const C = makeOrchestratorTask({ id: 'c', title: 'Task C' });
const EMPTY: PlanState = { plan: null, tasks: [], approaches: [], retiredTasks: [] };

function attempt(task: OrchestratorTask, number = 1): OrchestratorAttempt {
  return OrchestratorAttemptSchema.parse({
    taskId: task.id, purpose: 'implementation', attempt: number, childRunId: `00000000-0000-4000-8000-00000000000${number}`,
    status: 'settled', result: null, reservedAtUtc: AT,
    work: { kind: 'implementation', planPath: 'plan.md', planHash: 'h', task, instruction: 'Do it.' },
  });
}

/** The state a transition produced; a refused transition fails the test with its problems. */
function applied(transition: PlanTransition): PlanState {
  assert.ok(transition.ok, transition.ok ? '' : transition.problems.join(' '));
  return transition.next;
}

function planned(): PlanState {
  return applied(startPlan(EMPTY, makeOrchestratorPlan([A, B]), AT));
}

function withStatus(state: PlanState, taskId: string, status: OrchestratorTaskStatus): PlanState {
  return { ...state, tasks: state.tasks.map((task) => (task.taskId === taskId ? { ...task, status } : task)) };
}

test('the first plan opens approach 1 with every task pending, and a second plan is refused', () => {
  const state = planned();
  assert.deepEqual(state.approaches, [{ number: 1, title: 'Initial plan', startedAtUtc: AT, outcome: null }]);
  assert.deepEqual(state.tasks, [
    { taskId: 'a', status: 'pending', review: null, approach: 1 }, { taskId: 'b', status: 'pending', review: null, approach: 1 }]);
  assert.equal(activeApproach(state)?.number, 1);
  assert.equal(activeApproach(EMPTY), null);
  assert.deepEqual(startPlan(state, makeOrchestratorPlan([A]), LATER),
    { ok: false, problems: ['A plan is already saved; change it with update_tasks.'] });
});

test('update_tasks patches by id, adds tasks to the active approach, and refuses unknown and reused ids', () => {
  const state = applied(reviseTasks(planned(), { update: [{ taskId: 'a', set: { title: 'Renamed' } }], add: [C], retire: [] }, [], LATER));
  assert.deepEqual(state.plan?.tasks.map((task) => [task.id, task.title]), [['a', 'Renamed'], ['b', 'Task B'], ['c', 'Task C']]);
  assert.deepEqual(state.tasks.at(-1), { taskId: 'c', status: 'pending', review: null, approach: 1 });
  assert.deepEqual(
    reviseTasks(planned(), { update: [{ taskId: 'nowhere', set: {} }], add: [A], retire: [{ taskId: 'gone', reason: 'x' }] }, [], LATER),
    { ok: false, problems: ["Task 'nowhere' is not in the saved plan.", "Task 'gone' is not in the saved plan.",
      "Task id 'a' was already used in this run; give the new task a new id."] });
  assert.deepEqual(reviseTasks(EMPTY, { update: [], add: [A], retire: [] }, [], LATER),
    { ok: false, problems: ['Save a plan first with save_plan.'] });
});

test('a retired task that ran stays on record with its reason, one that never ran is dropped, and a dependent must follow or be re-pointed', () => {
  const failed = withStatus(planned(), 'a', 'failed');
  assert.deepEqual(reviseTasks(failed, { update: [], add: [], retire: [{ taskId: 'a', reason: 'Wrong file.' }] }, [attempt(A)], LATER),
    { ok: false, problems: ["Task 'b' depends on a, which this call retires: retire it too, or set its dependsOn."] });
  const replacement = makeOrchestratorTask({ id: 'a-2', title: 'Task A again' });
  const state = applied(reviseTasks(failed, { update: [{ taskId: 'b', set: { dependsOn: ['a-2'] } }], add: [replacement],
    retire: [{ taskId: 'a', reason: 'Wrong file.' }] }, [attempt(A)], LATER));
  assert.deepEqual(state.plan?.tasks.map((task) => [task.id, task.dependsOn]), [['b', ['a-2']], ['a-2', []]]);
  assert.deepEqual(state.retiredTasks,
    [{ taskId: 'a', title: 'Task A', approach: 1, status: 'failed', reason: 'Wrong file.', retiredAtUtc: LATER }]);
  assert.deepEqual(reviseTasks(state, { update: [], add: [A], retire: [] }, [attempt(A)], LATER),
    { ok: false, problems: ["Task id 'a' was already used in this run; give the new task a new id."] });
  const dropped = applied(reviseTasks(planned(), { update: [], add: [], retire: [{ taskId: 'b', reason: 'Not needed.' }] }, [], LATER));
  assert.deepEqual([dropped.plan?.tasks.map((task) => task.id), dropped.retiredTasks], [['a'], []]);
});

test('keeping an approach closes its completed tasks and carries the rest into the next one', () => {
  const state = applied(changeApproach(withStatus(planned(), 'a', 'completed'),
    { lesson: 'A works; B needs another design.', rollback: false, title: 'Second design' }, [attempt(A)], LATER));
  assert.deepEqual(state.approaches, [
    { number: 1, title: 'Initial plan', startedAtUtc: AT,
      outcome: { kind: 'kept', lesson: 'A works; B needs another design.', endedAtUtc: LATER } },
    { number: 2, title: 'Second design', startedAtUtc: LATER, outcome: null }]);
  assert.deepEqual(state.tasks.map((task) => [task.taskId, task.status, task.approach]), [['a', 'completed', 1], ['b', 'pending', 2]]);
  assert.deepEqual([state.plan?.tasks.length, state.retiredTasks], [2, []]);
  assert.deepEqual(reviseTasks(state, { update: [{ taskId: 'a', set: { title: 'x' } }], add: [], retire: [] }, [attempt(A)], LATER),
    { ok: false, problems: ["Task 'a' was completed in approach 1, which has ended; it can no longer change. Add a task instead."] });
});

test('rolling back an approach drops all its tasks, records those that ran with the lesson, and keeps earlier approaches', () => {
  const kept = applied(changeApproach(withStatus(planned(), 'a', 'completed'),
    { lesson: 'A works.', rollback: false, title: 'Second' }, [attempt(A)], LATER));
  const second = applied(reviseTasks(kept, { update: [], add: [C], retire: [] }, [attempt(A)], LATER));
  const state = applied(changeApproach(withStatus(second, 'b', 'failed'),
    { lesson: 'B cannot work this way.', rollback: true, title: 'Third' }, [attempt(A), attempt(B, 2)], LATER));
  assert.deepEqual(state.plan?.tasks.map((task) => task.id), ['a']);
  assert.deepEqual(state.tasks.map((task) => [task.taskId, task.approach]), [['a', 1]]);
  assert.deepEqual(state.retiredTasks,
    [{ taskId: 'b', title: 'Task B', approach: 2, status: 'failed', reason: 'B cannot work this way.', retiredAtUtc: LATER }]);
  assert.deepEqual(state.approaches.map((approach) => [approach.number, approach.outcome?.kind ?? 'active']),
    [[1, 'kept'], [2, 'rolled_back'], [3, 'active']]);
  assert.deepEqual(changeApproach(EMPTY, { lesson: 'x', rollback: true, title: 'y' }, [], LATER),
    { ok: false, problems: ['Save a plan first with save_plan.'] });
});

test('a finish needs a plan, at least one task, and every task complete', () => {
  assert.equal(finishProblem(EMPTY), 'No plan is saved; there is nothing to finish.');
  const state = withStatus(planned(), 'a', 'completed');
  assert.equal(finishProblem(withStatus(state, 'b', 'failed')),
    'Not every task is complete: b (failed). Retire a task that cannot be completed with update_tasks and add its replacement.');
  assert.equal(finishProblem(withStatus(state, 'b', 'completed')), null);
  const emptied = applied(changeApproach(planned(), { lesson: 'Nothing held.', rollback: true, title: 'Again' }, [], LATER));
  assert.equal(finishProblem(emptied), 'The plan has no tasks: add the next tasks with update_tasks.');
});
```

Run: `node ./src/test-runner/run-tests.ts orchestrator-plan-state`
Expected: FAIL, cannot find module `../src/orchestrator/plan-state.ts`.

- [ ] **Step 2: Change the tool argument schemas**

In `packages/contracts/src/orchestrator.ts`, replace `OrchestratorUpdateTasksArgsSchema` (its doc comment and type too) and add the new schema after it:

```ts
/** Revises the saved plan in place: patch tasks by id, add tasks, retire tasks with the reason each leaves, or replace the final verification. */
export const OrchestratorUpdateTasksArgsSchema = z.object({
  update: z.array(z.object({
    taskId: z.string().min(1), set: OrchestratorTaskSchema.omit({ id: true }).partial().strict(),
  }).strict()).default([]),
  add: z.array(OrchestratorTaskSchema).default([]),
  retire: z.array(z.object({ taskId: z.string().min(1), reason: z.string().trim().min(1) }).strict()).default([]),
  finalVerification: OrchestratorPlanSchema.shape.finalVerification.optional(),
}).strict();
export type OrchestratorUpdateTasksArgs = z.infer<typeof OrchestratorUpdateTasksArgsSchema>;

/** Ends the active approach with what it taught, keeps or rolls back its changes, and names the next approach. */
export const OrchestratorChangeApproachArgsSchema = z.object({
  lesson: z.string().trim().min(1), rollback: z.boolean(), title: z.string().trim().min(1),
}).strict();
export type OrchestratorChangeApproachArgs = z.infer<typeof OrchestratorChangeApproachArgsSchema>;
```

- [ ] **Step 3: Keep the run compiling until Task 5 rewires it**

In `src/orchestrator/run.ts`, `updateTasks`: add `const retired = args.retire.map((entry) => entry.taskId);` and use `retired` where the method used `args.remove` (twice).

In `src/repo-search/planner-protocol.ts`, the `update_tasks` example: `remove: []` becomes `retire: []`.

In tests, every `remove` argument of `update_tasks` becomes `retire`:
- `tests/repo-search-orchestrator-tools.test.ts`: the expected args `{ update, add: [], remove: [] }` become `{ update, add: [], retire: [] }`.
- `tests/process/orchestrator-run.e2e.test.ts`: `tool('update_tasks', { remove: ['nowhere'] })` becomes `tool('update_tasks', { retire: [{ taskId: 'nowhere', reason: 'Never planned.' }] })`.

Search the tests, `src`, and `packages` for any other `remove` argument of `update_tasks` and convert it the same way.

- [ ] **Step 4: Write the module**

Create `src/orchestrator/plan-state.ts`:

```ts
import type {
  OrchestratorApproach,
  OrchestratorAttempt,
  OrchestratorChangeApproachArgs,
  OrchestratorPlan,
  OrchestratorRetiredTask,
  OrchestratorRunState,
  OrchestratorTaskState,
  OrchestratorUpdateTasksArgs,
} from '@siftkit/contracts';

/** The plan and the records whose lifecycle follows it. Only the transitions below produce a new one. */
export type PlanState = Pick<OrchestratorRunState, 'plan' | 'tasks' | 'approaches' | 'retiredTasks'>;

/** The next plan state, or why the change cannot happen. Nothing is changed in place. */
export type PlanTransition = { ok: true; next: PlanState } | { ok: false; problems: string[] };

const FIRST_APPROACH_TITLE = 'Initial plan';
const NO_PLAN = 'Save a plan first with save_plan.';

/** The approach new tasks join; null until the first plan. */
export function activeApproach(state: Pick<PlanState, 'approaches'>): OrchestratorApproach | null {
  const last = state.approaches.at(-1);
  return last === undefined || last.outcome !== null ? null : last;
}

function pendingIn(approach: OrchestratorApproach, taskId: string): OrchestratorTaskState {
  return { taskId, status: 'pending', review: null, approach: approach.number };
}

/** Records for the tasks named in `reasons` that ran; a task that never ran leaves none. */
function retiredRecords(plan: OrchestratorPlan, tasks: readonly OrchestratorTaskState[], reasons: ReadonlyMap<string, string>,
  attempts: readonly OrchestratorAttempt[], nowUtc: string): OrchestratorRetiredTask[] {
  const ran = new Set(attempts.map((attempt) => attempt.taskId));
  return plan.tasks.flatMap((task) => {
    const reason = reasons.get(task.id);
    const state = tasks.find((entry) => entry.taskId === task.id);
    return reason === undefined || state === undefined || !ran.has(task.id) ? []
      : [{ taskId: task.id, title: task.title, approach: state.approach, status: state.status, reason, retiredAtUtc: nowUtc }];
  });
}

/** The first plan opens approach 1 with every task pending. */
export function startPlan(state: PlanState, plan: OrchestratorPlan, nowUtc: string): PlanTransition {
  if (state.plan !== null) return { ok: false, problems: ['A plan is already saved; change it with update_tasks.'] };
  const approach: OrchestratorApproach = { number: 1, title: FIRST_APPROACH_TITLE, startedAtUtc: nowUtc, outcome: null };
  return { ok: true, next: { plan, approaches: [approach], retiredTasks: [], tasks: plan.tasks.map((task) => pendingIn(approach, task.id)) } };
}

/** Patches, adds, and retires tasks of the active approach. A task id that ever ran is never given to another task. */
export function reviseTasks(state: PlanState, args: OrchestratorUpdateTasksArgs, attempts: readonly OrchestratorAttempt[],
  nowUtc: string): PlanTransition {
  const { plan } = state;
  const approach = activeApproach(state);
  if (plan === null || approach === null) return { ok: false, problems: [NO_PLAN] };
  const stateOf = new Map(state.tasks.map((task) => [task.taskId, task]));
  const reasons = new Map(args.retire.map((entry) => [entry.taskId, entry.reason]));
  const problems: string[] = [];
  for (const taskId of [...args.update.map((entry) => entry.taskId), ...reasons.keys()]) {
    const task = stateOf.get(taskId);
    if (task === undefined) problems.push(`Task '${taskId}' is not in the saved plan.`);
    else if (task.approach !== approach.number) {
      problems.push(`Task '${taskId}' was completed in approach ${task.approach}, which has ended; it can no longer change. Add a task instead.`);
    }
  }
  const used = new Set([...stateOf.keys(), ...state.retiredTasks.map((task) => task.taskId), ...attempts.map((attempt) => attempt.taskId)]);
  for (const task of args.add) {
    if (used.has(task.id)) problems.push(`Task id '${task.id}' was already used in this run; give the new task a new id.`);
  }
  const patchOf = new Map(args.update.map((entry) => [entry.taskId, entry.set]));
  const kept = plan.tasks.filter((task) => !reasons.has(task.id));
  for (const task of kept) {
    const gone = task.dependsOn.filter((dependency) => reasons.has(dependency));
    if (gone.length > 0 && patchOf.get(task.id)?.dependsOn === undefined) {
      problems.push(`Task '${task.id}' depends on ${gone.join(', ')}, which this call retires: retire it too, or set its dependsOn.`);
    }
  }
  if (problems.length > 0) return { ok: false, problems };
  // Parsed rather than spread alone: a patch field holding `undefined` is refused instead of erasing the task's value.
  const tasks = [...kept.map((task) => OrchestratorTaskSchema.parse({ ...task, ...patchOf.get(task.id) })), ...args.add];
  return { ok: true, next: {
    plan: { ...plan, tasks, finalVerification: args.finalVerification ?? plan.finalVerification },
    approaches: state.approaches,
    retiredTasks: [...state.retiredTasks, ...retiredRecords(plan, state.tasks, reasons, attempts, nowUtc)],
    tasks: tasks.map((task) => stateOf.get(task.id) ?? pendingIn(approach, task.id)),
  } };
}

/**
 * Ends the active approach with its lesson and opens the next. A rollback drops every task of the ended approach
 * (the caller restores its files); otherwise its completed tasks stay, closed, and the rest move to the next approach.
 */
export function changeApproach(state: PlanState, args: OrchestratorChangeApproachArgs, attempts: readonly OrchestratorAttempt[],
  nowUtc: string): PlanTransition {
  const { plan } = state;
  const active = activeApproach(state);
  if (plan === null || active === null) return { ok: false, problems: [NO_PLAN] };
  const ended: OrchestratorApproach = { ...active,
    outcome: { kind: args.rollback ? 'rolled_back' : 'kept', lesson: args.lesson, endedAtUtc: nowUtc } };
  const next: OrchestratorApproach = { number: active.number + 1, title: args.title, startedAtUtc: nowUtc, outcome: null };
  const approaches = [...state.approaches.slice(0, -1), ended, next];
  if (!args.rollback) {
    return { ok: true, next: { plan, approaches, retiredTasks: state.retiredTasks, tasks: state.tasks.map((task) => (
      task.approach === active.number && task.status !== 'completed' ? { ...task, approach: next.number } : task)) } };
  }
  const reasons = new Map(state.tasks.filter((task) => task.approach === active.number).map((task) => [task.taskId, args.lesson]));
  return { ok: true, next: {
    plan: { ...plan, tasks: plan.tasks.filter((task) => !reasons.has(task.id)) }, approaches,
    retiredTasks: [...state.retiredTasks, ...retiredRecords(plan, state.tasks, reasons, attempts, nowUtc)],
    tasks: state.tasks.filter((task) => !reasons.has(task.taskId)),
  } };
}

/** Why a completed finish cannot go to final verification yet. */
export function finishProblem(state: PlanState): string | null {
  if (state.plan === null) return 'No plan is saved; there is nothing to finish.';
  if (state.tasks.length === 0) return 'The plan has no tasks: add the next tasks with update_tasks.';
  const open = state.tasks.filter((task) => task.status !== 'completed').map((task) => `${task.taskId} (${task.status})`);
  return open.length === 0 ? null
    : `Not every task is complete: ${open.join(', ')}. Retire a task that cannot be completed with update_tasks and add its replacement.`;
}
```

- [ ] **Step 5: Verify**

Run: `node ./src/test-runner/run-tests.ts orchestrator-plan-state`, `repo-search-orchestrator-tools`, `contracts-orchestrator`
Expected: PASS.

Run: `node ./src/test-runner/run-tests.ts --process orchestrator-run.e2e`
Expected: PASS.

Run: `npm run typecheck`
Expected: exit 0.

**Acceptance:** `plan-state.ts` imports only types from `@siftkit/contracts` and has no IO; `update_tasks` takes `retire` and no longer takes `remove`.

---

### Task 5: The run uses the plan transitions; a task that ran can be retired

`save_plan`, `update_tasks`, and the finish gate go through `plan-state.ts`. The store saves a whole plan state. A task out of attempts stops being a dead end.

**Files:**
- Modify: `src/orchestrator/run-store.ts`, `src/orchestrator/run.ts`, `src/orchestrator/scheduler.ts`
- Modify: `src/repo-search/planner-protocol.ts` (the `update_tasks` description)
- Modify: `tests/helpers/orchestrator-plan.ts`
- Test: `tests/orchestrator-run-store.test.ts`, `tests/orchestrator-scheduler.test.ts`, `tests/process/orchestrator-run.e2e.test.ts`

- [ ] **Step 1: Write the failing tests**

`tests/helpers/orchestrator-plan.ts`: replace `savePlanned` with (import `assert from 'node:assert/strict'` and `{ startPlan, type PlanTransition }` from `../../src/orchestrator/plan-state.ts`):

```ts
/** Stores a plan transition the way the run does; a refused transition fails the test. */
export function storeTransition(store: OrchestratorRunStore, state: OrchestratorRunState, transition: PlanTransition,
  contentHash = 'hash'): OrchestratorRunState {
  assert.ok(transition.ok, transition.ok ? '' : transition.problems.join(' '));
  const { plan } = transition.next;
  assert.ok(plan);
  return store.savePlan(state.runId, state.revision, { ...transition.next, plan }, 'docs/plan.md', contentHash);
}

/** Saves `plan` as the run's first plan. */
export function savePlanned(store: OrchestratorRunStore, state: OrchestratorRunState, plan: OrchestratorPlan,
  contentHash = 'hash'): OrchestratorRunState {
  return storeTransition(store, state, startPlan(state, plan, new Date().toISOString()), contentHash);
}
```

`tests/orchestrator-run-store.test.ts`: replace the tests `a saved plan starts every task pending with no review, and keeps the state of tasks it still names` and `a changed plan cannot drop or rename a task that already has attempts` with the two below (import `reviseTasks` from `../src/orchestrator/plan-state.ts`, `storeTransition` and `makeTaskState` from the helper; add `const NOW = '2026-11-21T10:00:00.000Z';`):

```ts
test('a first plan starts every task pending, and a revision keeps the state of the tasks it still names', (t) => {
  const { store } = openStore(t);
  let state = planned(store);
  assert.deepEqual(state.tasks, [makeTaskState('inspect'), makeTaskState('follow-up')]);
  state = store.update(state.runId, state.revision, { tasks: state.tasks.map((task) => (task.taskId === 'inspect'
    ? { ...task, status: 'completed' } : task)) }, { message: 'Task inspect: completed.' });
  state = storeTransition(store, state,
    reviseTasks(state, { update: [], add: [makeOrchestratorTask({ id: 'last' })], retire: [] }, state.attempts, NOW), 'hash-2');
  assert.deepEqual(state.tasks.map((task) => [task.taskId, task.status]), [['inspect', 'completed'], ['follow-up', 'pending'], ['last', 'pending']]);
  assert.equal(state.planHash, 'hash-2');
});

test('a plan state that loses a task with attempts is refused; retiring that task keeps it on record', (t) => {
  const { store } = openStore(t);
  let state = planned(store);
  store.reserveAttempt(state.runId, state.revision, 'inspect', work());
  state = store.read(state.runId);
  const { plan } = state;
  assert.ok(plan);
  const lossy = { ...state, plan: { ...plan, tasks: plan.tasks.filter((task) => task.id !== 'inspect') },
    tasks: state.tasks.filter((task) => task.taskId !== 'inspect') };
  assert.throws(() => store.savePlan(state.runId, state.revision, lossy, 'docs/plan.md', 'hash-2'),
    /Plan change would lose task 'inspect', which has attempts/u);
  state = storeTransition(store, state, reviseTasks(state, { update: [{ taskId: 'follow-up', set: { dependsOn: [] } }], add: [],
    retire: [{ taskId: 'inspect', reason: 'Wrong file.' }] }, state.attempts, NOW), 'hash-2');
  assert.deepEqual(state.tasks.map((task) => task.taskId), ['follow-up']);
  assert.deepEqual(state.retiredTasks.map((task) => [task.taskId, task.status, task.reason]), [['inspect', 'pending', 'Wrong file.']]);
  assert.equal(state.attempts.length, 1, 'the retired task keeps its attempt');
});
```

`tests/orchestrator-scheduler.test.ts`: give the `dispatch` helper an optional `activeApproach?: number` input and pass `activeApproach: input.activeApproach ?? 1` to `dispatchProblem`. Append:

```ts
test('a task completed in an approach that has ended takes no more work', () => {
  const fix: DispatchRequest = { task: WRITE, purpose: 'fix' };
  const attempts = [attempt(WRITE, 'implementation', 1, 'settled')];
  assert.equal(dispatch({ request: fix, statuses: { write: 'completed' }, attempts }), null, 'in the active approach a completed task takes a fix');
  assert.equal(dispatch({ request: fix, statuses: { write: 'completed' }, attempts, activeApproach: 2 }),
    "Task 'write' was completed in approach 1, which has ended; add a task to the current approach for further work on it.");
});
```

`tests/process/orchestrator-run.e2e.test.ts`: append:

```ts
/** A child that never creates the target: it reads, then reports until its resubmits run out. */
function neverWrites(): MockPlannerResponseInput[] {
  return [tool('read', { path: 'src/app.ts' }), AGENT_REPORT, AGENT_REPORT, AGENT_REPORT];
}

test('a task out of attempts blocks the finish until it is retired and replaced under a new id; the run then completes', async (t) => {
  const context = await startHarness(t, 'siftkit-orchestrator-retire-');
  const { engine } = context;
  const failing = (purpose: OrchestratorChildPurpose) => [dispatch({ taskId: 'greeting', purpose }), review('greeting', 'fail')];
  engine.parent.push([savePlan(), ...failing('implementation'), ...failing('implementation'), ...failing('fix'), ...failing('fix'),
    COMPLETE,
    tool('update_tasks', { retire: [{ taskId: 'greeting', reason: 'Four children never created the file.' }],
      add: [{ ...WRITE_TASK, id: 'greeting-2' }] }),
    dispatch({ taskId: 'greeting-2' }), review('greeting-2', 'pass'), COMPLETE]);
  engine.children.push(neverWrites(), neverWrites(), neverWrites(), neverWrites(), WRITER);

  const { state } = await followRun(context, (await startRun(context, 'off')).runId);

  assertCompleted(state, engine);
  assert.deepEqual(state.tasks.map((task) => [task.taskId, task.status]), [['greeting-2', 'completed']]);
  assert.deepEqual(state.retiredTasks.map((task) => [task.taskId, task.status, task.approach, task.reason]),
    [['greeting', 'failed', 1, 'Four children never created the file.']]);
  assert.equal(state.attempts.length, 5, 'the retired task keeps its four attempts on record');
  const outputs = engine.parentToolOutputs();
  assert.ok(outputs.some((output) => /Recorded fail for greeting; it is now failed\. It is out of attempts: retire it/u.test(output)));
  assert.ok(outputs.some((output) => /^Plan updated: .*plan\.md now has 1 task\(s\)\./u.test(output)));
  assert.doesNotMatch(fs.readFileSync(path.join(context.repo, state.planPath ?? ''), 'utf8'), /## Task greeting:/u);
});
```

Run: `node ./src/test-runner/run-tests.ts orchestrator-run-store`
Expected: FAIL (`store.savePlan` still takes a plan).

- [ ] **Step 2: The store saves a whole plan state**

In `src/orchestrator/run-store.ts`, replace `savePlan` and its comment (import `type { PlanState } from './plan-state.ts'`; drop the now-unused `OrchestratorTaskState` import):

```ts
  /** Stores a validated plan state whole. A task that ran must stay on record, live or retired. */
  savePlan(runId: string, revision: number, next: PlanState & { plan: OrchestratorPlan }, planPath: string,
    contentHash: string): OrchestratorRunState {
    return this.mutate(runId, revision, (state) => {
      const recorded = new Set([...next.tasks.map((task) => task.taskId), ...next.retiredTasks.map((task) => task.taskId)]);
      const lost = state.attempts.find((attempt) => !recorded.has(attempt.taskId));
      if (lost !== undefined) throw new Error(`Plan change would lose task '${lost.taskId}', which has attempts.`);
      const { plan, tasks, approaches, retiredTasks } = next;
      return { stored: { ...state, plan, tasks, approaches, retiredTasks, planPath, planHash: contentHash },
        event: { message: `Plan saved: ${planPath}.` } };
    });
  }
```

- [ ] **Step 3: Dispatch refuses a closed task**

In `src/orchestrator/scheduler.ts`, replace the head of `dispatchProblem`, from its doc comment down to the line that computes `current`:

```ts
/** Why the requested child cannot start: a closed task, a status its purpose disallows, no attempt left, or incomplete dependencies. */
export function dispatchProblem(input: {
  taskStates: readonly OrchestratorTaskState[];
  attempts: readonly OrchestratorAttempt[];
  /** The number of the approach that work may be added to. */
  activeApproach: number;
  request: DispatchRequest;
}): string | null {
  const { task, purpose } = input.request;
  const own = input.taskStates.find((state) => state.taskId === task.id);
  if (own !== undefined && own.approach !== input.activeApproach) {
    return `Task '${task.id}' was completed in approach ${own.approach}, which has ended; add a task to the current approach for further work on it.`;
  }
  const status = new Map(input.taskStates.map((state) => [state.taskId, state.status]));
  const current = own?.status ?? 'pending';
```

- [ ] **Step 4: Rewire the run**

In `src/orchestrator/run.ts`:

Imports: add `activeApproach, finishProblem, reviseTasks, startPlan, type PlanState, type PlanTransition` from `./plan-state.ts`.

Replace `savePlan`, `updateTasks`, and `storePlan` with:

```ts
  private planState(): PlanState {
    const { plan, tasks, approaches, retiredTasks } = this.state;
    return { plan, tasks, approaches, retiredTasks };
  }

  /** Repository-relative path of the Markdown plan the host writes. */
  private get planFile(): string {
    return `${orchestratorArtifactDir(this.runId)}/plan.md`;
  }

  private async savePlan(args: OrchestratorSavePlanArgs): Promise<OrchestratorToolOutcome> {
    const problems = await this.storePlan(startPlan(this.planState(), args.plan, new Date().toISOString()));
    if (problems.length > 0) return this.refuse(problems);
    return { ok: true, output: [`Plan saved to ${this.planFile} with ${this.state.tasks.length} task(s).`, renderLedger(this.state)].join('\n') };
  }

  private async updateTasks(args: OrchestratorUpdateTasksArgs): Promise<OrchestratorToolOutcome> {
    const problems = await this.storePlan(reviseTasks(this.planState(), args, this.state.attempts, new Date().toISOString()));
    if (problems.length > 0) return this.refuse(problems);
    for (const { taskId } of args.retire) this.awaitingReview.delete(taskId);
    return { ok: true, output: [`Plan updated: ${this.planFile} now has ${this.state.tasks.length} task(s).`, renderLedger(this.state)].join('\n') };
  }

  /** Validates a plan transition, stores it, and rewrites plan.md. Returns why it was refused; empty means stored. */
  private async storePlan(transition: PlanTransition): Promise<readonly string[]> {
    const blocker = this.childBlocker();
    if (blocker !== null) return [blocker];
    if (!transition.ok) return transition.problems;
    if (transition.next.plan === null) throw new Error('A plan transition produced no plan.');
    let plan: OrchestratorPlan;
    try {
      plan = validateOrchestratorPlan(transition.next.plan, this.config, this.request.repoRoot);
    } catch (error) {
      return [toError(error).message];
    }
    const unrunnable = await findUnrunnableChecks(this.request.repoRoot,
      [...plan.tasks.flatMap((task) => task.verification), ...plan.finalVerification], this.signal);
    if (unrunnable.length > 0) return unrunnable;
    const markdown = renderOrchestratorPlan(plan);
    this.publish(this.ctx.orchestratorRunStore.savePlan(this.runId, this.state.revision, { ...transition.next, plan }, this.planFile,
      hashText(markdown)));
    // The host, not the model, writes the Markdown plan, under exclusive repository ownership.
    const lease = await this.acquireRepository();
    try {
      const absolute = join(this.request.repoRoot, this.planFile);
      mkdirSync(dirname(absolute), { recursive: true });
      writeFileSync(absolute, markdown, 'utf8');
    } finally {
      lease.release();
    }
    if (this.state.phase === 'preparing_plan') this.commit({ phase: 'executing' }, 'Executing the plan.');
    return [];
  }
```

In `dispatch`, replace the first two lines and the `dispatchProblem` call:

```ts
    const { plan, planPath, planHash } = this.state;
    const approach = activeApproach(this.state);
    if (plan === null || planPath === null || planHash === null || approach === null) return this.refuse(['Save a plan first.']);
```

```ts
    const problem = dispatchProblem({ taskStates: this.state.tasks, attempts: this.state.attempts, activeApproach: approach.number,
      request: { task, purpose: args.purpose } });
```

In `recordReview`, replace the final `return`:

```ts
    const hint = status === 'failed' ? ' It is out of attempts: retire it with update_tasks and add a replacement task that does it differently.' : '';
    return { ok: true, output: [`Recorded ${args.verdict} for ${args.taskId}; it is now ${status}.${hint}`, renderLedger(this.state)].join('\n') };
```

In `review` (the finish), replace the lines from `const { plan } = this.state;` through the `open.length > 0` rejection:

```ts
    const problem = finishProblem(this.planState());
    if (problem !== null) return { kind: 'reject', message: problem };
    const { plan } = this.state;
    if (plan === null) throw new Error('A finishable run has no plan.');
```

- [ ] **Step 5: Say what the tool now does**

In `src/repo-search/planner-protocol.ts`, the `update_tasks` description:

```ts
    description: 'Revise the saved plan: patch tasks by id with only the fields that change, add tasks, retire tasks with the reason each is dropped, or replace the final verification. A retired task that already ran stays on record and its id cannot be reused; give its replacement a new id. The whole plan is validated again and plan.md is rewritten.',
```

- [ ] **Step 6: Verify**

Run: `node ./src/test-runner/run-tests.ts orchestrator-run-store`, `orchestrator-scheduler`, `orchestrator-runs`, `orchestrator-plan-state`
Expected: PASS.

Run: `npm test`
Expected: exit 0 (the schema tests save plans through the helper).

Run: `node ./src/test-runner/run-tests.ts --process orchestrator-run.e2e`
Expected: PASS, including the new retire test.

Run: `npm run typecheck`
Expected: exit 0.

**Acceptance:** `run.ts` holds no plan-merging logic (a search for `args.update` and `args.add` in `src/orchestrator/run.ts` finds nothing); the new e2e test passes; a `failed` task can be retired and replaced and the run completes.

---

### Task 6: Checkpoint and restore the working tree

`workspace.ts` can already snapshot dirty files and measure changes against a snapshot. This task adds the inverse: put the tree back.

**Files:**
- Modify: `src/orchestrator/workspace.ts`
- Test: `tests/process/orchestrator-workspace.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `tests/process/orchestrator-workspace.test.ts` (add `checkpointWorkspace` and `restoreWorkspace` to its import):

```ts
test('a restore puts back edited, deleted, and already-dirty files, removes new ones with their empty folders, and leaves ignored files', async () => {
  const root = makeRepo();
  fs.writeFileSync(path.join(root, '.gitignore'), 'build/\n');
  fs.writeFileSync(path.join(root, 'src', 'c.ts'), 'export const c = 1;\n');
  execFileSync('git', ['add', '.'], { cwd: root });
  execFileSync('git', ['commit', '--quiet', '-m', 'more'], { cwd: root });
  fs.writeFileSync(path.join(root, 'README.md'), '# Repo\nuser edit\n');
  fs.writeFileSync(path.join(root, 'notes.txt'), 'mine');
  const checkpoint = await checkpointWorkspace(root);

  fs.writeFileSync(path.join(root, 'README.md'), '# Repo\nagent edit\n');
  fs.writeFileSync(path.join(root, 'src', 'a.ts'), 'export const a = 2;\n');
  fs.rmSync(path.join(root, 'src', 'c.ts'));
  fs.rmSync(path.join(root, 'notes.txt'));
  fs.mkdirSync(path.join(root, 'src', 'new'));
  fs.writeFileSync(path.join(root, 'src', 'new', 'b.ts'), 'export const b = 1;\n');
  fs.mkdirSync(path.join(root, 'build'));
  fs.writeFileSync(path.join(root, 'build', 'out.txt'), 'built');

  assert.deepEqual(await restoreWorkspace(root, checkpoint), ['README.md', 'notes.txt', 'src/a.ts', 'src/c.ts', 'src/new/b.ts']);
  assert.equal(fs.readFileSync(path.join(root, 'README.md'), 'utf8'), '# Repo\nuser edit\n', 'an edit that predates the checkpoint is kept');
  assert.equal(fs.readFileSync(path.join(root, 'notes.txt'), 'utf8'), 'mine');
  assert.equal(fs.readFileSync(path.join(root, 'src', 'a.ts'), 'utf8'), 'export const a = 1;\n');
  assert.equal(fs.readFileSync(path.join(root, 'src', 'c.ts'), 'utf8'), 'export const c = 1;\n');
  assert.equal(fs.existsSync(path.join(root, 'src', 'new')), false, 'a folder the restore emptied is removed');
  assert.equal(fs.readFileSync(path.join(root, 'build', 'out.txt'), 'utf8'), 'built', 'ignored files are not part of a checkpoint');
  assert.deepEqual(await diffWorkspace(root, checkpoint.files), { paths: [], digest: null });
  assert.deepEqual(await restoreWorkspace(root, checkpoint), [], 'a second restore finds nothing to do');
});

test('a restore refuses once a commit has been made since the checkpoint', async () => {
  const root = makeRepo();
  const checkpoint = await checkpointWorkspace(root);
  fs.writeFileSync(path.join(root, 'src', 'a.ts'), 'export const a = 2;\n');
  execFileSync('git', ['commit', '--quiet', '-am', 'moved'], { cwd: root });
  await assert.rejects(restoreWorkspace(root, checkpoint), /Cannot roll back: HEAD is [0-9a-f]{40}, but the approach began at [0-9a-f]{40}\./u);
});
```

Run: `node ./src/test-runner/run-tests.ts --process orchestrator-workspace`
Expected: FAIL, `checkpointWorkspace` is not exported.

- [ ] **Step 2: Implement**

In `src/orchestrator/workspace.ts`, add `rmdirSync` to the `node:fs` import, and add after `headContent`:

```ts
/** The tree at one moment, restorable: its dirty files, and the commit they are dirty against (null before any commit). */
export type WorkspaceCheckpoint = { head: string | null; files: WorkspaceSnapshot };

async function headCommit(repoRoot: string): Promise<string | null> {
  const result = await runGit(repoRoot, ['rev-parse', '--verify', '--quiet', 'HEAD']);
  return result.exitCode === 0 ? result.stdout.trim() : null;
}

export async function checkpointWorkspace(repoRoot: string): Promise<WorkspaceCheckpoint> {
  return { head: await headCommit(repoRoot), files: await captureWorkspace(repoRoot) };
}

/** How many paths one `git restore` takes, to stay under the Windows command-line limit. */
const RESTORE_BATCH = 50;

/**
 * Puts every file that changed since `checkpoint` back as it was and returns those paths. Files git ignores are not
 * part of a checkpoint, and a commit made since refuses the restore.
 */
export async function restoreWorkspace(repoRoot: string, checkpoint: WorkspaceCheckpoint): Promise<string[]> {
  const head = await headCommit(repoRoot);
  if (head !== checkpoint.head) {
    throw new Error(`Cannot roll back: HEAD is ${head ?? 'unborn'}, but the approach began at ${checkpoint.head ?? 'no commit'}.`);
  }
  const changed = (await diffWorkspace(repoRoot, checkpoint.files)).paths;
  const fromHead: string[] = [];
  for (const path of changed) {
    const recorded = checkpoint.files.get(path);
    if (recorded !== undefined) writeOrRemove(repoRoot, path, recorded);
    // Clean at the checkpoint: the file is HEAD's version, or did not exist.
    else if ((await runGit(repoRoot, ['cat-file', '-e', `HEAD:${path}`])).exitCode === 0) fromHead.push(path);
    else writeOrRemove(repoRoot, path, null);
  }
  for (let index = 0; index < fromHead.length; index += RESTORE_BATCH) {
    await git(repoRoot, ['restore', '--source=HEAD', '--worktree', '--', ...fromHead.slice(index, index + RESTORE_BATCH)]);
  }
  return changed;
}

/** Writes `content` to `path`; null deletes the file and every folder the deletion leaves empty, up to the root. */
function writeOrRemove(repoRoot: string, path: string, content: Buffer | null): void {
  const absolute = join(repoRoot, path);
  if (content !== null) {
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, content);
    return;
  }
  rmSync(absolute, { force: true });
  for (let folder = dirname(absolute); isWithin(resolve(repoRoot), folder) && existsSync(folder) && readdirSync(folder).length === 0;
    folder = dirname(folder)) {
    rmdirSync(folder);
  }
}
```

`isWithin` is a function declaration lower in the same file, so it is already in scope.

- [ ] **Step 3: Verify**

Run: `node ./src/test-runner/run-tests.ts --process orchestrator-workspace`
Expected: PASS.

Run: `npm run typecheck`
Expected: exit 0.

**Acceptance:** after a restore, `diffWorkspace` against the checkpoint reports no change; ignored files and files that were already dirty at the checkpoint are untouched; a moved HEAD is refused with both commits named.

---

### Task 7: The `change_approach` tool

The orchestrator can end an approach, record what it taught, and optionally put the files back. The checkpoint is taken when an approach begins: at `save_plan`, and after each `change_approach`.

**Files:**
- Modify: `packages/contracts/src/orchestrator.ts`
- Modify: `src/planner-protocol/repo-search.ts`, `src/repo-search/repo-tool-arguments.ts`, `src/repo-search/planner-protocol.ts`, `src/repo-search/engine/repo-tools.ts`, `src/repo-search/tool-activity.ts`, `src/repo-search/engine/tool-action-processor.ts`
- Modify: `src/orchestrator/run.ts`
- Test: `tests/contracts-orchestrator.test.ts`, `tests/repo-search-orchestrator-tools.test.ts`, `tests/process/orchestrator-run.e2e.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `tests/contracts-orchestrator.test.ts` (import `OrchestratorChangeApproachArgsSchema`, `OrchestratorPlanSchema`, `OrchestratorSavePlanArgsSchema`, and `makeOrchestratorPlan`):

```ts
test('a stored plan may hold no task after a rollback, but save_plan needs at least one; change_approach names all three fields', () => {
  const empty = { goal: 'Go.', constraints: [], tasks: [], finalVerification: [{ kind: 'command', command: 'npm test', cwd: '.', expectedExitCode: 0 }] };
  assert.equal(OrchestratorPlanSchema.safeParse(empty).success, true);
  assert.equal(OrchestratorSavePlanArgsSchema.safeParse({ plan: empty }).success, false);
  assert.equal(OrchestratorSavePlanArgsSchema.safeParse({ plan: makeOrchestratorPlan([makeOrchestratorTask()]) }).success, true);
  const change = { lesson: 'The cache cannot see headers.', rollback: true, title: 'Cache the index' };
  assert.equal(OrchestratorChangeApproachArgsSchema.safeParse(change).success, true);
  assert.equal(OrchestratorChangeApproachArgsSchema.safeParse({ lesson: change.lesson, title: change.title }).success, false);
  assert.equal(OrchestratorChangeApproachArgsSchema.safeParse({ ...change, lesson: ' ' }).success, false);
});
```

If an existing test in that file asserts that `OrchestratorPlanSchema` rejects an empty task list, change it to assert that on `OrchestratorSavePlanArgsSchema`.

Append to `tests/repo-search-orchestrator-tools.test.ts`:

```ts
test('change_approach reaches the host parsed', async () => {
  const host = new RecordingHost(() => ({ ok: true, output: 'Approach 2 is active.' }));
  const args = { lesson: 'The cache cannot see headers.', rollback: true, title: 'Cache the index' };
  await run(host, [{ toolCalls: [{ name: 'change_approach', arguments: args }] }, { content: 'done' }, { content: 'done' }]);
  assert.deepEqual(host.calls, [{ toolName: 'change_approach', args }]);
});
```

Append to `tests/process/orchestrator-run.e2e.test.ts`:

```ts
function changeApproachTo(title: string, lesson: string, rollback: boolean) {
  return tool('change_approach', { title, lesson, rollback });
}

test('change_approach with rollback puts the files back, records the dropped task with the lesson, and the next approach completes the run', async (t) => {
  const context = await startHarness(t, 'siftkit-orchestrator-rollback-');
  const { engine } = context;
  const lesson = 'A constant greeting cannot be localised.';
  engine.parent.push([savePlan(), dispatch({ taskId: 'greeting' }), review('greeting', 'fail'),
    changeApproachTo('Farewell first', lesson, true), tool('update_tasks', { add: [FAREWELL_TASK] }),
    dispatch({ taskId: 'farewell' }), review('farewell', 'pass'), COMPLETE]);
  engine.children.push(WRITER, FAREWELL_WRITER);

  const { state, events } = await followRun(context, (await startRun(context, 'off')).runId);

  assertCompleted(state, engine);
  assert.equal(fs.existsSync(path.join(context.repo, TARGET)), false, 'the rolled-back approach left no file behind');
  assert.ok(fs.existsSync(path.join(context.repo, 'src', 'farewell.ts')));
  assert.deepEqual(state.approaches.map((approach) => [approach.number, approach.title, approach.outcome?.kind ?? 'active', approach.outcome?.lesson ?? null]),
    [[1, 'Initial plan', 'rolled_back', lesson], [2, 'Farewell first', 'active', null]]);
  assert.deepEqual(state.retiredTasks.map((task) => [task.taskId, task.status, task.approach, task.reason]), [['greeting', 'reviewing', 1, lesson]]);
  assert.deepEqual(state.tasks.map((task) => [task.taskId, task.status, task.approach]), [['farewell', 'completed', 2]]);
  const changed = engine.parentToolOutputs().find((output) => output.startsWith('Approach 1 ended')) ?? '';
  assert.match(changed, /^Approach 1 ended, rolled back \(\d+ file\(s\) restored\)\. Approach 2 is active: Farewell first\./u);
  assert.match(changed, /Restored: .*src\/greeting\.ts/u);
  assert.ok(events.some((event) => /^Approach 1 rolled back \(\d+ file\(s\) restored\); approach 2 began: Farewell first\.$/u.test(event.message)));
});

test('change_approach without rollback keeps the files, closes completed tasks, and carries open tasks into the next approach', async (t) => {
  const context = await startHarness(t, 'siftkit-orchestrator-keep-');
  const { engine } = context;
  engine.parent.push([savePlan(planOf([WRITE_TASK, FAREWELL_TASK])), dispatch({ taskId: 'greeting' }), review('greeting', 'pass'),
    changeApproachTo('Second design', 'The greeting works; the farewell needs another design.', false),
    dispatch({ taskId: 'greeting', purpose: 'fix' }), dispatch({ taskId: 'farewell' }), review('farewell', 'pass'), COMPLETE]);
  engine.children.push(WRITER, FAREWELL_WRITER);

  const { state } = await followRun(context, (await startRun(context, 'off')).runId);

  assertCompleted(state, engine);
  assert.equal(fs.readFileSync(path.join(context.repo, TARGET), 'utf8'), GREETING, 'a kept approach keeps its files');
  assert.deepEqual(state.tasks.map((task) => [task.taskId, task.status, task.approach]), [['greeting', 'completed', 1], ['farewell', 'completed', 2]]);
  assert.deepEqual(state.approaches.map((approach) => approach.outcome?.kind ?? 'active'), ['kept', 'active']);
  assert.deepEqual(state.retiredTasks, []);
  assert.ok(engine.parentToolOutputs().some((output) => /Task 'greeting' was completed in approach 1, which has ended/u.test(output)),
    'a closed task takes no fix');
  assert.equal(state.attempts.length, 2, 'the refused fix started no child');
});
```

Run: `node ./src/test-runner/run-tests.ts repo-search-orchestrator-tools`
Expected: FAIL, `change_approach` is not a known tool.

- [ ] **Step 2: Contracts — an empty stored plan, a non-empty first plan**

In `packages/contracts/src/orchestrator.ts`, replace `OrchestratorPlanSchema` and `OrchestratorSavePlanArgsSchema`:

```ts
/** The stored plan. After a rollback it may hold no task until the next approach adds some. */
export const OrchestratorPlanSchema = z.object({
  goal: z.string().trim().min(1), constraints: z.array(z.string().min(1)),
  tasks: z.array(OrchestratorTaskSchema),
  finalVerification: z.array(OrchestratorVerificationCheckSchema).min(1),
}).strict();
export type OrchestratorPlan = z.infer<typeof OrchestratorPlanSchema>;
```

```ts
/** The first plan, as save_plan takes it: at least one task. */
export const OrchestratorSavePlanArgsSchema = z.object({
  plan: OrchestratorPlanSchema.extend({ tasks: OrchestratorPlanSchema.shape.tasks.min(1) }).strict(),
}).strict();
export type OrchestratorSavePlanArgs = z.infer<typeof OrchestratorSavePlanArgsSchema>;
```

- [ ] **Step 3: Register the tool**

`src/planner-protocol/repo-search.ts`, `ORCHESTRATOR_TOOL_NAMES`: add `'change_approach',` after `'update_tasks',`.

`src/repo-search/repo-tool-arguments.ts`: import `OrchestratorChangeApproachArgsSchema`; add to `REPO_TOOL_ARGUMENT_SCHEMAS`, after `update_tasks`:

```ts
  change_approach: OrchestratorChangeApproachArgsSchema,
```

and to `ORCHESTRATOR_TOOL_CALLS`, after the `update_tasks` entry:

```ts
  z.object({ toolName: z.literal('change_approach'), args: OrchestratorChangeApproachArgsSchema }).strict(),
```

`src/repo-search/planner-protocol.ts`: add to `REPO_TOOL_REGISTRY`, after `update_tasks`:

```ts
  change_approach: buildRepoToolDefinition({
    toolName: 'change_approach',
    description: 'End the current approach and begin the next. Give the lesson: what was tried and why it did not work. rollback true puts every file back as it was when the approach began and drops its tasks; rollback false keeps its work, closes its completed tasks, and carries the rest over. Files git ignores are never restored. Afterwards add the next tasks with update_tasks.',
    exampleArgs: { lesson: 'Caching whole responses broke invalidation: the keys cannot see request headers.', rollback: true, title: 'Cache only the parsed index' },
  }),
```

and add `'change_approach'` to `TREE_MUTATING_TOOL_NAMES`.

`src/repo-search/engine/repo-tools.ts`, before the `run_check` branch of the command formatter:

```ts
  if (toolName === 'change_approach') {
    return formatToolCommand('change_approach', [['title', readString(args.title)], ['rollback', optionalBoolean(args.rollback)]]);
  }
```

`src/repo-search/tool-activity.ts`: add `case 'change_approach':` beside `case 'update_tasks':` in both switches.

`src/repo-search/engine/tool-action-processor.ts`, in `invalidateAfterMutation`: add `|| normalizedToolName === 'change_approach'` to the condition that calls `this.deps.readWindows.invalidateAll()`. A rollback rewrites files, so every earlier read is stale.

Run `npm run typecheck`. If another exhaustive switch or record keyed by tool name fails to compile, add `change_approach` beside `update_tasks` there too.

- [ ] **Step 4: Handle it in the run**

In `src/orchestrator/run.ts`:

Imports: `changeApproach` from `./plan-state.ts`; `checkpointWorkspace`, `restoreWorkspace`, `type WorkspaceCheckpoint` from `./workspace.ts`; `type OrchestratorChangeApproachArgs` from `@siftkit/contracts`.

Next to `COMMAND_TAIL_CHARS`:

```ts
/** How many restored paths a rollback's result lists. */
const RESTORED_PATHS_SHOWN = 20;
```

A field, beside `passedRunChecks`:

```ts
  /** The tree as it was when the active approach began; a rollback restores it. */
  private checkpoint: WorkspaceCheckpoint | null = null;
```

A helper, after `acquireRepository`:

```ts
  /** Runs `work` while the parent holds the repository exclusively. */
  private async withRepository<T>(work: () => Promise<T>): Promise<T> {
    const lease = await this.acquireRepository();
    try {
      return await work();
    } finally {
      lease.release();
    }
  }
```

Use it for the two existing inline leases, so the pattern lives once:
- In `storePlan`, the Markdown write becomes:

```ts
    // The host, not the model, writes the Markdown plan, under exclusive repository ownership.
    await this.withRepository(() => {
      const absolute = join(this.request.repoRoot, this.planFile);
      mkdirSync(dirname(absolute), { recursive: true });
      writeFileSync(absolute, markdown, 'utf8');
      return Promise.resolve();
    });
```

- `runOwnedChecks` becomes:

```ts
  private runOwnedChecks(checks: readonly OrchestratorVerificationCheck[]): Promise<OrchestratorCheckResult[]> {
    return this.withModelReleased(() => this.withRepository(() => this.runChecks(checks, null)));
  }
```

`storePlan` takes a second parameter, because an approach change adds no check command:

```ts
  private async storePlan(transition: PlanTransition, preflight: boolean): Promise<readonly string[]> {
```

and its preflight block becomes:

```ts
    if (preflight) {
      const unrunnable = await findUnrunnableChecks(this.request.repoRoot,
        [...plan.tasks.flatMap((task) => task.verification), ...plan.finalVerification], this.signal);
      if (unrunnable.length > 0) return unrunnable;
    }
```

`savePlan` and `updateTasks` pass `true`. `savePlan` also takes the first checkpoint, after its `problems` check:

```ts
    this.checkpoint = await this.withRepository(() => checkpointWorkspace(this.request.repoRoot));
```

In `execute`, after the `update_tasks` case:

```ts
      case 'change_approach':
        return this.changeApproach(call.args);
```

The handler, after `updateTasks`:

```ts
  /** Ends the active approach: restores its files when asked, stores the transition, and checkpoints the next approach. */
  private async changeApproach(args: OrchestratorChangeApproachArgs): Promise<OrchestratorToolOutcome> {
    const blocker = this.childBlocker();
    if (blocker !== null) return this.refuse([blocker]);
    const ended = activeApproach(this.state);
    const transition = changeApproach(this.planState(), args, this.state.attempts, new Date().toISOString());
    if (!transition.ok) return this.refuse(transition.problems);
    const { checkpoint } = this;
    if (ended === null || checkpoint === null) throw new Error('A planned run has no checkpoint for its active approach.');
    let restored: string[] = [];
    if (args.rollback) {
      try {
        restored = await this.withRepository(() => restoreWorkspace(this.request.repoRoot, checkpoint));
      } catch (error) {
        return this.refuse([toError(error).message]);
      }
      // The files changed under every check that passed before.
      this.passedRunChecks = [];
    }
    const problems = await this.storePlan(transition, false);
    if (problems.length > 0) return this.refuse(problems);
    this.checkpoint = await this.withRepository(() => checkpointWorkspace(this.request.repoRoot));
    const live = new Set(this.state.tasks.map((task) => task.taskId));
    for (const taskId of [...this.awaitingReview.keys()]) {
      if (!live.has(taskId)) this.awaitingReview.delete(taskId);
    }
    const outcome = args.rollback ? `rolled back (${restored.length} file(s) restored)` : 'kept';
    this.commit({}, `Approach ${ended.number} ${outcome}; approach ${ended.number + 1} began: ${args.title}.`);
    const more = restored.length > RESTORED_PATHS_SHOWN ? `, and ${restored.length - RESTORED_PATHS_SHOWN} more` : '';
    return { ok: true, output: [
      `Approach ${ended.number} ended, ${outcome}. Approach ${ended.number + 1} is active: ${args.title}.`,
      ...(restored.length === 0 ? [] : [`Restored: ${restored.slice(0, RESTORED_PATHS_SHOWN).join(', ')}${more}`]),
      'Add its tasks with update_tasks.', renderLedger(this.state),
    ].join('\n') };
  }
```

The restore runs before the transition is stored. If it fails, the approach is still active and the call can be repeated; a restore is safe to repeat.

- [ ] **Step 5: Verify**

Run: `node ./src/test-runner/run-tests.ts contracts-orchestrator`, `repo-search-orchestrator-tools`, `orchestrator-plan-state`
Expected: PASS.

Run: `node ./src/test-runner/run-tests.ts --process orchestrator-run.e2e`
Expected: PASS, including both new approach tests.

Run: `npm test` then `npm run typecheck`
Expected: exit 0 for both.

**Acceptance:** the orchestrator is offered `change_approach`; a rollback removes the approach's file changes and records its tasks in `retiredTasks`; a kept approach closes its completed tasks; `run.ts` acquires the repository only through `withRepository` or for a child.

---

### Task 8: The run budget replaces the finish cap and the turn cap

The budget stored in Task 3 starts to count. The dispatch limit refuses new children and ends the run on the next failing finish. The time limit stops the run wherever it is. Finishing has no cap of its own.

**Files:**
- Create: `src/orchestrator/budget.ts`
- Modify: `packages/contracts/src/orchestrator.ts` (remove `ORCHESTRATOR_MAX_FINISH_ATTEMPTS`)
- Modify: `src/orchestrator/ledger.ts`, `src/orchestrator/run-store.ts`, `src/orchestrator/run.ts`, `src/orchestrator/digest.ts`, `src/orchestrator/prompts.ts`
- Test: `tests/orchestrator-budget.test.ts` (new), `tests/orchestrator-ledger.test.ts`, `tests/orchestrator-run-store.test.ts`, `tests/orchestrator-digest.test.ts`, `tests/process/orchestrator-run.e2e.test.ts`

- [ ] **Step 1: Write the failing unit tests**

Create `tests/orchestrator-budget.test.ts`:

```ts
import assert from 'node:assert/strict';
import test from 'node:test';

import { OrchestratorAttemptSchema, type OrchestratorAttempt } from '@siftkit/contracts';
import { budgetDeadlineMs, budgetUsage, dispatchBudgetSpent, renderBudget } from '../src/orchestrator/budget.ts';
import { makeOrchestratorRequest, makeOrchestratorRunState, makeOrchestratorTask } from './helpers/orchestrator-plan.ts';

const CREATED = '2026-11-21T10:00:00.000Z';
const CREATED_MS = Date.parse(CREATED);
const TASK = makeOrchestratorTask();

function attempt(number: number): OrchestratorAttempt {
  return OrchestratorAttemptSchema.parse({
    taskId: TASK.id, purpose: number > 2 ? 'fix' : 'implementation', attempt: number > 2 ? number - 2 : number,
    childRunId: `00000000-0000-4000-8000-00000000000${number}`, status: 'settled', result: null, reservedAtUtc: CREATED,
    work: { kind: number > 2 ? 'fix' : 'implementation', planPath: 'plan.md', planHash: 'h', task: TASK, instruction: 'Do it.' },
  });
}

function run(dispatched: number) {
  return makeOrchestratorRunState({ request: makeOrchestratorRequest({ budget: { minutes: 90, dispatches: 3 } }), createdAtUtc: CREATED,
    attempts: Array.from({ length: dispatched }, (_, index) => attempt(index + 1)) });
}

test('usage counts whole minutes since the run was created, capped at the limit, and every attempt as one dispatch', () => {
  assert.deepEqual(budgetUsage(run(2), CREATED_MS + 61 * 60_000 + 59_000), { minutes: 90, minutesUsed: 61, dispatches: 3, dispatchesUsed: 2 });
  assert.equal(budgetUsage(run(0), CREATED_MS + 600 * 60_000).minutesUsed, 90, 'a stopped run never shows more than its limit');
  assert.equal(budgetUsage(run(0), CREATED_MS - 5_000).minutesUsed, 0);
  assert.equal(renderBudget(budgetUsage(run(2), CREATED_MS + 61 * 60_000)), 'Budget: 2 of 3 dispatches and 61 of 90 minutes used.');
});

test('the deadline is the creation time plus the minutes, and the dispatch budget is spent at its limit', () => {
  assert.equal(budgetDeadlineMs(run(0)), CREATED_MS + 90 * 60_000);
  assert.deepEqual([dispatchBudgetSpent(run(2)), dispatchBudgetSpent(run(3))], [false, true]);
});
```

Replace both tests in `tests/orchestrator-ledger.test.ts` with (import `makeOrchestratorRequest`, `makeOrchestratorRunState`; the `attempt` helper stays):

```ts
const CREATED = '2026-10-11T12:00:00.000Z';
const NOW = Date.parse(CREATED) + 30 * 60_000;

test('the ledger lists every task with its status, attempts per purpose, and last review, then the budget', () => {
  const review: NonNullable<OrchestratorTaskState['review']> = { attempt: 1, purpose: 'fix', verdict: 'fail', criteria: [], findings: [] };
  const state = makeOrchestratorRunState({
    request: makeOrchestratorRequest({ budget: { minutes: 90, dispatches: 10 } }), createdAtUtc: CREATED,
    plan: makeOrchestratorPlan([A, B]), tasks: [makeTaskState('a', 'reviewing', { review }), makeTaskState('b')],
    attempts: [attempt(A, 'implementation', 1), attempt(A, 'implementation', 2), attempt(A, 'fix', 1)],
  });
  assert.equal(renderLedger(state, NOW), [
    'Task ledger:',
    '- a: reviewing (implementation 2/2, fix 1/2, last review fail)',
    '- b: pending (implementation 0/2, fix 0/2)',
    'Budget: 3 of 10 dispatches and 30 of 90 minutes used.',
  ].join('\n'));
});

test('before a plan exists the ledger says so and still shows the budget', () => {
  assert.equal(renderLedger(makeOrchestratorRunState({ createdAtUtc: CREATED }), NOW),
    'No plan saved yet.\nBudget: 0 of 80 dispatches and 30 of 720 minutes used.');
});
```

The three attempts in that test need distinct `childRunId` values only if the schema demands it; it does not, so the existing helper is fine.

Append to `tests/orchestrator-run-store.test.ts`:

```ts
test('a reservation past the dispatch budget is refused', (t) => {
  const { store } = openStore(t);
  let state = planned(store, startRequest({ budget: { minutes: 60, dispatches: 1 } }));
  store.reserveAttempt(state.runId, state.revision, 'inspect', work());
  state = store.read(state.runId);
  assert.throws(() => store.reserveAttempt(state.runId, state.revision, 'follow-up', work('implementation', 'follow-up')),
    /The run's dispatch budget is spent \(1 of 1\)\./u);
});
```

In `tests/orchestrator-digest.test.ts`: in `input`, replace `finishAttempts: 0` with `lastFailedFinish: null`; replace the assertion `/0 of 3 finish attempts used/` with `assert.doesNotMatch(digest, /finish/iu);`; append:

```ts
test('the digest repeats why the last finish failed', () => {
  const digest = renderRunDigest(input({ lastFailedFinish: ['Check `npm test` exited 1; expected 0.'] }));
  assert.match(digest, /The last finish failed final verification:\n- Check `npm test` exited 1; expected 0\./u);
});
```

Run: `node ./src/test-runner/run-tests.ts orchestrator-budget`
Expected: FAIL, cannot find module `../src/orchestrator/budget.ts`.

- [ ] **Step 2: Write the failing e2e tests**

In `tests/process/orchestrator-run.e2e.test.ts`:

Change `startRun` so a test can set any request field (import `type OrchestratorStartRequest`), and update its one caller that passed a submission id to pass `{ submissionId }`:

```ts
async function startRun(context: Harness, approval: ApprovalMode, overrides: Partial<OrchestratorStartRequest> = {}): Promise<OrchestratorRunState> {
  const response = await requestJson(`${context.baseUrl}/orchestrator`, { method: 'POST', body: JSON.stringify(
    makeOrchestratorRequest({ repoRoot: context.repo, approval, task: 'Add a greeting module.', ...overrides })) });
  assert.equal(response.statusCode, 202, JSON.stringify(response.body));
  return OrchestratorRunStateSchema.parse(response.body);
}
```

Replace the test `a final verification that fails on every finish fails the run after the last one` with:

```ts
test('a failed finish needs a child to run before the next one, and a spent dispatch budget ends the run on a failing finish', async (t) => {
  const context = await startHarness(t, 'siftkit-orchestrator-dispatch-budget-');
  const { engine } = context;
  const failing: OrchestratorVerificationCheck = { kind: 'command', command: 'exit 1', cwd: '.', expectedExitCode: 0 };
  engine.parent.push([savePlan(planOf([WRITE_TASK], [failing])), dispatch({ taskId: 'greeting' }), review('greeting', 'pass'),
    COMPLETE, COMPLETE,
    dispatch({ taskId: 'greeting', purpose: 'fix' }), review('greeting', 'pass'),
    dispatch({ taskId: 'greeting', purpose: 'fix' }), COMPLETE]);
  engine.children.push(WRITER, [writeFile('export const greeting = "hey";\n'), APPROVING_VERDICT, AGENT_REPORT]);

  const { state, events } = await followRun(context,
    (await startRun(context, 'off', { budget: { minutes: 60, dispatches: 2 } })).runId);

  assert.equal(state.phase, 'failed');
  assert.equal(state.failure?.code, 'budget_exhausted');
  assert.match(state.failure?.message ?? '',
    /^Final verification still fails and the dispatch budget is spent \(2 of 2\): Check `exit 1` exited 1; expected 0\./u);
  assert.equal(events.filter((event) => event.message === 'Running final verification.').length, 2,
    'the second finish was refused before any check ran, because no child had run since the first');
  assert.equal(state.attempts.length, 2, 'the third dispatch started no child');
  assert.ok(engine.parentToolOutputs().some((output) => /The run's dispatch budget is spent \(2 of 2\)\. Finish now/u.test(output)));
});

test('a run that outlives its time budget stops as budget_exhausted, even while it waits on a person', async (t) => {
  const context = await startHarness(t, 'siftkit-orchestrator-deadline-');
  const { engine } = context;
  engine.parent.push([savePlan(), dispatch({ taskId: 'greeting' })]);
  engine.children.push(WRITER);

  // Interactive approval parks the child's check on a person who never answers, so only the deadline can end the run.
  const { state } = await followRun(context,
    (await startRun(context, 'interactive', { budget: { minutes: 0.05, dispatches: 5 } })).runId);

  assert.equal(state.phase, 'failed');
  assert.deepEqual(state.failure, { code: 'budget_exhausted', message: "The run's time budget of 0.05 minutes is spent.", taskId: null });
  assert.equal(state.approval, null, 'the pending approval is cleared');
  assert.equal(state.tasks.some((task) => task.status === 'running' || task.status === 'reviewing'), false, 'no task is left looking live');
});
```

- [ ] **Step 3: Budget arithmetic**

Create `src/orchestrator/budget.ts`:

```ts
import type { OrchestratorRunState } from '@siftkit/contracts';

const MINUTE_MS = 60_000;

type BudgetedRun = Pick<OrchestratorRunState, 'request' | 'attempts' | 'createdAtUtc'>;

/** What a run has spent of its budget: whole minutes since it was created, and one dispatch per child it started. */
export type BudgetUsage = { minutes: number; minutesUsed: number; dispatches: number; dispatchesUsed: number };

/** When the run's time is spent, in epoch milliseconds. */
export function budgetDeadlineMs(run: BudgetedRun): number {
  return Date.parse(run.createdAtUtc) + run.request.budget.minutes * MINUTE_MS;
}

export function budgetUsage(run: BudgetedRun, nowMs: number): BudgetUsage {
  const { minutes, dispatches } = run.request.budget;
  const elapsed = Math.floor((nowMs - Date.parse(run.createdAtUtc)) / MINUTE_MS);
  return { minutes, minutesUsed: Math.min(minutes, Math.max(0, elapsed)), dispatches, dispatchesUsed: run.attempts.length };
}

export function dispatchBudgetSpent(run: BudgetedRun): boolean {
  return run.attempts.length >= run.request.budget.dispatches;
}

export function renderBudget(usage: BudgetUsage): string {
  return `Budget: ${usage.dispatchesUsed} of ${usage.dispatches} dispatches and ${usage.minutesUsed} of ${usage.minutes} minutes used.`;
}
```

- [ ] **Step 4: The ledger shows the budget**

Replace `renderLedger` in `src/orchestrator/ledger.ts` (import `budgetUsage`, `renderBudget` from `./budget.ts`):

```ts
/** One line per task, then what is left of the budget, so the orchestrator never re-derives either. */
export function renderLedger(state: Pick<OrchestratorRunState, 'plan' | 'tasks' | 'attempts' | 'request' | 'createdAtUtc'>,
  nowMs: number): string {
  const budget = renderBudget(budgetUsage(state, nowMs));
  if (state.plan === null) return ['No plan saved yet.', budget].join('\n');
  return ['Task ledger:', ...state.tasks.map((task) => {
    const used = OrchestratorChildPurposeSchema.options.map((purpose) => {
      const count = state.attempts.filter((attempt) => attempt.taskId === task.taskId && attempt.purpose === purpose).length;
      return `${purpose} ${count}/${ORCHESTRATOR_MAX_ATTEMPTS}`;
    });
    const review = task.review === null ? '' : `, last review ${task.review.verdict}`;
    return `- ${task.taskId}: ${task.status} (${used.join(', ')}${review})`;
  }), budget].join('\n');
}
```

In `src/orchestrator/run.ts` add one private method and use it at every `renderLedger(this.state)` call:

```ts
  private ledger(): string {
    return renderLedger(this.state, Date.now());
  }
```

- [ ] **Step 5: The store enforces the dispatch budget**

In `src/orchestrator/run-store.ts`, `reserveAttempt`, as the first check after the "not in the saved plan" check (import `dispatchBudgetSpent` from `./budget.ts`):

```ts
      if (dispatchBudgetSpent(current)) {
        throw new Error(`The run's dispatch budget is spent (${current.attempts.length} of ${current.request.budget.dispatches}).`);
      }
```

- [ ] **Step 6: The run enforces both limits and loses its two caps**

In `packages/contracts/src/orchestrator.ts`, delete `ORCHESTRATOR_MAX_FINISH_ATTEMPTS` and its comment.

In `src/orchestrator/run.ts`:

Replace the `PARENT_MAX_TURNS` constant and its comment, and use the new name in `converse`:

```ts
/** No turn count ends the orchestrator: its budget does. The engine still needs a finite limit, far above any real run. */
const PARENT_TURN_CEILING = 1_000_000;
```

Replace the `FinishOutcome` type's third member:

```ts
  | { status: 'budget_exhausted'; findings: string[] };
```

Replace the field `private finishAttempts = 0;` with:

```ts
  /** Why the last finish failed final verification; the digest repeats it after a compaction. */
  private lastFailedFinish: string[] | null = null;
  /** Set by a failed finish and cleared when a child starts or a rollback restores files: until then a finish would fail again. */
  private finishNeedsChange = false;
```

Replace `abort` and add `stop`:

```ts
  abort(reason: string): void {
    this.stop(new Error(reason));
  }

  /** Ends the run from outside its conversation: a person's abort, or a spent time budget. */
  private stop(cause: Error): void {
    if (this.abortController.signal.aborted) return;
    this.abortController.abort(cause);
    this.child?.session.abort();
    this.wake();
  }
```

In `run()`, arm the deadline before the `try` and clear it when the conversation ends:

```ts
    const { minutes } = this.request.budget;
    // The time budget stops the run wherever it is: mid-conversation, mid-child, or waiting on a person.
    const deadline = setTimeout(() => this.stop(fail('budget_exhausted', `The run's time budget of ${minutes} minutes is spent.`)),
      Math.max(0, budgetDeadlineMs(this.state) - Date.now()));
    let failure: Error | null = null;
    try {
      await this.converse();
      this.commit({ phase: 'cleaning' }, 'Cleaning run scratch files.');
      const cleanupProblem = this.cleanupRunScratch();
      if (cleanupProblem !== null) throw fail('cleanup_failed', cleanupProblem);
      this.commit({ phase: 'completed', failure: null }, 'Run completed.');
    } catch (error) {
      failure = toError(error);
    } finally {
      clearTimeout(deadline);
    }
```

In `converse`, replace the `verification_failed` branch:

```ts
    if (finish.status === 'budget_exhausted') {
      const { dispatches } = this.request.budget;
      throw fail('budget_exhausted',
        `Final verification still fails and the dispatch budget is spent (${dispatches} of ${dispatches}): ${finish.findings.join(' ')}`);
    }
```

Replace the body of `settleFailure` from the `if (this.signal.aborted)` block to the end, so a stop with a stored diagnosis fails the run instead of aborting it:

```ts
    const cause = this.signal.aborted ? toError(this.signal.reason) : error;
    if (this.signal.aborted && !(cause instanceof OrchestratorRunFailure)) {
      const message = withCleanup(cause.message);
      this.commit({ phase: 'aborted', approval: null, failure: { code: 'aborted', message, taskId: null } }, message);
      return;
    }
    const stored = cause instanceof OrchestratorRunFailure
      ? cause.failure
      : fail(cause instanceof OrchestratorInfrastructureError ? 'infrastructure_failed' : 'internal_error', cause.message).failure;
    const failure = { ...stored, message: withCleanup(stored.message) };
    this.commit({ phase: 'failed', approval: null, failure }, failure.message);
```

In `dispatch`, before the `dispatchProblem` call:

```ts
    if (dispatchBudgetSpent(this.state)) {
      return this.refuse([`The run's dispatch budget is spent (${this.state.attempts.length} of ${this.request.budget.dispatches}). `
        + 'Finish now: completed if final verification can pass, otherwise blocked with what was tried.']);
    }
```

In `startChild`, beside `this.passedRunChecks = [];`:

```ts
    this.finishNeedsChange = false;
```

In `changeApproach`, beside `this.passedRunChecks = [];` in the rollback branch, the same line.

In `review` (the finish), replace everything from `this.commit({ phase: 'verifying' }, …)` to the end of the method:

```ts
    if (this.finishNeedsChange) {
      return { kind: 'reject', message: 'Final verification failed and no child has run since, so it would fail again: '
        + 'dispatch a fix, replace what cannot work, or change approach before finishing.' };
    }
    this.commit({ phase: 'verifying' }, 'Running final verification.');
    const checks = await this.runOwnedChecks(plan.finalVerification);
    this.commit({ phase: 'executing' }, 'Final verification finished.');
    const failing = checks.filter((check) => orchestratorCheckFailure(check) !== null);
    if (failing.length === 0) {
      this.finishOutcome = { status: 'completed' };
      return { kind: 'accept', output: answer };
    }
    const findings = failing.map((check) => orchestratorCheckFailure(check) ?? '');
    this.lastFailedFinish = findings;
    this.finishNeedsChange = true;
    if (dispatchBudgetSpent(this.state)) {
      this.finishOutcome = { status: 'budget_exhausted', findings };
      return { kind: 'accept', output: answer };
    }
    return { kind: 'reject', message: [
      'Final verification failed:',
      ...failing.map((check) => `${orchestratorCheckFailure(check) ?? ''}\n${renderCheckOutput(check, COMMAND_TAIL_CHARS)}`),
      'Dispatch fixes for the tasks responsible, or replace what cannot work, then finish again.',
      renderBudget(budgetUsage(this.state, Date.now())),
    ].join('\n') };
```

In `contextDigest`, replace `finishAttempts: this.finishAttempts` with `lastFailedFinish: this.lastFailedFinish`.

Imports: add `budgetDeadlineMs, budgetUsage, dispatchBudgetSpent, renderBudget` from `./budget.ts`; remove `ORCHESTRATOR_MAX_FINISH_ATTEMPTS`.

- [ ] **Step 7: The digest and the prompt stop naming a finish limit**

`src/orchestrator/digest.ts`: drop the `ORCHESTRATOR_MAX_FINISH_ATTEMPTS` import; in `RunDigestInput` replace `finishAttempts: number;` with:

```ts
  /** Why the last finish failed final verification; null when none has failed. */
  lastFailedFinish: readonly string[] | null;
```

and replace the last array element of `renderRunDigest` (the "finish attempts used" line) with:

```ts
    ...(input.lastFailedFinish === null ? []
      : [`The last finish failed final verification:\n${input.lastFailedFinish.map((finding) => `- ${finding}`).join('\n')}`]),
```

`src/orchestrator/prompts.ts`: drop the `ORCHESTRATOR_MAX_FINISH_ATTEMPTS` import and replace rule 6's second line (Task 9 rewrites rules 5 to 7 in full):

```ts
    '   final verification and returns failures for you to fix; after a failed finish a child must run before you finish again. If the work cannot be',
```

- [ ] **Step 8: Verify**

Run: `node ./src/test-runner/run-tests.ts orchestrator-budget`, `orchestrator-ledger`, `orchestrator-run-store`, `orchestrator-digest`, `orchestrator-prompts`
Expected: PASS.

Run: `node ./src/test-runner/run-tests.ts --process orchestrator-run.e2e`
Expected: PASS, including the two budget tests. The deadline test takes about three seconds.

Run: `npm test` then `npm run typecheck`
Expected: exit 0 for both.

**Acceptance:** a search for `ORCHESTRATOR_MAX_FINISH_ATTEMPTS`, `PARENT_MAX_TURNS`, and `finishAttempts` in `src`, `packages`, and `dashboard/src` finds nothing; a run with a spent dispatch budget ends `budget_exhausted` on its next failing finish; a run past its minutes ends `budget_exhausted` with no approval pending and no task left `running` or `reviewing`.

---

### Task 9: The orchestrator is told about approaches, retired tasks, and persistence

The model can only keep going if every tool result and every compaction tells it where it stands and what was already ruled out, and if its instructions stop telling it to give up.

**Files:**
- Modify: `src/orchestrator/ledger.ts`, `src/orchestrator/plan-state.ts`, `src/orchestrator/digest.ts`, `src/orchestrator/prompts.ts`, `src/orchestrator/run.ts`
- Test: `tests/orchestrator-ledger.test.ts`, `tests/orchestrator-digest.test.ts`, `tests/orchestrator-prompts.test.ts`

- [ ] **Step 1: Write the failing tests**

`tests/orchestrator-ledger.test.ts`: in the first test give the state `approaches: [{ number: 2, title: 'Cache the index', startedAtUtc: CREATED, outcome: null }]` and expect `'Approach 2: Cache the index.'` as the first line, before `'Task ledger:'`. Append:

```ts
test('an approach with no tasks yet says how to add them', () => {
  const state = makeOrchestratorRunState({ createdAtUtc: CREATED, plan: makeOrchestratorPlan([]),
    approaches: [{ number: 2, title: 'Cache the index', startedAtUtc: CREATED, outcome: null }] });
  assert.equal(renderLedger(state, NOW), [
    'Approach 2: Cache the index.', 'Task ledger:', '- no tasks yet: add them with update_tasks',
    'Budget: 0 of 80 dispatches and 30 of 720 minutes used.',
  ].join('\n'));
});
```

`tests/orchestrator-digest.test.ts`: in `input`, add `approaches: [{ number: 1, title: 'Initial plan', startedAtUtc: AT, outcome: null }], retiredTasks: [],` (with `const AT = '2026-11-21T10:00:00.000Z';`). Append:

```ts
test('the digest lists every approach with its lesson and every retired task with its reason, and neither while there is nothing to learn from', () => {
  assert.doesNotMatch(renderRunDigest(input()), /Approaches so far|Retired tasks/u);
  const digest = renderRunDigest(input({
    approaches: [
      { number: 1, title: 'Initial plan', startedAtUtc: AT,
        outcome: { kind: 'rolled_back', lesson: 'Response caching cannot see headers.', endedAtUtc: AT } },
      { number: 2, title: 'Cache the index', startedAtUtc: AT, outcome: null }],
    retiredTasks: [{ taskId: 'cache', title: 'Cache responses', approach: 1, status: 'failed', reason: 'Out of attempts.', retiredAtUtc: AT }],
  }));
  assert.match(digest, /Approaches so far \(never repeat one a lesson ruled out\):\n- 1\. Initial plan: rolled back\. Lesson: Response caching cannot see headers\.\n- 2\. Cache the index: active/u);
  assert.match(digest, /Retired tasks \(their ids cannot be reused\):\n- cache: Cache responses \(approach 1, failed\)\. Out of attempts\./u);
});
```

`tests/orchestrator-prompts.test.ts`: in `brief`, add `budget: { minutes: 90, dispatches: 12 },`; add `'change_approach'` to the tool list the first test loops over; append:

```ts
test('the orchestrator prompt states the budget and tells the model to keep going by replacing tasks and changing approach', () => {
  const prompt = buildOrchestratorPrompt(brief());
  for (const rule of [
    'Budget: this run may start 12 children and run 90 minutes',
    'Keep going until the goal is met',
    'retire: [{taskId, reason}]',
    'call change_approach',
    'Never repeat a task or an approach that a lesson already ruled out',
    'a child must run before you finish again',
    'only when no approach can meet the goal',
  ]) {
    assert.ok(prompt.includes(rule), rule);
  }
  assert.doesNotMatch(prompt, /If the work cannot be\s+completed, finish/u, 'a failed approach is no longer a reason to stop');
});
```

Run: `node ./src/test-runner/run-tests.ts orchestrator-prompts`
Expected: FAIL (`budget` is not part of the brief).

- [ ] **Step 2: The ledger names the active approach**

Replace `renderLedger` in `src/orchestrator/ledger.ts` (import `activeApproach` from `./plan-state.ts`):

```ts
/** The active approach, one line per task, then what is left of the budget, so the orchestrator never re-derives them. */
export function renderLedger(
  state: Pick<OrchestratorRunState, 'plan' | 'tasks' | 'attempts' | 'approaches' | 'request' | 'createdAtUtc'>, nowMs: number): string {
  const budget = renderBudget(budgetUsage(state, nowMs));
  const approach = activeApproach(state);
  if (state.plan === null || approach === null) return ['No plan saved yet.', budget].join('\n');
  const lines = state.tasks.map((task) => {
    const used = OrchestratorChildPurposeSchema.options.map((purpose) => {
      const count = state.attempts.filter((attempt) => attempt.taskId === task.taskId && attempt.purpose === purpose).length;
      return `${purpose} ${count}/${ORCHESTRATOR_MAX_ATTEMPTS}`;
    });
    const review = task.review === null ? '' : `, last review ${task.review.verdict}`;
    return `- ${task.taskId}: ${task.status} (${used.join(', ')}${review})`;
  });
  return [`Approach ${approach.number}: ${approach.title}.`, 'Task ledger:',
    ...(lines.length === 0 ? ['- no tasks yet: add them with update_tasks'] : lines), budget].join('\n');
}
```

- [ ] **Step 3: The digest keeps the history**

Append to `src/orchestrator/plan-state.ts`, so the digest and the dashboard word an outcome the same way:

```ts
/** How an ended approach reads, in the digest and in the dashboard. */
export const APPROACH_OUTCOME_LABELS = { kept: 'kept', rolled_back: 'rolled back' } as const satisfies
  Record<NonNullable<OrchestratorApproach['outcome']>['kind'], string>;
```

Replace `src/orchestrator/digest.ts`:

```ts
import type { OrchestratorApproach, OrchestratorPlan, OrchestratorRetiredTask, OrchestratorTaskState } from '@siftkit/contracts';

import { APPROACH_OUTCOME_LABELS } from './plan-state.ts';

export type RunDigestInput = {
  plan: OrchestratorPlan | null;
  planPath: string | null;
  tasks: readonly OrchestratorTaskState[];
  ledger: string;
  approaches: readonly OrchestratorApproach[];
  retiredTasks: readonly OrchestratorRetiredTask[];
  /** Rendered reports the orchestrator has not reviewed yet. */
  pendingReports: readonly string[];
  /** Announced child approvals still waiting for `decide`. */
  pendingApprovals: readonly string[];
  /** Why the last finish failed final verification; null when none has failed. */
  lastFailedFinish: readonly string[] | null;
};

function describeApproach(approach: OrchestratorApproach): string {
  const { outcome } = approach;
  return outcome === null ? `- ${approach.number}. ${approach.title}: active`
    : `- ${approach.number}. ${approach.title}: ${APPROACH_OUTCOME_LABELS[outcome.kind]}. Lesson: ${outcome.lesson}`;
}

/** What replaces the orchestrator's conversation when it outgrows the context: the run as the host records it. */
export function renderRunDigest(input: RunDigestInput): string {
  const failedReviews = input.tasks.flatMap((task) => (task.review?.verdict === 'fail' && task.status !== 'completed'
    ? [[`${task.taskId} (${task.review.purpose} attempt ${task.review.attempt}) failed review:`,
      ...task.review.findings.map((finding) => `- ${finding.path}:${finding.line} ${finding.issue}`)].join('\n')]
    : []));
  const section = (title: string, entries: readonly string[]): string[] =>
    (entries.length === 0 ? [] : [`${title}:\n\n${entries.join('\n\n')}`]);
  const list = (title: string, lines: readonly string[]): string[] => (lines.length === 0 ? [] : [`${title}:\n${lines.join('\n')}`]);
  return [
    'Your earlier conversation was dropped to fit the context. This is the run as the host records it; '
      + 'nothing below is lost. Earlier file reads are gone too: re-read any file you need.',
    ...(input.plan === null || input.planPath === null ? [] : [[
      `Plan: ${input.planPath}`, `Goal: ${input.plan.goal}`, 'Tasks:',
      ...input.plan.tasks.map((task) => `- ${task.id}: ${task.title} (${task.workerPresetId}; writes ${task.writePaths.join(', ')}`
        + `${task.dependsOn.length === 0 ? '' : `; after ${task.dependsOn.join(', ')}`})`),
    ].join('\n')]),
    ...(input.approaches.some((approach) => approach.outcome !== null)
      ? list('Approaches so far (never repeat one a lesson ruled out)', input.approaches.map(describeApproach)) : []),
    ...list('Retired tasks (their ids cannot be reused)', input.retiredTasks.map((task) =>
      `- ${task.taskId}: ${task.title} (approach ${task.approach}, ${task.status}). ${task.reason}`)),
    input.ledger,
    ...failedReviews,
    ...section('Reports waiting for record_review', input.pendingReports),
    ...section('Approvals waiting for decide', input.pendingApprovals),
    ...list('The last finish failed final verification', (input.lastFailedFinish ?? []).map((finding) => `- ${finding}`)),
  ].join('\n\n');
}
```

In `src/orchestrator/run.ts`, `contextDigest`: add `approaches: this.state.approaches, retiredTasks: this.state.retiredTasks,`.

- [ ] **Step 4: The prompt states the budget and the way to keep going**

In `src/orchestrator/prompts.ts`:

Add `type OrchestratorBudget` to the contracts import. In `OrchestratorBrief`, add:

```ts
  budget: OrchestratorBudget;
```

In `buildOrchestratorPrompt`, after the `CHECK_SHELL_RULE,` line:

```ts
    `Budget: this run may start ${brief.budget.dispatches} children and run ${brief.budget.minutes} minutes, waits included. Every ledger`
      + ' shows what is left. The run is stopped when the minutes are spent.',
```

Replace rules 5 and 6 (from the line starting `` `5. After a failed review `` through `'   completed, finish with only {"status":"blocked","reason":"why"}.',`) with:

```ts
    `5. After a failed review, dispatch a fix (repairs the current changes) or a fresh implementation; each task allows ${ORCHESTRATOR_MAX_ATTEMPTS}`,
    '   of each. A completed task can also take a fix later. To split, reorder, add, or widen work, call update_tasks with',
    '   only the fields that change. writePaths are guidance, not a limit: judge changes to other files on their merits,',
    '   and move work the plan gives a later task with update_tasks.',
    '6. Keep going until the goal is met. A task out of attempts, or a final verification that still fails after fixes,',
    '   means the plan was wrong, not that the work is impossible:',
    '   - Retire the task with update_tasks (retire: [{taskId, reason}]) and add its replacement under a new id, with what',
    '     the failure taught you written into its steps.',
    '   - When the design itself is the problem, call change_approach: give the lesson (what was tried and why it did not',
    '     work), choose rollback true to put the files back as they were when this approach began or false to keep its',
    '     work, and name the next approach. Then add its tasks with update_tasks.',
    '   Never repeat a task or an approach that a lesson already ruled out. A task completed in an earlier approach is',
    '   closed: further work on it is a new task. Start a new approach whenever the work so far is worth keeping and what',
    '   comes next might have to be thrown away.',
    '7. When every task is complete, finish with only {"status":"completed","summary":"what was done"}. Code then runs the',
    '   final verification and returns failures for you to act on; after a failed finish a child must run before you finish again.',
    '   Finish with only {"status":"blocked","reason":"why"} only when no approach can meet the goal (a missing credential,',
    '   a requirement that contradicts itself) or the budget is nearly spent with the goal unmet; say what was tried.',
```

In `src/orchestrator/run.ts`, `converse`: pass `budget: this.request.budget` to `buildOrchestratorPrompt`.

- [ ] **Step 5: Verify**

Run: `node ./src/test-runner/run-tests.ts orchestrator-ledger`, `orchestrator-digest`, `orchestrator-prompts`
Expected: PASS.

Run: `node ./src/test-runner/run-tests.ts --process orchestrator-run.e2e`
Expected: PASS. If a test matched the old ledger's first line, it now starts with `Approach 1: Initial plan.`; update the assertion to the new text.

Run: `npm test` then `npm run typecheck`
Expected: exit 0 for both.

**Acceptance:** every tool result that shows the ledger starts with the active approach and ends with the budget; the digest lists ended approaches with lessons and retired tasks with reasons; the prompt names `change_approach`, `retire`, and the budget, and no longer tells the model to finish `blocked` when work "cannot be completed".

---

### Task 10: Budget flags on the CLI

`siftkit orchestrator` takes `--minutes` and `--dispatches`, and its printed result says what the run spent, which approaches it went through, and which tasks it retired.

**Files:**
- Modify: `src/orchestrator/budget.ts`
- Modify: `src/cli/orchestrator-args.ts`, `src/cli/run-orchestrator.ts`, `src/cli/help.ts`
- Test: `tests/orchestrator-budget.test.ts`, `tests/orchestrator-args.test.ts`, `tests/orchestrator-cli-result.test.ts` (new)

- [ ] **Step 1: Write the failing tests**

Append to `tests/orchestrator-budget.test.ts` (add `runClockMs` to the `budget.ts` import):

```ts
test("a finished run's clock stopped at its last update; a live run's clock is now", () => {
  const finished = makeOrchestratorRunState({ createdAtUtc: CREATED, phase: 'completed', updatedAtUtc: '2026-11-21T10:14:02.000Z' });
  const muchLater = CREATED_MS + 999 * 60_000;
  assert.equal(runClockMs(run(0), CREATED_MS + 5_000), CREATED_MS + 5_000);
  assert.equal(runClockMs(finished, muchLater), CREATED_MS + 14 * 60_000 + 2_000);
  assert.equal(budgetUsage(finished, runClockMs(finished, muchLater)).minutesUsed, 14);
});
```

In `tests/orchestrator-args.test.ts`, add `budget: { minutes: 720, dispatches: 80 },` to both expected objects of the first test, and append:

```ts
test('--minutes and --dispatches replace each budget limit, and a bad value fails with a precise message', () => {
  const budgetOf = (tokens: string[]) => {
    const invocation = parseOrchestratorInvocation(tokens, 'C:/repo');
    return invocation.kind === 'start' ? invocation.budget : null;
  };
  assert.deepEqual(budgetOf(['--minutes', '90', '--dispatches', '12', 'Go']), { minutes: 90, dispatches: 12 });
  assert.deepEqual(budgetOf(['Go', '--minutes', '0.5']), { minutes: 0.5, dispatches: 80 });
  assert.deepEqual(budgetOf(['--dispatches', '3', 'Go']), { minutes: 720, dispatches: 3 });
  for (const value of ['0', 'soon', '20161']) {
    assert.throws(() => budgetOf(['--minutes', value, 'Go']),
      new RegExp(`Invalid --minutes value: ${value}\\. Expected a number above 0 and at most 20160\\.`, 'u'));
  }
  for (const value of ['0', '1.5', 'many']) {
    assert.throws(() => budgetOf(['--dispatches', value, 'Go']),
      new RegExp(`Invalid --dispatches value: ${value}\\. Expected a whole number above 0\\.`, 'u'));
  }
  assert.throws(() => budgetOf(['Go', '--minutes']), /Missing value for --minutes/u);
});
```

Create `tests/orchestrator-cli-result.test.ts`:

```ts
import assert from 'node:assert/strict';
import test from 'node:test';

import { renderOrchestratorResult } from '../src/cli/run-orchestrator.ts';
import { parseJsonText } from '../src/lib/json.ts';
import { z } from '../src/lib/zod.ts';
import {
  makeOrchestratorPlan, makeOrchestratorRequest, makeOrchestratorRunState, makeOrchestratorTask, makeTaskState,
} from './helpers/orchestrator-plan.ts';

const AT = '2026-11-21T10:00:00.000Z';

/** The parts of the printed result this test reads; other keys are dropped by the parse. */
const ResultSchema = z.object({
  budget: z.object({ minutes: z.number(), minutesUsed: z.number(), dispatches: z.number(), dispatchesUsed: z.number() }),
  approaches: z.array(z.object({ number: z.number(), title: z.string(), outcome: z.string(), lesson: z.string().nullable() })),
  tasks: z.array(z.object({ taskId: z.string(), approach: z.number() })),
  retiredTasks: z.array(z.object({ taskId: z.string(), approach: z.number(), status: z.string(), reason: z.string() })),
});

test('the printed result states the budget used, every approach with its lesson, and the retired tasks', () => {
  const task = makeOrchestratorTask();
  const state = makeOrchestratorRunState({
    request: makeOrchestratorRequest({ budget: { minutes: 90, dispatches: 12 } }),
    phase: 'completed', createdAtUtc: AT, updatedAtUtc: '2026-11-21T10:14:02.000Z',
    planPath: 'plan.md', planHash: 'h', plan: makeOrchestratorPlan([task]), tasks: [makeTaskState(task.id, 'completed', { approach: 2 })],
    approaches: [
      { number: 1, title: 'Initial plan', startedAtUtc: AT,
        outcome: { kind: 'rolled_back', lesson: 'Response caching cannot see headers.', endedAtUtc: AT } },
      { number: 2, title: 'Cache the index', startedAtUtc: AT, outcome: null }],
    retiredTasks: [{ taskId: 'cache', title: 'Cache responses', approach: 1, status: 'failed', reason: 'Out of attempts.', retiredAtUtc: AT }],
  });

  const result = parseJsonText(renderOrchestratorResult(state, Date.parse(AT) + 999 * 60_000), ResultSchema);

  assert.deepEqual(result, {
    budget: { minutes: 90, minutesUsed: 14, dispatches: 12, dispatchesUsed: 0 },
    approaches: [
      { number: 1, title: 'Initial plan', outcome: 'rolled_back', lesson: 'Response caching cannot see headers.' },
      { number: 2, title: 'Cache the index', outcome: 'active', lesson: null }],
    tasks: [{ taskId: 'inspect', approach: 2 }],
    retiredTasks: [{ taskId: 'cache', approach: 1, status: 'failed', reason: 'Out of attempts.' }],
  });
});
```

Run: `node ./src/test-runner/run-tests.ts orchestrator-args`
Expected: FAIL, the start invocation has no `budget`.

- [ ] **Step 2: One clock for a finished run**

Append to `src/orchestrator/budget.ts` (import `isOrchestratorTerminalPhase` from `@siftkit/contracts` as a value, beside the type import):

```ts
/** A finished run's clock stopped at its last update; a live run's clock is `nowMs`. */
export function runClockMs(run: Pick<OrchestratorRunState, 'phase' | 'updatedAtUtc'>, nowMs: number): number {
  return isOrchestratorTerminalPhase(run.phase) ? Date.parse(run.updatedAtUtc) : nowMs;
}
```

- [ ] **Step 3: Parse the flags**

In `src/cli/orchestrator-args.ts`:

Replace the contracts import:

```ts
import {
  ApprovalModeSchema, DEFAULT_APPROVAL_MODE, DEFAULT_ORCHESTRATOR_BUDGET, ORCHESTRATOR_MAX_BUDGET_MINUTES, OrchestratorBudgetSchema,
  type ApprovalMode, type OrchestratorBudget,
} from '@siftkit/contracts';
```

In the `start` member of `OrchestratorInvocationSchema`, after `approval: ApprovalModeSchema,`:

```ts
    budget: OrchestratorBudgetSchema,
```

After `readValue`:

```ts
/** What each budget flag accepts, as its error message says it. */
const BUDGET_FLAG_EXPECTATIONS = {
  '--minutes': `a number above 0 and at most ${ORCHESTRATOR_MAX_BUDGET_MINUTES}`,
  '--dispatches': 'a whole number above 0',
} as const;

function readBudgetLimit(tokens: readonly string[], index: number, option: keyof typeof BUDGET_FLAG_EXPECTATIONS): number {
  const value = readValue(tokens, index, option);
  const limit = option === '--minutes' ? OrchestratorBudgetSchema.shape.minutes : OrchestratorBudgetSchema.shape.dispatches;
  const parsed = limit.safeParse(Number(value));
  if (!parsed.success) throw new Error(`Invalid ${option} value: ${value}. Expected ${BUDGET_FLAG_EXPECTATIONS[option]}.`);
  return parsed.data;
}
```

In `parseOrchestratorInvocation`, beside `let approval`:

```ts
  let budget: OrchestratorBudget = DEFAULT_ORCHESTRATOR_BUDGET;
```

As the first statement inside the `for` loop body, after `const token = …`:

```ts
    if (token === '--minutes' || token === '--dispatches') {
      const limit = readBudgetLimit(tokens, index, token);
      index += 1;
      budget = token === '--minutes' ? { ...budget, minutes: limit } : { ...budget, dispatches: limit };
      continue;
    }
```

And the final `parseOrThrow` call passes it:

```ts
  return parseOrThrow({ kind: 'start', task: task.length === 0 ? null : task, planPath, presetId, approval, budget, repoRoot });
```

- [ ] **Step 4: Send the budget and print the result**

In `src/cli/run-orchestrator.ts`:

Remove the `DEFAULT_ORCHESTRATOR_BUDGET` import that Task 3 added. Import `budgetUsage, runClockMs` from `'../orchestrator/budget.ts'`.

Replace `renderResult` with an exported function that takes the clock, and pass `Date.now()` at each of its five call sites:

```ts
/** The typed summary printed on stdout; the exit code follows the parent phase, never a child's exit. */
export function renderOrchestratorResult(state: OrchestratorRunState, nowMs: number): string {
  return JSON.stringify({
    runId: state.runId, status: state.phase, planPath: state.planPath, failure: state.failure,
    budget: budgetUsage(state, runClockMs(state, nowMs)),
    approval: state.approval === null ? null : {
      ...state.approval,
      decide: {
        approve: `siftkit orchestrator decide ${state.runId} ${state.approval.approvalId} approve`,
        deny: `siftkit orchestrator decide ${state.runId} ${state.approval.approvalId} deny --reason "<why>"`,
        abort: `siftkit orchestrator decide ${state.runId} ${state.approval.approvalId} abort`,
      },
    },
    approaches: state.approaches.map((approach) => ({ number: approach.number, title: approach.title,
      outcome: approach.outcome?.kind ?? 'active', lesson: approach.outcome?.lesson ?? null })),
    tasks: state.tasks.map((task) => ({ taskId: task.taskId, approach: task.approach, status: task.status,
      review: task.review?.verdict ?? null, report: taskReport(state, task.taskId) })),
    retiredTasks: state.retiredTasks.map((task) => ({ taskId: task.taskId, approach: task.approach, status: task.status,
      reason: task.reason })),
    attempts: state.attempts.map((attempt) => ({ taskId: attempt.taskId, purpose: attempt.purpose, attempt: attempt.attempt,
      childRunId: attempt.childRunId, outcome: attempt.result?.outcome ?? null })),
  }, null, 2);
}
```

In the `start` case, replace `budget: DEFAULT_ORCHESTRATOR_BUDGET` with `budget: invocation.budget`.

In `src/cli/help.ts`, replace the orchestrator start line:

```ts
    '  siftkit orchestrator [--plan <path>] [--preset <id>] [--approval auto|interactive|off] [--minutes <n>] [--dispatches <n>] [--repo <root>] "<task>"',
```

- [ ] **Step 5: Verify**

Run: `node ./src/test-runner/run-tests.ts orchestrator-args`, `orchestrator-budget`, `orchestrator-cli-result`
Expected: PASS.

Run: `npm test` then `npm run typecheck`
Expected: exit 0 for both.

**Acceptance:** `siftkit orchestrator --minutes 90 --dispatches 12 "task"` starts a run whose stored request has that budget; a start without the flags uses 720 and 80; `DEFAULT_ORCHESTRATOR_BUDGET` is referenced in `src/cli/` only by `orchestrator-args.ts`.

---

### Task 11: The dashboard sets the budget and shows budget, approach, and history

**Files:**
- Modify: `dashboard/src/hooks/useOrchestratorRun.ts`, `dashboard/src/tabs/ChatTab.tsx`
- Modify: `dashboard/src/orchestrator-view.ts`, `dashboard/src/components/OrchestratorRunPanel.tsx`, `dashboard/src/styles/orchestrator.css`
- Test: `dashboard/tests/orchestrator-view.test.ts`, `dashboard/tests/orchestrator-run-panel.test.tsx`, `dashboard/tests/use-orchestrator-run.test.tsx`, `dashboard/tests/chat-tab.test.tsx`

The dashboard reuses `budgetUsage` and `runClockMs` from `src/orchestrator/budget.ts`, and `activeApproach` and `APPROACH_OUTCOME_LABELS` from `src/orchestrator/plan-state.ts`. Both files import only types and one pure helper from the contracts, so they are safe in the browser bundle.

All dashboard test commands in this task run from **PowerShell**.

- [ ] **Step 1: Write the failing tests**

`dashboard/tests/orchestrator-view.test.ts`: add `approachLabel, budgetSummary, endedApproaches` to the `orchestrator-view.ts` import and `type OrchestratorApproach` to the contracts import; append:

```ts
test('budget summary, active approach, and ended approaches read from the run state', () => {
  const approaches: OrchestratorApproach[] = [
    { number: 1, title: 'Initial plan', startedAtUtc: AT, outcome: { kind: 'rolled_back', lesson: 'Too slow.', endedAtUtc: AT } },
    { number: 2, title: 'Cache the index', startedAtUtc: AT, outcome: { kind: 'kept', lesson: 'Works; needs eviction.', endedAtUtc: AT } },
    { number: 3, title: 'Add eviction', startedAtUtc: AT, outcome: null },
  ];
  assert.equal(budgetSummary(runState({}), Date.parse(AT) + 31 * 60_000), '0/80 dispatches · 31/720 min');
  assert.equal(budgetSummary(runState({}, { phase: 'completed' }), Date.parse(AT) + 999 * 60_000), '0/80 dispatches · 14/720 min',
    'a finished run stops counting at its last update');
  assert.equal(approachLabel(runState({})), null);
  assert.equal(approachLabel(runState({}, { approaches })), '3 · Add eviction');
  assert.deepEqual(endedApproaches(runState({})), []);
  assert.deepEqual(endedApproaches(runState({}, { approaches })), [
    { number: 1, title: 'Initial plan', outcome: 'rolled back', lesson: 'Too slow.' },
    { number: 2, title: 'Cache the index', outcome: 'kept', lesson: 'Works; needs eviction.' },
  ]);
});
```

`dashboard/tests/orchestrator-run-panel.test.tsx`: in the test `a running task shows its phase, plan path, and attempts, and Stop aborts`, before the `fireEvent.click`, add:

```ts
  assert.equal(screen.queryByRole('list', { name: 'Earlier approaches' }), null);
  assert.equal(screen.queryByRole('list', { name: 'Retired tasks' }), null);
```

and append (import `orchestratorRequest` and `orchestratorTaskState` from `./orchestrator-fixture.ts` if Task 1 did not already):

```ts
test('the panel shows the budget used, the active approach, what earlier approaches taught, and the retired tasks', () => {
  renderPanel(runState({
    phase: 'completed', updatedAtUtc: '2026-09-23T12:14:02.000Z',
    request: orchestratorRequest({ budget: { minutes: 90, dispatches: 12 } }),
    attempts: [attempt('implementation', 1, true)],
    tasks: [orchestratorTaskState(TASK.id, 'completed', { approach: 2 })],
    approaches: [
      { number: 1, title: 'Initial plan', startedAtUtc: AT,
        outcome: { kind: 'rolled_back', lesson: 'Response caching cannot see headers.', endedAtUtc: AT } },
      { number: 2, title: 'Cache the index', startedAtUtc: AT, outcome: null }],
    retiredTasks: [{ taskId: 'cache', title: 'Cache responses', approach: 1, status: 'failed', reason: 'Out of attempts.', retiredAtUtc: AT }],
  }));
  screen.getByText('1/12 dispatches · 14/90 min');
  screen.getByText('2 · Cache the index');
  assert.match(screen.getByRole('list', { name: 'Earlier approaches' }).textContent ?? '',
    /1\. Initial plan\s+rolled back: Response caching cannot see headers\./u);
  assert.match(screen.getByRole('list', { name: 'Retired tasks' }).textContent ?? '',
    /cache\s+Cache responses · approach 1 · failed: Out of attempts\./u);
});
```

`dashboard/tests/use-orchestrator-run.test.tsx`, test `a session with no run of its own looks nothing up, and a start names the session it came from`: add `budget: { minutes: 90, dispatches: 12 },` to the object passed to `result.current.start`, and after the `body.planPath` assertion:

```ts
    assert.deepEqual(body.budget, { minutes: 90, dispatches: 12 }, 'the budget is the one the caller chose, not a default');
```

`dashboard/tests/chat-tab.test.tsx`:

In `orchestrator mode starts a run for the saved repository and shows its live panel`, before the click on `Run orchestrator`:

```ts
    fireEvent.change(screen.getByLabelText('Budget minutes'), { target: { value: '90' } });
    fireEvent.change(screen.getByLabelText('Budget dispatches'), { target: { value: '12' } });
```

and change the expected body's budget to `budget: { minutes: 90, dispatches: 12 }`.

Append after `orchestrator mode cannot start without a saved repository folder`:

```ts
test('orchestrator mode shows the default budget and cannot start with an invalid one', () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => { throw new Error(`Unexpected fetch ${String(input)}`); };
  try {
    renderComponent(<ChatTab {...orchestratorProps({ selectedSession: { ...ORCHESTRATOR_SESSION, orchestratorRunId: null } })} />);
    const blocked = () => screen.getByRole('button', { name: 'Run orchestrator' }).hasAttribute('disabled');
    const field = (label: string) => screen.getByLabelText(label);
    const shown = (label: string) => { const input = field(label); return input instanceof window.HTMLInputElement ? input.value : null; };
    assert.deepEqual([shown('Budget minutes'), shown('Budget dispatches')], ['720', '80']);
    assert.equal(blocked(), false);
    for (const [label, bad, good] of [['Budget minutes', '0', '45'], ['Budget minutes', '', '0.5'],
      ['Budget dispatches', '1.5', '3'], ['Budget dispatches', '', '80']] as const) {
      fireEvent.change(field(label), { target: { value: bad } });
      assert.equal(blocked(), true, `${label} "${bad}" blocks the start`);
      fireEvent.change(field(label), { target: { value: good } });
      assert.equal(blocked(), false, `${label} "${good}" allows it`);
    }
  } finally { globalThis.fetch = originalFetch; }
});
```

Run (PowerShell): `npx vitest run --config .\dashboard\vitest.config.ts orchestrator-view`
Expected: FAIL, `budgetSummary` is not exported.

- [ ] **Step 2: The view functions**

In `dashboard/src/orchestrator-view.ts`:

Add imports:

```ts
import { budgetUsage, runClockMs } from '../../src/orchestrator/budget.ts';
import { APPROACH_OUTCOME_LABELS, activeApproach } from '../../src/orchestrator/plan-state.ts';
```

Replace `runElapsedMs`, so the dashboard and the CLI share one rule for a finished run's clock:

```ts
/** A finished run's duration is fixed at its last update; a live one runs to `now`. */
export function runElapsedMs(state: OrchestratorRunState, now: number): number {
  return runClockMs(state, now) - Date.parse(state.createdAtUtc);
}
```

Append:

```ts
/** e.g. "3/80 dispatches · 31/720 min"; a finished run stops counting at its last update. */
export function budgetSummary(state: OrchestratorRunState, now: number): string {
  const usage = budgetUsage(state, runClockMs(state, now));
  return `${usage.dispatchesUsed}/${usage.dispatches} dispatches · ${usage.minutesUsed}/${usage.minutes} min`;
}

/** e.g. "2 · Cache the index"; null before the first plan. */
export function approachLabel(state: OrchestratorRunState): string | null {
  const approach = activeApproach(state);
  return approach === null ? null : `${approach.number} · ${approach.title}`;
}

export type EndedApproach = { number: number; title: string; outcome: string; lesson: string };

/** Every approach that has ended, with how it ended and what it taught. */
export function endedApproaches(state: OrchestratorRunState): EndedApproach[] {
  return state.approaches.flatMap((approach) => (approach.outcome === null ? [] : [{
    number: approach.number, title: approach.title, outcome: APPROACH_OUTCOME_LABELS[approach.outcome.kind], lesson: approach.outcome.lesson,
  }]));
}
```

- [ ] **Step 3: The run panel**

In `dashboard/src/components/OrchestratorRunPanel.tsx`:

Import `approachLabel, budgetSummary, endedApproaches` from `'../orchestrator-view.ts'`.

After `const completed = …`:

```tsx
  const approach = approachLabel(state);
  const ended = endedApproaches(state);
```

Replace the `orch-meta` block:

```tsx
      <div className="orch-meta">
        {state.planPath ? <span>plan <code>{state.planPath}</code></span> : null}
        {approach ? <span>approach <b>{approach}</b></span> : null}
        <span>approval <b>{state.request.approval}</b></span>
        <span>elapsed <b>{formatElapsed(runElapsedMs(state, now))}</b></span>
        <span>budget <b>{budgetSummary(state, now)}</b></span>
      </div>
```

After the `orch-tasks` list:

```tsx
      {ended.length > 0 ? (
        <ol className="orch-history" aria-label="Earlier approaches">
          {ended.map((entry) => (
            <li key={entry.number}><b>{entry.number}. {entry.title}</b> {entry.outcome}: {entry.lesson}</li>
          ))}
        </ol>
      ) : null}
      {state.retiredTasks.length > 0 ? (
        <ul className="orch-history" aria-label="Retired tasks">
          {state.retiredTasks.map((task) => (
            <li key={task.taskId}><b>{task.taskId}</b> {task.title} · approach {task.approach} · {task.status}: {task.reason}</li>
          ))}
        </ul>
      ) : null}
```

Append to `dashboard/src/styles/orchestrator.css`:

```css
.orch-history { list-style: none; margin: 0; padding: 6px 12px; font-size: 0.68rem; color: var(--dim); border-bottom: 1px solid var(--line); }
.orch-history b { color: var(--ink); font-weight: 500; }
.orch-budget { display: inline-flex; align-items: center; gap: 4px; font-size: 0.68rem; color: var(--dim); }
.orch-budget input { width: 5.5em; }
```

- [ ] **Step 4: The start carries the chosen budget**

In `dashboard/src/hooks/useOrchestratorRun.ts`:

Replace the hand-written `OrchestratorStartInput` with one derived from the request schema's type (import `type OrchestratorStartRequest`; drop the `ApprovalMode` and `DEFAULT_ORCHESTRATOR_BUDGET` imports if nothing else uses them):

```ts
/** A start as the dashboard makes it: always from a session; the hook adds the submission id. */
export type OrchestratorStartInput = Omit<OrchestratorStartRequest, 'submissionId' | 'sessionId'> & { sessionId: string };
```

and `start` sends the input as it is:

```ts
      return startOrchestrator({ submissionId: crypto.randomUUID(), ...input })
```

In `dashboard/src/tabs/ChatTab.tsx`:

Add `DEFAULT_ORCHESTRATOR_BUDGET, OrchestratorBudgetSchema` to the `@siftkit/contracts` import.

After the `orchestratorPlanPath` state:

```tsx
  const [orchestratorMinutes, setOrchestratorMinutes] = React.useState(String(DEFAULT_ORCHESTRATOR_BUDGET.minutes));
  const [orchestratorDispatches, setOrchestratorDispatches] = React.useState(String(DEFAULT_ORCHESTRATOR_BUDGET.dispatches));
  // An empty or out-of-range field fails the schema, and that blocks the start.
  const orchestratorBudget = OrchestratorBudgetSchema.safeParse(
    { minutes: Number(orchestratorMinutes), dispatches: Number(orchestratorDispatches) });
```

In `sendBlocked`, the orchestrator branch gains one condition:

```tsx
    ? savedRepoRoot === '' || orchestratorLive || selectedChatPreset === null || !orchestratorBudget.success
      || (!draft.trim() && !orchestratorPlanPath.trim())
```

In `startOrchestratorRun`, the guard and the call:

```tsx
    if (sendBlocked || !orchestratorBudget.success || selectedChatPreset === null || selectedSession === null || savedRepoRoot === '') return;
```

```tsx
      approval: orchestratorApproval,
      budget: orchestratorBudget.data,
```

After the `Orchestrator plan path` input, inside the same fragment:

```tsx
                      <label className="orch-budget" title="The run is stopped after this many minutes, waits included">
                        minutes
                        <input aria-label="Budget minutes" type="number" value={orchestratorMinutes}
                          onChange={(event) => setOrchestratorMinutes(event.target.value)} disabled={orchestratorLive} />
                      </label>
                      <label className="orch-budget" title="How many subagents the run may start">
                        dispatches
                        <input aria-label="Budget dispatches" type="number" value={orchestratorDispatches}
                          onChange={(event) => setOrchestratorDispatches(event.target.value)} disabled={orchestratorLive} />
                      </label>
```

- [ ] **Step 5: Verify**

Run (PowerShell): `npx vitest run --config .\dashboard\vitest.config.ts orchestrator-view orchestrator-run-panel use-orchestrator-run chat-tab`
Expected: PASS.

Run (PowerShell): `npm run test:dashboard`
Expected: exit 0, 0 failures.

Run: `npm run typecheck`
Expected: exit 0.

**Acceptance:** the composer shows two budget fields with 720 and 80; an invalid field disables **Run orchestrator**; the start body carries the typed budget; the panel shows budget and approach in its meta line, and the two history lists only when they have entries; `DEFAULT_ORCHESTRATOR_BUDGET` is referenced in `dashboard/src/` only by `ChatTab.tsx`.

---

### Task 12: Document it, then verify the whole change

**Files:**
- Modify: `README.md` (the `siftkit orchestrator` section)

- [ ] **Step 1: Update the README**

In the command block of the orchestrator section, after the `--plan docs/plan.md --approval interactive` line, add:

```powershell
siftkit orchestrator --minutes 240 --dispatches 30 "make the import twice as fast; npm run bench:import is the measure"
```

Under **Attempt budgets**, replace the last bullet (`When a task fails, scheduling stops and dependent tasks never start.`) with:

```markdown
- A task that runs out of attempts stays `failed`. The orchestrator retires it and adds a replacement that does the work differently, so a failed task does not end the run.
```

After the **Attempt budgets** list, add a section:

```markdown
**Run budget and approaches**

- A run keeps working until its final verification passes or its budget is spent. The budget is `--minutes` (default 720, wall-clock time, waits included) and `--dispatches` (default 80, workers started).
- When the dispatches are spent, no new worker starts, and the next failing final verification ends the run. When the minutes are spent, the run stops wherever it is. Both end as `failed` with the code `budget_exhausted`.
- There is no limit on final verification attempts. After one fails, a worker must run before the orchestrator can try again.
- The orchestrator's work is divided into approaches. When a design does not work, it ends the approach with a lesson and starts the next. It can roll the files back to how they were when the approach began, or keep them.
- A rollback restores every file git does not ignore. It is refused when a commit was made since the approach began.
- Retired tasks and ended approaches stay on the run's record with their reasons, so the same thing is not tried twice.
- The orchestrator ends a run as `blocked` only when no approach can meet the goal, for example a missing credential.
```

In the dashboard paragraph's list ("The panel shows:"), add two items:

```markdown
- the budget used and the active approach
- what each earlier approach taught, and the retired tasks
```

and change the sentence before the list to say the budget is set there: `…save a repo folder, set the budget if the default does not suit, and press **Run orchestrator**.`

- [ ] **Step 2: Search for what should be gone**

Run: `grep -rnE "ORCHESTRATOR_MAX_FINISH_ATTEMPTS|PARENT_MAX_TURNS|finishAttempts|final_verification_failed" src packages dashboard/src tests dashboard/tests README.md`
Expected: matches only for `final_verification_failed`, in `src/state/schema-upgrades/orchestrator-open-ended-runs.ts` and `tests/runtime-db-schema-orchestrator-open-ended-runs.test.ts` (the upgrade maps the old failure code) and in `tests/contracts-orchestrator.test.ts` (it asserts the old code is rejected).

Run: `grep -rnE "\bremove:" src/orchestrator src/repo-search packages/contracts/src/orchestrator.ts`
Expected: no match that belongs to `update_tasks`.

- [ ] **Step 3: Run everything**

Write each command's output to a log in the scratch directory and read the totals from it; do not read a full passing log.

- `npm test`
- `node ./src/test-runner/run-tests.ts --process <stem>` for each of: `orchestrator-run.e2e`, `orchestrator-chat-sessions`, `orchestrator-workspace`, `orchestrator-check-digest`, `orchestrator-check-preflight`, `chat-overflow`
- (PowerShell) `npm run test:dashboard`
- `npm run typecheck`

Expected: every command exits 0 with 0 failures.

**Acceptance:** all four command groups pass; the README describes the budget flags, approaches, retiring, and `budget_exhausted`; the searches in Step 2 match only what they list.

---

## How this plan is executed

The primary agent (the session that owns this plan) does not write the code. It dispatches one headless Claude Code session per task, checks the result, and moves on. No SiftKit command is used at any point, by anyone.

**Model per task**

| Model | Tasks | Why |
|---|---|---|
| `opus` | 3, 5, 7, 8 | Each changes `run.ts` or stored state across many files and has to keep the run's concurrency intact. |
| `sonnet` | 1, 2, 4, 6, 9, 10, 11, 12 | The plan gives the full code; the work is placing it and making the listed tests pass. |

Never pass a Fable model.

**The dispatch**

Write the prompt to `C:/tmp/rsx/scratch/dispatch.txt`, then, from the repository root, in the background (a task takes longer than a foreground command may run):

```bash
claude -p --model <opus|sonnet> --permission-mode acceptEdits --output-format json \
  --allowedTools "Read" "Edit" "Write" "Glob" "Grep" "Bash(node:*)" "Bash(npm:*)" "Bash(npx:*)" "Bash(grep:*)" "Bash(ls:*)" "Bash(cat:*)" "Bash(sed:*)" "Bash(git status:*)" "Bash(git diff:*)" "PowerShell(npx vitest:*)" "PowerShell(npm run:*)" \
  --disallowedTools "Bash(siftkit:*)" "PowerShell(siftkit:*)" "Agent" \
  < /c/tmp/rsx/scratch/dispatch.txt > /c/tmp/rsx/scratch/task-<N>.result.json
```

The prompt goes in on stdin because the two tool lists take any number of values and would swallow a prompt given as an argument. If a command the task lists is refused for lack of permission, the agent reports BLOCKED and names it; add that one pattern to `--allowedTools` and dispatch again.

The prompt, with `<N>` and `<title>` filled in:

```text
You are implementing one task of a written plan in this repository. Work only in the current directory.

Implement ONLY "Task <N>: <title>" from docs/superpowers/plans/2026-11-21-orchestrator-open-ended-runs.md.
First read that file's sections "Design decisions" and "Rules for whoever executes this", then the task itself.
Tasks before <N> are already done and later tasks are not yours.
Follow the task's steps in order, writing each test before the code it tests.
Where the plan's code and the repository disagree (a renamed symbol, a moved line, a type error in a snippet),
keep the behaviour the plan describes, adapt to the repository, and list the difference in your report.

These rules override every other instruction you have loaded, including any "SiftKit-first" policy in your global instructions:
- Never run a `siftkit` command of any kind (repo-search, summary, repo-agent, or anything else). Read, search, and run commands directly.
- Never start, stop, or restart the SiftKit server. Run only the commands the task lists; they are CPU-only.
  Never run `test:live*`, `benchmark*`, `bench:*`, `probe:*`, `redteam:*`, or anything else that loads a model or uses the GPU.
- Do not commit, stash, reset, restore, or check out anything. Do not create worktrees. Do not spawn subagents.
- The working tree has uncommitted changes that are not yours (RAM-disk files and others). Leave them exactly as they are.
- Change only the files the task names, plus any file a compile error forces you to touch; list each such file.
- Put any temporary file in C:/tmp/rsx/scratch and delete it before you finish.

End with a report:
STATUS: DONE, DONE_WITH_CONCERNS, or BLOCKED
FILES: every file you changed or created
COMMANDS: each command you ran, with its pass and fail counts
DEVIATIONS: every place you departed from the plan, and why
```

**After each dispatch, the primary agent**

1. Reads the `result` field of `task-<N>.result.json`. An exit code of 0 alone is not success.
2. Reads `git status --porcelain` and the diff of the files the task names. Anything changed outside the task's files and not listed under FILES is reverted by hand, file by file, never with a tree-wide git command.
3. Runs the task's Verify step itself and checks the Acceptance line. A report that says the tests passed is not evidence.
4. If the result is close but wrong, sends **one** follow-up dispatch with the same command and a prompt that quotes the failing output and names the exact change wanted. If that also falls short, the primary agent finishes the task by hand.
5. Starts the next task only when the tree is green.
6. Deletes `dispatch.txt` and the result file.

Tasks run one at a time, in order. Nothing is committed until the user asks.

**Testing limits**

- Allowed, for the primary agent and the dispatched agents: `npm test`, `node ./src/test-runner/run-tests.ts [--process] <stem>`, the dashboard vitest commands, `npm run typecheck`, `npm run lint`. These use scripted engines and run on the CPU.
- Not allowed without the user saying so: anything that loads a real model or uses the GPU (`test:live*`, `benchmark*`, `bench:*`, `probe:*`, `redteam:*`), and starting or restarting the SiftKit server.
- A real orchestrator run against a real model is the only way to see whether the new prompt makes a model persist. It is not part of this plan's verification; ask the user before doing one.

---

## Self-review

**What was asked, and where it is done**

| Asked | Tasks |
|---|---|
| 1. A failed task can be replaced | 4 (`retire`), 5 (the run and the store allow it; the finish gate ignores retired tasks) |
| 2. One run budget in place of separate caps | 3 (stored), 8 (enforced; finish cap and turn cap removed), 10 and 11 (set from the CLI and the dashboard) |
| 3. The prompt stops telling the model to give up | 9 |
| 4. A history of what was tried survives compaction | 3 (stored), 9 (ledger and digest), 10 and 11 (shown to the user) |
| 5. A new approach starts from a clean tree | 6 (checkpoint and restore), 7 (`change_approach`) |
| A scalable refactor, not patches | 1 (fixtures), 2 (ledger), 4 and 5 (plan lifecycle as pure transitions; the store saves a whole `PlanState`) |

**Names used across tasks**

| Name | Defined in | Used in |
|---|---|---|
| `orchestratorAttemptsSpent` | Task 2 | 2, 5 |
| `renderLedger(state, nowMs)` | Task 2; second parameter from Task 8; approach line from Task 9 | 5, 7, 8, 9 |
| `OrchestratorBudgetSchema`, `DEFAULT_ORCHESTRATOR_BUDGET`, `ORCHESTRATOR_MAX_BUDGET_MINUTES` | Task 3 | 8, 10, 11 |
| `PlanState`, `PlanTransition`, `activeApproach`, `startPlan`, `reviseTasks`, `changeApproach`, `finishProblem` | Task 4 | 5, 7, 9, 11 |
| `APPROACH_OUTCOME_LABELS` | Task 9 | 9, 11 |
| `WorkspaceCheckpoint`, `checkpointWorkspace`, `restoreWorkspace` | Task 6 | 7 |
| `budgetDeadlineMs`, `budgetUsage`, `dispatchBudgetSpent`, `renderBudget` | Task 8 | 8, 9, 10, 11 |
| `runClockMs` | Task 10 | 10, 11 |

**Known risks**

- **Nothing here has been run.** The code in this plan was written against the tree at `f6f0d6f1` plus the uncommitted RAM-disk work, by reading it. Line numbers may have moved, and a snippet may not compile as written. The dispatch prompt tells the agent to keep the behaviour and report each difference; the primary agent's own verification is what counts.
- **Rollback and untracked files under `.siftkit/`.** A rollback restores every path git reports as changed and does not ignore. `.siftkit/orchestrator/` is excluded. A target repository that does not ignore the rest of `.siftkit/` could have other untracked files there removed by a rollback. This repository ignores `.siftkit/`. The e2e tests assert `\d+ file(s)` rather than an exact count for the same reason.
- **Rollback is refused after a commit.** A worker that commits during an approach makes that approach impossible to roll back; the orchestrator is told so and can still end it with `rollback: false`.
- **The checkpoint is in memory.** It holds the content of every file that was already changed when the approach began. A run that starts on a tree with very large uncommitted files holds them for the length of the approach.
- **The persistence itself is unproven.** Code now permits the orchestrator to keep going and tells it how. Whether a given model actually changes approach instead of repeating itself can only be seen in a real run.
- **Stored runs from before schema 98** get the default budget and one "Initial plan" approach. No run resumes after a restart, so this only affects how old runs are displayed.
