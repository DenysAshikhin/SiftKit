# Orchestrator Preset Implementation Plan

> **For agentic workers:** Complete the model-routing plan first, then O1–O8 sequentially with TDD, including O5b between O5 and O6. Use `siftkit repo-agent` for defined implementation tasks as now authorized; the primary agent owns review and validation. Do not create worktrees or commit.

**Goal:** Add an orchestrator that prepares executable plans, delegates bounded work, verifies each task, and resolves impactful code drift through scoped correction workers, with separate two-attempt implementation and correction budgets.

**Architecture:** A server-owned state machine controls plan validation, dependency scheduling, implementation/correction attempts, verification, critical drift review, cleanup, and durable events. Parent inference phases and workers use the model admission layer from M1–M7. The parent never holds a model lease while waiting for a child.

**Tech stack:** TypeScript, Zod, SQLite, existing repo-search/repo-agent engine and approvals, Node `node:test`, React, existing SSE/chat recovery.

**Spec:** [Shared design, section C](../specs/2026-09-22-preset-model-routing-and-orchestration-design.md).

**Prerequisite:** [Preset model routing plan](2026-09-22-preset-model-routing.md), including its integrated tests.

## Global constraints

- TypeScript throughout; parse IO with Zod and derive types with `z.infer`.
- No `any`, type assertions, non-null assertions, namespace imports, or schema-duplicating types.
- No worktrees; preserve unrelated changes.
- For this implementation session, the primary commits each independently verified task and starts every repo-agent dispatch from a clean Git working tree. Workers do not commit; controller artifacts stay in ignored scratch storage.
- Delegate review corrections and further implementation fixes to repo-agent with bounded findings and exact instructions. The primary owns review, independent validation, planning, and commits.
- Explicit versioned migrations; no runtime compatibility readers or silent invalid-reference fallback.
- Execute defined implementation tasks through `siftkit repo-agent` as newly requested; the primary agent owns planning, review, and validation. Follow the session's SiftKit-first discovery policy and wait for every invocation to finish.
- `maxSubagents` defaults to 1 and counts dispatched/queued/running/approval-paused children.
- Modifications require exclusive repository ownership; independent read-only children can overlap.
- Each task has at most 2 implementation attempts and a separate pool of 2 drift-correction attempts; approval continuation is not a new attempt. Correction output never starts a new correction budget.
- After each code-changing delegated step, apply the reflect-session-drift rubric to attributable changes and immediate neighbors. Require verified evidence and concrete impact or lasting code/architecture drift; zero findings is valid.
- Send fixes to `repo-agent` as scoped finding/fix bullets without requiring another Markdown plan. Functional verification, resolved drift, and cleanup all gate dependent work.
- The parent validates/coordinates. Worker planning, recursive orchestration, and shell self-delegation are prohibited.
- **Child approvals are decided by the parent model (user requirement, 2026-09-23).** A child parked on an approval releases its model lease while it waits. The parent then runs a finite `approval` inference phase through ordinary admission, loading its own model if needed, and is told explicitly that it is deciding a child's approval. It releases its lease after deciding. The child then re-acquires its lease, reloading its model if needed, and continues the same attempt. No lease is held across the handoff in either direction, so one slot and different parent/child models cannot deadlock.

## Review focus

1. One inference slot and parent/child on different models: no model lease held across a child wait — O3/O4/O8.
2. Worker says completed but tests fail: retry with evidence, then stop after attempt 2 — O4/O5.
3. Reattach, duplicate submit, approval reply, or server restart dispatches work twice — O2/O6/O7/O8.
4. A supposedly read-only task mutates, or cleanup escapes scratch: fail visibly and preserve the initial dirty baseline — O3/O5.
5. Cosmetic/speculative findings cause churn, or correction findings/reset attempts create an unbounded loop: critical evidence threshold and one persistent two-attempt correction pool per step — O1/O2/O5b/O8. O1/O3/O4 also cover stale, cyclic, or edited plans without resetting either budget.

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
| `src/orchestrator/drift-review.ts` | Critical evidence checks, drift report state, and scoped correction prompt construction |
| `src/orchestrator/workspace.ts` | Initial dirty baseline, change evidence, bounded scratch cleanup |
| `src/orchestrator/run.ts` | State machine, separate two-attempt budgets, event-driven coordination |
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
export const OrchestratorChildPurposeSchema = z.enum(['implementation', 'drift_fix']);
export type OrchestratorChildPurpose = z.infer<typeof OrchestratorChildPurposeSchema>;

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

Define the drift contracts here so the store and worker boundary use one schema from their first implementation:

```typescript
const DriftCodeEvidenceSchema = z.object({
  path: z.string().min(1), line: z.number().int().positive(),
  snippet: z.string().trim().min(1),
}).strict();

export const OrchestratorDriftFindingSchema = z.object({
  id: z.string().trim().min(1), title: z.string().trim().min(1),
  purpose: z.string().trim().min(1), directive: z.string().trim().min(1),
  evidence: z.array(DriftCodeEvidenceSchema).min(1),
  impact: z.string().trim().min(1), fix: z.string().trim().min(1),
  affectedPaths: z.array(z.string().min(1)).min(1),
  verification: z.array(OrchestratorVerificationCheckSchema).min(1),
}).strict();
export type OrchestratorDriftFinding = z.infer<typeof OrchestratorDriftFindingSchema>;

const DriftReviewFields = {
  taskId: z.string().min(1), changeDigest: z.string().min(1),
  scopePaths: z.array(z.string().min(1)),
  resolutions: z.array(z.object({
    findingId: z.string().min(1), evidence: z.string().trim().min(1),
  }).strict()),
};
export const OrchestratorDriftReviewSchema = z.discriminatedUnion('status', [
  z.object({ ...DriftReviewFields, status: z.literal('not_required'),
    reason: z.literal('no_code_changes') }).strict(),
  z.object({ ...DriftReviewFields, status: z.literal('clean'),
    findings: z.array(OrchestratorDriftFindingSchema).max(0) }).strict(),
  z.object({ ...DriftReviewFields, status: z.literal('actionable'),
    findings: z.array(OrchestratorDriftFindingSchema).min(1) }).strict(),
]);
export type OrchestratorDriftReview = z.infer<typeof OrchestratorDriftReviewSchema>;

export const OrchestratorDriftCorrectionWorkSchema = z.object({
  kind: z.literal('drift_fix'), taskId: z.string().min(1),
  objective: z.string().trim().min(1), changeDigest: z.string().min(1),
  findings: z.array(OrchestratorDriftFindingSchema).min(1),
  allowedPaths: z.array(z.string().min(1)).min(1),
  verification: z.array(OrchestratorVerificationCheckSchema).min(1),
}).strict();
export type OrchestratorDriftCorrectionWork = z.infer<typeof OrchestratorDriftCorrectionWorkSchema>;

export const OrchestratorChildWorkSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('implementation'), planPath: z.string().min(1),
    planHash: z.string().min(1), task: OrchestratorTaskSchema }).strict(),
  OrchestratorDriftCorrectionWorkSchema,
]);
export type OrchestratorChildWork = z.infer<typeof OrchestratorChildWorkSchema>;
```

