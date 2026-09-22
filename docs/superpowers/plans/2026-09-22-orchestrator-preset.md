# Orchestrator Preset Implementation Plan

> **For agentic workers:** Use `superpowers:executing-plans` when implementation is separately requested. Complete the model-routing plan first, then O1–O8 sequentially with TDD. Do not invoke SiftKit, create worktrees, or commit.

**Goal:** Add an orchestrator that accepts a task or plan, prepares an executable Markdown plan, delegates bounded work, verifies each task, and stops after two unsuccessful attempts.

**Architecture:** A server-owned state machine controls plan validation, dependency scheduling, child attempts, verification, cleanup, and durable events. Parent inference phases and workers use the model admission layer from M1–M7. The parent never holds a model lease while waiting for a child.

**Tech stack:** TypeScript, Zod, SQLite, existing repo-search/repo-agent engine and approvals, Node `node:test`, React, existing SSE/chat recovery.

**Spec:** [Shared design, section C](../specs/2026-09-22-preset-model-routing-and-orchestration-design.md).

**Prerequisite:** [Preset model routing plan](2026-09-22-preset-model-routing.md), including its integrated tests.

## Global constraints

- TypeScript throughout; parse IO with Zod and derive types with `z.infer`.
- No `any`, type assertions, non-null assertions, namespace imports, or schema-duplicating types.
- No worktrees; preserve unrelated changes; no commits without a separate request.
- Explicit versioned migrations; no runtime compatibility readers or silent invalid-reference fallback.
- Do not invoke SiftKit to execute this implementation plan. This is a planning-only request.
- `maxSubagents` defaults to 1 and counts dispatched/queued/running/approval-paused children.
- Modifications require exclusive repository ownership; independent read-only children can overlap.
- Each task has at most 2 attempts; approval continuation is not a new attempt.
- The parent validates/coordinates. Worker planning, recursive orchestration, and shell self-delegation are prohibited.

## Review focus

1. One inference slot and parent/child on different models: no model lease held across a child wait — O3/O4/O8.
2. Worker says completed but tests fail: retry with evidence, then stop after attempt 2 — O4/O5.
3. Reattach, duplicate submit, approval reply, or server restart dispatches work twice — O2/O6/O7/O8.
4. A supposedly read-only task mutates, or cleanup escapes scratch: fail visibly and preserve the initial dirty baseline — O3/O5.
5. The supplied plan is obsolete, ambiguous, cyclic, or edited after validation: validate before dispatch without resetting attempt budgets — O1/O3/O4.

## Modules and boundaries

| File | Responsibility |
|---|---|
| `packages/contracts/src/orchestrator.ts` | IO schemas and inferred request/plan/task/state/event/result types |
| `src/orchestrator/plan.ts` | Deterministic plan validation and Markdown rendering |
| `src/orchestrator/prompts.ts` | Parent planning/review prompts and bounded worker instructions |
| `src/orchestrator/phase-runner.ts` | One admitted parent inference phase; typed result parsing |
| `src/orchestrator/run-store.ts` | Atomic state/attempt reservations and durable event sequence |
| `src/orchestrator/workers.ts` | Server-owned child startup, completion, abort, approval forwarding |
| `src/orchestrator/scheduler.ts` | Dependencies, child cap, exclusive mutating task ownership |
| `src/orchestrator/verification.ts` | Check executed verification evidence and acceptance review |
| `src/orchestrator/workspace.ts` | Initial dirty baseline, change evidence, bounded scratch cleanup |
| `src/orchestrator/run.ts` | State machine, two-attempt policy, event-driven coordination |
| `src/status-server/orchestrator-runs.ts` | Live parent registry and server shutdown/recovery integration |
| `src/status-server/routes/orchestrator.ts` | Start/status/events/decide/abort HTTP endpoints |
| `src/cli/orchestrator-args.ts`, `src/cli/run-orchestrator.ts` | CLI parsing and native lifecycle client |
| `dashboard/src/tabs/OrchestratorRunPanel.tsx` | Parent phase/tasks/attempts/child links inside chat |

Use classes only for the run/store/phase/worker objects that own shared state or explicit dependencies. Keep schema, prompt, plan, selection, and evidence comparison functions ordinary functions. Reuse existing SSE, approvals, JSON/model parsing, repository tools, and child session persistence; do not create another general agent framework.

### O1: Define executable plan contracts and the orchestrator preset

**Files**

- Create `packages/contracts/src/orchestrator.ts`, `src/orchestrator/plan.ts`, `src/orchestrator/prompts.ts`.
- Modify `packages/contracts/src/index.ts`, `config.ts`, `operation-types.ts`.
- Modify `src/preset-catalog.ts`, `src/presets.ts`, `dashboard/src/preset-editor.ts`, `settings-draft-editor.ts`.
- Create `src/state/schema-upgrades/orchestrator.ts`; modify `src/state/runtime-db.ts`.
- Create `tests/contracts-orchestrator.test.ts`, `tests/orchestrator-plan.test.ts`, `tests/helpers/orchestrator-plan.ts`, `tests/runtime-db-schema-orchestrator.test.ts`.
- Update `tests/preset-catalog.test.ts`, `tests/contracts-config.test.ts`, and preset-kind fixtures.

