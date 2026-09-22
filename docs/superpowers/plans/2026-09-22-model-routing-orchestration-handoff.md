# Model routing and orchestrator handoff

## Pause state

The user requested: **after the current repo-agent finishes, pause and provide enough information to continue in a fresh session.** That run has finished. Do not start another task until the user resumes the work.

- Repository: `C:/Users/denys/Documents/GitHub/SiftKit`; PowerShell; branch `main`.
- Latest implementation checkpoint: `afc4dc888fd58c59126b94c67cd32006be61e57c` — **unverified M4-C1 work, not an accepted task**.
- The worker returned JSON `status: completed`, but its own final report says acceptance remains unresolved. Its last focused test run had **75 tests: 66 passed, 8 failed, 1 cancelled**. It made additional fixes afterward without rebuilding, retesting, or running final typecheck/lint.
- The primary checked file scope and `git diff --check`, then committed the partial work for a clean continuation baseline. The primary has **not** independently validated or fully reviewed the M4-C1 implementation, including critical drift, at this final revision. No new tests were launched after the user's pause request took effect.
- No repo-agent from this execution remains active. The completion event listener exited. No next task or correction has been dispatched.
- Worker run: `52550c50-27c6-41f4-9f1b-9f6b1a155392`; terminal revision 2 at `2026-09-22T17:05:55.502Z`.
- Engine/transcript run: `bc685cc3-7708-4990-a2cf-91eb56965abe`; 59.8 minutes, 101 turns, no human approval wait.

## Read these plans

1. [Master plan and confirmed decisions](2026-09-22-model-routing-and-orchestration.md).
2. [Routing tasks M1–M7](2026-09-22-preset-model-routing.md).
3. [Bounded M4 continuation: M4-C1 and M4-C2](2026-09-22-model-admission-continuation.md).
4. [Orchestrator tasks O1–O8, including O5b](2026-09-22-orchestrator-preset.md).
5. [Shared design/specification](../specs/2026-09-22-preset-model-routing-and-orchestration-design.md).

The continuation document refines the unfinished M4 work. It does not authorize executing M4-C2 before M4-C1 is accepted.

## User decisions and execution rules

- The original planning-only request said not to use SiftKit. The user subsequently explicitly authorized proceeding through the tasks using **repo-agent**. That later authorization controls implementation.
- The latest implementation preference is: **give fixes and other implementation work to repo-agent instead of doing them in the primary**. This supersedes the supplied AGENTS fallback that said to finish failed/rejected work directly. Earlier primary fixes to M1–M3 happened before this steering. Since then the primary has only planned, reviewed, validated, monitored, and committed.
- The primary owns architecture, decomposition, acceptance, plans, and final decisions. Never ask SiftKit to plan or choose architecture. Dispatch bounded implementation tasks or concrete correction bullets from a written plan.
- Commit between tasks. **Every repo-agent dispatch starts with clean Git porcelain output.** A failed/partial task may have an explicitly labelled unverified checkpoint, as this one does; never treat that as acceptance.
- No worktrees, destructive Git operations, stash/reset/restore, unrelated refactors, or nested workers. Preserve unrelated changes. Workers do not commit.
- Use SiftKit-first repository discovery. Raw reads are permitted for explicitly named files, narrow follow-ups, exact diagnostics, validation, and non-interpretive Git state. Only `summary`, `repo-search`, `repo-agent`, and help SiftKit commands are authorized.
- Wait for each SiftKit operation. Run tasks sequentially. Parse JSON status; CLI exit 0 is not sufficient. Continue a pending approval through the returned `decide` command rather than redispatching the task.
- Give SiftKit invocations a 15-minute CLI observation timeout. **A CLI timeout does not stop the server-owned worker.** Reattach to the existing run and wait; do not duplicate it. Use completion/approval event notification rather than polling SiftKit. The user explicitly asked to let workers finish.
- All product code/tests TypeScript; infer from runtime schemas. No `any`, casts, non-null assertions, namespace imports, unvalidated IO, compatibility shims, or duplicated alternate paths. Keep comments to one or two lines. Use TDD, meaningful regressions, independent primary verification, relevant broader tests, typecheck, and lint.
- Review code-changing tasks with the critical threshold from `C:/Users/denys/.codex/skills/reflect-session-drift/SKILL.md`: concrete impact or lasting architectural/style drift only. Do not manufacture cosmetic findings. Delegate material corrections to repo-agent.
- Keep controller artifacts in the existing ignored scratch directory. Preserve them while paused; clean owned temporary artifacts when the overall task is finished.