`not_required` is produced by host-side diff classification, not accepted as the model's excuse to skip review. Schema validity alone does not qualify a finding: O5b verifies attribution, anchors, impact, and proportionate fix. A clean follow-up must resolve every previously open finding against the current digest.

Add `OrchestratorPresetOptionsSchema = z.object({ maxSubagents: z.number().int().positive() }).strict()`. `SiftPreset.orchestrator` is required and nullable; only kind `orchestrator` may have non-null options, and that kind must have them. Other kinds explicitly use null. Add `orchestrator` to `PresetKindSchema` and `RunOperationTypeSchema`.

- [x] **Write failing schema/catalog tests.** Assert protected built-in presence, CLI/Web surfaces, current-model default, maxSubagents 1, invalid zero/fractional cap, invalid option/kind combinations, and rejected recursive worker selection. Assert two attempts per purpose is the fixed policy, not another configurable setting. Assert implementation work requires a plan reference, drift-fix work accepts only finding/fix payload without a plan reference, and empty/incomplete actionable findings reject.

```typescript
test('the default orchestrator inherits the model and runs one child at a time', () => {
  const preset = PresetCatalog.createDefault().requireById('orchestrator');
  assert.equal(preset.presetKind, 'orchestrator');
  assert.equal(preset.modelPresetId, null);
  assert.deepEqual(preset.orchestrator, { maxSubagents: 1 });
  assert.equal(preset.deletable, false);
});
```

- [x] **Run red:** `npm run build:test`, `npm test -- contracts-orchestrator preset-catalog`.
- [x] **Add the built-in and schema upgrade.** Upgrade 76 to 77 (schema 76 is taken by chat status narration): append `orchestrator: null` to existing operation presets, append the protected orchestrator built-in, preserve every existing assignment/custom preset. A conflicting existing custom ID `orchestrator` fails with a rename instruction; do not overwrite it. Fresh defaults already contain the new entry. Test the complete 74 -> 77 chain and ensure M1's historical migration does not accidentally depend on the latest preset shape.
- [x] **Implement deterministic plan validation.** `validateOrchestratorPlan(plan: OrchestratorPlan, config: SiftConfig, repoRoot: string): OrchestratorPlan` rejects duplicate/missing dependency IDs, cycles, self-dependencies, unsupported worker kinds, write scopes on read-only workers, escaping paths, and empty required instructions. Normalize repository path keys with the existing Windows path utilities. This validates structure and capabilities; O3 adds semantic review against repository facts.
- [x] **Define reusable test tasks.** Export `makeOrchestratorTask` from `tests/helpers/orchestrator-plan.ts`:

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

- [x] **Add graph/path tests and run green.** Include an acyclic two-task plan, a cycle, a missing dependency, `../` and absolute path escape, a junction/symlink escape, invalid worker reference, and a supported custom worker preset. Run `npm run build:test`, then `npm test -- contracts-orchestrator orchestrator-plan runtime-db-schema-orchestrator preset-catalog`.

**Acceptance:** A strict, independently valid task manifest and selectable protected preset exist; old config is upgraded explicitly; invalid/recursive tasks cannot reach dispatch.

### O2: Persist parent state, events, and exactly-once attempt reservations

**Files**

- Create `src/orchestrator/run-store.ts`, `src/status-server/orchestrator-runs.ts`, `tests/orchestrator-run-store.test.ts`.
- Extend `packages/contracts/src/orchestrator.ts`, `src/state/runtime-schema.ts`, `src/state/runtime-db.ts`.
- Create `src/state/schema-upgrades/orchestrator-runs.ts` for schema 77 -> 78; do not change the meaning of an already-applied version-77 upgrade.
- Modify `src/status-server/index.ts`, `server-types.ts`, and `tests/helpers/server-context-fixture.ts`.

**Interfaces**

Schemas define parent phases `preparing_plan`, `validating_plan`, `executing`, `verifying`, `reviewing_drift`, `correcting_drift`, `cleaning`, `approval_required`, `completed`, `failed`, `aborted`, `interrupted`. Task states distinguish `pending`, `running`, `verifying`, `reviewing_drift`, `correcting_drift`, `retry_pending`, `completed`, `failed`, `aborted`. Attempts are integers 1 or 2 within purpose `implementation` or `drift_fix`; child terminal statuses reuse existing worker schemas. Use `OrchestratorDriftReviewSchema` for nullable not-yet-reviewed state and stored reports from the first store implementation.

The parent state's `failure` is nullable and uses this canonical shape so corrective failures can expose unresolved finding IDs:

```typescript
export const OrchestratorFailureSchema = z.object({
  code: z.string().min(1), message: z.string().min(1),
  taskId: z.string().nullable(), purpose: OrchestratorChildPurposeSchema.nullable(),
  findingIds: z.array(z.string().min(1)),
}).strict();
```

`OrchestratorRunStore` takes `RuntimeDatabase` and exposes:

```typescript
create(request: OrchestratorStartRequest): OrchestratorRunState;
read(runId: string): OrchestratorRunState;
savePlan(runId: string, revision: number, plan: OrchestratorPlan,
  planPath: string, contentHash: string): OrchestratorRunState;
reserveAttempt(runId: string, revision: number, taskId: string,
  purpose: OrchestratorChildPurpose): OrchestratorAttempt;
recordAttemptResult(runId: string, revision: number,
  result: OrchestratorAttemptResult): OrchestratorRunState;
readEvents(runId: string, afterSequence: number): OrchestratorEvent[];
markInterrupted(runId: string, revision: number, reason: string): OrchestratorRunState;
```