**Interfaces**

Use these canonical schemas; export only their inferred types. Use `ApprovalModeSchema` from the existing contracts. `OrchestratorStartRequestSchema` includes an idempotency/submission UUID, `repoRoot`, `presetId`, approval mode, optional task text, and optional plan path; require at least one of task/plan.

```typescript
export const ORCHESTRATOR_MAX_ATTEMPTS = 2;

export const OrchestratorVerificationCheckSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('command'), command: z.string().trim().min(1),
    cwd: z.string().min(1), expectedExitCode: z.literal(0),
  }).strict(),
  z.object({
    kind: z.literal('evidence'), instruction: z.string().trim().min(1),
    paths: z.array(z.string().min(1)).min(1),
  }).strict(),
]);

export const OrchestratorTaskSchema = z.object({
  id: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u),
  title: z.string().trim().min(1),
  dependsOn: z.array(z.string().min(1)),
  workerPresetId: z.string().trim().min(1),
  readPaths: z.array(z.string().min(1)),
  writePaths: z.array(z.string().min(1)),
  steps: z.array(z.object({
    instruction: z.string().trim().min(1), expectedResult: z.string().trim().min(1),
  }).strict()).min(1),
  verification: z.array(OrchestratorVerificationCheckSchema).min(1),
  acceptance: z.array(z.string().trim().min(1)).min(1),
  temporaryPaths: z.array(z.string().min(1)),
}).strict();
export type OrchestratorTask = z.infer<typeof OrchestratorTaskSchema>;

export const OrchestratorPlanSchema = z.object({
  goal: z.string().trim().min(1), constraints: z.array(z.string().min(1)),
  tasks: z.array(OrchestratorTaskSchema).min(1),
  finalVerification: z.array(OrchestratorVerificationCheckSchema).min(1),
}).strict();
export type OrchestratorPlan = z.infer<typeof OrchestratorPlanSchema>;
```

Add `OrchestratorPresetOptionsSchema = z.object({ maxSubagents: z.number().int().positive() }).strict()`. `SiftPreset.orchestrator` is required and nullable; only kind `orchestrator` may have non-null options, and that kind must have them. Other kinds explicitly use null. Add `orchestrator` to `PresetKindSchema` and `RunOperationTypeSchema`.

- [ ] **Write failing schema/catalog tests.** Assert protected built-in presence, CLI/Web surfaces, current-model default, maxSubagents 1, invalid zero/fractional cap, invalid option/kind combinations, and rejected recursive worker selection. Assert two attempts is the fixed policy, not another configurable setting.

```typescript
test('the default orchestrator inherits the model and runs one child at a time', () => {
  const preset = PresetCatalog.createDefault().requireById('orchestrator');
  assert.equal(preset.presetKind, 'orchestrator');
  assert.equal(preset.modelPresetId, null);
  assert.deepEqual(preset.orchestrator, { maxSubagents: 1 });
  assert.equal(preset.deletable, false);
});
```

- [ ] **Run red:** `npm run build:test`, `npm test -- contracts-orchestrator preset-catalog`.
- [ ] **Add the built-in and schema upgrade.** Upgrade 75 to 76: append `orchestrator: null` to existing operation presets, append the protected orchestrator built-in, preserve every existing assignment/custom preset. A conflicting existing custom ID `orchestrator` fails with a rename instruction; do not overwrite it. Fresh defaults already contain the new entry. Test the complete 74 -> 75 -> 76 chain and ensure M1's historical migration does not accidentally depend on the latest preset shape.
- [ ] **Implement deterministic plan validation.** `validateOrchestratorPlan(plan: OrchestratorPlan, config: SiftConfig, repoRoot: string): OrchestratorPlan` rejects duplicate/missing dependency IDs, cycles, self-dependencies, unsupported worker kinds, write scopes on read-only workers, escaping paths, and empty required instructions. Normalize repository path keys with the existing Windows path utilities. This validates structure and capabilities; O3 adds semantic review against repository facts.
- [ ] **Define reusable test tasks.** Export `makeOrchestratorTask` from `tests/helpers/orchestrator-plan.ts`:

```typescript
export function makeOrchestratorTask(overrides: Partial<OrchestratorTask> = {}): OrchestratorTask {
  return OrchestratorTaskSchema.parse({
    id: 'inspect', title: 'Inspect README', dependsOn: [],
    workerPresetId: 'repo-search', readPaths: ['README.md'], writePaths: [],
    steps: [{ instruction: 'Read README.md and report its installation commands.',
      expectedResult: 'Commands with file and line evidence.' }],
    verification: [{ kind: 'evidence', instruction: 'Verify each reported command in README.md.',
      paths: ['README.md'] }],
    acceptance: ['Every reported command is supported by the current README.'],
    temporaryPaths: [], ...overrides,
  });
}
```

- [ ] **Add graph/path tests and run green.** Include an acyclic two-task plan, a cycle, a missing dependency, `../` and absolute path escape, a junction/symlink escape, invalid worker reference, and a supported custom worker preset. Run `npm run build:test`, then `npm test -- contracts-orchestrator orchestrator-plan runtime-db-schema-orchestrator preset-catalog`.