## Product behavior to preserve

1. Each operation preset references a saved model preset or null. Null means the **currently applied model when each operation is admitted**, including operations in an existing chat. Load a different required model and leave it selected afterward.
2. The queue chooses the oldest request compatible with the resident model before older requests for another model. When no compatible work remains, drain active work and choose the oldest remaining request. **There is no starvation/fairness override**, by explicit user decision. Preserve compatible-group FIFO, cancellation, and ordinary timeouts.
3. New `orchestrator` preset, default `maxSubagents: 1`, accepts a task or plan. It validates an existing plan or writes a Markdown implementation plan, delegates bounded steps to repo-agent/repo-search, independently validates, and cleans owned artifacts. Serialize modifying workers; parallelize independent reads. No worktrees.
4. Each orchestrator implementation step has at most two attempts: one initial dispatch plus one retry with updated instructions.
5. After a code-changing step, perform a critical drift review. Correct confirmed issues through repo-agent with actionable bullets; a separate full Markdown correction plan is unnecessary. Each step has a **separate two-attempt correction budget**, shared across findings and re-reviews. Revalidate before dependent work advances.
6. Per-task commits and clean baselines are this implementation session's workflow, not an added automatic-commit feature of the future orchestrator.

## Completed work and commits

| Task | Commit | Accepted result |
|---|---|---|
| M1 | `9b00ec3e8b328358f133c64fc405e3218ef23df5` | Strict required nullable `modelPresetId`; model-reference validation; schema 74→75 migration; defaults and fixtures. Independent full suite: 4216 tests, 4211 pass, 5 skipped, 0 fail; typecheck/lint passed. |
| M2 | `a50d77f01af93f6e53b890cd16b76f323d6a0ff9` | Pure model intent resolution and isolated execution config snapshots. 54 focused and 326 broader tests passed; typecheck/lint passed. |
| M3 checkpoint | `ff409b574808804e8f8ddfb3e6285edb6354394b` | Physical residency identity, shared requested/admin readiness, sticky selection and guarded rollback. Had three fixture-related queue failures at that checkpoint. |
| M3 accepted correction | `782483237feaa809cde3faf1c33894c5cebfd1db` | Repo-agent added capacity to the recording runtime identity. Independent full suite: **4245 tests, 4240 pass, 5 skipped, 0 fail**; typecheck/lint passed. This is the last fully green full-suite baseline. |
| M4 selector only | `10820eecda8f6ff9ae8002b13903fd71119d1f53` | Pure resident-first selector and three focused tests. Build, 3/3 tests, typecheck/lint passed. Full M4 was not accepted. |
| M4 continuation plan | `1e1e3abc49eb817c6bf4ded96055c27e2cd50f72` | Primary split unfinished admission and diagnostics into M4-C1 and M4-C2. |
| M4-C1 checkpoint | `afc4dc888fd58c59126b94c67cd32006be61e57c` | Current worker's partial admission implementation. **Tests failed before its last fixes; final state is unverified.** |

M3 important implementation boundaries: residency derives from actual load/launch inputs and normalized endpoints/effective environment, excludes labels/IDs/samplers/idle timers, and includes parallel-slot capacity. Equivalent metadata changes still reach the runtime without unloading. Missing targets fail before unloading; failed load/rollback clears admission blockers. Conditional config persistence preserves newer saved selection/profile changes. Cancellation suppression at lock grant belongs to M4.