All named data types above are exported from canonical schemas in `packages/contracts/src/orchestrator.ts`. The state includes request/submission ID, owner epoch, revision, phase, plan hash/path/manifest, per-task state, purpose-keyed attempts, child IDs, parent inference-phase IDs, active approval, verification/drift records, reviewed change digests, finding resolutions, and failure detail. An approval has a discriminated target: `{ kind: 'phase', phaseRunId }` or `{ kind: 'child', childRunId }`, plus the existing approval ID/payload. `reserveAttempt` generates/reserves the child run UUID within the transaction; derive both counters from these purpose-keyed records, not independently mutable counters. Finding/report IDs never become fresh attempt-budget keys.

- [x] **Write store tests before tables.** Two `create` calls with the same submission ID and payload return the same parent. The same ID with a different payload rejects. Two reservation calls against the same revision cannot both succeed. After attempts 1 and 2 in one purpose, a third reservation in that purpose rejects; approval/state updates cannot lower either count. Two implementation attempts do not consume the correction pool, and a new drift report cannot reset that pool.

```typescript
assert.equal(firstAttempt.attempt, 1);
assert.equal(secondAttempt.attempt, 2);
assert.notEqual(firstAttempt.childRunId, secondAttempt.childRunId);
assert.throws(() => store.reserveAttempt(runId, currentRevision, taskId, 'implementation'), /attempt limit/u);
```

Create the database with `createManagedTempDir`/`getRuntimeDatabase`, write state through the store, and close it before cleanup. The test must use store-produced revisions and attempt results, not mutate state JSON directly.

- [x] **Run red:** `npm run build:test`, `npm test -- orchestrator-run-store`.
- [x] **Add SQLite tables in fresh bootstrap and a new 77 -> 78 upgrade.** Use `orchestrator_runs` (unique submission ID; per-task state lives in its validated `state_json`), `orchestrator_attempts` (parent/task/purpose/attempt primary key plus unique child UUID), and `orchestrator_events` (parent/sequence primary key). Store schema-validated payload JSON alongside indexed identities/revisions, including drift reports, report digests, correction work payloads, and resolutions. Put revision checks, state changes, attempt reservation, and event append in one transaction. Extend `tests/runtime-db-schema-orchestrator.test.ts` with fresh/upgrade layout parity and the complete 74 -> 78 chain. These features are still planned together, so include the purpose column in this new table's first creation; do not add a redundant follow-up migration for code that has not shipped.
- [x] **Integrate lifetime ownership.** `OrchestratorRunRegistry` owns live parent objects, completion subscriptions, and one shared read/exclusive repository gate keyed by canonical real path. On shutdown, stop scheduling, abort owned requests/children, wait for settlement, and record terminal/interrupted state. On startup, reconcile nonterminal stored parents with worker records; mark uncertain work interrupted rather than recreating it. Do not add a polling timer to find completion.
- [x] **Test crash boundaries and event replay.** Cover reserve-before-start, child-created-before-parent-ack, completion-before-client-delivery, duplicate terminal event, stale revision, malformed row, unknown child, and monotonically increasing replay sequences for both purposes. Restart must never reset either budget or run an uncertain task again; a stale clean drift report cannot complete a changed code digest.
- [x] **Run green:** `npm run build:test`, then `npm test -- orchestrator-run-store runtime-db-schema-orchestrator runtime-db-lifecycle`.

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

- `OrchestratorPhaseRunner` receives `ServerContext`; `preparePlan`, `reviewAttempt`, `reviewDrift`, and `verifyFinal` perform finite parent inference phases, returning schema-validated results/evidence. Each parsed phase request has both parent `runId` and a durable `phaseRunId`; use the latter for engine request identity, lock ownership, and phase approvals. `reviewDrift` implements O5b's critical rubric as a read-only parent phase.
- `OrchestratorWorkers.start(input: OrchestratorChildRequest): OrchestratorChildHandle` starts only a reserved child. Its handle exposes run ID, existing completion promise/progress subscription, `abort`, and approval-decision forwarding. It does not expose recursive parent startup.
- `OrchestratorChildRequest` contains parent ID, task ID, attempt, reserved child UUID, worker preset ID, repo root, `work: OrchestratorChildWork`, bounded instruction, approval mode, and cancellation ownership. It is parsed by its canonical schema. Derive attempt purpose from `work.kind`. Drift-fix children use the configured built-in `repo-agent` preset and the bullet payload; they do not require a Markdown plan path/hash.
- `OrchestratorPhaseRunner.decideChildApproval(input)` is a finite parent phase that receives the child's task, attempt, approval ID, and the exact requested action. Its result is a strict `approve` / `deny` (with a reason) union. The prompt states that the parent is reviewing a subagent's permission request. It holds its lease only for that phase.
- A parked child releases its model lease on `approval_required` and re-acquires it through the normal queue after the decision, keeping its run ID, attempt, and transcript. `RepoAgentSession` implements release-on-park/reacquire-on-resume for every server-owned session, so interactive users and the orchestrator share one lifecycle.
- Parent results use strict discriminated unions: plan review `ready` with manifest versus `revise` with issues; task review `pass` versus `fail` with anchored findings. Failed JSON/schema parsing is a failed phase, not permission to execute free text.

- [x] **Write plan preparation tests with scripted engine responses.** Test a valid supplied plan unchanged, missing plan generated, inadequate plan rewritten to a new Markdown file, ambiguous plan reference, stale repository paths, malformed model output, and a task-only request. Generated plans must be saved and revalidated before a worker starts.
- [x] **Run red:** `npm run build:test`, then `npm test -- orchestrator-phase-runner orchestrator-plan`.
- [x] **Implement parent inference with scoped leases.** Add the orchestrator task kind/system prompt to the existing engine; use the mutating agent's compaction behavior while preserving operation identity `orchestrator`. Before model admission, acquire repository read/exclusive ownership or validate the task's existing internal ownership token. Planning phases allow repository inspection tools; writing the selected Markdown plan is performed by the host after typed output validation under exclusive repository ownership. Release the planning model lease before upgrading a read lease to write ownership. Review/verification phases may run the specified checks under existing approvals.

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