**Acceptance:** A strict, independently valid task manifest and selectable protected preset exist; old config is upgraded explicitly; invalid/recursive tasks cannot reach dispatch.

### O2: Persist parent state, events, and exactly-once attempt reservations

**Files**

- Create `src/orchestrator/run-store.ts`, `src/status-server/orchestrator-runs.ts`, `tests/orchestrator-run-store.test.ts`.
- Extend `packages/contracts/src/orchestrator.ts`, `src/state/runtime-schema.ts`, `src/state/runtime-db.ts`.
- Create `src/state/schema-upgrades/orchestrator-runs.ts` for schema 76 -> 77; do not change the meaning of an already-applied version-76 upgrade.
- Modify `src/status-server/index.ts`, `server-types.ts`, and `tests/helpers/server-context-fixture.ts`.

**Interfaces**

Schemas define parent phases `preparing_plan`, `validating_plan`, `executing`, `verifying`, `cleaning`, `approval_required`, `completed`, `failed`, `aborted`, `interrupted`. Task states distinguish `pending`, `running`, `verifying`, `retry_pending`, `completed`, `failed`, `aborted`. Attempts are integers 1 or 2; child terminal statuses reuse existing worker schemas.

`OrchestratorRunStore` takes `RuntimeDatabase` and exposes:

```typescript
create(request: OrchestratorStartRequest): OrchestratorRunState;
read(runId: string): OrchestratorRunState;
savePlan(runId: string, revision: number, plan: OrchestratorPlan,
  planPath: string, contentHash: string): OrchestratorRunState;
reserveAttempt(runId: string, revision: number, taskId: string): OrchestratorAttempt;
recordAttemptResult(runId: string, revision: number,
  result: OrchestratorAttemptResult): OrchestratorRunState;
readEvents(runId: string, afterSequence: number): OrchestratorEvent[];
markInterrupted(runId: string, revision: number, reason: string): OrchestratorRunState;
```

All named data types above are exported from canonical schemas in `packages/contracts/src/orchestrator.ts`. The state includes request/submission ID, owner epoch, revision, phase, plan hash/path/manifest, per-task state, attempts, child IDs, parent inference-phase IDs, active approval, verification records, and failure detail. An approval has a discriminated target: `{ kind: 'phase', phaseRunId }` or `{ kind: 'child', childRunId }`, plus the existing approval ID/payload. `reserveAttempt` generates/reserves the child run UUID within the transaction and increments the task count only there.

- [ ] **Write store tests before tables.** Two `create` calls with the same submission ID and payload return the same parent. The same ID with a different payload rejects. Two reservation calls against the same revision cannot both succeed. After failed attempts 1 and 2, a third reservation rejects; approval/state updates cannot lower the count.

```typescript
assert.equal(firstAttempt.attempt, 1);
assert.equal(secondAttempt.attempt, 2);
assert.notEqual(firstAttempt.childRunId, secondAttempt.childRunId);
assert.throws(() => store.reserveAttempt(runId, currentRevision, taskId), /attempt limit/u);
```

Create the database with `createManagedTempDir`/`getRuntimeDatabase`, write state through the store, and close it before cleanup. The test must use store-produced revisions and attempt results, not mutate state JSON directly.

- [ ] **Run red:** `npm run build:test`, `npm test -- orchestrator-run-store`.
- [ ] **Add SQLite tables in fresh bootstrap and a new 76 -> 77 upgrade.** Use `orchestrator_runs` (unique submission ID), `orchestrator_tasks` (parent/task primary key), `orchestrator_attempts` (parent/task/attempt primary key plus unique child UUID), and `orchestrator_events` (parent/sequence primary key). Store schema-validated payload JSON alongside indexed identities/revisions. Put revision checks, state changes, attempt reservation, and event append in one transaction. Extend `tests/runtime-db-schema-orchestrator.test.ts` with fresh/upgrade layout parity and the complete 74 -> 77 chain.
- [ ] **Integrate lifetime ownership.** `OrchestratorRunRegistry` owns live parent objects, completion subscriptions, and one shared read/exclusive repository gate keyed by canonical real path. On shutdown, stop scheduling, abort owned requests/children, wait for settlement, and record terminal/interrupted state. On startup, reconcile nonterminal stored parents with worker records; mark uncertain work interrupted rather than recreating it. Do not add a polling timer to find completion.
- [ ] **Test crash boundaries and event replay.** Cover reserve-before-start, child-created-before-parent-ack, completion-before-client-delivery, duplicate terminal event, stale revision, malformed row, unknown child, and monotonically increasing replay sequences. Restart must never reset attempts or run an uncertain task again.
- [ ] **Run green:** `npm run build:test`, then `npm test -- orchestrator-run-store runtime-db-schema-orchestrator runtime-db-lifecycle`.

**Acceptance:** Durable state distinguishes “reserved” from “executed”; reconnects cannot create extra attempts; every user-visible state follows a committed event.

### O3: Prepare plans and start bounded children without nested lock ownership

**Files**

