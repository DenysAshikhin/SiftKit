# Preset model routing, resident-model scheduling, and orchestration

Status: implementation design; product code is unchanged. Based on the working tree inspected on 2026-09-22, including its existing uncommitted chat/runtime changes.

## Confirmed requirements

1. Every operation preset can select a model. Its default is the model currently active when execution is admitted.
2. A different requested model is unloaded/loaded before execution. The selected model remains active afterward.
3. After a request finishes, prefer waiting requests for the resident model, even when they arrived later. Continue until there are no matches. There is **no fairness override or aging threshold**.
4. Existing chat sessions also use the current model for each new operation when their operation preset inherits it.
5. Add an `orchestrator` preset. It accepts a task or implementation plan, validates an existing plan, writes a Markdown implementation plan when needed, delegates tasks to `repo-agent` or `repo-search`, verifies each result, and cleans up owned temporary artifacts.
6. `maxSubagents` is the maximum concurrent children, default **1**. Serialize modifications in the shared checkout; independent read-only children can run concurrently.
7. Each executable task has at most **2 child attempts**. After the first failure, update instructions from the failure evidence and dispatch once more. After the second failure, stop. An approval continuation remains the same attempt.

## Project constraints

- TypeScript throughout; parse IO with Zod and derive types with `z.infer`.
- No `any`, type assertions, non-null assertions, namespace imports, or schema-duplicating types.
- Reuse existing runtime, inference, approvals, tool execution, run logging, and chat transport.
- No worktrees; preserve unrelated changes; no commits without a separate request.
- Explicit versioned migrations; no runtime compatibility readers or silent invalid-reference fallback.
- TDD for implementation. Run relevant tests, broader applicable suites, `npm run typecheck`, and `npm run lint` before implementation closeout.
- Do not invoke SiftKit to execute this implementation plan. This is a planning-only request.

## Design decisions

These are implementation defaults proposed by this design, rather than additional user requirements:

- The selector references an existing `Server.ModelPresets.Presets` entry. This reuses model paths, endpoints, context sizes, loading settings, and samplers.
- Store `SiftPreset.modelPresetId: string | null`; `null` means **Current model**. Never store a copy of the current ID as the default.
- Persist a successful automatic selection as `ActivePresetId`, so a config read or server restart does not silently restore the previous model. A newer explicit settings change wins over an automatic writeback.
- “Same resident model” means the same backend loading configuration, not just the label or model name. Profiles with identical loading requirements but different samplers can share residency.
- Keep existing idle unload behavior. Unloading for idle does not change which model is selected; a later inherited request reloads that selection.
- A task is the retry unit. Its implementation steps remain inside one bounded worker dispatch, rather than receiving separate retry budgets.
- Once an orchestrator request is submitted, plan generation/validation and execution proceed within that request's authorization and existing approval mode. Normal tool approvals still apply.
- Generated plans live at `docs/superpowers/plans/<date>-orchestrator-<run-id>.md`. Durable orchestration evidence is separate from a single run-owned scratch directory.

## Current implementation anchors