## What the last worker changed

The checkpoint contains exactly these ten paths:

- `src/status-server/server-ops.ts`: removed synchronous acquisition; asynchronous drain ownership; per-pass intent resolution; target readiness before lock grant; context/key on locks; compatible-only no-coordinator admission; cancellation/release/wake handling; queue timeout progress.
- `src/status-server/server-types.ts`: request intent, lock/waiter context, runtime reference, drain state.
- `src/status-server/index.ts`: shares the already-created runtime and flush queue with the server context.
- `src/status-server/model-idle-controller.ts`: suppresses idle unload during admission work.
- `src/status-server/routes/server-admin.ts`: wakes admission after no-coordinator configuration saves.
- `tests/model-request-queue.test.ts`: eleven routing/cancellation/failure/timeout regressions and fixture/assertion migrations.
- `tests/helpers/server-context-fixture.ts`, `tests/assistant-idle-gate.test.ts`, `tests/model-residency-actions.test.ts`, `tests/preset-runtime-coordinator.test.ts`: runtime/context/async-acquisition fixture migrations.

These are worker-reported behaviors, not a completed primary code review. Validate the actual code against M4-C1 before accepting them.

The explicit no-coordinator decision is documented in the continuation plan: runtime construction already occurs even when startup is disabled; expose its canonical identity without starting it. Such a server must reject incompatible targets instead of pretending to switch a model. Normal production admission still uses M3's coordinator. Do not duplicate the identity algorithm or substitute an optional compatibility path.

## Validation gaps and known evidence

- Worker turn 97: `npm run build:test; npm test -- model-request-selection model-request-queue model-request-queue-http model-residency-actions routes-model-residency assistant-idle-gate` returned exit 1: **66 pass, 8 fail, 1 cancelled**.
- Its captured output is truncated even though the worker requested full output. Known named failures include:
  - `model request admission logs queue position without waking the engine`: expected `wait_ms=0`, observed `wait_ms=10` after asynchronous admission.
  - `queued model request timeout resets when an earlier queued request drops`: observed `0 !== 1`.
  - An additional `notStrictEqual` failure with `actual: null`, `expected: null`; its test name is absent from the retained excerpt. The worker guessed idle-summary rescheduling, but that is **not established evidence**.
- Earlier turn 94 also timed out `two active A requests are admitted before the older B request` and `an invalid intent rejects only its waiter and does not poison other waiters`. Do not assume either still fails or is fixed at the checkpoint without reproduction.
- The worker reports fixing a lost drain wake, missing timeout restart after an earlier waiter drops, and a log timing assertion. The final edits were **not** rebuilt or tested. Compiled `.test-build` output may therefore be stale.
- The reported initial red step was missing-interface TypeScript errors. It does not establish the required meaningful behavioral red test. Reproduce actual unresolved behavior before prescribing fixes.
- No final M4-C1 primary tests, broader suite, typecheck/lint, full review, or critical drift review has been completed. M4-C2 and M5 must remain gated.
- Live two-model switching has not been smoke-tested. All accepted task validation used isolated fixtures. Do not exercise the user's live models merely to validate code.

## First actions when the user resumes