- [x] **Validate and render plans.** Semantic review checks task coverage, present files/symbols, manageable scope, verification sufficiency, dependencies, and applicable repository instructions. `renderOrchestratorPlan(plan)` renders a complete Markdown goal/constraints/task list with worker, scopes, steps, exact checks, expected results, and acceptance. Preserve valid supplied Markdown; store its compiled manifest/hash as execution evidence. Allow at most two prepare/revise phase attempts before a precise plan-preparation failure.
- [x] **Implement child startup through the server API boundary.** Extract the common server-side worker start from `startRepoAgentRun` into `startRepoWorkerRun`; update all callers. It chooses `taskKind` and effective allowed tools from the selected worker preset, accepts the pre-reserved child UUID, and reuses `RepoAgentSession`/run-store lifecycle. Existing standalone repo-agent routes remain repo-agent workers. A repo-search child receives only its read-only tool surface and normal repo-search execution behavior; reject a selected repo-search profile that grants mutating tools rather than silently treating it as read-only. Acquire the shared repository gate before acquiring a model lease. A delegated child receives a verified internal ownership token from its parent task instead of acquiring the same exclusive gate twice; never accept this token from HTTP/model output. No shell CLI spawning or header bypass.
- [x] **Construct bounded worker instructions.** Implementation work includes exact task ID/heading, plan path/hash, attempt number, allowed files, full task steps and acceptance, verification commands, preservation of existing changes, scratch path, and no commits/no unrelated tasks. Attempt 2 additionally includes observed failure, previous diff/evidence, completed work to retain, and the specific correction. Do not pass only the entire plan and ask the child to choose its task. Drift-fix work instead uses O5b's complete bullet prompt with finding IDs, impact, fix direction, scope, and validation; never generate an extra plan merely to satisfy the implementation-work shape.
- [x] **Implement parent-decided child approvals.** On a child's `approval_required` event the run records the approval target, the child releases its lease, and the parent runs `decideChildApproval` on its own routed model. The parent's decision is forwarded with the exact approval ID and the parent lease is released. The child then re-queues for its model and resumes the same attempt. Under the user's `interactive` approval mode, forward the request to the user instead of the parent phase; under `auto`/LLM modes the parent phase decides. Test with `ParallelSlots=1`, parent on A, and child on B. The observed load order must be `B` (child), `A` (parent approval), then `B` (child resumes). No lease may be held across either wait, and the attempt count and child ID must not change.
- [x] **Test lifecycle and safety.** With `ParallelSlots=1`, parent preparation completes/releases and a child can acquire. A child cannot select an orchestrator worker preset, expand its tools from read-only to full, or bypass nested shell self-call protection. Approval continuation retains the same child ID.
- [x] **Run green:** `npm run build:test`, then `npm test -- orchestrator-phase-runner orchestrator-workers repo-agent-sessions nested-agent-server-reject repo-search-runtime-profile`.

**Acceptance:** The parent owns design/planning; worker instructions are discrete; child execution is ordinary preset-routed execution; no parent model lease survives into child waiting.

### O4: Schedule dependencies, concurrency, and bounded attempts

**Files**

- Create `src/orchestrator/scheduler.ts`, `src/orchestrator/run.ts`, `tests/orchestrator-scheduler.test.ts`, `tests/orchestrator-run.test.ts`.
- Extend `src/status-server/orchestrator-runs.ts`, `src/orchestrator/run-store.ts` only for required state transitions.

**Interfaces**

- `selectReadyOrchestratorTasks(plan, taskStates, activeChildren, maxSubagents)` returns eligible task IDs in plan order.
- `OrchestratorRun` receives concrete store, phase-runner, worker, verification, and workspace dependencies. `start()`, `abort()`, `submitDecision()`, `settled`, and event subscriptions mirror the established server-run lifecycle.
- Completion/verification state updates wake one scheduler drain. Register child subscriptions before relying on their completion; avoid a check-then-subscribe race.

- [x] **Write scheduler tests.** Default cap admits one; cap 3 admits independent read-only tasks; no dependent starts before predecessor verification/cleanup. A mutation task starts only with no active children and holds exclusive ownership through validation/cleanup. While that owner exists, no new reader or writer starts. Global validation commands also take exclusive ownership. Add two-parent/same-repository and standalone-writer-versus-orchestrator cases to prove the gate is server-owned rather than local to one parent. Lock ordering is repository ownership, then model admission; never reverse it.

Use `makeOrchestratorTask` to build the cases. A task is mutating when its worker kind is repo-agent or its verified execution policy can write, not merely when the manifest claims empty write paths. Reject read-only workers with mutating capabilities.

```typescript
assert.deepEqual(startedTaskIds, ['read-a', 'read-b']);
assert.equal(startedTaskIds.includes('write-c'), false);
assert.equal(maxObservedChildren <= configuredMaxSubagents, true);
assert.equal(maxObservedWriters, 1);
assert.equal(readerWriterOverlapCount, 0);
```

These arrays/counters come from scripted worker handles wired to the production scheduler; tests settle handles explicitly rather than waiting on elapsed time.

- [x] **Run red:** `npm run build:test`, `npm test -- orchestrator-scheduler orchestrator-run`.
- [x] **Implement scheduling and attempt reservation.** Compute ready tasks only from completed predecessors. Reserve/persist attempt purpose and child ID, then start that specific child once. Queued/approval-paused children of either purpose count against the cap. On worker completion, schedule independent verification and drift review when code changed; release dependencies only after verification, the current drift gate, and cleanup pass.
- [x] **Implement the fixed implementation retry decision.** The persisted implementation count is authoritative. Use the outcome from O5, not just the worker status. Functional success advances to O5b's gate rather than completing the task immediately.

```typescript
export function nextTaskAction(
  attempt: number, verificationPassed: boolean,
): 'review_drift' | 'retry' | 'fail' {
  if (verificationPassed) return 'review_drift';
  return attempt < ORCHESTRATOR_MAX_ATTEMPTS ? 'retry' : 'fail';
}
```

Schema validation constrains implementation attempt to 1 or 2 before this function. Add tests for `(1,false) -> retry`, `(2,false) -> fail`, and either successful attempt -> review_drift. O5b skips that gate for no code changes. Code-changing unsuccessful attempts also receive drift diagnosis; include accepted findings in the next implementation instruction when a retry remains. The correction budget starts only after functional verification succeeds and cannot become a third implementation attempt. User abort/denied forbidden actions bypass retry and preserve their explicit terminal cause.

