# Ownership and Persistence Reliability — Standalone Implementation Plan

> Execute sequentially with `superpowers:executing-plans` when implementation is authorized. This deliverable is the plan only.

**Goal:** Keep active repo-agent ownership, prevent inference-log writes from invalidating chat transactions or duplicating chunks, and reliably finish queued persistence during shutdown.

**Architecture:** Retain the current worker and `runtime.sqlite`. Observe provider activity independently of UI text delivery. Use SQLite immediate write transactions at the outermost chat mutation boundary and for each complete log batch; ordinary connection close leaves WAL mode intact. Shutdown explicitly drains existing queues before closing their database.

**Tech stack:** TypeScript, Node.js, better-sqlite3, Zod, existing test harness.

**Starting point:** The current uncommitted implementation already renews on delivered progress, user-message enqueue, and approval decisions; releases ownership in `finally`; and skips empty queue items. Preserve these behaviors. This document contains the complete requirements and replaces the earlier plan as the implementation checklist.

## Requirements and constraints

- Every valid provider message belonging to the run renews its one-hour inactivity window, including headless generation, approval inference, compaction, and final synthesis. Client polling and unrelated logs do not renew it.
- Preserve `SIFTKIT_MODEL_REQUEST_HOLD_CEILING_MS` as the existing timeout setting. Preserve acquisition timestamps, token-scoped renewal, and terminal release.
- Empty arrays and batches containing only zero-length strings perform no database work. Whitespace is valid log content.
- Expected writer overlap must serialize before chat reads establish a snapshot. Failed log batches must leave no partial chunks to duplicate on retry.
- Keep WAL and `synchronous=FULL`. Genuine storage failures must still fail closed; do not suppress journal errors or retry external tool execution.
- Use direct tools, no SiftKit, no worktrees, and no commits. Preserve unrelated edits. Keep diagnostics in one scratch directory and remove them afterward.
- Follow repository TypeScript/IO rules and TDD. Each task starts with failing regressions and ends with its relevant tests passing. No database migration or new dependency is needed.

## Task 1: Complete activity-based ownership

**Files:** `src/lib/progress-writer.ts`; `src/llm-protocol/inference-client.ts`; `src/repo-search/planner-protocol.ts`; `src/repo-search/execute.ts`; `src/repo-search/engine/{progress-reporter,task-loop,transcript-compactor,terminal-synthesizer}.ts`; `src/status-server/{operation-progress-writers,repo-agent-sessions,server-ops}.ts`.

**Tests:** `tests/{model-request-queue,repo-agent-sessions,status-server-chat-repo-agent,llm-protocol-streaming,repo-search-planner-protocol,progress-reporter-live-text}.test.ts`.

- [ ] Add regressions for a headless stream that remains active beyond the original deadline, a full inactivity window, terminal release, and the existing environment-variable override. Use controlled time and a fake provider stream.
- [ ] Add one small `InferenceActivityObserver` contract with `recordActivity()`. Extend the existing progress writer/reporter with this operation; the session implementation renews its lock. Lifecycle and composite writers must forward it.
- [ ] Pass the observer through planner, approval, compaction, and synthesis requests into `InferenceClient`. Call it on validated, non-error provider messages, independently of `onThinkingDelta`, `onContentDelta`, and `wantsLiveText`. Use an observer object, not a dynamically injected callback.
- [ ] Keep UI text construction and forwarding subscriber-gated. Activity observation must not generate additional journal/display events or console output per token.
- [ ] Restore the existing environment-variable name; remove use of the newly introduced `SIFTKIT_MODEL_REQUEST_INACTIVITY_TIMEOUT_MS` name and update its tests. Internal inactivity-oriented names can remain.
- [ ] Verify observer forwarding through the real execution path, user/approval renewal, no revival of released tokens, and release on success/failure/abort. Run the relevant tests to green.

**Acceptance:** A stream can run for multiple inactivity windows with no subscriber while retaining the same reservation; one full window without activity still expires it.

## Task 2: Make log batches atomic and empty batches inert

**Files:** `src/status-server/inference-run-flush-{queue,worker}.ts`, `src/state/{inference-runs,runtime-db}.ts`.

**Tests:** `tests/inference-run-flush-{queue,worker}.test.ts`, `tests/runtime-db-lifecycle.test.ts`.

- [ ] Add failing worker tests for an empty-string-only batch and a mixed empty/nonempty batch. Add a two-entry regression with a temporary SQLite trigger that rejects the second insertion.
- [ ] Filter zero-length entries before opening a connection. Return success immediately when none remain. Retain the queue's existing early guards and whitespace behavior.
- [ ] Wrap the entire nonempty batch, including sequence allocation, in one `database.transaction(...).immediate()` call. Send success only after commit. A failed insertion rolls back every entry in that batch.
- [ ] Keep the queue payload until acknowledgement and restore it only for a failed flush. A connection-close/reporting failure after a successful commit must not convert that commit into a retriable batch failure.
- [ ] Remove explicit `wal_checkpoint(TRUNCATE)` and `journal_mode=DELETE` from ordinary `closeRuntimeDatabaseHandle`; close the handle normally. Explicit maintenance/checkpoint operations retain their separate lifecycle.
- [ ] Verify: failed batch writes zero rows; retry writes each chunk once; mixed batches preserve nonempty text; empty batches create no path; another live connection remains usable in WAL mode; Windows cleanup succeeds after all handles close.