- Create `src/orchestrator/phase-runner.ts`, `src/orchestrator/workers.ts`.
- Extend `src/orchestrator/plan.ts`, `prompts.ts`, `packages/contracts/src/orchestrator.ts`.
- Modify `src/repo-search/task-kind.ts`, `run-system-prompt.ts`, `prompts.ts`, `engine/runtime-profile.ts`, `execute.ts` for a genuine orchestrator parent inference identity.
- Modify `src/status-server/routes/repo-agent.ts`, `repo-agent-sessions.ts`, `repo-agent-lock-adapter.ts` to expose server-owned worker creation with a reserved child ID and chosen worker kind.
- Create `tests/orchestrator-phase-runner.test.ts`, `tests/orchestrator-workers.test.ts`.
- Extend `tests/orchestrator-plan.test.ts`, `tests/nested-agent-server-reject.test.ts`, `tests/repo-search-runtime-profile.test.ts`.

**Interfaces**

- `OrchestratorPhaseRunner` receives `ServerContext`; `preparePlan`, `reviewAttempt`, and `verifyFinal` perform finite parent inference phases, returning schema-validated results/evidence. Each parsed phase request has both parent `runId` and a durable `phaseRunId`; use the latter for engine request identity, lock ownership, and phase approvals.
- `OrchestratorWorkers.start(input: OrchestratorChildRequest): OrchestratorChildHandle` starts only a reserved child. Its handle exposes run ID, existing completion promise/progress subscription, `abort`, and approval-decision forwarding. It does not expose recursive parent startup.
- `OrchestratorChildRequest` contains parent ID, task ID, attempt, reserved child UUID, worker preset ID, repo root, bounded instruction, approval mode, and cancellation ownership. It is parsed by its canonical schema.
- Parent results use strict discriminated unions: plan review `ready` with manifest versus `revise` with issues; task review `pass` versus `fail` with anchored findings. Failed JSON/schema parsing is a failed phase, not permission to execute free text.

- [ ] **Write plan preparation tests with scripted engine responses.** Test a valid supplied plan unchanged, missing plan generated, inadequate plan rewritten to a new Markdown file, ambiguous plan reference, stale repository paths, malformed model output, and a task-only request. Generated plans must be saved and revalidated before a worker starts.
- [ ] **Run red:** `npm run build:test`, then `npm test -- orchestrator-phase-runner orchestrator-plan`.
- [ ] **Implement parent inference with scoped leases.** Add the orchestrator task kind/system prompt to the existing engine; use the mutating agent's compaction behavior while preserving operation identity `orchestrator`. Before model admission, acquire repository read/exclusive ownership or validate the task's existing internal ownership token. Planning phases allow repository inspection tools; writing the selected Markdown plan is performed by the host after typed output validation under exclusive repository ownership. Release the planning model lease before upgrading a read lease to write ownership. Review/verification phases may run the specified checks under existing approvals.

```typescript
const lock = await acquireModelRequestWithWait(ctx, 'orchestrator_phase', undefined, undefined, {
  intent: { presetId: request.presetId, model: null },
  ownerRunId: request.phaseRunId,
  abortSignal: request.abortSignal,
});
if (!lock) throw new Error('Orchestrator phase was not admitted.');
try {
  return await ctx.engineService.executeRepoSearch({
    ...phaseRequest,
    requestId: request.phaseRunId,
    taskKind: 'orchestrator',
    presetId: request.presetId,
    config: lock.context.config,
    modelPresetId: lock.context.modelPreset.id,
    modelPreset: lock.context.modelPreset,
    abortSignal: request.abortSignal,
  });
} finally {
  releaseModelRequest(ctx, lock.token);
}
```

`request` is the parsed parent phase request; `phaseRequest` is constructed by the phase-specific prompt/tool policy. Parse the engine's terminal text using the corresponding result schema after this function has released its lease. Child creation happens outside this block.

- [ ] **Validate and render plans.** Semantic review checks task coverage, present files/symbols, manageable scope, verification sufficiency, dependencies, and applicable repository instructions. `renderOrchestratorPlan(plan)` renders a complete Markdown goal/constraints/task list with worker, scopes, steps, exact checks, expected results, and acceptance. Preserve valid supplied Markdown; store its compiled manifest/hash as execution evidence. Allow at most two prepare/revise phase attempts before a precise plan-preparation failure.
- [ ] **Implement child startup through the server API boundary.** Extract the common server-side worker start from `startRepoAgentRun` into `startRepoWorkerRun`; update all callers. It chooses `taskKind` and effective allowed tools from the selected worker preset, accepts the pre-reserved child UUID, and reuses `RepoAgentSession`/run-store lifecycle. Existing standalone repo-agent routes remain repo-agent workers. A repo-search child receives only its read-only tool surface and normal repo-search execution behavior; reject a selected repo-search profile that grants mutating tools rather than silently treating it as read-only. Acquire the shared repository gate before acquiring a model lease. A delegated child receives a verified internal ownership token from its parent task instead of acquiring the same exclusive gate twice; never accept this token from HTTP/model output. No shell CLI spawning or header bypass.
- [ ] **Construct bounded worker instructions.** Include exact task ID/heading, plan path/hash, attempt number, allowed files, full task steps and acceptance, verification commands, preservation of existing changes, scratch path, and no commits/no unrelated tasks. Attempt 2 additionally includes observed failure, previous diff/evidence, completed work to retain, and the specific correction. Do not pass only the entire plan and ask the child to choose its task.
- [ ] **Test lifecycle and safety.** With `ParallelSlots=1`, parent preparation completes/releases and a child can acquire. A child cannot select an orchestrator worker preset, expand its tools from read-only to full, or bypass nested shell self-call protection. Approval continuation retains the same child ID.
- [ ] **Run green:** `npm run build:test`, then `npm test -- orchestrator-phase-runner orchestrator-workers repo-agent-sessions nested-agent-server-reject repo-search-runtime-profile`.