1. Read this handoff and the short M4 continuation plan. Check `git status --porcelain=v1` and preserve any newer changes. Checkpoint `afc4dc88` is an unverified baseline, not proof the tree is green.
2. Independently rebuild and reproduce the focused failures, capturing complete output in the same scratch directory. Start with `npm run build:test`, then the focused command listed above. Also run `npm run typecheck` (it invokes lint). Avoid trusting stale bundles or inferring all failure names from truncated worker output.
3. The primary reviews the changed admission paths and failure evidence, writes a small correction task with concrete findings, steps, tests, and acceptance, and commits that task document before dispatch so the repo stays clean. Delegate repairs to repo-agent. Do **not** redispatch the whole M4 plan or implement the fixes in the primary.
4. Independently verify the correction, relevant broader queue/runtime/HTTP coverage, and critical drift. Commit accepted results. If more evidence warrants correction, delegate another bounded task rather than silently accepting failures.
5. Implement and accept **M4-C2 diagnostics**, including opaque SHA-256 public residency keys. The internal key includes engine environment values and must not escape through responses or logs. Describe queue indices as arrival order, not guaranteed service order.
6. Finish **M5** (admitted snapshots through CLI/repo-agent/chat/summary/passthrough/provider boundaries), **M6** (settings selectors and reference-safe deletion), and **M7** (integrated routing validation).
7. Continue the orchestrator plan: **O1** contracts/catalog/manifest and migration 75→76; **O2** durable parent state/events/attempt reservations/repository gate and migration 76→77; **O3** planning phases/bounded child execution without holding the parent's model lease; **O4** dependencies/concurrency/two attempts; **O5** independent validation/owned cleanup; **O5b** critical drift and separate correction budget; **O6** HTTP/CLI lifecycle; **O7** UI/settings/evidence; **O8** integrated workflow/closeout.
8. Final overall gate: `npm run build:test`, `npm test`, `npm run test:dashboard`, `npm run typecheck`, `npm run lint`. Report failures and unverified live-runtime scope. Clean owned scratch artifacts only when the overall work is complete.

## Evidence and continuation mechanics

All controller artifacts are under the ignored directory:

`C:/Users/denys/Documents/GitHub/SiftKit/.scratch/model-routing-orchestration-execution/`

Useful files:

- `progress.md`: full task ledger, review findings, validations, prior failures, and policy changes. Later entries override stale early fallback instructions.
- `M4-C1-recovered-state.json`: authoritative terminal state and full final worker report.
- `M4-C1-result.json`, `M4-C1-stderr.log`: original CLI capture; it ended after 15 minutes, so the recovered state is authoritative for completion.
- `M4-resumed-search.json`: focused pre-dispatch repository facts. Verify anchors before using them; the reported health-diagnostics endpoint attribution was imprecise (`StatusReadEndpoint`, not `HealthEndpoint`, includes model request diagnostics).
- `M3-C1-primary-full.log`, `M3-C1-primary-typecheck.log`: last accepted full-suite/typecheck evidence.
- `watch-task-run.ts`: event-based recovery listener. Example for this now-finished run: `node --experimental-strip-types .scratch/model-routing-orchestration-execution/watch-task-run.ts M4-C1 1e1e3abc49eb817c6bf4ded96055c27e2cd50f72`.

The watcher finds a run whose request begins `Implement ONLY <task>:` and includes its exact clean base commit. It watches the run directory, writes `<task>-recovered-state.json`, and exits on approval-required or terminal status. It does not cancel a worker. New task IDs must match its current pattern (`M4-C3`, for example, is supported; arbitrary suffixes may require a controller-only update). An approval pause continues the same run through `siftkit repo-agent decide <run-id> approve` when the requested action is already authorized and appropriate.

Do not ask workers to read ignored scratch briefs: their native file tool cannot read them. Dispatch the exact heading in a **tracked** plan. Old scratch briefs contain superseded no-commit/direct-fix guidance and old scratch paths; do not rerun their setup.

Historical logs live in `.siftkit/runtime.sqlite`, table `run_logs`, keyed by the **engine/transcript run ID**, which differs from the repo-agent lifecycle ID. Apply the find-logs skill for log recovery. Its read-only helper can dump this run:

```powershell
node C:/Users/denys/.claude/skills/find-logs/scripts/dump_logs.ts bc685cc3-7708-4990-a2cf-91eb56965abe --repo C:/Users/denys/Documents/GitHub/SiftKit --out .scratch/model-routing-orchestration-execution/M4-C1-run-dump.md
```

Delete that temporary dump after reading it; the database and terminal-state artifact retain evidence. Live snapshots are deleted after completion. The original M4 attempt stopped during provider compaction when the local server went down; the user restored it before M4-C1. Do not assume current infrastructure health in a fresh session or restart live services merely for test validation.