- [x] **Test updated retry instructions.** Implementation attempt 1 fails a concrete check. Assert implementation attempt 2 contains that check's actual exit/output evidence and any confirmed drift, retains the successful partial diff, and has a new child ID. After its failure, assert no third implementation `start`, no disguised drift-fix dispatch for the failed implementation, no dependent dispatch, and no hidden parent coding phase. Approval continuation emits no new reservation. A duplicate child completion cannot reserve twice.
- [ ] **Implement plan-change handling.** Rehash the plan before dispatch. Revalidate changes without reducing persisted attempts or silently replaying completed tasks. If a changed plan invalidates completed work or renames task identities, stop with a plan-changed diagnosis requiring a new run rather than reset the budget.
- [x] **Handle terminal paths.** On task attempt 2 failure, stop scheduling immediately, signal owned active children, await their settlement, and retain evidence/changes. On disconnect, keep the parent running. On explicit abort, remove queued admissions and stop active children. Register cancellation before long awaits and check it after readiness.
- [x] **Run green:** `npm run build:test`, then `npm test -- orchestrator-scheduler orchestrator-run orchestrator-run-store model-request-queue`.

**Acceptance:** Concurrency is a cap, mutations are exclusive, dependencies wait for verification/drift/cleanup, and every task has at most two implementation attempts plus its separate two-attempt drift-fix pool across all continuations.

### O5: Independently verify results and clean only owned artifacts

**Files**

- Create `src/orchestrator/verification.ts`, `src/orchestrator/workspace.ts`, `tests/orchestrator-verification.test.ts`, `tests/orchestrator-workspace.test.ts`.
- Extend `phase-runner.ts`, `run.ts`, `run-store.ts` for verification records and cleanup ownership.
- Reuse `src/repo-search/engine/tool-action-processor.ts`, `repo-tools.ts`, and `approval-gate.ts`; modify only to expose recorded execution evidence if the current scorecard omits it.

**Interfaces**

- `OrchestratorWorkspace.captureBaseline()` records dirty tracked/untracked paths and content hashes in the run evidence store.
- `captureAttemptChanges(task, baseline)` returns schema-validated changed-path/diff evidence and scope violations.
- `OrchestratorVerification.verifyAttempt(input)` produces `OrchestratorAttemptResult` containing child purpose/status, independently executed checks, acceptance review findings, and diff evidence. O5b consumes this result before final cleanup/task completion. Keep functional pass/fail separate from whether the drift gate is clear.
- `cleanupOwnedScratch(paths)` accepts only paths recorded as created by this run under its canonical scratch root.

- [x] **Write failing verification tests.** A completed child with a nonzero check fails; an incomplete/missing check fails; an assertion in model prose with no recorded execution fails; a read-only task needs checked path/line evidence; scope drift fails; a successful worker plus independently passing evidence succeeds.

```typescript
assert.equal(result.workerStatus, 'completed');
assert.equal(result.checks[0]?.exitCode, 1);
assert.equal(result.passed, false);
assert.equal(nextTaskAction(1, result.passed), 'retry');
```

Build `result` by passing an actual scripted tool-execution record through `verifyAttempt`; do not construct the expected result directly. The production verifier compares each declared command/cwd/expected exit to its recorded execution, including timeout/abort flags.

- [x] **Run red:** `npm run build:test`, `npm test -- orchestrator-verification orchestrator-workspace`.
- [x] **Implement independent review.** After a worker settles, the parent reads the actual changed files/diff and runs the plan's checks in a new verification phase. Use the ordinary tool/approval path; never call unguarded `executeRepoTool` directly to sidestep approval. Check that every required command really executed with the declared cwd and result; a model's JSON review cannot replace tool evidence. Apply the plan's final checks again at parent closeout, once all tasks finish.
- [x] **Protect the initial dirty baseline.** Compare current changes to the start-of-task baseline, distinguish initial user changes from child changes, and include relevant existing dirty files in the worker instructions. Do not restore pre-existing edits. A scope violation becomes retry evidence; on attempt 2 it becomes a reported terminal failure, not a destructive automatic reset.
- [x] **Implement scratch cleanup with canonical containment.** Use one `scratch` directory under the durable parent run's artifact directory. Resolve existing parents through real paths before deleting; reject the scratch root itself as a supplied arbitrary candidate, parent traversal, sibling prefixes, symlinks/junctions to outside, and unowned paths. Settle child processes before cleanup. Preserve the Markdown plan, task manifests, diffs, logs, and verification records.
- [x] **Test cleanup boundaries with real isolated files.** Create an unrelated dirty file and a run-owned temp file. After cleanup the former is unchanged and the latter is gone. A path outside scratch and a linked path outside scratch both reject without deleting their targets. Failure to delete an owned temp file is recorded and cannot silently complete cleanup.
- [x] **Run green:** `npm run build:test`, then `npm test -- orchestrator-verification orchestrator-workspace orchestrator-run repo-agent-sessions`.

**Acceptance:** Verification can contradict worker success; every completed task has real evidence; cleanup cannot erase unrelated work; retry instructions reflect exactly what failed.

### O5b: Critically review code drift and delegate bounded bullet-based corrections

**Files**

- Create `src/orchestrator/drift-review.ts`, `tests/orchestrator-drift-review.test.ts`, `tests/orchestrator-drift-correction.test.ts`.
- Extend `src/orchestrator/prompts.ts`, `phase-runner.ts`, `run.ts`, `workers.ts`, `workspace.ts`, `verification.ts`, `run-store.ts`.
- Consume the drift/work-purpose schemas defined in O1; keep all request/state types inferred from them.
- Extend `tests/orchestrator-phase-runner.test.ts`, `tests/orchestrator-run-store.test.ts`, `tests/orchestrator-scheduler.test.ts`, `tests/orchestrator-workers.test.ts`.

**Interfaces**

- `OrchestratorPhaseRunner.reviewDrift(input)` returns `OrchestratorDriftReview`. Input contains the task objective, applicable directives, attributable cumulative step diff, current change digest, actual read/touched paths, immediate relevant neighbors, previous findings, and verification evidence.
- `validateDriftReview(review, changes, previousReview)` checks current anchors/digest, attribution, and complete resolution coverage; a malformed or unverifiable report is never treated as clean. Its data arguments use the existing O1/workspace schemas.
- `buildDriftCorrectionPrompt(work: OrchestratorDriftCorrectionWork): string` constructs the direct worker instruction; it does not render or write another Markdown plan.
- `OrchestratorWorkers.start` accepts `work.kind === 'drift_fix'` with `workerPresetId: 'repo-agent'`. It uses `reserveAttempt(..., 'drift_fix')`, the same child cap/repository ownership, and the existing approval/model/abort lifecycle.
- Task completion requires either host-proven `not_required` or a current-digest `clean` report, in addition to functional verification and cleanup.