**Acceptance:** The parent owns design/planning; worker instructions are discrete; child execution is ordinary preset-routed execution; no parent model lease survives into child waiting.

### O4: Schedule dependencies, concurrency, and two attempts per task

**Files**

- Create `src/orchestrator/scheduler.ts`, `src/orchestrator/run.ts`, `tests/orchestrator-scheduler.test.ts`, `tests/orchestrator-run.test.ts`.
- Extend `src/status-server/orchestrator-runs.ts`, `src/orchestrator/run-store.ts` only for required state transitions.

**Interfaces**

- `selectReadyOrchestratorTasks(plan, taskStates, activeChildren, maxSubagents)` returns eligible task IDs in plan order.
- `OrchestratorRun` receives concrete store, phase-runner, worker, verification, and workspace dependencies. `start()`, `abort()`, `submitDecision()`, `settled`, and event subscriptions mirror the established server-run lifecycle.
- Completion/verification state updates wake one scheduler drain. Register child subscriptions before relying on their completion; avoid a check-then-subscribe race.

- [ ] **Write scheduler tests.** Default cap admits one; cap 3 admits independent read-only tasks; no dependent starts before predecessor verification/cleanup. A mutation task starts only with no active children and holds exclusive ownership through validation/cleanup. While that owner exists, no new reader or writer starts. Global validation commands also take exclusive ownership. Add two-parent/same-repository and standalone-writer-versus-orchestrator cases to prove the gate is server-owned rather than local to one parent. Lock ordering is repository ownership, then model admission; never reverse it.

Use `makeOrchestratorTask` to build the cases. A task is mutating when its worker kind is repo-agent or its verified execution policy can write, not merely when the manifest claims empty write paths. Reject read-only workers with mutating capabilities.

```typescript
assert.deepEqual(startedTaskIds, ['read-a', 'read-b']);
assert.equal(startedTaskIds.includes('write-c'), false);
assert.equal(maxObservedChildren <= configuredMaxSubagents, true);
assert.equal(maxObservedWriters, 1);
assert.equal(readerWriterOverlapCount, 0);
```

These arrays/counters come from scripted worker handles wired to the production scheduler; tests settle handles explicitly rather than waiting on elapsed time.

- [ ] **Run red:** `npm run build:test`, `npm test -- orchestrator-scheduler orchestrator-run`.
- [ ] **Implement scheduling and attempt reservation.** Compute ready tasks only from completed predecessors. Reserve/persist attempt and child ID, then start that specific child once. Queued/approval-paused children count against the cap. On worker completion, schedule independent verification; release dependencies only after verification and cleanup pass.
- [ ] **Implement the fixed retry decision.** The persisted attempt count is the only counter. Use the outcome from O5, not just the worker status.

```typescript
export function nextTaskAction(
  attempt: number, verificationPassed: boolean,
): 'complete' | 'retry' | 'fail' {
  if (verificationPassed) return 'complete';
  return attempt < ORCHESTRATOR_MAX_ATTEMPTS ? 'retry' : 'fail';
}
```

Schema validation constrains attempt to 1 or 2 before this function. Add tests for `(1,false) -> retry`, `(2,false) -> fail`, and either successful attempt -> complete. User abort/denied forbidden actions bypass retry and preserve their explicit terminal cause.

- [ ] **Test updated retry instructions.** Attempt 1 fails a concrete check. Assert attempt 2 contains that check's actual exit/output evidence, retains the successful partial diff, and has a new child ID. After its failure, assert no third `start` call, no dependent dispatch, and no hidden parent coding phase. Approval continuation emits no new reservation. A duplicate child completion cannot reserve twice.
- [ ] **Implement plan-change handling.** Rehash the plan before dispatch. Revalidate changes without reducing persisted attempts or silently replaying completed tasks. If a changed plan invalidates completed work or renames task identities, stop with a plan-changed diagnosis requiring a new run rather than reset the budget.
- [ ] **Handle terminal paths.** On task attempt 2 failure, stop scheduling immediately, signal owned active children, await their settlement, and retain evidence/changes. On disconnect, keep the parent running. On explicit abort, remove queued admissions and stop active children. Register cancellation before long awaits and check it after readiness.
- [ ] **Run green:** `npm run build:test`, then `npm test -- orchestrator-scheduler orchestrator-run orchestrator-run-store model-request-queue`.

**Acceptance:** Concurrency is a cap, mutations are exclusive, dependencies wait for verified completion, and every task has at most two actual child attempts across all continuations.

### O5: Independently verify results and clean only owned artifacts

**Files**

