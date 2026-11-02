# Orchestrator Single-Worker Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The orchestrator reads the repository and runs checks itself; it no longer plans survey tasks for read-only `repo-search` workers. `repo-agent` is the only worker kind, and exactly one child runs at a time.

**Architecture:** Five slices, each leaving the tree green. (1) One child per dispatch, which removes the parallel scheduler, the queue, model-slot accounting, and reader change-tracking. (2) Workers are only `repo-agent` presets that can change files, and every task declares `writePaths`, which removes the read-only task path. (3) One report shape, without a `kind` discriminator, plus schema upgrade 88 → 89 for stored reports and the built-in preset description. (4) The repository gate loses owner-scoped overlap, which only orchestrator readers used. (5) The orchestrator prompt drops surveys and tells the orchestrator to explore with its read tools and verify with `run_check`.

**Tech Stack:** TypeScript (Node ≥ 26, `node:test`), Zod contracts in `packages/contracts`, SQLite runtime DB with explicit schema upgrades, React dashboard (vitest).

**Rules for every task:** TDD (failing test, then the minimum code, then a passing test). Do not commit. No `any`, type assertions, or non-null assertions. Comments stay at 1–2 lines. No shims or compatibility paths. Keep temporary files in `.siftkit/tmp/` and delete them at the end.

**Commands used below**
- One test file: `node .\src\test-runner\run-tests.ts tests\<file>.test.ts`
- Process (e2e) file: `node .\src\test-runner\run-tests.ts --process tests\process\orchestrator-run.e2e.test.ts`
- Dashboard: `npm run test:dashboard`
- Gates: `npm run typecheck`, `npm run lint`, `npm test`

## Design decisions (owned by the primary agent)