- [x] **Write failing trigger/scope tests.** Drive the parent through a worker completion. Production source, tests, scripts, deleted/new code, and behavior-affecting config changes trigger review; no diff or solely prose/log changes skip it. Pre-existing dirty files alone do not trigger findings. A retry or correction that changes code is reviewed too. Skip decisions use the original step baseline, not merely the latest correction delta: a no-op correction cannot bypass existing findings. Check the gate after each delegated step, never only at end-of-plan and never between every individual TDD edit/test command.
- [ ] **Write critical-threshold cases.** Accepted fixtures include a duplicated behavior path that will diverge, an obsolete compatibility branch preserving invalid architecture, an IO assertion hiding invalid input, and a needless abstraction with a demonstrably simpler equivalent. Rejected fixtures include formatting/name preferences, an intentionally fixed domain constant, an external-API callback, a necessary state-owning class, allowed `as const`/`satisfies`, speculative future extensibility, and unchanged pre-existing debt. Require the review to explicitly consider these counterexamples before accepting a finding.

Scripted model tests prove schema/evidence filtering and orchestration behavior; they do not by themselves prove the model's judgment. Keep representative positive/negative diff cases for review-prompt evaluation against the configured model during live validation, and report that quality check as unverified if it is not run.

- [x] **Run red:** `npm run build:test`, then `npm test -- orchestrator-drift-review orchestrator-drift-correction`.
- [x] **Implement the focused review prompt.** Port the user-requested skill's rubric from the shared design into `prompts.ts`; do not open a developer-machine skill path at product runtime. The prompt must require introduced/worsened attribution, actual code evidence, a relevant directive, concrete impact or durable maintenance cost, a proportionate fix, and a countercheck against legitimate reasons for the current design. Reviewers must discard weak candidates and may return zero findings. They must not treat three findings as a quota.

For each accepted finding, preserve What/Purpose/Impact/Fix/Context in the stored fields. Rank the full confirmed list by impact. Display its top three plus the remaining count; feed all confirmed findings to correction, not just the visible three. Do not expand a local drift review into an unrelated whole-repository refactor.

- [x] **Validate evidence and review freshness.** Resolve paths under the actual repository, read cited lines, confirm snippets against the captured diff/current code, and verify the issue was introduced or worsened by this step. Review immediate callers/siblings only to establish consequences or a complete fix. A current clean report must account for every prior open finding and match the current change digest. Reject stale anchors before dispatch; re-review without resetting the correction counter. A deleted offending branch can be resolved by verified removal evidence rather than an invented current line.

- [x] **Implement direct corrective prompts.** Use the canonical work payload and include the original task objective plus concrete fix bullets. A representative payload renders as:

```text
Complete these drift corrections for step <task-id>. Preserve working behavior and unrelated edits.
- D1 — <title>
  Evidence: <file:line and short snippet>; directive: <applicable rule>.
  Impact: <specific failure or durable maintenance cost>.
  Fix: <exact replacement/refactor direction and related callers to migrate>.
  Verify: <specific regression/check and expected result>.
- D2 — <next confirmed issue, only when one exists>
Allowed files: <bounded paths, including required immediate callers/tests>.
Run the listed checks and report changed files, results, and unresolved items.
Do not create a new implementation plan, commit, or perform unrelated cleanup.
```

The angle-bracket values above are interpolated from validated findings/task evidence at runtime. Do not send these labels without their actual values. Use the full fix direction in the prompt, not merely “fix drift”. If a behavioral defect is involved, reproduce it with a failing regression test first; for a structural-only correction, use meaningful existing behavior checks plus typecheck/lint instead of inventing tests that mirror syntax.

The construction can remain an ordinary function:

```typescript
export function buildDriftCorrectionPrompt(work: OrchestratorDriftCorrectionWork): string {
  const bullets = work.findings.flatMap(finding => [
    `- ${finding.id}: ${finding.title}`,
    `  Evidence: ${finding.evidence.map(item => `${item.path}:${item.line} ${item.snippet}`).join('; ')}`,
    `  Directive: ${finding.directive}`,
    `  Purpose: ${finding.purpose}`,
    `  Impact: ${finding.impact}`,
    `  Fix: ${finding.fix}`,
  ]);
  const checks = work.verification.map(check => check.kind === 'command'
    ? `- Run ${check.command} in ${check.cwd}; expected exit ${check.expectedExitCode}.`
    : `- ${check.instruction}; inspect ${check.paths.join(', ')}.`);
  return [
    `Resolve only the confirmed drift in step ${work.taskId}. Objective: ${work.objective}`,
    ...bullets,
    `Allowed files: ${work.allowedPaths.join(', ')}`,
    'Verify the corrections and preserve the original task acceptance:', ...checks,
    'Preserve successful work and unrelated edits. Do not create a new plan or commit.',
    'Reproduce behavioral defects with a failing regression test before fixing them.',
    'Use existing behavior checks for structural-only changes; avoid tests that mirror implementation.',
    'Report changed files, verification results, and unresolved findings.',
  ].join('\n');
}
```

Build `work.verification` as the deduplicated union of relevant original task checks and finding-specific checks. Put new failure evidence from correction attempt 1 into the existing worker instruction envelope for attempt 2. Preserve initial code/context evidence in run storage even when source anchors have moved.

- [x] **Integrate the separate bounded correction cycle.** After functional success, an actionable review transitions to `correcting_drift`. Reserve one correction child under the original task and purpose `drift_fix`; release the parent's model lease, retain/reuse the task's exclusive repository ownership, and count the child against `maxSubagents`. After it settles, run affected functional checks and review the cumulative step diff again. A clean current result advances to cleanup/completion. Otherwise use correction attempt 2 with updated evidence, then fail with `drift_unresolved` if the gate still fails.

All findings, newly introduced correction drift, correction test failures, and re-reviews share that step's one two-attempt correction pool. Do not reset it on a new finding/report, create another remediation task, or let the parent apply a third hidden fix. A functionally failed original implementation stays on its original retry/stop path; drift corrections cannot be used as extra implementation attempts.

- [x] **Test both counters and actual dispatch payloads.** A step that used implementation attempt 2 can still start drift-fix attempt 1. Assert the correction worker is `repo-agent`, gets actual finding/fix bullets, and starts without writing/attaching a second plan file. Corrections can resolve issues on attempt 1 or 2; a second failed correction stops with unresolved evidence and no fifth child for that task. The existing two-attempt implementation-failure test still stops after its two implementation children.