- Create `src/orchestrator/verification.ts`, `src/orchestrator/workspace.ts`, `tests/orchestrator-verification.test.ts`, `tests/orchestrator-workspace.test.ts`.
- Extend `phase-runner.ts`, `run.ts`, `run-store.ts` for verification records and cleanup ownership.
- Reuse `src/repo-search/engine/tool-action-processor.ts`, `repo-tools.ts`, and `approval-gate.ts`; modify only to expose recorded execution evidence if the current scorecard omits it.

**Interfaces**

- `OrchestratorWorkspace.captureBaseline()` records dirty tracked/untracked paths and content hashes in the run evidence store.
- `captureAttemptChanges(task, baseline)` returns schema-validated changed-path/diff evidence and scope violations.
- `OrchestratorVerification.verifyAttempt(input)` produces `OrchestratorAttemptResult` containing child status, independently executed checks, acceptance review findings, diff evidence, and cleanup result.
- `cleanupOwnedScratch(paths)` accepts only paths recorded as created by this run under its canonical scratch root.

- [ ] **Write failing verification tests.** A completed child with a nonzero check fails; an incomplete/missing check fails; an assertion in model prose with no recorded execution fails; a read-only task needs checked path/line evidence; scope drift fails; a successful worker plus independently passing evidence succeeds.

```typescript
assert.equal(result.workerStatus, 'completed');
assert.equal(result.checks[0]?.exitCode, 1);
assert.equal(result.passed, false);
assert.equal(nextTaskAction(1, result.passed), 'retry');
```

Build `result` by passing an actual scripted tool-execution record through `verifyAttempt`; do not construct the expected result directly. The production verifier compares each declared command/cwd/expected exit to its recorded execution, including timeout/abort flags.

- [ ] **Run red:** `npm run build:test`, `npm test -- orchestrator-verification orchestrator-workspace`.
- [ ] **Implement independent review.** After a worker settles, the parent reads the actual changed files/diff and runs the plan's checks in a new verification phase. Use the ordinary tool/approval path; never call unguarded `executeRepoTool` directly to sidestep approval. Check that every required command really executed with the declared cwd and result; a model's JSON review cannot replace tool evidence. Apply the plan's final checks again at parent closeout, once all tasks finish.
- [ ] **Protect the initial dirty baseline.** Compare current changes to the start-of-task baseline, distinguish initial user changes from child changes, and include relevant existing dirty files in the worker instructions. Do not restore pre-existing edits. A scope violation becomes retry evidence; on attempt 2 it becomes a reported terminal failure, not a destructive automatic reset.
- [ ] **Implement scratch cleanup with canonical containment.** Use one `scratch` directory under the durable parent run's artifact directory. Resolve existing parents through real paths before deleting; reject the scratch root itself as a supplied arbitrary candidate, parent traversal, sibling prefixes, symlinks/junctions to outside, and unowned paths. Settle child processes before cleanup. Preserve the Markdown plan, task manifests, diffs, logs, and verification records.
- [ ] **Test cleanup boundaries with real isolated files.** Create an unrelated dirty file and a run-owned temp file. After cleanup the former is unchanged and the latter is gone. A path outside scratch and a linked path outside scratch both reject without deleting their targets. Failure to delete an owned temp file is recorded and cannot silently complete cleanup.
- [ ] **Run green:** `npm run build:test`, then `npm test -- orchestrator-verification orchestrator-workspace orchestrator-run repo-agent-sessions`.

**Acceptance:** Verification can contradict worker success; every completed task has real evidence; cleanup cannot erase unrelated work; retry instructions reflect exactly what failed.

### O6: Add a single HTTP lifecycle and CLI access

**Files**

- Create `src/status-server/routes/orchestrator.ts`, `src/cli/orchestrator-args.ts`, `src/cli/run-orchestrator.ts`.
- Modify `src/status-server/routes/core.ts`, `routes/operations.ts`, `preset-runner.ts`, `src/cli/dispatch.ts`, `command-catalog.ts`, `help.ts`, `status-server-api-client.ts`, `run-preset.ts`, `src/command-output/types.ts`.
- Create `tests/orchestrator-http.test.ts`, `tests/orchestrator-cli.test.ts`, `tests/orchestrator-args.test.ts`.
- Update `tests/cli-command-catalog.test.ts`, `tests/cli-preset.test.ts`, `tests/cli-help.test.ts`.

**Interfaces**

| Endpoint | Contract |
|---|---|
| `POST /orchestrator` | Validated start request; returns JSON parent ID/state with HTTP 202 |
| `GET /orchestrator/status?runId=...` | Validated durable parent state |
| `GET /orchestrator/events?runId=...&after=...` | Replay committed events then subscribe to new events |
| `POST /orchestrator/decide` | Parent ID + discriminated phase/child target + exact execution/approval IDs + existing approval decision |
| `POST /orchestrator/abort` | Parent ID; idempotent cancellation of the owned run |

Define request/response/event schemas in the existing contracts module from O1. Results distinguish completed, approval-required, failed, aborted, and interrupted with task/attempt/child IDs and actionable failure evidence. Parent SSE heartbeats use the existing transport constant, and events are committed before delivery.