| Responsibility | Current owner | Required change |
|---|---|---|
| Operation/model schemas | `packages/contracts/src/config.ts` | Reference field, orchestrator kind/options, strict reference checks |
| Built-in operation catalog | `src/preset-catalog.ts` | Defaults and orchestrator entry |
| Config storage/upgrades | `src/status-server/config-store.ts`, `src/state/runtime-db.ts` | Explicit catalog migrations, conditional active-selection writeback |
| Applied model state | `src/status-server/applied-model-preset-state.ts` | Continue as the live selection authority |
| Lifecycle transitions | `src/status-server/preset-runtime-coordinator.ts` | Targeted readiness before admission; safe writeback/rollback |
| Backend residency | `src/status-server/managed-tabby.ts`, `src/inference-presets/exl3-preset-adapter.ts` | Shared loading identity; retain actual backend lifecycle behavior |
| Global request queue | `src/status-server/server-ops.ts`, `server-types.ts` | Resident-model selection and an admitted execution snapshot |
| CLI operation execution | `routes/streamed-operation-endpoint.ts`, `routes/operations.ts`, `routes/repo-search.ts`, `preset-runner.ts` | Resolve preset before admission; consume admitted configuration |
| Long-lived worker runs | `src/status-server/repo-agent-sessions.ts`, `repo-agent-lock-adapter.ts`, `routes/repo-agent.ts` | Carry operation selection into admission and expose admitted config |
| Chat model snapshots | `src/status-server/chat.ts`, `routes/chat.ts`, `chat-repo-operation-runner.ts` | Historical evidence only; rebind each admitted operation |
| Early image admission | `src/status-server/routes/chat-session-operation-endpoint.ts` | Separate input validation from model-dependent admission |
| Preset editor | `dashboard/src/tabs/settings/PresetsSection.tsx` | Model selector and orchestrator concurrency setting |
| Nested-call protection | `src/status-server/nested-agent-call-guard.ts` | Retain shell self-call rejection; use server-owned child creation |

Paths in the table's abbreviated rows are relative to `src/status-server/`.

## A. Preset model selection

### Resolution

Resolve the operation preset ID before joining the queue. Resolve its saved model assignment when the scheduler considers the request. Use the validated saved configuration for that admission decision, then freeze one execution snapshot through the entire admitted operation.

The explicit CLI `--model` override remains highest priority. Match it against the selected profile's `Model` first; otherwise require exactly one configured model profile with that `Model`. An unknown or ambiguous value is a request error, not a string overlay that claims to load an unconfigured model. Document this intentional tightening of the current CLI behavior.

For a request with no operation preset, such as ordinary passthrough, inherit the current selection unless its existing explicit model argument selects a configured profile. Internal calls already inside an admitted run reuse that run's snapshot and lease; they do not start nested admission.

### One execution snapshot

The granted model lease carries the selected operation preset (nullable for non-preset requests), full model preset, residency key, and effective `SiftConfig`. Every provider request, token/context calculation, image capability check, tool policy, and run identity consumes that snapshot.

Remove post-admission reads/overlays that can silently substitute a different model: old chat snapshots, a second preset resolution, late `--model` overlays, or a host-settings cache from a previous model. Preserve per-session reasoning toggles where already supported.

For a chat, update session model metadata after admission. Prior transcript/run identities retain the models that actually produced them. Parse uploaded image IO at submission; evaluate model-dependent vision limits against the admitted target, including queued messages, forced successors, plan/search/agent operations, and condensation. Do not relabel historical turns.

### Lifecycle and failure

Perform transitions before granting a request lock. Never grant a lock and then wait for a transition that requires that same lock to drain.

Use the existing coordinator's transition mechanism. The runtime provides a canonical residency key built from the adapter's load request and managed launch environment, endpoint, backend, and lifecycle ownership. Exclude labels and per-request samplers; include model path, context/cache, parallel slots, speculation, and vision loading settings through the adapter outputs. Do not maintain a second field list.

If the key already matches and the runtime is ready, do not unload/reload. Different per-request settings remain frozen on individual leases. A different key waits until all active requests finish. Recalculate capacity from the newly applied profile before granting requests.

Successful transitions update the live selection and conditionally persist `ActivePresetId` against the configuration observed at transition start. Read and merge the latest configuration; never overwrite unrelated edits. A newer active-selection or target-profile edit is a pending intent for the next safe boundary, not permission to change an already admitted run.

On load failure, fail the requesting operation without executing it. Attempt the existing physical rollback. Any config rollback must also be conditional on the failed intent still being current. Report both load and rollback errors, release admission blockers, and allow later viable requests to proceed. Do not execute a failed request on the rollback model.

Managed/external Tabby lifecycle behavior remains owned by `ManagedTabbyRuntime`. A local server without a runtime coordinator cannot claim to switch physical models: inherited requests retain the existing path; requests requiring a different resident model fail clearly. A relay that cannot command its remote host also fails an explicit mismatching selection rather than pretending a local overlay switched it.