```typescript
assert.deepEqual(dispatched.map(child => [child.work.kind, child.attempt]), [
  ['implementation', 1], ['implementation', 2],
  ['drift_fix', 1], ['drift_fix', 2],
]);
assert.equal(savedPlanPaths.length, 1);
assert.equal(parentState.phase, 'failed');
assert.ok(parentState.failure);
assert.equal(parentState.failure.code, 'drift_unresolved');
assert.equal(dependentTaskStarted, false);
```

Use the production parent/store with scripted worker/review results: the final correction is deliberately still actionable in this case. Add a zero-finding case with only one implementation child and no correction, and a success case that releases dependencies only after fresh checks/review/cleanup.

- [ ] **Test repeated/recovery boundaries.** Cover more than three confirmed findings (display cap only), correction-introduced drift, a clean report for an older digest, a duplicate correction completion, reconnect during correction, approval continuation, a new finding after correction attempt 2, and abort while a correction waits for the model. Neither counter changes on attach/approval replay; changed code cannot inherit a previous clean result.
- [x] **Run green:** `npm run build:test`, then `npm test -- orchestrator-drift-review orchestrator-drift-correction orchestrator-run-store orchestrator-scheduler orchestrator-workers orchestrator-phase-runner`.

**Acceptance:** Every completed code-changing delegated step has an evidence-backed critical review; non-impactful candidates cause no corrective dispatch; actionable findings are fixed through bounded `repo-agent` bullet prompts and verified/reviewed again; both budgets and dependency gates survive recovery.

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

Define request/response/event schemas in the existing contracts module from O1. Results distinguish completed, approval-required, failed, aborted, and interrupted with task/attempt-purpose/attempt/child IDs and actionable failure evidence. Include drift-review/correction phase events, both attempt counts, reviewed digest, and unresolved findings. Parent SSE heartbeats use the existing transport constant, and events are committed before delivery.

- [x] **Write failing HTTP and CLI tests.** Exercise task-only, `--plan`, custom orchestrator preset, invalid body/flag, duplicate start, reconnect with cursor, approval for a stale/wrong child, abort while queued, and status after completion. `--model` follows the strict routing contract if exposed; do not add an unvalidated override path.

Expected user-visible invocation forms:

```text
siftkit orchestrator "Implement the requested feature" --repo-root C:\repo
siftkit orchestrator --plan docs/superpowers/plans/change.md --repo-root C:\repo
siftkit orchestrator status <run-id>
siftkit orchestrator decide <run-id> <execution-id> <approval-id> approve
siftkit orchestrator abort <run-id>
siftkit preset --preset orchestrator --prompt "Implement the requested feature"
```

These commands describe the product interface to implement. Use the currently available `repo-agent` for implementation tasks, not the future orchestrator interface before it is complete.

- [x] **Run red:** `npm run build:test`, then `npm test -- orchestrator-http orchestrator-cli orchestrator-args cli-preset`.
- [x] **Implement routes and client with schema parsing.** A start request reserves the parent before launching work. CLI starts with JSON, then subscribes to the event endpoint using the existing SSE framing. A cursor is a validated nonnegative integer bounded by committed history. Decisions are forwarded only to the parent's current recorded phase/child approval; no command-string evaluation. The result supplies the exact execution ID and decision command, so the CLI need not guess whether it names a phase or child. Test both parent verification approvals and child approvals. CLI parses typed results, never treats process exit alone as worker completion.
- [x] **Dispatch preset execution without an outer model lock.** `presetKind === 'orchestrator'` routes to the parent service before ordinary `StreamedOperationEndpoint` admission. Refactor the endpoint's existing branch ownership so ordinary presets still use the shared admitted path; the orchestrator envelope itself acquires no model lease. Do not fake an orchestrator as one repo-search request or one long-held repo-agent lock.
- [x] **Preserve cancellation semantics.** Dropping a CLI/Web subscription detaches it, while explicit abort cancels the run. Propagate approval-required state with exact run/task/attempt-purpose/attempt IDs. Approval continuation keeps purpose, attempt, and child identity unchanged for both implementation and drift-fix children. Return failure details for interrupted runs instead of restarting them on status reads.
- [x] **Run green:** `npm run build:test`, then `npm test -- orchestrator-http orchestrator-cli orchestrator-args cli-command-catalog cli-preset cli-help streamed-repo-agent-endpoint`.

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
- `OrchestratorRunPanel` consumes canonical parent/task state and typed start/decide/abort actions. It shows child run links, verification evidence, and critical drift findings rather than duplicating child transcripts. Distinguish implementation and correction attempt counts; a completed implementation child is still pending while drift is reviewed/resolved.
- The parent envelope identifies the orchestration. Individual parent inference phases and child runs carry actual model usage; total metrics count each underlying inference once.

- [x] **Write failing settings and chat tests.** Show concurrency only for orchestrator presets, default 1, valid save/reload, invalid noninteger/zero rejection. Selecting an orchestrator changes the action to “Run orchestrator”. Reload must attach to the existing parent; stop must abort its children. Surface “Implementation attempt 1 of 2”/“Drift correction 1 of 2”, plan path, failed checks, and required approval. Show “No actionable drift” for a clean review, or up to three confirmed findings plus the remaining count, with concrete impact/fix/evidence. Do not present dismissed cosmetic suggestions as a user action list.

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