- [ ] **Write failing HTTP and CLI tests.** Exercise task-only, `--plan`, custom orchestrator preset, invalid body/flag, duplicate start, reconnect with cursor, approval for a stale/wrong child, abort while queued, and status after completion. `--model` follows the strict routing contract if exposed; do not add an unvalidated override path.

Expected user-visible invocation forms:

```text
siftkit orchestrator "Implement the requested feature" --repo-root C:\repo
siftkit orchestrator --plan docs/superpowers/plans/change.md --repo-root C:\repo
siftkit orchestrator status <run-id>
siftkit orchestrator decide <run-id> <execution-id> <approval-id> approve
siftkit orchestrator abort <run-id>
siftkit preset --preset orchestrator --prompt "Implement the requested feature"
```

These commands describe the product interface to implement; do not run them as the tool for implementing this plan.

- [ ] **Run red:** `npm run build:test`, then `npm test -- orchestrator-http orchestrator-cli orchestrator-args cli-preset`.
- [ ] **Implement routes and client with schema parsing.** A start request reserves the parent before launching work. CLI starts with JSON, then subscribes to the event endpoint using the existing SSE framing. A cursor is a validated nonnegative integer bounded by committed history. Decisions are forwarded only to the parent's current recorded phase/child approval; no command-string evaluation. The result supplies the exact execution ID and decision command, so the CLI need not guess whether it names a phase or child. Test both parent verification approvals and child approvals. CLI parses typed results, never treats process exit alone as worker completion.
- [ ] **Dispatch preset execution without an outer model lock.** `presetKind === 'orchestrator'` routes to the parent service before ordinary `StreamedOperationEndpoint` admission. Refactor the endpoint's existing branch ownership so ordinary presets still use the shared admitted path; the orchestrator envelope itself acquires no model lease. Do not fake an orchestrator as one repo-search request or one long-held repo-agent lock.
- [ ] **Preserve cancellation semantics.** Dropping a CLI/Web subscription detaches it, while explicit abort cancels the run. Propagate approval-required state with exact run/task/attempt IDs. Approval continuation keeps attempt and child identity unchanged. Return failure details for interrupted runs instead of restarting them on status reads.
- [ ] **Run green:** `npm run build:test`, then `npm test -- orchestrator-http orchestrator-cli orchestrator-args cli-command-catalog cli-preset cli-help streamed-repo-agent-endpoint`.

**Acceptance:** Direct command and preset invocation share one parent lifecycle; a disconnected client cannot duplicate work; all public IO is validated and parent/child identities remain distinct.

### O7: Add Web operation controls, settings, and run evidence

**Files**

- Create `dashboard/src/tabs/OrchestratorRunPanel.tsx`, `dashboard/tests/orchestrator-run-panel.test.tsx`.
- Modify `dashboard/src/tabs/settings/PresetsSection.tsx`, `settings-action-groups.ts`, `settings-draft-editor.ts`, `hooks/useSettingsController.ts`.
- Modify `dashboard/src/tabs/ChatTab.tsx`, `hooks/useChatController.ts`, `hooks/useChatSessions.ts`, `lib/chat-session-state.ts`, `dashboard-presets.ts`.
- Modify `packages/contracts/src/chat.ts`, `chat-recovery.ts`, `src/status-server/routes/chat.ts`, `routes/chat-session-operation-endpoint.ts`, `chat-session-response.ts`, and add `routes/chat-orchestrator.ts`.
- Modify `src/status-server/dashboard-runs/run-identity.ts` and `src/orchestrator/run-store.ts` for parent/child evidence links without duplicated inference totals.
- Test `dashboard/tests/presets-section.test.tsx`, `dashboard/tests/chat-tab.test.tsx`, `dashboard/tests/hooks/useChatSessions.test.tsx`, `tests/status-server-chat-operation-attach.test.ts`, `tests/inference-throughput-operations.e2e.test.ts`.

**Interfaces**

- Settings action: `{ type: 'set-orchestrator-max-subagents'; presetId: string; value: number }` and corresponding `setMaxSubagents` action.
- `ChatSessionOperationKindSchema` gains `orchestrator`; chat operation descriptors route that kind to the parent service, not `ChatRepoOperationRunner`.
- `OrchestratorRunPanel` consumes canonical parent/task state and typed start/decide/abort actions. It shows child run links and verification evidence rather than duplicating child transcripts.
- The parent envelope identifies the orchestration. Individual parent inference phases and child runs carry actual model usage; total metrics count each underlying inference once.

- [ ] **Write failing settings and chat tests.** Show concurrency only for orchestrator presets, default 1, valid save/reload, invalid noninteger/zero rejection. Selecting an orchestrator changes the action to “Run orchestrator”. Reload must attach to the existing parent; stop must abort its children. Surface “Attempt 1 of 2”/“Attempt 2 of 2”, plan path, failed checks, and required approval.

```tsx
const options = preset.orchestrator;
if (options === null) throw new Error('Orchestrator preset options are missing.');

<SettingsField label="Maximum concurrent subagents" layout="half">
  <input type="number" min="1" step="1"
    value={options.maxSubagents}
    onChange={event => {
      const parsed = OrchestratorPresetOptionsSchema.shape.maxSubagents
        .safeParse(Number(event.target.value));
      if (parsed.success) presetActions.setMaxSubagents(preset.id, parsed.data);
    }} />
</SettingsField>
```