## B. Resident-model queue scheduling

Keep one global queue and the existing capacity limit. Replace FIFO selection with this algorithm:

1. Remove cancelled/expired entries and fail invalid preset references individually.
2. If an administrative transition is already in progress, wait for its completion.
3. Resolve queued candidates against the current saved config and applied model. Inherited requests match the applied model at this decision, not at enqueue time.
4. Choose the oldest candidate whose residency key matches the applied model.
5. If none matches and requests remain active, leave unused capacity idle; wait for active requests to drain.
6. If none matches and the active count is zero, choose the oldest remaining candidate and switch once to its target.
7. Grant compatible requests in arrival order up to the applied capacity, freezing each lease's execution snapshot. Repeat selection on arrivals, releases, cancellation, config updates, and transition completion.

Once a transition starts, a later arrival cannot reverse it. One event-driven drain owns selection/transition/grant; reentrant wakeups request another pass instead of starting another transition.

Example: A is resident; the waiting arrival order is `B1, A1, C1, A2`. Execution order is `A1, A2, B1, C1`, assuming one slot and no later arrivals. `B1, inherit1, A1` runs `inherit1, A1, B1`.

The user intentionally accepts starvation of other models under a continuous matching workload. Existing explicit cancellation and queue timeout still apply. Do not add fairness counters, age-based switching, or a bypass limit. Queue diagnostics distinguish arrival order from eligibility; never describe an arrival index as a guaranteed execution position. A skipped request's deadline is not reset merely because another matching request was chosen.

## C. Orchestrator

### Scope and interface

Add the built-in operation preset `orchestrator`, kind `orchestrator`, operation mode `full`, CLI and Web surfaces, `modelPresetId: null`, and `orchestrator: { maxSubagents: 1 }`. Other presets carry `orchestrator: null`; reject invalid combinations. Custom orchestrator presets may select their own model and concurrency.

Use one server-owned `OrchestratorRun` implementation behind a dedicated HTTP lifecycle and both entry surfaces:

- CLI: `orchestrator <task> [--plan <path>] [--preset <id>] [--approval <mode>]`, plus `status`, `decide`, and `abort` controls.
- `preset --preset orchestrator ...` dispatches to the same lifecycle; it never enters a wrapper that holds a model lock for the entire orchestration.
- Web: choosing an orchestrator preset runs the same service and shows plan path, task/attempt state, child runs, approvals, and validation evidence. Reload attaches to the existing run.

The request supplies a task, a plan path, or both. With no explicit path, a clearly referenced or unambiguously relevant plan found during repository inspection can be selected; otherwise generate a new plan. Never execute an unrelated file merely because it is a Markdown plan.

### Plan preparation

The parent inspects the repository and applicable instructions using its own inference phases. `repo-search` children extract facts; they do not author the orchestration plan or choose architecture.

Validate an existing plan semantically against the task and current repository: scope, required paths/symbols, dependencies, discrete steps, worker kind, tests, expected outcomes, acceptance criteria, cleanup, and constraints. Also validate the resulting task graph deterministically: unique IDs, no cycles/missing dependencies, supported worker preset kinds, bounded scopes, and nonempty acceptance/verification instructions.

A valid supplied plan is preserved. If missing or inadequate, write a corrected standalone Markdown plan with source attribution, then validate it before dispatch. Do not overwrite a supplied plan by default. Store the validated task manifest, source content hash, and plan path as run evidence. The manifest is derived execution state, not a separately editable competing plan. Detect plan edits before each dispatch; pause for revalidation, without resetting task attempt counts.

Each task defines: ID/title, dependency IDs, worker preset ID (`repo-agent` or `repo-search` kind), file scope, ordered implementation/investigation steps, exact verification commands or read-only evidence checks, acceptance criteria, and cleanup expectations. Product code steps require red/green verification instructions.

### Supervision and model leases