- [x] **Run red:** `npm run build:test`, then `npm test -- dashboard/tests/orchestrator-run-panel.test.tsx dashboard/tests/chat-tab.test.tsx dashboard/tests/presets-section.test.tsx`.
- [x] **Implement the parent operation UI/transport.** Reuse existing chat submission IDs, journal/broadcast attachment, approvals, and stop ownership. Link the chat operation to one orchestrator parent run and forward its committed phases/task summaries. Preserve the current uncommitted recovery/reattachment changes; extend their contracts, not a parallel Web operation path.
- [ ] **Keep per-phase model evidence accurate.** A parent can plan on A, wait while a child runs on B, and review on A or inherited B. Do not label the entire orchestration with the chat's creation model. Record actual model snapshots on inference phases and existing child runs. The parent has no additional inference usage just for supervising; derived aggregate views must not add their totals again to global metrics.
- [ ] **Test cross-surface lifecycle.** Start in Web, read in CLI/status, reload Web, approve once, and verify only one child continues. Repeat during a drift correction and verify neither budget resets, the reviewed digest/findings persist, and dependents remain gated. Stop during a child queue wait removes that waiter. A terminal run no longer shows running even if its old SSE socket reconnects.
- [x] **Run green:** `npm run test:dashboard`, then `npm test -- orchestrator-http status-server-chat-operation-attach status-server-chat-stop inference-throughput-operations`.

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
| Code changed with no impactful drift | Review runs; no manufactured findings and no correction child |
| Cosmetic or pre-existing debt only | No actionable finding or correction dispatch |
| Confirmed code drift | `repo-agent` gets bounded findings/fix bullets without a second plan file |
| Implementation succeeded on attempt 2 | Separate drift-correction attempts 1 and 2 remain available |
| Correction introduces drift/regression | Revalidate/review; reuse the same correction pool; no recursive new budget |
| Second correction fails | Stop with unresolved evidence; no third correction or hidden parent fix |
| No-op correction or stale clean review | Existing findings/change digest keep the task gate closed |
| Parent A / child B / one model slot | Parent releases before child; no deadlock; routing stays consistent |
| Child approval with parent A / child B / one slot | Child parks and releases B; parent loads A and decides; child reloads B and continues the same attempt |
| Resident-model queue | Another B worker can precede an A review; no fairness exception |
| Reconnect/duplicate submit/approval | Stable parent/child IDs and attempt count |
| Abort/restart boundaries | No orphan active worker, no uncertain automatic redispatch |
| Dirty files and scratch | Initial user edits survive; owned temps removed; artifacts retained |
| Smaller/vision-incompatible model | Context/image checks use admitted phase/worker model |

- [x] **Pin the two-attempt boundary at real dispatch.** Record worker starts and terminal verification results through the production parent service.

```typescript
assert.deepEqual(dispatched.map(child => child.attempt), [1, 2]);
assert.equal(new Set(dispatched.map(child => child.childRunId)).size, 2);
assert.equal(parentState.phase, 'failed');
assert.equal(dependentTaskStarted, false);
assert.equal(activeChildCount, 0);
```

This scenario has two functionally failed implementation attempts, so no corrective child is eligible. In the success variant, implementation attempt 2 passes, its task becomes completed only after the current drift gate and cleanup pass, and the dependent task receives its first attempt. Add O5b's four-dispatch scenario to prove two implementation attempts and two correction attempts are independently bounded, and neither counter resets on re-review/reattachment.

- [x] **Document operation rules.** Explain model inheritance, concurrency as a cap rather than a promise of parallel modifications, separate two-attempt implementation/correction budgets, plan output location, verification evidence, approvals, reconnect/abort, and interrupted-run recovery. Explain the critical drift threshold, valid zero-finding outcome, direct bullet-based `repo-agent` fixes, and review after correction. Document the difference between a completed child and a completed task. Keep CLI help and Web labels consistent.
- [x] **Run focused then full gates.**

```powershell
npm run build:test
npm test -- orchestrator preset-model-routing model-request-queue preset-runtime-coordinator repo-agent-sessions nested-agent-server-reject
npm test
npm run test:dashboard
npm run typecheck
npm run lint
```

- [x] **Review the implementation against every confirmed requirement.** Verify actual tool policies, not only prompts; check parent lease release, child cap ownership, both durable attempt counters, drift trigger/scope/evidence freshness, rejection of cosmetic/speculative findings, bullet-only correction dispatch, plan-change handling, approval-denial behavior, and no duplicate model/usage identities. Remove obsolete replaced paths and task-owned temp files. Do not commit or revert unrelated changes.
- [x] **Report outcome and limits.** List changed areas, command evidence, failures, and any unverified live-model behavior. Keep the initial user-requested scope; defer unrelated agent-framework, distributed scheduling, or worktree features.

**Acceptance:** All three requested features and the critical post-step drift gate work together across CLI/Web and failure/recovery boundaries; model scheduling, bounded implementation/correction delegation, independent verification, and preservation of user work are demonstrated by tests.

## Delivery status (2026-09-23)

Delivered O3–O8 as ticked above. Open boxes are not done, or only partly done.

**Deviations from the plan text**

- **Web transport.** The Web client uses the dedicated `/orchestrator` routes and does not use a chat-journal operation kind:
  - `POST /orchestrator` starts a run.
  - `GET /orchestrator/runs?repoRoot=` lists runs; reloading the page reattaches to the newest one.
  - `GET /orchestrator/status` reads one run.
  - `POST /orchestrator/events` is SSE with a cursor.
  - `POST /orchestrator/decide` answers an approval.
  - `POST /orchestrator/abort` stops a run.

  The chat tab's orchestrator mode renders `OrchestratorRunPanel` from this state.
- **`/preset/run`.** It rejects orchestrator presets with 400 and names `siftkit orchestrator`. It does not route to the parent service.
- **Artifacts.** They live in the repository under `.siftkit/orchestrator/<runId>/`: `plan.md` for a generated plan, and `scratch/` for task temp files.
- **Subagent cap.** The cap counts tasks, not child processes. A task holds its slot through verification, drift review, and correction.
- **Parent-decided child approvals.**
  - A parked approval releases the child's model lock through `ApprovalParkLease`. `ApprovalGate` parks it, and `RepoAgentSession` releases and later re-acquires the lock.
  - With `auto`, the parent's `decideChildApproval` phase loads the parent model and answers. The child then re-queues for its own model and continues the same attempt.
  - With `interactive`, the request goes to the person.
  - The observed load order is pinned as B, A, B in `tests/process/orchestrator-run.e2e.test.ts`.

**Not delivered or partial**

- **Plan changes.** The plan file is not rehashed before each dispatch. The run store does reject a changed plan that drops or renames a task that already has attempts.
- **Drift-review threshold.** There are no fixtures for the accepted and rejected cases. The rubric lives in the prompt, and `validateDriftReview` rejects stale, unattributable, or fabricated evidence.
- **Model evidence.** Per-phase model snapshots are not added to aggregate chat views.
- **E2E matrix.** Not tested yet:
  - cap 3 with parallel reads
  - a model queue that already has the model loaded
  - a model too small or without vision support
  - a no-op correction after a stale clean review
  - a cross-surface Web → CLI → Web lifecycle

  The covered cases are the 9 tests in `tests/process/orchestrator-run.e2e.test.ts`.
- **Live models.** Behavior against a real model has not been verified. Every test uses scripted engine responses.
