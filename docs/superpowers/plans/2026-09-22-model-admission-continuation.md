# M4 model admission continuation

> **Status (2026-09-23):** M4-C1 verified on `df72a321`: the focused suite passes, typecheck and lint pass, and the full suite is green (its earlier failures were fixed by later commits). M4-C2 is implemented inline (uncommitted): `resident`, per-lock `model`, and queued `requested`/`resolved`/`waitingReason`, with SHA-256 residency fingerprints and an `arrival_position` log label. M5 is next.

This narrows the unfinished M4 work in [the routing plan](2026-09-22-preset-model-routing.md). The pure resident-first selector is already committed in `10820eec`. The original worker stopped on a provider error before changing admission. Do not repeat that selector task or implement M5.

The primary owns these decisions. Workers implement only their dispatched heading, use TDD, and return exact validation results. No commits, worktrees, temporary files, plan edits, nested workers, live-server changes, casts, `any`, non-null assertions, or compatibility paths. Keep comments to one or two lines. The primary reviews, validates independently, and commits each task before another dispatch.

## M4-C1: Complete asynchronous model admission

**Scope:** `src/status-server/server-ops.ts`, `server-types.ts`, `index.ts`; directly affected fixture constructors and existing queue callers/tests. Reuse the committed selector, M2 resolver, M3 runtime identity/readiness, and conditional selection persistence. Public diagnostic additions belong to M4-C2.

**Existing anchors:** queue helpers start at `server-ops.ts:264`; synchronous acquisition at 379; FIFO grant at 513; async wrapper at 554; release at 651. `PresetRuntimeCoordinator.getActiveRuntime()` exposes the canonical runtime. `index.ts:359-368` constructs the runtime and coordinator unconditionally, but lines 369-372 omit coordinator registration when startup is disabled. The only direct production caller of synchronous acquisition is its async wrapper; direct tests are `tests/assistant-idle-gate.test.ts:149,209`.

**Interfaces and ownership:**

- Add `intent?: ModelRequestIntent` to `ModelRequestWaitOptions`; omission means the actual non-preset current-model intent `{ presetId: null, model: null }`.
- Add `context: ModelRequestContext` and `residencyKey: string` to granted locks. Waiters retain intent, resolved context/key when selected, and resolve/reject hooks alongside existing cancellation/timeout state.
- Add a required `modelRuntime: ManagedInferenceRuntime` reference on `ServerContext`. Reuse the already constructed runtime in `index.ts`, moving construction before the context if necessary and sharing the same flush queue. Test contexts use the existing recording runtime. Do not invent a second identity algorithm or dynamically passed identity function.
- Add one `modelRequestDrainPromise: Promise<void> | null` and one `modelRequestDrainRequested: boolean` on the context. All acquisition, release, configuration-resume, and transition completion wakes join this owner. No timer-based scheduler.
- Delete synchronous `acquireModelRequest` and migrate its two direct test callers to await the async API. All requests enter the queue; there is no separate immediate-grant path.

**Implement and verify in order:**

1. Add meaningful failing integration tests in `tests/model-request-queue.test.ts`, reusing `PresetQueueHarness`, `BlockingQueueRuntime`, and validated A/B/C configuration fixtures. Cover A/B/A observed grant order, two active A requests before B, same-residency profiles with different sampling, a capacity-only change, frozen configuration, and invalid-target rejection without poisoning other waiters. Rebuild before each red/green run.
2. Resolve waiting intents against current saved config and the currently applied profile on each scheduling pass. Compute canonical keys through `ctx.modelRuntime`. Reject invalid waiters individually. Choose the oldest resident match; only choose a different model after active work drains. Preserve FIFO within a matching key and the explicit absence of an aging override.
3. Freeze the selected context, await M3 targeted readiness before adding the lock, then recheck cancellation and capacity/transition state before grant. Never hold a request lock while waiting for a model transition. Continue or roll back an irreversible load even if its selected waiter cancels; the canceled operation must not execute.
4. Preserve the existing explicit mode with no registered coordinator: it owns no model lifecycle. Read canonical identity from its runtime object, admit only a target compatible with the applied residency, and fail an incompatible target clearly instead of pretending to switch it. For compatible profile metadata changes, update applied state and conditionally persist the selection using the existing helper. Add a regression test for the incompatible-target boundary. Normal production mode still uses the coordinator for all readiness and persistence.
5. Keep cancellation/null results and inactivity renewal. Resolution/load errors reject the requesting waiter's promise, and the drain catches and routes them without an unhandled rejection or stranded owner. Keep idle unloading disabled while queued or selected admission work exists, including a canceled waiter whose load is still completing.
6. Preserve existing timeout progress for requests that were actually ahead of a waiter. A resident-model request that arrived behind another waiter must not extend that older waiter's deadline merely by being granted and released. Add event-driven tests for repeated affinity bypass, cancellation during readiness, inherited-current resolution after a switch, and failure followed by successful admission.
7. Update directly affected typed fixture constructors and assertions for asynchronous admission; never weaken behavioral assertions. `tests/helpers/server-context-fixture.ts` currently seeds applied state from defaults: make each queue fixture's config, applied state, and recording runtime agree. Do not initialize any actual managed engine in test-only no-coordinator fixtures.

**Validation:** `npm run build:test`; `npm test -- model-request-selection model-request-queue model-request-queue-http model-residency-actions routes-model-residency assistant-idle-gate`; `npm run typecheck` (includes lint). The primary runs broader applicable tests separately. Return failing-test evidence before implementation, green counts, changed paths, and unresolved scope. Do not execute M4-C2.

**Acceptance:** Every managed admission has a matching ready runtime and isolated execution snapshot; compatible queued work wins; active work is never unloaded; each transition/drain has one owner; cancellation and load failure cannot run the wrong operation or strand later work. No-coordinator mode remains explicit and cannot silently switch models.

## M4-C2: Publish model-aware queue diagnostics

Depends on accepted, committed M4-C1. Do not start concurrently.

**Scope:** `src/lib/operation-stream.ts`, the diagnostic producer/log labels in `src/status-server/server-ops.ts`, `src/cli/progress-renderer.ts` when needed, and direct contract/HTTP/renderer tests and typed fixtures. Preserve M4-C1 scheduling.

1. Add failing schema and HTTP tests for requested operation/model identity, resolved model preset/key when known, resident profile/key, and waiting reason (`capacity`, `different_model`, `transition`). Keep timestamps and wait duration.
2. Publish only SHA-256 fingerprints of internal residency keys. Internal keys contain engine environment values; add a regression proving those values cannot appear in responses or logs. Hash at the diagnostic boundary; scheduling continues using the canonical internal key.
3. Describe queue indices in logs/rendered diagnostics as arrival order, not guaranteed service order. Keep existing lock-wait elapsed time and queue length behavior. Update callers/fixtures without runtime compatibility readers.
4. Run `npm run build:test`, relevant operation-stream/progress-renderer/queue HTTP tests, and `npm run typecheck` including lint. Return exact counts and any unresolved assertion failures.

**Acceptance:** Diagnostic consumers can distinguish capacity, another model, and a transition; no raw runtime identity escapes; reported ordering does not promise FIFO service. The primary reviews M4 as a whole before accepting it.