Render this only after narrowing `preset.presetKind === 'orchestrator'` and verifying its required options, so a malformed stored preset is an error rather than a silently applied default.

- [ ] **Run red:** `npm run build:test`, then `npm test -- dashboard/tests/orchestrator-run-panel.test.tsx dashboard/tests/chat-tab.test.tsx dashboard/tests/presets-section.test.tsx`.
- [ ] **Implement the parent operation UI/transport.** Reuse existing chat submission IDs, journal/broadcast attachment, approvals, and stop ownership. Link the chat operation to one orchestrator parent run and forward its committed phases/task summaries. Preserve the current uncommitted recovery/reattachment changes; extend their contracts, not a parallel Web operation path.
- [ ] **Keep per-phase model evidence accurate.** A parent can plan on A, wait while a child runs on B, and review on A or inherited B. Do not label the entire orchestration with the chat's creation model. Record actual model snapshots on inference phases and existing child runs. The parent has no additional inference usage just for supervising; derived aggregate views must not add their totals again to global metrics.
- [ ] **Test cross-surface lifecycle.** Start in Web, read in CLI/status, reload Web, approve once, and verify only one child continues. Stop during a child queue wait removes that waiter. A terminal run no longer shows running even if its old SSE socket reconnects.
- [ ] **Run green:** `npm run test:dashboard`, then `npm test -- orchestrator-http status-server-chat-operation-attach status-server-chat-stop inference-throughput-operations`.

**Acceptance:** The new preset is usable through both surfaces; settings enforce the cap; task/attempt/model evidence survives reattachment; usage is not double-counted.

### O8: Verify the complete workflow, document it, and close out

**Files**

- Create `tests/orchestrator.e2e.test.ts` using isolated repositories and recording runtimes.
- Modify `README.md` and the CLI/preset help sections implemented above.
- Add the completed verification evidence to the implementation handoff, retaining any known failures.

- [ ] **Add end-to-end cases before final integration fixes.**

| Case | Required observations |
|---|---|
| Existing good plan | No rewrite; task scope honored; checks run after every child |
| Task-only request | Markdown saved; plan validated before first dispatch |
| Bad/outdated plan | Corrected new file; original preserved; invalid graph cannot dispatch |
| Default child cap | At most one child, including approval/queue waits |
| Cap 3 with reads/writes | Parallel independent reads; zero reader/writer overlap; exclusive verification |
| First attempt fails | Second instruction includes actual failure evidence and retained partial work |
| Second attempt fails | No third child; no dependent task; terminal report lists changes and checks |
| Worker claims success incorrectly | Parent verification fails and consumes the retry policy |
| Parent A / child B / one model slot | Parent releases before child; no deadlock; routing stays consistent |
| Resident-model queue | Another B worker can precede an A review; no fairness exception |
| Reconnect/duplicate submit/approval | Stable parent/child IDs and attempt count |
| Abort/restart boundaries | No orphan active worker, no uncertain automatic redispatch |
| Dirty files and scratch | Initial user edits survive; owned temps removed; artifacts retained |
| Smaller/vision-incompatible model | Context/image checks use admitted phase/worker model |

- [ ] **Pin the two-attempt boundary at real dispatch.** Record worker starts and terminal verification results through the production parent service.

```typescript
assert.deepEqual(dispatched.map(child => child.attempt), [1, 2]);
assert.equal(new Set(dispatched.map(child => child.childRunId)).size, 2);
assert.equal(parentState.phase, 'failed');
assert.equal(dependentTaskStarted, false);
assert.equal(activeChildCount, 0);
```

In the success variant, attempt 2 passes, its task becomes completed after cleanup, and the dependent task receives its first attempt, not a continuation of the predecessor's budget.

- [ ] **Document operation rules.** Explain model inheritance, concurrency as a cap rather than a promise of parallel modifications, one retry with updated instructions, plan output location, verification evidence, approvals, reconnect/abort, and interrupted-run recovery. Document the difference between a completed child and a completed task. Keep CLI help and Web labels consistent.
- [ ] **Run focused then full gates.**

```powershell
npm run build:test
npm test -- orchestrator preset-model-routing model-request-queue preset-runtime-coordinator repo-agent-sessions nested-agent-server-reject
npm test
npm run test:dashboard
npm run typecheck
npm run lint
```

- [ ] **Review the implementation against every confirmed requirement.** Verify actual tool policies, not only prompts; check parent lease release, child cap ownership, durable retry counts, plan-change handling, approval-denial behavior, and no duplicate model/usage identities. Remove obsolete replaced paths and task-owned temp files. Do not commit or revert unrelated changes.
- [ ] **Report outcome and limits.** List changed areas, command evidence, failures, and any unverified live-model behavior. Keep the initial user-requested scope; defer unrelated agent-framework, distributed scheduling, or worktree features.

**Acceptance:** All three requested features work together across CLI/Web and failure/recovery boundaries; model scheduling, bounded delegation, independent verification, and preservation of user work are demonstrated by tests.