**Acceptance:** The demonstrated partial-batch retry cannot duplicate the first chunk, and empty content never opens SQLite.

## Task 3: Reserve the writer before chat mutation reads

Changing only `ChatJournalStore.append` is insufficient: a nested immediate transaction is a savepoint and cannot repair a snapshot already opened by an outer deferred transaction.

**Files — mutation boundaries to migrate:**

- `src/state/{chat-journal,chat-runtime-owner,chat-message-queue,chat-history-revisions,chat-sessions}.ts`.
- `src/status-server/{chat-run-recorder,chat-history-import,chat-history-repair,chat-run-recovery,chat-run-projection}.ts`.

**Tests:** `tests/{chat-journal,chat-run-recorder,chat-runtime-owner,chat-message-queue-delivery,inference-run-flush-queue}.test.ts`, plus the existing history/recovery/projection tests covering changed methods.

- [ ] Reproduce the journal race using two connections and the real recorder. Intercept the journal INSERT preparation through the test mocking API and attempt the competing log write after the journal has read. The current deferred transaction permits that write and then fails with `SQLITE_BUSY_SNAPSHOT`.
- [ ] Invoke existing write transactions with `.immediate()` at every listed outer mutation boundary, including recorder context/queue/finish transactions and runtime-owner renewal. Retain their existing bodies, rollback behavior, and sequence restoration.
- [ ] Leave genuinely read-only transactions, including operation snapshot capture, deferred. Check callers of journal mutators so no outer read-then-write transaction bypasses the reservation.
- [ ] Keep the worker's short busy wait and existing queued retry. When chat owns the writer slot, the worker yields and retries its whole uncommitted batch. When the worker owns it first, the journal acquires the slot before reading, using its existing bounded SQLite wait.
- [ ] Add coverage for both acquisition orders, nested recorder transactions, owner heartbeat renewal, and a high-water flush during active inference. Verify all evidence and log chunks persist exactly once and the run does not acquire `storage_failure` from the reproduced overlap.
- [ ] Retain failure tests for genuinely unavailable storage and exhausted lock waits; never acknowledge or execute a tool whose evidence did not commit.

**Acceptance:** The forced interleaving is prevented by the writer reservation, rather than repaired after journal state has partially changed. No change to journal durability or tool-execution ordering.

## Task 4: Drain on shutdown and replace the stale health test

**Files:** `src/status-server/{terminal-metadata,inference-run-flush-queue,index,server-types}.ts`; update `tests/helpers/server-context-fixture.ts` for any timer-handle fields.

**Tests:** `tests/terminal-metadata-drain.test.ts`, `tests/repo-search-status-server.test.ts`, `tests/inference-run-flush-queue.test.ts`.

- [ ] Add a failing shutdown regression with pending metadata and an idle delay longer than the shutdown budget. Add a case with both pending inference logs and metadata.
- [ ] Retain cancellable handles for scheduled drains. Add `InferenceRunFlushQueue.drainForShutdown(timeoutMs): Promise<void>` and `flushTerminalMetadataForShutdown(ctx, timeoutMs): Promise<void>`. They cancel normal delay timers and reuse the existing processing routines without the idle-delay gate. Do not increase the current shutdown timeout.
- [ ] After admissions/in-flight requests and engine shutdown have settled, drain inference logs first, then terminal metadata and direct deferred jobs, then deferred artifacts. Only afterward terminate the flush worker, release the runtime lease, and close the database.
- [ ] The inference shutdown drain must process pending batches as well as an in-flight batch. Await acknowledgements before worker termination. Keep a bounded wait for genuine failure and propagate shutdown persistence errors.
- [ ] Replace the obsolete file-read monkeypatch and 250 ms assertion. The replacement HTTP test posts completion metadata, receives both acknowledgement and `/health` while persistence is still deferred, and asserts that shutdown persists the actual `run_logs` row/metrics exactly once.
- [ ] Use a controlled scheduler or a deliberately long idle delay to establish ordering, not CPU busy-waits or a load-sensitive latency threshold. Rename the test to describe acknowledgement/deferred-persistence ordering.
- [ ] Verify no scheduled writer runs after close, repeated shutdown is safe, and the pending-queue regression passes under the full suite.

**Acceptance:** Shutdown completion depends on completed persistence, not a race between the 10-second idle delay and 10-second wait deadline.

## Final validation

- [ ] Run `npm run build:test`, all task-specific tests, the broader affected chat/queue/lifecycle suites, and `npm test`.
- [ ] Run `npm run typecheck` and `npm run lint`.
- [ ] Review the final diff against all requirements above. Confirm no unsafe IO/type shortcuts, dual configuration names, discarded log data, weakened durability, or swallowed persistence failures.
- [ ] Report test counts and any unverified scope; remove diagnostics. The previously observed full-suite failure must now pass.

**Operational limit:** Immediate transactions serialize normal writer overlap; they do not make a stalled disk or a writer held beyond the configured SQLite wait succeed. Those failures remain explicit. A successful plan must eliminate the reproduced snapshot race, partial-batch duplication, and artificial shutdown-delay timeout without claiming immunity to storage failure.