The orchestration service is a durable state machine: `preparing_plan -> validating_plan -> executing -> verifying -> cleaning -> completed`, with explicit `approval_required`, `failed`, and `aborted` outcomes. Task states and attempts are durable separately from the parent phase.

Parent model calls are finite inference phases under the orchestrator preset. Release the parent model lease before starting or waiting for children. Children acquire ordinary model leases using their selected worker presets. Parent review phases join the same resident-model queue; they receive no secret priority exception. Waiting for children uses their completion/progress promises and subscriptions, not polling.

The host scheduler creates children directly; the model cannot forge ancestry or invoke a shell command to bypass nested-call protection. Do not expose recursive orchestrator children. Reuse the repo-agent lifecycle for mutating workers and the existing repo-search engine for read-only workers, with typed parent/task/attempt correlation.

### Concurrency and verification

Count dispatched, queued, running, and approval-paused children toward `maxSubagents`; a child slot is released at its terminal state. Independent read-only tasks may overlap. A mutating task has exclusive repository ownership: it runs without other children reading or modifying that checkout. Hold that ownership through independent verification and cleanup. Repository-mutating validation commands also require exclusive ownership. The server registry owns this gate per canonical repository root across parent runs; a second orchestrator cannot acquire a separate writer gate for the same checkout. Server-owned standalone mutating workers also respect it. Acquire repository ownership before model admission to avoid holding a model while waiting for a writer's verification.

Treat both the child terminal status and independent verification as authoritative inputs. A process exit code or prose claim of success cannot complete a task. The parent reviews changed files/diff against the pre-attempt baseline, executes the plan's verification, and checks acceptance criteria before releasing dependencies. Read-only tasks require cited, checked repository evidence rather than a fabricated test command.

On first task failure, retain its diff and evidence, update the instruction with the exact observed failure and remaining acceptance criteria, and start attempt 2 against the current checkout. The second instruction explicitly preserves successful partial work and forbids restarting unrelated tasks. On a second failure, stop scheduling, settle/cancel owned active children, preserve changes and evidence, and report the failed task. No third attempt, hidden parent implementation attempt, or automatic plan rewrite that resets the budget.

Approval pauses resume the same attempt. Record whether each approval belongs to a parent inference phase or a child, with its exact execution and approval IDs. A denial must not be evaded by redispatching the same forbidden action. Abort cancels queued model requests and active children and waits for their owned processes to settle before cleanup.

### Persistence, cleanup, and recovery

Persist parent ID, plan hash/path, task manifest, dependency/task state, attempt number, child run IDs, approval IDs, verification results, and sequence-numbered events before their external effects are reported. Reserve an attempt and child ID before dispatch; a disconnect cannot dispatch it again.

A Web reload or CLI reattachment subscribes to the existing run. A server restart marks an interrupted run explicitly and reconciles child states; it never silently reruns uncertain modifications. Resumption must retain attempt counts and reconcile the current diff before further work.

Capture the initial dirty-file baseline, retain user edits, and keep generated plans and durable run evidence. Remove only run-owned temporary artifacts after their processes settle. Reject cleanup paths outside the canonical scratch root, including traversal and symlink/junction escapes. Never use Git reset/clean or restore unrelated changes.

## Delivery and acceptance

Implement the linked plans in order:

1. `../plans/2026-09-22-preset-model-routing.md`: schema/migration, target resolution, lifecycle, resident-model queue, all operation surfaces, settings, integrated validation.
2. `../plans/2026-09-22-orchestrator-preset.md`: contracts/state, plan preparation, workers, supervision/retries, verification/cleanup, CLI/Web, integration.

End-to-end acceptance includes A/B routing and sticky selection, `B,A,C,A` queue reordering, an old chat using the newly active model, an existing valid plan, generated/repaired plans, read-only concurrency, serialized mutations, exactly two failed attempts, approval continuation, disconnect/abort/restart recovery, and preservation of pre-existing edits.

The principal accepted operational tradeoff is unbounded model affinity: a parent review or other-model request can wait until no matching request remains, subject to its normal timeout. Do not hide that condition as a hung worker.