1. **Evidence checks stay.** `{ kind: 'evidence' }` verification checks are not survey-specific. A writer task, for example a docs change, can still be verified by review evidence.
2. **One child at a time.** With no readers left, a second child could only be a second writer, and two writers never overlap. So `dispatch` takes one child, and parallel slots, the queue, and model-slot waits are deleted. The schedule keeps `claims` (model and context per task) and `waits` (each pending task's unmet `dependencies`); `writerUsed` and the `writer_slot` wait were later dropped, since the live children list already shows the one running child.
3. **Stored history.** There are 59 survey attempts across 34 stored runs (checked in `.siftkit/runtime.sqlite` at schema 88). Upgrade 88 → 89 turns each stored `search` report into `report: null` and strips `kind` from `agent` reports. Nothing renders a stored report's body after a run ends: the dashboard never reads `report`, and the CLI prints a run only while it streams it. Stored plans keep their historical `repo-search` tasks and empty `writePaths`; the schema still parses them, and only new plans are validated.
4. **`writePaths` is required.** The schema default `[]` is removed. Plan validation rejects a task with no write paths.
5. **The built-in orchestrator description** changes in `src/preset-catalog.ts`. Upgrade 89 rewrites the stored built-in only when it still holds the old text, so a user's own edit survives.

## File map

| File | Change |
|---|---|
| `packages/contracts/src/orchestrator.ts` | Single-child dispatch args, no `ORCHESTRATOR_MAX_DISPATCH`; schedule without `models` or `mutating`, wait without `model_slot`; one report schema; no `OrchestratorCitationSchema`; `writePaths` required |
| `src/orchestrator/scheduler.ts` | `planDispatch` judges one request; delete `fitsBeside`, the queue, `isMutatingTask`, and slot accounting |
| `src/orchestrator/run.ts` | `live` Map → `child` field; delete queue, reader tracking, `settleReadOnlyTask`, and shared access |
| `src/orchestrator/workspace.ts` | `diffWorkspace` drops its `excluded` parameter |
| `src/orchestrator/plan.ts` | `isOrchestratorWorker`; workers are file-changing `repo-agent` presets; `writePaths` required |
| `src/orchestrator/workers.ts` | child `taskKind` is always `repo-agent` |
| `src/orchestrator/handoff.ts` | one report template; `findCitationProblem` moves out; no search rendering |
| `src/orchestrator/verification.ts` | gains `findCitationProblem` |
| `src/orchestrator/review.ts` | imports `findCitationProblem` from verification |
| `src/orchestrator/submission.ts` | no `kind` or `repoRoot` |
| `src/orchestrator/prompts.ts` | new orchestrator prompt; worker line; child instruction without `kind` |
| `src/orchestrator/digest.ts` | no "writes nothing" branch |
| `src/repo-search/planner-protocol.ts` | `dispatch` and `decide` tool descriptions and example args |
| `src/repo-search/prompts.ts` | orchestrator system prompt line |
| `src/status-server/orchestrator-runs.ts` | gate without `owner` |
| `src/status-server/repo-agent-sessions.ts` | gate call without owner |
| `src/preset-catalog.ts` | orchestrator description |
| `src/cli/run-orchestrator.ts` | comment |
| `src/state/schema-upgrades/orchestrator-single-worker.ts` | **new**: upgrade 88 → 89 |
| `src/state/runtime-db.ts` | register upgrade; `CURRENT_SCHEMA_VERSION = 89` |
| `dashboard/src/components/OrchestratorRunPanel.tsx`, `OrchestratorTaskRow.tsx`, `dashboard/src/orchestrator-view.ts`, `dashboard/src/styles/orchestrator.css` | writer-only slot meter, no role label, no `model_slot` |
| Tests | see each task |

---

### Task 1: One child per dispatch

Readers still exist after this task, but every child, reader or writer, runs alone.

**Files:**
- Modify: `packages/contracts/src/orchestrator.ts`
- Modify: `src/orchestrator/scheduler.ts`, `src/orchestrator/run.ts`, `src/orchestrator/workspace.ts`
- Modify: `src/repo-search/planner-protocol.ts`
- Modify: `dashboard/src/components/OrchestratorRunPanel.tsx`, `dashboard/src/components/OrchestratorTaskRow.tsx`, `dashboard/src/orchestrator-view.ts`, `dashboard/src/styles/orchestrator.css`
- Test: `tests/orchestrator-scheduler.test.ts` (rewrite), `tests/contracts-orchestrator.test.ts`, `tests/orchestrator-live-activity.test.ts`, `tests/repo-search-orchestrator-tools.test.ts`, `tests/process/orchestrator-run.e2e.test.ts`, `tests/process/orchestrator-workspace.test.ts` (only if it passes a third argument), `dashboard/tests/orchestrator-run-panel.test.tsx`, `dashboard/tests/orchestrator-view.test.ts`

- [ ] **Step 1: Rewrite the scheduler tests for single-request dispatch.** Replace all of `tests/orchestrator-scheduler.test.ts` with:

```ts
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  OrchestratorAttemptSchema,
  type OrchestratorAttempt,
  type OrchestratorChildPurpose,
  type OrchestratorTask,
  type OrchestratorTaskState,
  type OrchestratorTaskStatus,
} from '@siftkit/contracts';
import { getActiveModelPreset } from '../src/config/getters.ts';
import { planDispatch, type DispatchRequest } from '../src/orchestrator/scheduler.ts';
import { getDefaultConfig } from '../src/status-server/config-store.ts';
import { makeOrchestratorPlan, makeOrchestratorTask } from './helpers/orchestrator-plan.ts';

const WRITE = makeOrchestratorTask({ id: 'write', workerPresetId: 'repo-agent', writePaths: ['src/a.ts'] });
const WRITE_2 = makeOrchestratorTask({ id: 'write-2', workerPresetId: 'repo-agent', writePaths: ['src/b.ts'] });
const AFTER_WRITE = makeOrchestratorTask({ id: 'after-write', dependsOn: ['write'], workerPresetId: 'repo-agent', writePaths: ['src/c.ts'] });
const PLAN = makeOrchestratorPlan([WRITE, WRITE_2, AFTER_WRITE]);
const CONFIG = getDefaultConfig();

function states(overrides: Record<string, OrchestratorTaskStatus> = {}): OrchestratorTaskState[] {
  return PLAN.tasks.map((task) => ({ taskId: task.id, status: overrides[task.id] ?? 'pending', review: null }));
}

function attempt(task: OrchestratorTask, purpose: OrchestratorChildPurpose, number: number, status: OrchestratorAttempt['status']): OrchestratorAttempt {
  return OrchestratorAttemptSchema.parse({
    taskId: task.id, purpose, attempt: number, childRunId: `00000000-0000-4000-8000-00000000000${number}`, status, result: null,
    reservedAtUtc: '2026-10-11T12:00:00.000Z',
    work: { kind: purpose, planPath: 'plan.md', planHash: 'h', task, instruction: 'Do it.' },
  });
}

function dispatch(input: { request: DispatchRequest; statuses?: Record<string, OrchestratorTaskStatus>; attempts?: OrchestratorAttempt[] }) {
  return planDispatch({ config: CONFIG, plan: PLAN, taskStates: states(input.statuses), attempts: input.attempts ?? [], request: input.request });
}

const implement = (task: OrchestratorTask): DispatchRequest => ({ task, purpose: 'implementation' });

test('a dependent starts only once its predecessor completed, not while it runs, awaits review, or failed', () => {
  for (const status of ['pending', 'running', 'reviewing', 'failed'] as const) {
    assert.equal(dispatch({ request: implement(AFTER_WRITE), statuses: { write: status } }).problem,
      "Task 'after-write' cannot start: its dependencies are not complete: write.", status);
  }
  assert.equal(dispatch({ request: implement(AFTER_WRITE), statuses: { write: 'completed' } }).problem, null);
});

test('an implementation needs a pending or reviewed task and an attempt left', () => {
  assert.equal(dispatch({ request: implement(WRITE), statuses: { write: 'reviewing' },
    attempts: [attempt(WRITE, 'implementation', 1, 'settled')] }).problem, null, 'a retry after a failed review');
  assert.equal(dispatch({ request: implement(WRITE), statuses: { write: 'completed' } }).problem,
    "Task 'write' is completed; implementation work needs it pending or reviewing.");
  assert.equal(dispatch({ request: implement(WRITE), statuses: { write: 'reviewing' },
    attempts: [attempt(WRITE, 'implementation', 1, 'settled'), attempt(WRITE, 'implementation', 2, 'settled')] }).problem,
  "Task 'write' used all 2 implementation attempts.");
});

test('a fix needs a reviewed or completed task with a settled attempt, and has its own attempt budget', () => {
  const fix: DispatchRequest = { task: WRITE, purpose: 'fix' };
  const settled = [attempt(WRITE, 'implementation', 1, 'settled'), attempt(WRITE, 'implementation', 2, 'settled')];
  assert.equal(dispatch({ request: fix, statuses: { write: 'completed' }, attempts: settled }).problem, null,
    'implementation attempts never consume the fix budget');
  assert.equal(dispatch({ request: fix, statuses: { write: 'pending' } }).problem,
    "Task 'write' is pending; fix work needs it reviewing or completed.");
  assert.equal(dispatch({ request: fix, statuses: { write: 'reviewing' }, attempts: [attempt(WRITE, 'implementation', 1, 'abandoned')] }).problem,
    "Task 'write' has no settled attempt to fix.");
  assert.equal(dispatch({ request: fix, statuses: { write: 'reviewing' },
    attempts: [...settled, attempt(WRITE, 'fix', 1, 'settled'), attempt(WRITE, 'fix', 2, 'settled')] }).problem,
  "Task 'write' used all 2 fix attempts.");
});

test('the schedule records every claim, holds the writer slot for the started task, and says why each other pending task waits', () => {
  const model = getActiveModelPreset(CONFIG);
  const { problem, schedule } = dispatch({ request: implement(WRITE) });
  assert.equal(problem, null);
  assert.deepEqual(schedule.claims, PLAN.tasks.map((task) => ({ taskId: task.id, modelId: model.id, contextTokens: model.NumCtx })));
  assert.equal(schedule.writerUsed, true);
  assert.deepEqual(schedule.waits, [
    { taskId: 'write-2', wait: { kind: 'writer_slot' } },
    { taskId: 'after-write', wait: { kind: 'dependencies', taskIds: ['write'] } },
  ], 'dependencies are checked before the slot; the started task never waits');
});

test('a refused dispatch holds no slot', () => {
  const { problem, schedule } = dispatch({ request: implement(AFTER_WRITE) });
  assert.notEqual(problem, null);
  assert.equal(schedule.writerUsed, false);
  assert.deepEqual(schedule.waits, [{ taskId: 'after-write', wait: { kind: 'dependencies', taskIds: ['write'] } }]);
});
```

- [ ] **Step 2: Update the contract and tool tests.**
  - In `tests/contracts-orchestrator.test.ts`, remove the `ORCHESTRATOR_MAX_DISPATCH` import. Replace the dispatch assertions in the test `'a dispatch starts one or two children…'` (the `ORCHESTRATOR_MAX_DISPATCH` and three `OrchestratorDispatchArgsSchema` lines) with the lines below. Rename that test to `'a dispatch starts exactly one child and a review judges every criterion with code evidence'`.
    ```ts
    assert.equal(OrchestratorDispatchArgsSchema.safeParse(child).success, true);
    assert.equal(OrchestratorDispatchArgsSchema.safeParse({ children: [child] }).success, false);
    assert.equal(OrchestratorDispatchArgsSchema.safeParse({ taskId: 'a' }).success, false);
    ```
    In that file's `SCHEDULE` fixture, change to `claims: [{ taskId: 'greeting', modelId: 'exl3-main', contextTokens: 32768 }], writerUsed: true, waits: []` (no `models`). Replace the `model_slot` safeParse line with `assert.equal(OrchestratorTaskWaitSchema.safeParse({ kind: 'model_slot', modelId: 'exl3-main' }).success, false);`.
  - In `tests/orchestrator-live-activity.test.ts`, change `SCHEDULE` to `{ claims: [{ taskId: 'write', modelId: 'exl3-main', contextTokens: 4000 }], writerUsed: true, waits: [] }`.
  - In `tests/repo-search-orchestrator-tools.test.ts`, set `const DISPATCH = { taskId: 'greeting', purpose: 'implementation', instruction: 'Create src/greeting.ts.' };`. In the refusal test, replace the invalid `{ children: [] }` call with `{ taskId: 'greeting' }`.

- [ ] **Step 3: Update the e2e file.** In `tests/process/orchestrator-run.e2e.test.ts`:
  - Replace the `dispatch` helper with:
    ```ts
    function dispatch(child: { taskId: string; purpose?: OrchestratorChildPurpose; instruction?: string }) {
      return tool('dispatch', { taskId: child.taskId, purpose: child.purpose ?? 'implementation',
        instruction: child.instruction ?? `Do task ${child.taskId}.` });
    }
    ```
  - Delete these tests, which assert parallel or queued children or reader change-tracking:
    - `'a writer and a reader dispatched together run at once…'`, together with the `WAIT_FOR_TARGET` constant above it;
    - `'two readers dispatched together on a one-slot model…'`;
    - `'a reader that starts after the writer finished is charged…'`.
  - In `'code refuses an invalid plan or dispatch…'`:
    - Remove the step `dispatch({ taskId: 'greeting' }, { taskId: 'farewell' })`.
    - Destructure `const [badPlan, goodPlan, unmet, unknown] = engine.parentToolOutputs();`.
    - Delete the `twoWriters` assertion.
  - Remove the `RepoSearchExecutionRequest` import if nothing else uses it.

- [ ] **Step 4: Update the dashboard tests.**
  - In `dashboard/tests/orchestrator-run-panel.test.tsx`:
    - Set `CLAIM = { taskId: TASK.id, modelId: 'exl3-main', contextTokens: 4000 }`.
    - Remove every `models: [...]` entry from schedule fixtures.
    - Rename the slot test to `'the slot meter shows the writer slot, and a pending task says why it waits'`.
    - Delete its `screen.getByTitle('1 of 2 exl3-main slots in use');` line.
  - In `dashboard/tests/orchestrator-view.test.ts`:
    - In `ACTIVITY.schedule`, drop `mutating` from the claim and drop `models`.
    - Delete the `{ taskId: 'read', wait: { kind: 'model_slot', modelId: 'm' } }` entry.
    - Change the `'read'` assertion to `assert.equal(waitReason(taskOf(state, 'read'), state, ACTIVITY), 'queued');`.
    - Change the `contextPercent` claim to `{ taskId: 'write', modelId: 'm', contextTokens: 4000 }`.

- [ ] **Step 5: Run the tests to verify they fail.**
  - `node .\src\test-runner\run-tests.ts tests\orchestrator-scheduler.test.ts tests\contracts-orchestrator.test.ts`
  - Expected: FAIL (typecheck or assertions on `problem`, single-child dispatch, and claims).

- [ ] **Step 6: Change the contracts.** In `packages/contracts/src/orchestrator.ts`:
  - Delete `ORCHESTRATOR_MAX_DISPATCH` and its comment.
  - Replace `OrchestratorDispatchArgsSchema` with:
    ```ts
    /** Starts one fresh child for one saved task; children run one at a time. */
    export const OrchestratorDispatchArgsSchema = z.object({
      taskId: z.string().min(1), purpose: OrchestratorChildPurposeSchema, instruction: z.string().trim().min(1),
    }).strict();
    ```
  - Replace the schedule block (claim, model-slot, wait, and schedule schemas) with:
    ```ts
    /** What a task claims while its child runs: one slot of its worker's model. */
    export const OrchestratorTaskClaimSchema = z.object({
      taskId: z.string().min(1), modelId: z.string().min(1), contextTokens: z.number().positive(),
    }).strict();
    export type OrchestratorTaskClaim = z.infer<typeof OrchestratorTaskClaimSchema>;

    /** Why a pending task cannot be dispatched now, in the order the host checks. */
    export const OrchestratorTaskWaitSchema = z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('dependencies'), taskIds: z.array(z.string().min(1)).min(1) }).strict(),
      z.object({ kind: z.literal('writer_slot') }).strict(),
    ]);
    export type OrchestratorTaskWait = z.infer<typeof OrchestratorTaskWaitSchema>;

    /** The latest dispatch: every task's claim, whether a child holds the writer slot, and why each pending task waits. */
    export const OrchestratorScheduleSchema = z.object({
      claims: z.array(OrchestratorTaskClaimSchema), writerUsed: z.boolean(),
      waits: z.array(z.object({ taskId: z.string().min(1), wait: OrchestratorTaskWaitSchema }).strict()),
    }).strict();
    export type OrchestratorSchedule = z.infer<typeof OrchestratorScheduleSchema>;
    ```
  - Delete `OrchestratorModelSlotsSchema` and its type.

- [ ] **Step 7: Rewrite the scheduler.** Replace `src/orchestrator/scheduler.ts` from the `HeldClaim` type to the end of the file with the code below. Keep `isMutatingTask` and `workerModelPreset` as they are; Task 2 deletes `isMutatingTask`. Drop the now-unused imports (`OrchestratorTaskClaim` stays; check `SiftPreset` is still used by `workerModelPreset`).

```ts
function taskClaim(config: SiftConfig, task: OrchestratorTask): OrchestratorTaskClaim {
  const model = workerModelPreset(config, requireOrchestratorWorkerPreset(config, task));
  return { taskId: task.id, modelId: model.id, contextTokens: model.NumCtx };
}

function unmetDependencies(task: OrchestratorTask, status: ReadonlyMap<string, OrchestratorTaskStatus>): string[] {
  return task.dependsOn.filter((dependency) => status.get(dependency) !== 'completed');
}

const DISPATCHABLE_STATUSES: Record<OrchestratorChildPurpose, readonly OrchestratorTaskStatus[]> = {
  implementation: ['pending', 'reviewing'],
  fix: ['reviewing', 'completed'],
};

export type DispatchRequest = { task: OrchestratorTask; purpose: OrchestratorChildPurpose };

/**
 * Whether the requested child starts: a task status its purpose allows, an attempt left, and complete dependencies.
 * The schedule records every claim and why each other pending task waits, so no viewer re-derives these rules.
 */
export function planDispatch(input: {
  config: SiftConfig;
  plan: OrchestratorPlan;
  taskStates: readonly OrchestratorTaskState[];
  attempts: readonly OrchestratorAttempt[];
  request: DispatchRequest;
}): { problem: string | null; schedule: OrchestratorSchedule } {
  const { task, purpose } = input.request;
  const status = new Map(input.taskStates.map((state) => [state.taskId, state.status]));
  const current = status.get(task.id) ?? 'pending';
  const used = input.attempts.filter((attempt) => attempt.taskId === task.id && attempt.purpose === purpose).length;
  const unmet = unmetDependencies(task, status);
  let problem: string | null = null;
  if (!DISPATCHABLE_STATUSES[purpose].includes(current)) {
    problem = `Task '${task.id}' is ${current}; ${purpose} work needs it ${DISPATCHABLE_STATUSES[purpose].join(' or ')}.`;
  } else if (purpose === 'fix' && !input.attempts.some((attempt) => attempt.taskId === task.id && attempt.status === 'settled')) {
    problem = `Task '${task.id}' has no settled attempt to fix.`;
  } else if (used >= ORCHESTRATOR_MAX_ATTEMPTS) problem = `Task '${task.id}' used all ${ORCHESTRATOR_MAX_ATTEMPTS} ${purpose} attempts.`;
  else if (unmet.length > 0) problem = `Task '${task.id}' cannot start: its dependencies are not complete: ${unmet.join(', ')}.`;
  return { problem, schedule: describeSchedule(input.config, input.plan, input.taskStates, problem === null ? task : null) };
}

/** Every planned task's claim, whether `running` holds the writer slot, and why each other pending task waits. */
export function describeSchedule(config: SiftConfig, plan: OrchestratorPlan, taskStates: readonly OrchestratorTaskState[],
  running: OrchestratorTask | null): OrchestratorSchedule {
  const status = new Map(taskStates.map((state) => [state.taskId, state.status]));
  const waits: OrchestratorSchedule['waits'] = plan.tasks.flatMap((task) => {
    if (status.get(task.id) !== 'pending' || task.id === running?.id) return [];
    const unmet = unmetDependencies(task, status);
    if (unmet.length > 0) return [{ taskId: task.id, wait: { kind: 'dependencies', taskIds: unmet } }];
    return running === null ? [] : [{ taskId: task.id, wait: { kind: 'writer_slot' } }];
  });
  return { claims: plan.tasks.map((task) => taskClaim(config, task)), writerUsed: running !== null, waits };
}
```

If `describeSchedule` has no caller outside this file after Step 8, make it a non-exported function.

- [ ] **Step 8: Make `run.ts` run one child at a time.** In `src/orchestrator/run.ts`:
  1. Replace the `LiveChild` type and its comment with:
     ```ts
     /** The one child between its start and its settled result. */
     type LiveChild = {
       attempt: OrchestratorAttempt;
       task: OrchestratorTask;
       mutating: boolean;
       baseline: WorkspaceSnapshot;
       repository: RepositoryLease;
       submission: WorkerSubmission;
       session: RepoAgentSession | null;
     };
     ```
  2. Replace the fields `live` and `queued` (with its comment) with `private child: LiveChild | null = null;`.
  3. `abort`: replace the loop with `this.child?.session?.abort();`.
  4. `run()`: replace the `sessions` lines with:
     ```ts
     const session = this.child?.session ?? null;
     if (session !== null) {
       session.abort();
       await Promise.allSettled([session.settled]);
     }
     ```
  5. `storePlan`: `if (this.child !== null) return this.refuse(['A child is still running; change the plan once it reports.']);`
  6. Replace `dispatch` and delete `startQueuedChildren`:
     ```ts
     private async dispatch(args: OrchestratorDispatchArgs): Promise<OrchestratorToolOutcome> {
       const { plan, planPath, planHash } = this.state;
       if (plan === null || planPath === null || planHash === null) return this.refuse(['Save a plan first.']);
       if (this.escalations.size > 0) return this.refuse(['A child approval is waiting; answer it with decide.']);
       if (this.child !== null) return this.refuse(['A child is still running.']);
       const task = plan.tasks.find((entry) => entry.id === args.taskId);
       if (task === undefined) return this.refuse([`Task '${args.taskId}' is not in the saved plan.`]);
       const { problem, schedule } = planDispatch({ config: this.config, plan, taskStates: this.state.tasks,
         attempts: this.state.attempts, request: { task, purpose: args.purpose } });
       if (problem !== null) return this.refuse([problem]);
       this.activity.setSchedule(schedule);
       await this.startChild(task, { kind: args.purpose, planPath, planHash, task, instruction: args.instruction });
       return this.waitForChild();
     }
     ```
  7. `startChild`:
     - Build `child` without `writerPaths`.
     - Replace `this.live.set(attempt.childRunId, child);` with `this.child = child;`.
     - Leave the rest of the function unchanged.
  8. `superviseChild` `finally`: replace `this.live.delete(child.attempt.childRunId);` with `this.child = null;`.
  9. Replace `waitForChildren` with `waitForChild`:
     ```ts
     /** Releases the parent's model until the child has settled or needs the parent's decision. */
     private async waitForChild(): Promise<OrchestratorToolOutcome> {
       await this.withModelReleased(async () => {
         while (this.child !== null && this.childFailure === null && !this.hasUnannouncedEscalation()) {
           await new Promise<void>((resolve) => {
             this.wakeWaiter = resolve;
           });
           this.signal.throwIfAborted();
         }
       });
       if (this.childFailure !== null) throw this.childFailure;
       const announcements = [...this.escalations.entries()].filter(([, entry]) => !entry.announced).map(([approvalId, entry]) => {
         entry.announced = true;
         return renderEscalation(approvalId, entry);
       });
       const reports = this.unreported.splice(0).map((entry) => {
         const report = renderAttemptForParent(entry.result, entry.diffstat);
         if (this.state.tasks.some((task) => task.taskId === entry.result.taskId && task.status === 'reviewing')) {
           this.awaitingReview.set(entry.result.taskId, report);
         }
         return report;
       });
       const running = this.child === null ? []
         : [`Still running: ${this.child.task.id} (${this.child.attempt.purpose} attempt ${this.child.attempt.attempt}).`];
       return { ok: true, output: [...announcements, ...reports, ...running, this.renderLedger()].join('\n\n') };
     }
     ```
     In `answerEscalation`, return `this.waitForChild()`.
  10. `runCheck`: `if (this.child !== null) return this.refuse(['A child is still running; run checks once it reports.']);`
  11. Add this helper beside `runTaskChecks`, then rewrite `runTaskChecks` and `measureChanges`:
      ```ts
      /** The running child of `task`; none is a caller bug. */
      private requireChild(task: OrchestratorTask): LiveChild {
        const { child } = this;
        if (child === null || child.task.id !== task.id) throw new Error(`Task '${task.id}' has no running child.`);
        return child;
      }

      /** Runs the child's task checks with its model released, so a check may itself call this server's models. */
      async runTaskChecks(task: OrchestratorTask): Promise<OrchestratorCheckResult[]> {
        const { session } = this.requireChild(task);
        if (session === null) throw new Error(`Task '${task.id}' has no running child session.`);
        session.park();
        try {
          return await this.runChecks(task.verification, task.id);
        } finally {
          await session.resume();
        }
      }

      /** The changes charged to the task's child since its baseline. */
      async measureChanges(task: OrchestratorTask): Promise<WorkspaceChanges> {
        return diffWorkspace(this.request.repoRoot, this.requireChild(task).baseline);
      }
      ```
  12. `review`: `if (this.child !== null) return { kind: 'reject', message: 'A child is still running; wait for its report before finishing.' };`
  13. Imports: drop `fitsBeside` and `describeSchedule`.

- [ ] **Step 9: Drop `diffWorkspace`'s `excluded` parameter.** In `src/orchestrator/workspace.ts`, use this signature, delete the `if (excluded.has(path)) continue;` line, and update the doc comment:
  ```ts
  /** Content changed since `baseline`; a pre-existing edit left untouched is not a change. */
  export async function diffWorkspace(repoRoot: string, baseline: WorkspaceSnapshot): Promise<WorkspaceChanges> {
  ```
  Then check `tests/process/orchestrator-workspace.test.ts` passes no third argument.

- [ ] **Step 10: Update the tool definitions.** In `src/repo-search/planner-protocol.ts`:
  ```ts
  dispatch: buildRepoToolDefinition({
    toolName: 'dispatch',
    description: 'Start a fresh subagent for one saved plan task, then wait. Returns its report once it finishes, or earlier when it needs your approval decision. One child runs at a time.',
    exampleArgs: { taskId: 'greeting', purpose: 'implementation', instruction: 'Create src/greeting.ts exporting greeting; keep src/app.ts unchanged.' },
  }),
  decide: buildRepoToolDefinition({
    toolName: 'decide',
    description: 'Answer a child approval that was escalated to you: approve, deny, or escalate it to the user. Then waits for the running child like dispatch.',
    exampleArgs: { approvalId: '00000000-0000-4000-8000-000000000000', decision: 'approve', reason: 'Runs the test file of the task.' },
  }),
  ```
  Search `src/repo-search` for any other `children` reference that formats dispatch arguments, and update it to the flat shape.

- [ ] **Step 11: Update the dashboard.**
  - `OrchestratorRunPanel.tsx` `SlotMeter` body:
    ```tsx
    <div className="orch-slots" aria-label="Scheduler slots">
      <span className="orch-slot-group" title={schedule.writerUsed ? 'writer slot in use' : 'writer slot free'}>
        writer <span className={schedule.writerUsed ? 'orch-slot writer used' : 'orch-slot writer'} />
      </span>
    </div>
    ```
  - `orchestrator.css`: delete the `.orch-slot.used { … }` rule (line 26). Keep `.orch-slot.writer.used`.
  - `OrchestratorTaskRow.tsx`:
    - Delete `const role = …`.
    - Change the `<small>` to `{[task.taskId, planned?.workerPresetId].filter((part) => part !== undefined).join(' · ')}`.
  - `orchestrator-view.ts` `describeWait`: delete the `model_slot` case.

- [ ] **Step 12: Run the tests to verify they pass.**
  - `node .\src\test-runner\run-tests.ts tests\orchestrator-scheduler.test.ts tests\contracts-orchestrator.test.ts tests\orchestrator-live-activity.test.ts tests\repo-search-orchestrator-tools.test.ts`
  - `node .\src\test-runner\run-tests.ts --process tests\process\orchestrator-run.e2e.test.ts tests\process\orchestrator-workspace.test.ts`
  - `npm run test:dashboard`
  - `npm run typecheck`
  - `npm run lint`
  - Expected: all PASS.

**Acceptance:**
- (0) `dispatch` accepts exactly `{taskId, purpose, instruction}`.
- (1) `ORCHESTRATOR_MAX_DISPATCH`, `OrchestratorModelSlotsSchema`, the `model_slot` wait, `fitsBeside`, `startQueuedChildren`, the `queued` field, `writerPaths`, and `diffWorkspace`'s `excluded` parameter no longer exist (`rg` finds none in `src`, `packages`, `dashboard/src`, or `tests`).
- (2) `run.ts` holds at most one child in `this.child`.
- (3) The dashboard shows the writer slot only, and no role label.

---

### Task 2: Workers are file-changing repo-agent presets

**Files:**
- Modify: `src/orchestrator/plan.ts`, `src/orchestrator/scheduler.ts`, `src/orchestrator/run.ts`, `src/orchestrator/workers.ts`, `src/orchestrator/prompts.ts`, `src/orchestrator/digest.ts`, `packages/contracts/src/orchestrator.ts`
- Test: `tests/helpers/orchestrator-plan.ts`, `tests/orchestrator-plan.test.ts`, `tests/orchestrator-verification.test.ts`, `tests/orchestrator-digest.test.ts`, `tests/orchestrator-prompts.test.ts`, `tests/process/orchestrator-run.e2e.test.ts`

- [ ] **Step 1: Make the test helper's default task a writer.** In `tests/helpers/orchestrator-plan.ts`, change only `workerPresetId: 'repo-search'` to `workerPresetId: 'repo-agent'`, and `writePaths: []` to `writePaths: ['README.md']`. Keep every other field.

- [ ] **Step 2: Rewrite the worker cases in `tests/orchestrator-plan.test.ts`.**
  - Replace `configWithCustomWorkers` with:
    ```ts
    function configWithCustomWorkers(): SiftConfig {
      const config = getDefaultServerConfig();
      const repoAgent = config.Presets.find((preset) => preset.id === 'repo-agent');
      assert.ok(repoAgent);
      config.Presets.push(
        { ...repoAgent, id: 'careful-writer', label: 'Careful Writer', builtin: false, deletable: true },
        { ...repoAgent, id: 'read-only-agent', label: 'Read-only Agent', builtin: false, deletable: true, allowedTools: ['read', 'grep'] },
      );
      return config;
    }
    ```
  - Replace the test `'a supported custom read-only worker preset is accepted'` with:
    ```ts
    test('a custom repo-agent worker preset that can change files is accepted', () => {
      const plan = makeOrchestratorPlan([makeOrchestratorTask({ workerPresetId: 'careful-writer' })]);
      assert.doesNotThrow(() => validateOrchestratorPlan(plan, configWithCustomWorkers(), createRepo()));
    });
    ```
  - In the rejection table:
    - Replace the `'a recursive orchestrator worker'` pattern with `/Task 'inspect' selects preset 'orchestrator' \(orchestrator\); workers must be repo-agent presets that can change files/u`.
    - Delete the `'write paths on a read-only worker'` and `'a read-only worker granting mutating tools'` rows.
    - Add these rows:
      ```ts
      ['a repo-search worker', [makeOrchestratorTask({ workerPresetId: 'repo-search' })],
        /Task 'inspect' selects preset 'repo-search' \(repo-search\); workers must be repo-agent presets that can change files/u],
      ['a repo-agent worker that cannot change files', [makeOrchestratorTask({ workerPresetId: 'read-only-agent' })],
        /Task 'inspect' selects preset 'read-only-agent' \(repo-agent\); workers must be repo-agent presets that can change files/u],
      ['a task with no write paths', [makeOrchestratorTask({ writePaths: [] })],
        /Task 'inspect' lists no writePaths; name the files it is expected to change/u],
      ```

- [ ] **Step 3: Update the render, digest, and prompt tests.**
  - `tests/orchestrator-verification.test.ts` render test: expect ``'- Worker: `repo-agent`'`` and ``'- Writes: `README.md`'`` in place of the `repo-search` and `none (read-only)` lines.
  - `tests/orchestrator-digest.test.ts`:
    - Rename the fixture task `survey` to `locate`, titled `'Locate the store'`, with `writePaths: ['src/store-index.ts']`; the store task's `dependsOn` becomes `['locate']`.
    - Update the expectations to `/- locate: Locate the store \(repo-agent; writes src\/store-index\.ts\)/u`, `…; after locate\)/u`, and the ledger string `'Task ledger:\n- locate: completed\n- store: reviewing'`.
  - `tests/orchestrator-prompts.test.ts`, first test: expect `` `- repo-agent (model ${model.id}, ${model.NumCtx} context tokens): ` `` in place of `(repo-agent, can modify files; model …`.

- [ ] **Step 4: Update the e2e file.** In `tests/process/orchestrator-run.e2e.test.ts`:
  - Delete `READ_TASK`, `SEARCH_REPORT`, `READER`, and `APP_EVIDENCE`. Add:
    ```ts
    const FAREWELL_TASK = makeOrchestratorTask({ ...WRITE_TASK, id: 'farewell', title: 'Add farewell', writePaths: ['src/farewell.ts'],
      steps: [{ instruction: 'Create src/farewell.ts exporting farewell.', expectedResult: 'The module exists.' }],
      acceptance: ['src/farewell.ts exports farewell.'] });
    const FAREWELL_EVIDENCE = { path: 'src/farewell.ts', line: 1, snippet: 'export const farewell' };
    /** A writer that creates the farewell module, approved by its own reviewer, and reports. */
    const FAREWELL_WRITER: MockPlannerResponseInput[] = [writeFile("export const farewell = 'bye';\n", 'src/farewell.ts'),
      APPROVING_VERDICT, AGENT_REPORT];
    ```
    Place `FAREWELL_WRITER` after `WRITER`.
  - In `review()`, use `const evidence = taskId === 'farewell' ? FAREWELL_EVIDENCE : GREETING_EVIDENCE;`.
  - Delete the test `'a read-only task is decided by its checks…'`.
  - `'code refuses an invalid plan or dispatch…'`:
    - Use `const second = FAREWELL_TASK;` and `const dependent = makeOrchestratorTask({ ...FAREWELL_TASK, id: 'goodbye', writePaths: ['src/goodbye.ts'], dependsOn: ['greeting'] });`.
    - Dispatch `{ taskId: 'goodbye' }` in place of `read-app`.
    - Assert `/Task 'goodbye' cannot start: its dependencies are not complete: greeting\./u`.
  - `'update_tasks revises the saved plan…'`:
    - `add: [FAREWELL_TASK]`.
    - Dispatch `{ taskId: 'farewell' }`.
    - Push `FAREWELL_WRITER`.
    - Blocked reason `'Stop after the farewell.'`.
    - Expect titles `[['greeting', 'Write the greeting module'], ['farewell', FAREWELL_TASK.title]]` and statuses `[['greeting', 'pending'], ['farewell', 'reviewing']]`.
  - `'update_tasks sent whole as a string…'`: `add: [FAREWELL_TASK]`, and expect ids `['greeting', 'farewell']`.
  - `'a run keeps the configuration it started with…'`:
    - `dependent = { ...FAREWELL_TASK, dependsOn: ['greeting'] }`.
    - Parent turns: `[savePlan(planOf([WRITE_TASK, dependent])), dispatch({ taskId: 'greeting' }), review('greeting', 'pass'), dispatch({ taskId: 'farewell' }), review('farewell', 'pass'), COMPLETE]`.
    - Children: `ESCALATING_WRITER, FAREWELL_WRITER`.
    - Mid-run change: `await context.harness.updateOperationPreset('repo-agent', { allowedTools: ['read', 'edit'] });`.
    - Final assertion: `assert.notDeepEqual(engine.requireRepoSearch('Create src/farewell.ts exporting farewell').allowedTools, ['read', 'edit'], 'the second writer keeps the tools the run started with');`.

- [ ] **Step 5: Run the tests to verify they fail.**
  - `node .\src\test-runner\run-tests.ts tests\orchestrator-plan.test.ts tests\orchestrator-digest.test.ts tests\orchestrator-prompts.test.ts`
  - Expected: FAIL (`repo-search` is still accepted; empty `writePaths` is accepted; the old worker line and digest text).

- [ ] **Step 6: Implement worker validation.** In `src/orchestrator/plan.ts`, replace `workerCanMutate` and `requireOrchestratorWorkerPreset` with:
  ```ts
  /** Workers are repo-agent presets that can change files; orchestrators never delegate to orchestrators. */
  export function isOrchestratorWorker(preset: SiftPreset): boolean {
    return preset.presetKind === 'repo-agent' && MUTATING_TOOLS.some((tool) => preset.allowedTools.includes(tool));
  }

  export function requireOrchestratorWorkerPreset(config: SiftConfig, task: Pick<OrchestratorTask, 'id' | 'workerPresetId'>): SiftPreset {
    const preset = PresetCatalog.fromPresets(config.Presets).requireById(task.workerPresetId);
    if (!isOrchestratorWorker(preset)) {
      throw new Error(`Task '${task.id}' selects preset '${preset.id}' (${preset.presetKind}); workers must be repo-agent presets that can change files.`);
    }
    return preset;
  }
  ```
  - In `validateOrchestratorPlan`, replace the `repo-search` write-path check with:
    ```ts
    requireOrchestratorWorkerPreset(config, task);
    if (task.writePaths.length === 0) throw new Error(`Task '${task.id}' lists no writePaths; name the files it is expected to change.`);
    ```
    and drop the unused `worker` binding.
  - In `renderOrchestratorPlan`, render writes as ``- Writes: ${task.writePaths.map((entry) => `\`${entry}\``).join(', ')}``.

- [ ] **Step 7: Make writePaths required.** In `packages/contracts/src/orchestrator.ts`, replace the `OrchestratorTaskSchema` declaration and its comment with:
  ```ts
  export const OrchestratorTaskSchema = OrchestratorTaskFieldsSchema;
  ```
  Keep `OrchestratorTaskFieldsSchema`, which `update_tasks` uses. Rename it only if lint flags the alias.

- [ ] **Step 8: Delete the read-only path everywhere.**
  - `scheduler.ts`: delete `isMutatingTask` and the `workerCanMutate` import.
  - `run.ts`:
    - Workers list: `config.Presets.filter(isOrchestratorWorker).map((preset) => ({ preset, model: workerModelPreset(config, preset) }))`, importing `isOrchestratorWorker` from `./plan.ts`.
    - `LiveChild`: drop `mutating`.
    - `startChild`: `const repository = await this.acquireRepository('exclusive');` and `const kind: HandoffKind = 'agent';`. Task 3 removes `kind`.
    - `settleChild`: replace the `if (child.mutating) … else this.settleReadOnlyTask(…)` lines with `this.setTaskStatus(child.task.id, 'reviewing');`.
    - Delete `settleReadOnlyTask`.
    - `recordReview`: delete the `isMutatingTask` refusal line.
    - Imports: drop `isMutatingTask`.
  - `workers.ts`: `taskKind: 'repo-agent',`.
  - `prompts.ts`:
    - `describeWorker` becomes:
      ```ts
      function describeWorker({ preset, model }: PlanWorker): string {
        return `- ${preset.id} (model ${model.id}, ${model.NumCtx} context tokens): ${preset.description}`;
      }
      ```
    - In `buildChildInstruction`: ``Expected to change: ${task.writePaths.join(', ')}``.
  - `digest.ts`: ``(${task.workerPresetId}; writes ${task.writePaths.join(', ')}${task.dependsOn.length === 0 ? '' : `; after ${task.dependsOn.join(', ')}`})``.

- [ ] **Step 9: Run the tests to verify they pass.**
  - `node .\src\test-runner\run-tests.ts tests\orchestrator-plan.test.ts tests\orchestrator-verification.test.ts tests\orchestrator-digest.test.ts tests\orchestrator-prompts.test.ts tests\orchestrator-scheduler.test.ts`
  - `node .\src\test-runner\run-tests.ts --process tests\process\orchestrator-run.e2e.test.ts`
  - `npm run typecheck`
  - `npm run lint`
  - Expected: PASS.

**Acceptance:**
- (0) A plan task on a `repo-search` worker, on a `repo-agent` preset without write, edit, or run, or with empty `writePaths`, is refused at `save_plan` or `update_tasks` with the messages above.
- (1) `settleReadOnlyTask`, `isMutatingTask`, `workerCanMutate`, and the `'shared'` access request in `run.ts` no longer exist.
- (2) The worker list in the orchestrator prompt contains only `repo-agent` presets.

---

### Task 3: One report shape and schema 89

**Files:**
- Modify: `packages/contracts/src/orchestrator.ts`, `src/orchestrator/handoff.ts`, `src/orchestrator/verification.ts`, `src/orchestrator/review.ts`, `src/orchestrator/submission.ts`, `src/orchestrator/prompts.ts`, `src/orchestrator/run.ts`, `src/cli/run-orchestrator.ts`, `src/preset-catalog.ts`, `src/state/runtime-db.ts`
- Create: `src/state/schema-upgrades/orchestrator-single-worker.ts`
- Test: create `tests/runtime-db-schema-orchestrator-single-worker.test.ts`; modify `tests/contracts-orchestrator.test.ts`, `tests/orchestrator-handoff.test.ts`, `tests/orchestrator-submission.test.ts`, `tests/orchestrator-prompts.test.ts`, `tests/runtime-db-schema-orchestrator-attempt-results.test.ts`, `tests/runtime-db-schema-orchestrator-search-reports.test.ts`, `tests/process/orchestrator-run.e2e.test.ts`

- [ ] **Step 1: Write the failing upgrade test.** Create `tests/runtime-db-schema-orchestrator-single-worker.test.ts`:

```ts
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import test from 'node:test';

import { z } from '../src/lib/zod.ts';
import { JsonObjectSchema } from '../src/lib/json-types.ts';
import { OrchestratorRunStore } from '../src/orchestrator/run-store.ts';
import { CURRENT_SCHEMA_VERSION, closeAllRuntimeDatabases, getRuntimeDatabase, getSchemaVersion } from '../src/state/runtime-db.ts';
import { writeConfig } from '../src/status-server/config-store.ts';
import { getDefaultServerConfig } from './helpers/mock-config.ts';
import { makeOrchestratorPlan, makeOrchestratorTask } from './helpers/orchestrator-plan.ts';
import { withRuntimeDatabaseConnection } from './helpers/runtime-database-probe.ts';
import { createManagedTempDir } from './helpers/temp-dirs.ts';

const OLD_DESCRIPTION = 'Prepares an implementation plan, delegates bounded steps to repo-agent and repo-search workers, and verifies each one.';
const SURVEY = makeOrchestratorTask({ id: 'survey', workerPresetId: 'repo-search', writePaths: [] });
const WRITE = makeOrchestratorTask({ id: 'greeting', workerPresetId: 'repo-agent', writePaths: ['src/greeting.ts'] });
const PresetsRowSchema = z.object({ presets_json: z.string() });

/** A schema-88 file: a settled survey with a search report, a settled writer with a kinded report, and the old description. */
function seedSchema88(description: string): { dbPath: string; runId: string } {
  const dbPath = path.join(createManagedTempDir('siftkit-single-worker-'), 'runtime.sqlite');
  writeConfig(dbPath, getDefaultServerConfig());
  const store = new OrchestratorRunStore(getRuntimeDatabase(dbPath));
  const created = store.create({ submissionId: randomUUID(), sessionId: null, repoRoot: createManagedTempDir('siftkit-single-worker-repo-'),
    presetId: 'orchestrator', approval: 'off', task: 'Add greeting.', planPath: null });
  const state = store.savePlan(created.runId, created.revision, makeOrchestratorPlan([SURVEY, WRITE]), 'docs/plan.md', 'hash');
  const survey = store.reserveAttempt(state.runId, state.revision, 'survey',
    { kind: 'implementation', planPath: 'docs/plan.md', planHash: 'hash', task: SURVEY, instruction: 'Find it.' });
  const write = store.reserveAttempt(state.runId, store.read(state.runId).revision, 'greeting',
    { kind: 'implementation', planPath: 'docs/plan.md', planHash: 'hash', task: WRITE, instruction: 'Write it.' });
  closeAllRuntimeDatabases();
  withRuntimeDatabaseConnection(dbPath, (database) => {
    const settle = database.prepare('UPDATE orchestrator_attempts SET attempt_json = ? WHERE child_run_id = ?');
    const seeded = [
      [survey, { kind: 'search', unknowns: [], findings: [{ claim: 'greet() at src/greeting.ts:1', evidence: [{ path: 'src/greeting.ts', line: 1 }] }] }],
      [write, { kind: 'agent', status: 'completed', deviations: [{ what: 'Kept the old export.', why: 'Callers use it.' }] }],
    ] as const;
    for (const [attempt, report] of seeded) {
      settle.run(JSON.stringify({ ...attempt, status: 'settled', result: {
        taskId: attempt.taskId, purpose: 'implementation', attempt: 1, childRunId: attempt.childRunId, workerStatus: 'completed',
        workerOutput: 'done', report, outcome: 'passed', submissions: 1, passed: true, checks: [], findings: [],
        changedPaths: attempt.work.task.writePaths, changeDigest: 'd',
      } }), attempt.childRunId);
    }
    const catalog = z.array(JsonObjectSchema).parse(JSON.parse(PresetsRowSchema.parse(
      database.prepare('SELECT presets_json FROM app_config WHERE id = 1').get()).presets_json));
    const stored = catalog.map((preset) => (preset.id === 'orchestrator' ? { ...preset, description } : preset));
    database.prepare('UPDATE app_config SET presets_json = ? WHERE id = 1').run(JSON.stringify(stored));
    database.exec('UPDATE runtime_schema SET version = 88 WHERE id = 1');
  });
  return { dbPath, runId: state.runId };
}

function storedDescription(dbPath: string): unknown {
  const database = getRuntimeDatabase(dbPath);
  const catalog = z.array(JsonObjectSchema).parse(JSON.parse(PresetsRowSchema.parse(
    database.prepare('SELECT presets_json FROM app_config WHERE id = 1').get()).presets_json));
  return catalog.find((preset) => preset.id === 'orchestrator')?.description;
}

test('the 88 to 89 upgrade drops search reports, strips the report kind, and renews the stock orchestrator description', (t) => {
  t.after(closeAllRuntimeDatabases);
  const { dbPath, runId } = seedSchema88(OLD_DESCRIPTION);
  const database = getRuntimeDatabase(dbPath);
  assert.equal(getSchemaVersion(database), CURRENT_SCHEMA_VERSION);
  const [survey, write] = new OrchestratorRunStore(database).read(runId).attempts.map((attempt) => attempt.result?.report);
  assert.equal(survey, null, 'a survey report has no shape left; the attempt keeps its outcome');
  assert.deepEqual(write, { status: 'completed', deviations: [{ what: 'Kept the old export.', why: 'Callers use it.' }] });
  assert.equal(storedDescription(dbPath), getDefaultServerConfig().Presets.find((preset) => preset.id === 'orchestrator')?.description);
});

test('the 88 to 89 upgrade keeps an orchestrator description the user edited', (t) => {
  t.after(closeAllRuntimeDatabases);
  const { dbPath } = seedSchema88('My own orchestrator.');
  assert.equal(storedDescription(dbPath), 'My own orchestrator.');
});
```

- [ ] **Step 2: Update the existing tests to the single report shape.**
  - `tests/runtime-db-schema-orchestrator-attempt-results.test.ts`: in its final assertions, the upgraded reports have no `kind`: `{ status: 'completed', deviations: [...] }` and `{ status: 'incomplete', deviations: [] }`. Retitle it `'the 84 to 89 upgrades drop write scope and reduce agent reports to a status and deviations'`.
  - `tests/runtime-db-schema-orchestrator-search-reports.test.ts`:
    - Expect `survey === null` and `write` to deep-equal `{ status: 'completed', deviations: [] }`.
    - Retitle it `'search reports seeded at 85 end as no report after the upgrade chain'`.
    - Keep the `AGENT_REPORT` constant only as the seeded value.
  - `tests/contracts-orchestrator.test.ts`:
    - In the report test, drop `kind` from the agent report.
    - Delete the `finding` and `search` cases.
    - Add `assert.equal(OrchestratorHandoffReportSchema.safeParse({ kind: 'agent', status: 'completed', deviations: [] }).success, false);`.
  - `tests/orchestrator-handoff.test.ts`:
    - Drop `kind: 'agent'` from report fixtures.
    - Delete the test `'a search report renders only its findings and unknowns…'`.
  - `tests/orchestrator-submission.test.ts`:
    - `REPORT: OrchestratorHandoffReport = { status: 'completed', deviations: [] }`.
    - The `submission()` helper becomes `(host: SubmissionHost, task: OrchestratorTask = TASK) => new WorkerSubmission(host, task)`.
    - Delete the two search-report tests (the ones built on `makeOrchestratorTask({ id: 'survey' })`).
    - Any JSON report literal drops `kind`.
  - `tests/orchestrator-prompts.test.ts`:
    - Remove `kind: 'agent'` from every `buildChildInstruction` call.
    - Replace the last test with:
      ```ts
      test('each child ends with the report template, which names the report schema fields', () => {
        const instruction = buildChildInstruction({ work: work('implementation'), attempt: 1, scratchPath: 's', preexistingDirtyPaths: [] });
        assert.match(instruction, /Use TDD where behavior changes\./u);
        assert.deepEqual(Object.keys(JsonObjectSchema.parse(parseJsonValueText(reportTemplate(instruction)))),
          Object.keys(OrchestratorHandoffReportSchema.shape));
      });
      ```
  - `tests/process/orchestrator-run.e2e.test.ts`: `AGENT_REPORT` content becomes `JSON.stringify({ status: 'completed', deviations: [] })`, and any other inline report drops `kind`.

- [ ] **Step 3: Run the tests to verify they fail.**
  - `node .\src\test-runner\run-tests.ts tests\runtime-db-schema-orchestrator-single-worker.test.ts tests\contracts-orchestrator.test.ts tests\orchestrator-submission.test.ts`
  - Expected: FAIL (schema still 88; report still kinded).

- [ ] **Step 4: Change the contracts.** In `packages/contracts/src/orchestrator.ts`:
  - Delete `OrchestratorCitationSchema` and its type, `OrchestratorAgentReportSchema` and its type, and `OrchestratorSearchReportSchema` and its type.
  - Replace the union with:
    ```ts
    /** A worker's outcome: whether it finished, and where it departed from the plan and why. The host attaches the measured facts. */
    export const OrchestratorHandoffReportSchema = z.object({
      status: z.enum(['completed', 'incomplete']),
      deviations: z.array(z.object({ what: z.string().trim().min(1), why: z.string().trim().min(1) }).strict()),
    }).strict();
    export type OrchestratorHandoffReport = z.infer<typeof OrchestratorHandoffReportSchema>;
    ```
  - Keep `ReportIndexSchema`; `OrchestratorReviewRecordSchema` still uses it.

- [ ] **Step 5: Move `findCitationProblem` into `src/orchestrator/verification.ts`.** Add it below `findEvidenceProblem`; `statSync` joins the `node:fs` import, and the type import adds `OrchestratorReviewFinding`.
  ```ts
  /** Why a cited location does not exist: a missing file or a line past its end. */
  export function findCitationProblem(repoRoot: string, citation: Pick<OrchestratorReviewFinding, 'path' | 'line'>): string | null {
    const resolved = resolveRepoScopedPath(repoRoot, citation.path);
    if (resolved === null || !existsSync(resolved.absolutePath) || !statSync(resolved.absolutePath).isFile()) {
      return `${citation.path} is not a file in the repository`;
    }
    const lineCount = readFileSync(resolved.absolutePath, 'utf8').split(/\r?\n/u).length;
    return citation.line > lineCount ? `${citation.path}:${citation.line} is past the end of the file` : null;
  }
  ```
  In `review.ts`, import it from `./verification.ts` alongside `findEvidenceProblem`.

- [ ] **Step 6: Simplify `src/orchestrator/handoff.ts`.**
  - Delete `HandoffKind`, `REPORT_TEMPLATES`, `findCitationProblem`, and `findReportProblem`. Keep `describeOverrun`, `list`, `renderChanges`, `isCommandCheck`, and `renderCheck`.
  - The file's public functions become:
    ```ts
    export type ParsedHandoff = { ok: true; report: OrchestratorHandoffReport } | { ok: false; reason: 'length' | 'shape'; problem: string };

    const REPORT_TEMPLATE = JSON.stringify({
      status: 'completed | incomplete',
      deviations: [{ what: 'a step skipped or done differently, a file changed beyond the expected ones, or work left undone', why: 'the reason' }],
    });

    /** The closing lines of a child's assignment and of every rejected shape: the limits, then the template itself. */
    export function renderReportInstruction(): string {
      return [`Finish with only this JSON report, no prose, under ${HANDOFF_REPORT_MAX_CHARS} characters:`, REPORT_TEMPLATE].join('\n');
    }

    /** The child's final answer as its report: within size, the report's shape, and an incomplete status explained. */
    export function parseHandoffReport(answer: string, enforceLength: boolean): ParsedHandoff {
      if (enforceLength && answer.length > HANDOFF_REPORT_MAX_CHARS) return { ok: false, reason: 'length', problem: describeOverrun(answer) };
      let report: OrchestratorHandoffReport;
      try {
        report = ModelJson.parseObject(answer, OrchestratorHandoffReportSchema, 'handoff report');
      } catch (error) {
        return { ok: false, reason: 'shape', problem: toError(error).message };
      }
      return report.status === 'incomplete' && report.deviations.length === 0
        ? { ok: false, reason: 'shape', problem: 'An incomplete report names what was left undone in deviations.' }
        : { ok: true, report };
    }
    ```
  - In `renderAttemptForParent`:
    - Delete `showChanges` and its comment, and always include `renderChanges(diffstat)`.
    - `renderReport(report)` becomes:
      ```ts
      function renderReport(report: OrchestratorHandoffReport): string[] {
        return [`Status: ${report.status}`, ...(report.deviations.length === 0 ? ['Deviations: none.']
          : list('Deviations', report.deviations.map((deviation) => `${deviation.what} Why: ${deviation.why}`)))];
      }
      ```
  - Remove the unused imports: `existsSync`, `readFileSync`, `statSync`, `resolveRepoScopedPath`, `OrchestratorCitation`, and the two old report schemas. Import `OrchestratorHandoffReportSchema`.

- [ ] **Step 7: Simplify `src/orchestrator/submission.ts`.**
  - The constructor becomes `constructor(host: SubmissionHost, task: OrchestratorTask)`.
  - Delete the `kind` and `repoRoot` fields.
  - Call `parseHandoffReport(answer, enforceLength)` and `renderReportInstruction()`.
  - Drop the `HandoffKind` import.

- [ ] **Step 8: Drop the report kind from the prompt and run code.**
  - `prompts.ts` `buildChildInstruction`:
    - Delete the `kind` input and the `HandoffKind` import.
    - Replace the `input.kind === 'agent' ? … : …` element with `'Use TDD where behavior changes. Do not commit, do not create a plan, and do not work on any other task.'`.
    - End with `renderReportInstruction()`.
  - `run.ts` `startChild`:
    - Delete `const kind…`.
    - `submission: new WorkerSubmission(this, task)`.
    - `buildChildInstruction({ work, attempt: attempt.attempt, scratchPath: orchestratorScratchDir(this.runId), preexistingDirtyPaths: [...baseline.keys()] })`.
    - Drop the `HandoffKind` import.
  - `src/cli/run-orchestrator.ts`: change the comment to `/** The handoff report of the task's latest passing attempt. */`.

- [ ] **Step 9: Change the built-in description.** In `src/preset-catalog.ts`, set the orchestrator `description` to:
  `'Plans from its own reading of the repository, delegates each task to a repo-agent worker, and verifies and reviews every one.'`

- [ ] **Step 10: Write upgrade 89.** Create `src/state/schema-upgrades/orchestrator-single-worker.ts`:

```ts
import { parseJsonValueText } from '../../lib/json.ts';
import { JsonObjectSchema, JsonValueSchema } from '../../lib/json-types.ts';
import { z } from '../../lib/zod.ts';
import type { RuntimeDatabase } from '../database-handle.ts';

const AttemptRowsSchema = z.array(z.object({ child_run_id: z.string(), attempt_json: z.string() }));
const CatalogRowsSchema = z.array(z.object({ id: z.number().int(), presets_json: z.string() }));
// Pins only what this step reads from schema-88 attempts and catalogs.
const Stored88AttemptSchema = z.object({
  result: z.object({
    report: z.object({ kind: z.enum(['agent', 'search']) }).catchall(JsonValueSchema).nullable(),
  }).catchall(JsonValueSchema).nullable(),
}).catchall(JsonValueSchema);
const Stored88CatalogSchema = z.array(z.object({ id: z.string(), description: z.string() }).catchall(JsonValueSchema));

// Literals, so later catalog edits cannot change what this upgrade matches or writes.
const ORCHESTRATOR_DESCRIPTION_88 = 'Prepares an implementation plan, delegates bounded steps to repo-agent and repo-search workers, and verifies each one.';
const ORCHESTRATOR_DESCRIPTION_89 = 'Plans from its own reading of the repository, delegates each task to a repo-agent worker, and verifies and reviews every one.';

/** Schema 88 -> 89: one worker kind. Reports lose `kind`; a survey's search report, which no longer exists, becomes null. */
export function upgradeOrchestratorSingleWorker(database: RuntimeDatabase): void {
  const updateAttempt = database.prepare('UPDATE orchestrator_attempts SET attempt_json = ? WHERE child_run_id = ?');
  for (const row of AttemptRowsSchema.parse(database.prepare('SELECT child_run_id, attempt_json FROM orchestrator_attempts').all())) {
    const attempt = Stored88AttemptSchema.parse(JsonObjectSchema.parse(parseJsonValueText(row.attempt_json)));
    const report = attempt.result?.report ?? null;
    if (attempt.result === null || report === null) continue;
    const { kind, ...rest } = report;
    updateAttempt.run(JSON.stringify({ ...attempt, result: { ...attempt.result, report: kind === 'agent' ? rest : null } }), row.child_run_id);
  }
  const updateCatalog = database.prepare('UPDATE app_config SET presets_json = ? WHERE id = ?');
  for (const row of CatalogRowsSchema.parse(database.prepare('SELECT id, presets_json FROM app_config').all())) {
    const catalog = Stored88CatalogSchema.parse(parseJsonValueText(row.presets_json));
    const updated = catalog.map((preset) => (preset.id === 'orchestrator' && preset.description === ORCHESTRATOR_DESCRIPTION_88
      ? { ...preset, description: ORCHESTRATOR_DESCRIPTION_89 } : preset));
    updateCatalog.run(JSON.stringify(updated), row.id);
  }
}
```

In `src/state/runtime-db.ts`:
- Import `upgradeOrchestratorSingleWorker`.
- Append `{ from: 88, apply: upgradeOrchestratorSingleWorker },` to `SCHEMA_UPGRADES`.
- Set `CURRENT_SCHEMA_VERSION = 89`.
- Search `tests/` for a hard-coded `88` that means the current version, such as a schema-version assertion, and update it to `89`.

- [ ] **Step 11: Run the tests to verify they pass.**
  - `node .\src\test-runner\run-tests.ts tests\runtime-db-schema-orchestrator-single-worker.test.ts tests\runtime-db-schema-orchestrator-attempt-results.test.ts tests\runtime-db-schema-orchestrator-search-reports.test.ts tests\runtime-db-schema-orchestrator.test.ts tests\contracts-orchestrator.test.ts tests\orchestrator-handoff.test.ts tests\orchestrator-submission.test.ts tests\orchestrator-prompts.test.ts tests\orchestrator-review.test.ts tests\orchestrator-verification.test.ts`
  - `node .\src\test-runner\run-tests.ts --process tests\process\orchestrator-run.e2e.test.ts`
  - `npm run typecheck`
  - `npm run lint`
  - Expected: PASS.

**Acceptance:**
- (0) `OrchestratorHandoffReportSchema` is `{status, deviations}` and rejects a `kind` field.
- (1) `HandoffKind`, `OrchestratorAgentReportSchema`, `OrchestratorSearchReportSchema`, and `OrchestratorCitationSchema` no longer exist anywhere.
- (2) Upgrading a schema-88 DB nulls search reports, strips `kind` from agent reports, and renews only the stock orchestrator description.
- (3) `CURRENT_SCHEMA_VERSION` is 89.

---

### Task 4: Repository gate without owner overlap

Only an orchestrator reader beside its own writer used owner-scoped overlap. Without readers, the parent and its child never hold the gate together, because `run_check` is refused while a child runs.

**Files:**
- Modify: `src/status-server/orchestrator-runs.ts`, `src/orchestrator/run.ts`, `src/status-server/repo-agent-sessions.ts`
- Test: `tests/orchestrator-runs.test.ts`, `tests/repo-agent-sessions.test.ts`

- [ ] **Step 1: Update the gate tests.** In `tests/orchestrator-runs.test.ts`:
  - Delete the test `'an owned exclusive lease overlaps only its own run\'s readers…'`.
  - In the remaining gate tests, drop the owner argument: `gate.acquire(repo, 'shared', signal)`.
  - Add:
    ```ts
    test('two exclusive leases never overlap', async () => {
      const repo = createManagedTempDir('siftkit-gate-exclusive-');
      const gate = new RepositoryGate();
      const signal = new AbortController().signal;
      const first = await gate.acquire(repo, 'exclusive', signal);
      const second = gate.acquire(repo, 'exclusive', signal);
      assert.equal(await settle(second), 'pending');
      first.release();
      (await second).release();
    });
    ```
  - In `tests/repo-agent-sessions.test.ts`, drop the `null` owner argument from both `repositoryGate.acquire` calls.

- [ ] **Step 2: Run the tests to verify they fail.**
  - `node .\src\test-runner\run-tests.ts tests\orchestrator-runs.test.ts`
  - Expected: FAIL (typecheck: wrong argument count).

- [ ] **Step 3: Implement.** In `src/status-server/orchestrator-runs.ts`:
  - Replace `RepositoryClaim`, `RepositoryWaiter`, `RepositoryEntry`, `sameOwner`, and `isCompatible` with the code below. A holder is a fresh object per grant, so release splices exactly its own entry.
    ```ts
    /** One granted lease; a fresh object per grant, so release removes exactly this one. */
    type RepositoryHolder = { access: RepositoryAccess };
    type RepositoryWaiter = RepositoryHolder & { grant(): void };
    type RepositoryEntry = { holders: RepositoryHolder[]; waiters: RepositoryWaiter[] };

    function isCompatible(next: RepositoryAccess, holders: readonly RepositoryHolder[]): boolean {
      return holders.length === 0 || (next === 'shared' && holders.every((holder) => holder.access === 'shared'));
    }
    ```
  - Fix the comments:
    - `RepositoryAccess` comment: `/** Shared readers overlap; an exclusive holder overlaps nothing. */`.
    - Class comment: `/** Server-owned repository ownership: shared readers overlap, and an exclusive holder overlaps nothing. Waiters are FIFO, so no later request starts ahead of one queued. */`.
  - `acquire(repoRoot: string, access: RepositoryAccess, abortSignal: AbortSignal)`:
    - Replace `const claim: RepositoryClaim = { access, owner };` with `const holder: RepositoryHolder = { access };`.
    - The waiter is `{ access, grant: () => { … } }`.
    - Inside `grant`, push and splice `holder` where the code used `claim`.
  - `drain`: `if (!isCompatible(next.access, entry.holders)) break;`.
  - `run.ts` `acquireRepository`: `this.ctx.orchestratorRuns.repositoryGate.acquire(this.request.repoRoot, access, this.signal)`. Since `access` is always `'exclusive'`, also simplify to `private acquireRepository(): Promise<RepositoryLease>` with that constant, update its two call sites, and drop the `RepositoryAccess` import.
  - `repo-agent-sessions.ts:406`: `this.repository.gate.acquire(this.repository.repoRoot, this.repository.access, this.executionSignal)`.

- [ ] **Step 4: Run the tests to verify they pass.**
  - `node .\src\test-runner\run-tests.ts tests\orchestrator-runs.test.ts tests\repo-agent-sessions.test.ts`
  - `node .\src\test-runner\run-tests.ts --process tests\process\orchestrator-run.e2e.test.ts`
  - `npm run typecheck`
  - `npm run lint`
  - Expected: PASS.

**Acceptance:**
- (0) `RepositoryGate.acquire` takes `(repoRoot, access, abortSignal)`.
- (1) No `owner` or `sameOwner` remains.
- (2) Shared and exclusive semantics are otherwise unchanged.

---

### Task 5: The orchestrator explores and verifies on its own

**Files:**
- Modify: `src/orchestrator/prompts.ts`, `src/repo-search/prompts.ts`
- Test: `tests/orchestrator-prompts.test.ts`, plus any test asserting the orchestrator system-prompt line (search `tests/` for `subagents change the repository through dispatch`)

- [ ] **Step 1: Write the failing prompt test.** In `tests/orchestrator-prompts.test.ts`, replace the test `'the orchestrator prompt delegates code exploration to survey tasks…'` with:

```ts
test('the orchestrator explores the code and runs checks itself, and plans only implementation tasks', () => {
  const prompt = buildOrchestratorPrompt(brief());
  for (const rule of ['Explore the code yourself with read, grep, find, ls, and git', 'Use run_check',
    'baseline', 'reproduce', 'never to change files', 'add the rest with update_tasks', 'Review every reported task',
    'writePaths are guidance, not a limit', 'line counts, not the code', 'Dispatch one task at a time']) {
    assert.ok(prompt.includes(rule), rule);
  }
  for (const gone of ['survey', 'Survey', 'read-only', 'Leave code exploration to subagents', 'never to read files or search code']) {
    assert.equal(prompt.includes(gone), false, gone);
  }
});
```

In the test `'the orchestrator adds implementation tasks in small batches in dependency order'`, change the asserted string to `'at most 4 tasks per save_plan or update_tasks call'`.

- [ ] **Step 2: Run the test to verify it fails.**
  - `node .\src\test-runner\run-tests.ts tests\orchestrator-prompts.test.ts`
  - Expected: FAIL (the survey rules are present).

- [ ] **Step 3: Replace the "How to work" section.** In `buildOrchestratorPrompt`, replace everything from `'How to work:'` through the `run_check` line (old lines 61–104) with:

```ts
    'How to work:',
    '1. Read the requirements: the task and any spec or plan it names. Explore the code yourself with read, grep, find, ls, and git',
    '   until you can name every file each change touches and the tests that cover it. Read narrowly: grep for symbols and read',
    '   line ranges, not whole directories; your context also has to hold every review.',
    '   Use run_check to establish a baseline of the test suites the work will touch, and to reproduce a reported bug, before',
    '   planning; a suite that already fails is a fact for the plan, not a task\'s fault.',
    '2. Call save_plan with the implementation tasks in dependency order, at most 4 tasks per save_plan or update_tasks call,',
    '   and add the rest with update_tasks, so a malformed call costs little to resend. Planning rules:',
    '   - One task is one concern a worker finishes within about half its context: a handful of files (at most about 6 write',
    '     paths) and their tests. Split anything larger.',
    '   - Every task changes files and lists the paths it expects to change in writePaths, tests included.',
    '   - Steps are test-first: write the failing test, then the implementation.',
    '   - A task\'s verification has command checks for every test suite its change can affect, not only its new tests,',
    '     plus the project\'s typecheck and lint commands, using the exact commands the request names, flags included.',
    '   - finalVerification always includes the project\'s typecheck and lint commands and every relevant test suite.',
    '   - dependsOn names every task whose output or changes a task needs.',
    '3. Dispatch one task at a time, with its dependencies complete. Every child starts fresh and knows only its instruction:',
    '   include what it must change, the files and lines you found, what earlier tasks changed that matters to it, and the',
    `   pitfalls you already know. dispatch waits until the child reports. Code runs a child's checks each time it finishes;`,
    `   it fixes its own failures up to ${ORCHESTRATOR_MAX_RESUBMITS} times before its report reaches you.`,
    '4. Review every reported task with record_review. A report gives the child\'s status, where it departed from the plan,',
    '   the gate\'s last check results, and what changed as line counts, not the code: read the changed code yourself, and use',
    '   run_check for any test or command the review needs.',
    '   Judge each acceptance criterion by index with exact code evidence (path, line, and the code at that line). Record a',
    '   finding for every real defect: a missed requirement, an incomplete refactor, a special-case patch, a leftover shim or',
    '   parallel path, duplicated logic, unsafe type or IO handling, a missing test, a weakened or silenced test.',
    '   Judge every deviation and host finding against that list: a change to a test outside the task (an allowlist or',
    '   skip entry, a loosened assertion, an environment patch) is a finding unless the plan asked for it. Ignore style',
    '   preferences. A task whose checks failed cannot pass.',
    `5. After a failed review, dispatch a fix (repairs the current changes) or a fresh implementation; each task allows ${ORCHESTRATOR_MAX_ATTEMPTS}`,
    '   of each. A completed task can also take a fix later. To split, reorder, add, or widen work, call update_tasks with',
    '   only the fields that change; tasks that already ran keep their ids. writePaths are guidance, not a limit: judge',
    '   changes to other files on their merits, and move work the plan gives a later task with update_tasks.',
    '6. When every task is complete, finish with only {"status":"completed","summary":"what was done"}. Code then runs the',
    `   final verification and returns failures for you to fix (at most ${ORCHESTRATOR_MAX_FINISH_ATTEMPTS} finishes). If the work cannot be`,
    '   completed, finish with only {"status":"blocked","reason":"why"}.',
    'Use run_check to run tests, typecheck, lint, or a command that reproduces a problem; never to change files, install',
    'packages, or commit: that is a child\'s work. Read and search code with your read tools, not run_check.',
```

Also change the opening line to:
`'You run this orchestrator job from start to finish in this one conversation. You read the code, plan, verify, and review;'`
`'repo-agent subagents make every change. Everything you learn stays with you across tasks: use it in later instructions.'`

- [ ] **Step 4: Update the system prompt.** In `src/repo-search/prompts.ts` `buildOrchestratorSystemPrompt`, replace the "You never edit files…" line with:
`'You never edit files yourself; repo-agent subagents change the repository through dispatch. Read code with your read tools and verify with run_check.'`
Update any test that asserts the old line.

- [ ] **Step 5: Run the tests to verify they pass.**
  - `node .\src\test-runner\run-tests.ts tests\orchestrator-prompts.test.ts tests\repo-search-orchestrator-tools.test.ts`
  - Expected: PASS.

**Acceptance:**
- (0) The orchestrator prompt contains no survey, read-only, or "leave exploration to subagents" text.
- (1) It tells the orchestrator to explore with read, grep, find, ls, and git, and to use `run_check` for baselines, reproductions, and review checks, never for changes.
- (2) It tells the orchestrator to dispatch one task at a time.

---

### Task 6: Whole-tree verification (primary agent)

- [ ] `rg -n "repo-search|survey|read-only|search report|SearchReport|HandoffKind|MAX_DISPATCH|model_slot|fitsBeside|writerPaths|settleReadOnly|isMutatingTask|workerCanMutate|OrchestratorCitation" src/orchestrator packages/contracts/src/orchestrator.ts dashboard/src/orchestrator-view.ts dashboard/src/components/Orchestrator*.tsx`. Expected: no hits, apart from historic literals inside `src/state/schema-upgrades/`.
- [ ] `npm run typecheck`, `npm run lint`, and `npm test`, with output routed through `siftkit summary` per the user's large-output rules. Then `npm run test:dashboard` and `npm run test:process`. Expected: all pass.
- [ ] Back up `.siftkit/runtime.sqlite`, then start the stable server (`npm run start:status:stable`) and confirm that the upgrade to schema 89 succeeds against the real DB and that the old runs still open in the dashboard.
- [ ] Delete scratch files.

## Out of scope

- The `run_check` timeout and output tail (4,000 characters) are unchanged.
- The orchestrator's context budget and compaction digest are unchanged, apart from its wording. Self-exploration costs parent context. Watch the first live run's prompt tokens before tuning anything.
