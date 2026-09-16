# Shutdown persistence defects — confirmation, proof, and fix plan

Date: 2026-09-15
Status: all five findings **confirmed**. No production code changed.
§1-§3 are reproduced by the harness below. §4-§5 are confirmed from the shutdown wiring itself
(`index.ts:440-460` + `index.ts:512-525`, `main.ts:24-34`) and require the process-level regression test in §4.
Reproduction harness (kept for review): `tests/tmp-bug-verification.test.ts` — git-ignored via `.gitignore:73` (`tmp-*.ts`).

```powershell
npm run build:test
node .\dist\test-runner\run-tests.js tmp-bug-verification   # 3 pass = 3 bugs reproduce
```

Scope: the shutdown persistence chain — `src/status-server/index.ts:509-526` drives
`inferenceRunFlushQueue.drainForShutdown()` → `flushTerminalMetadataForShutdown()` → artifacts → `close()`. Any
rejection reaches `rejectShutdownPromise` (`index.ts:525`), which `afterClose` (443-446) forwards to the close
callback — and §4 shows the entrypoint throws that argument away. Each stage is meant to be a bounded wait that
fails loudly (`index.ts:141`, `SHUTDOWN_PERSISTENCE_TIMEOUT_MS = 10_000`).

---

## 1. HIGH — shutdown hides metadata write failures

**Where:** `src/status-server/terminal-metadata.ts:368` (failure handler in `processTerminalMetadataItem`, 352-377).

**Mechanism**

1. `processTerminalMetadataItem` runs the whole persistence chain inside `try { processTerminalMetadataBody(...) }`
   (360-361) and its `catch` (368-376) only emits a `terminal_metadata_process_failed` line. It never rethrows.
2. That chain writes to the database: `processTerminalMetadataBody` (290) → `applyDeferredTerminalMetadata`
   → `persistStatusRunLog` (118) → `upsertRunLog` INSERT (`status-run-log.ts:87`,
   `dashboard-runs/artifact-upserts.ts:64`). A rejected insert therefore throws straight into the swallowing catch.
3. `flushTerminalMetadataForShutdown` (384-398) loops the queue with that same swallowing function (389-391),
   then calls `waitForTerminalMetadataIdle` (397). The idle predicate (400-406) checks only queue length,
   direct-job count, drain flags and `completedRequestCount >= minimumCompletedRequestCount` — and that minimum
   is a **default parameter snapshotted after the loop** (411), so it structurally cannot notice a lost write.
4. Nothing re-raises, so `index.ts:515` proceeds through artifacts and `close()`; shutdown exits successfully
   with an emptied queue and zero saved rows.
5. Aggravating detail: `ctx.metrics` is reassigned and `writeMetrics` runs (93-117) **before** `persistStatusRunLog`
   (118), so the aggregate totals already claim a run whose row never landed.
6. The asymmetry proves intent: direct jobs (`scheduleDeferredTerminalMetadata`, 158-163) use `try/finally` with
   **no** catch, so they *do* propagate out of shutdown (396). Only the queued path hides the failure.

**Proof** (run_logs INSERT rejected by a `RAISE(ABORT)` trigger, then `flushTerminalMetadataForShutdown(ctx, 1000)`):

```
st bug1-rej  terminal_metadata_process_failed  state=completed duration_ms=29 error=injected insert rejection

=== BUG1 EVIDENCE ===
flushTerminalMetadataForShutdown threw: null
run_logs rows saved: 0
terminalMetadata.queue.length: 0        <- success reported, queue emptied, zero rows
elapsed_ms=29
```

Existing coverage is happy-path only (`tests/terminal-metadata-drain.test.ts:86-100` asserts `countRunLogs == 1`).
The inference-log side already has the loud contract (`tests/terminal-metadata-drain.test.ts:124-135`); metadata does not.

**Fix**

- Make `processTerminalMetadataItem` log **and rethrow** (`throw toError(error)`); it stops deciding fatality.
- Move the deliberate swallow to the *background* drain, `drainTerminalMetadataQueue` (342-344), which is a
  timer callback fired as `void`/`setTimeout` (191-198) where an escaping throw would be an unhandled rejection.
  **Say plainly what that swallow costs: the item is gone.** The item is already shifted off the queue (341) and
  `finalizeTerminal` has already run (`terminal-metadata.ts:288`) *before* persistence (290), so a resubmission of
  the same request id resolves as `'duplicate'` (237, 245-247) and returns without persisting. There is no retry
  path — an earlier draft of this plan claimed "a retry is possible later"; that is wrong and must not be written
  into a comment. Background loss therefore has to be loud (`terminal_metadata_process_failed` at error severity,
  plus a `persistenceFailedCount` on the terminal-metadata snapshot) so it is at least countable, and the shutdown
  path must never swallow at all.
- `flushTerminalMetadataForShutdown` then propagates from both loops (389-391 queued, 396 direct jobs) →
  `index.ts:525` rejects → `afterClose` (443-446) forwards the error to the close callback. **That is where the
  chain currently dies: see §4.** Propagation alone does not produce a failing exit until the entrypoint is fixed.
- Atomicity, not ordering: `getMetricsPath()` **is** the runtime database (`config/paths.ts:85-87`), and
  `writeMetrics` (`metrics.ts:403-404`) and `persistStatusRunLog` (`status-run-log.ts:87`) both resolve to the same
  cached connection as `ctx.runtimeDatabase` (`state/runtime-db.ts:146`), which exposes `.transaction(…).immediate()`
  (as used in `state/chat-message-queue.ts:153`). So wrap the two writes in one `ctx.runtimeDatabase.transaction(…)`,
  and **publish the in-memory aggregates only after it commits**: build the next `Metrics` value, commit row +
  totals, then assign `ctx.metrics` and `writeMetrics`' side effects.
  Simply reordering `persistStatusRunLog` (118) ahead of `writeMetrics` (117) does **not** fix the disagreement —
  it only moves it: the row commits, `writeMetrics` then fails, and persistent totals still understate the row.
  Reordering is worth keeping only as part of the transaction (memory last, never first).
  Narrowed guarantee to state in the comment: *either both writes land and memory advances, or nothing changes and
  the failure is reported* — not "the row is written first".
- Do **not** add re-queue/retry to the shutdown loop: at shutdown there is no later chance to retry, so failing
  loudly is the correct contract (same reasoning as the flush-queue docstring at 97-100).

**Tests (TDD order)**

1. RED: shutdown rejects when the `run_logs` insert is rejected, and the `terminal_metadata_process_failed`
   line is still emitted (log stays, silence goes).
2. RED→GREEN: direct-job insert failure also rejects (today true, locks the contract in).
3. Regression guard for the deliberate asymmetry: the background drain still swallows + logs one error line and
   produces no crash / no unhandled rejection — and the new `persistenceFailedCount` moves.
4. Lost-write immutability (replaces the old "reorder" test): with the insert rejected, `ctx.metrics` is unchanged
   **and** the `runtime_metrics_totals` row is unchanged.
5. Atomicity: reject only the totals write (trigger on `runtime_metrics_totals`) → the `run_logs` row must also be
   absent, proving one transaction, not two writes in an order.
6. Duplicate-guard regression: after a failed background persistence, re-posting the same request id is reported as
   `'duplicate'` and persists nothing — documents the permanent-loss boundary so nobody assumes a retry exists.

---

## 2. MEDIUM — reporting inside the DB retry scope duplicates committed logs

**Where:** `src/status-server/inference-run-flush-queue.ts:267` (retry scope in `drainNow`, 225-305).

**Mechanism**

1. The `try` at 267 covers **both** the persistence call `await this.flushInWorker(...)` (268) **and** the success
   report `serverLogger.dim({ event: 'flush_done' })` (271-277), plus `completedCount += 1` (270).
2. Any throw from the reporting path lands in the database-failure `catch` (278), which does failure bookkeeping:
   `restoreInferenceRunPendingLogChunks(runId, item.entries)` (283) puts the **already committed** chunk text back
   into the in-memory pending buffer, `failedCount += 1` (286), re-queues the item (287-288) and
   `scheduleDrain(250)` (296) retries it — writing the same chunk a second time.
3. The batch is durable the moment the worker acks: `inference-run-flush-worker.ts:25` → `appendInferenceRunLogChunks`,
   whose contract (`state/inference-runs.ts:498-502`) is that the single-transaction rollback is what makes
   "a retry never duplicates". That guarantee holds only while retries are driven by *rejections*; a post-commit
   trigger voids it, because the retry gets fresh sequence numbers (`inference-runs.ts:415-427`, 503+).
4. Reporting can genuinely throw: `ServerLogger.emit` calls `writeText` → `process.stdout.write` synchronously
   (`server-logger.ts:168`, 172-175).
5. Side effects of the same scope error: both counters move for one batch (`completedCount: 1, failedCount: 1`),
   and the log shows `flush_retry` for a batch that in fact succeeded.

**Proof** (throw injected into `serverLogger.dim` while `flush_done` is reported):

```
=== BUG2 EVIDENCE ===
rows committed by the successful flush: 1
characters restored into the pending buffer after the reporting throw: 6
snapshot after drainNow: {"pendingCount":1,"runningRunId":null,"scheduled":true,"completedCount":1,"failedCount":1}
rows after the retry: 2
persisted log text: "hello\nhello\n"

exl3 fa1cd092  flush_retry  wait_ms=0 duration_ms=156 attempt=1 pending_chars=6 error="injected reporting failure"
exl3 fa1cd092  flush_done   wait_ms=410 duration_ms=6 pending_chars=6 stream_count=1
```

**Fix**

- Narrow the `try` to the persistence call only, and turn the catch into a value:

  ```
  let failure: Error | null = null;
  try { await this.flushInWorker(runId, item.entries); }
  catch (error) { failure = toError(error); }
  finally { this.runningRunId = null; }

  if (failure) { attempts++, restore, failedCount++, requeue, flush_retry log, scheduleDrain(250), break; }

  completedCount++;
  flush_done log;            // outside any catch that can restore
  ```

- Why this shape: restore-and-retry is justified **only** by a rejected transaction. Once the worker has acked,
  the only correct response to a reporting failure is to let it surface, never to re-write the batch.
- **Error ownership (the part the first draft left vague).** A drain failure must have exactly one owner, and it
  must be the queue — not whichever call site happened to await it:
  1. The queue records the first escaping failure (`private drainFailure: Error | null`) before anything else,
     then **reschedules** so the remaining `pendingOrder` items still run. Today an escaping throw falls through
     `finally { this.draining = false }` (302-304) with `scheduled` already false (229): the leftover items sit
     until some unrelated `enqueue` / `setModelRequestState` (165-167, 177-188) happens to kick the queue.
  2. `isIdle()` stays a pure state query (218-223); `waitForIdle` rejects on `drainFailure !== null` **immediately**,
     without waiting for the deadline. Without this, a shutdown that joins an already-running drain (106-108 skips
     `drainNow`) only polls state and can miss the failure entirely — and if the failed item was the last one, the
     queue genuinely *looks* idle and shutdown resolves green.
  3. The two `void this.drainNow()` sites (385, 394) catch, record into `drainFailure`, and report on
     `process.stderr.write` — **not** `serverLogger.error`. The reporting failure that starts all this comes from
     the same stdout sink (`server-logger.ts:168`, 172-175), so a logger-based handler can throw again and turn into
     the unhandled rejection we are trying to remove. `index.ts` already reports its own lifecycle failures this way
     (455, 490) — follow that precedent.
  4. A failure owned by a background drain is surfaced to shutdown through `drainFailure`, and a failure raised
     inside `drainForShutdown`'s own `await drainNow()` (107) propagates directly. Both end in the same rejection
     value, so shutdown cannot lose a failure by arriving late.
- Do not "fix" this by wrapping the logger in its own `try/catch` and continuing: that keeps the silent-success
  failure mode this file is meant to eliminate, and it is exactly the compatibility-shim shape to avoid.

**Tests**

1. RED: injected reporting failure → exactly one committed row, log text appears once,
   `completedCount: 1, failedCount: 0`, queue empty (today: 2 rows, `"hello\nhello\n"`, both counters at 1).
2. Keep the existing rejection-retry tests untouched — they are the legitimate restore path.
3. Invariant guard: a single batch can never advance both `completedCount` and `failedCount`.
4. **Multiple queued runs:** three runs pending, reporting throws on the first → the other two still flush exactly
   once each (guards the "drain stops and never reschedules" stall).
5. **Joined drain:** start `drainNow()` unawaited, then call `drainForShutdown(...)` while `draining` is true and
   force the reporting failure → shutdown rejects with that error, and does not resolve on the idle-looking queue.
6. **Timer-started retry:** let the 250 ms `scheduleDrain(250)` (296) path run the drain, inject the reporting
   failure there → the failure is recorded and reported on stderr (no unhandled rejection), and a later
   `waitForIdle` rejects instead of resolving.
7. Sink failure containment: with stdout throwing, the queue still records the failure and the process logs nothing
   that can re-throw from a `catch` handler.

---

## 3. MEDIUM — the shutdown timeout excludes the first flush

**Where:** `src/status-server/inference-run-flush-queue.ts:102-110` (`drainForShutdown`).

**Mechanism**

1. `await this.drainNow()` (107) runs the entire first drain pass — every pending batch, each awaiting its worker
   ack (268) — **before** `await this.waitForIdle(timeoutMs)` (109) creates its deadline
   (`const deadline = Date.now() + normalizedTimeoutMs`, 203).
2. Because `getIdleWaitMs` returns 0 while `shuttingDown` (308), that pass flushes everything, so by the time the
   clock starts the queue is normally already idle and `waitForIdle` returns at 204 without waiting at all.
3. Net effect: the budget covers only the retry tail (the `break` at 297 leaves the queue non-idle, so
   `waitForIdle` does bound it). The first flush and its worker acknowledgement are unbounded.
4. This contradicts the method's own docstring (97-100, "a bounded wait that rejects") and the stage contract at
   `index.ts:141`.

**Proof** (worker injected that answers 250 ms after `postMessage`):

```
=== BUG3 EVIDENCE ===
drainForShutdown(25) rejected: no — resolved
elapsed_ms=259 (budget 25ms)
snapshot: {"pendingCount":0,"runningRunId":null,"scheduled":false,"completedCount":1,"failedCount":0}
```

**Fix**

- Start the clock before the work and pass it down: normalise `timeoutMs` into a single
  `deadlineMs = Date.now() + timeoutMs` at the top of `drainForShutdown`, then (a) drain against that deadline and
  (b) wait against the **same** deadline. Concretely: add a private `waitForIdleUntil(deadlineMs: number)` in the
  same class and let the existing `waitForIdle(timeoutMs)` (201-216) delegate to it. This is a within-file change —
  no shared helper and no cross-module refactor is required (see DRY-1, downgraded).
- Bound the in-flight acknowledgement, with one hard constraint: **an expired ack must not restore or retry the
  batch.** A batch whose ack is late may still commit, so restoring it re-creates defect #2. On expiry, reject
  shutdown with the existing snapshot-style message ("flush acknowledgement not received within budget") and leave
  the batch owned by the worker.
  **Depends on §5.** The first draft justified this by "`close()` (112-137) already handles the leaked-fd trade-off";
  as the code stands that is false, because `close()` at `index.ts:518` is one of the statements a rejection skips.
  Once cleanup runs in a `finally`, the trade-off becomes real: `close()` waits up to `closeFlushWaitMs` (31, 120-123)
  and logs `flush_close_timeout` (129-134) instead of silently abandoning the handle. Land §5 first.
- Between batches the check is cheap and safe: if the deadline has passed while items remain, reject — the item is
  still in `pendingOrder`, so nothing needs restoring.
- Why this shape: the budget's purpose is a bound on **total shutdown persistence time**, not on its tail. A
  stage that cannot finish must fail loudly (the contract `tests/terminal-metadata-drain.test.ts:124-135` already
  relies on). A watchdog that restores-on-timeout would buy the bound by corrupting data, which is a worse trade
  than a slow shutdown.

**Tests**

1. RED: 25 ms budget + worker that acks at 250 ms → rejects, and elapsed ≤ budget + one poll interval
   (today: resolves at ~259 ms).
2. Slow-but-in-budget ack still resolves with exactly one committed row (no false failure).
3. Ack-timeout path never restores: a later flush of the same run produces no duplicate rows.
4. Existing budgeted-failure test (`terminal-metadata-drain.test.ts:124-135`) stays green.

---

## 4. HIGH — a rejected shutdown still exits 0

**Where:** `src/status-server/main.ts:24-34` (the `server.close` callback at line 24).

**Mechanism**

1. `index.ts:525` completes the drain chain with `.then(resolveShutdownPromise, (error) => rejectShutdownPromise(toError(error)))`.
2. `index.ts:440-447` already honours the failure contract: `afterClose` awaits `shutdownPromise` and, on
   rejection, calls `finalCallback(toError(failure))` — the error **is** handed to the close callback.
3. `main.ts:24` registers `server.close(() => { … })` — a zero-parameter callback. The argument is discarded,
   `forcedExitTimer` is cleared (25-28) and `process.exit(0)` runs (33). Every failure produced by §1-§3 therefore
   ends as a successful exit.
4. The `SIGUSR2` branch (29-32) re-raises the signal and returns without reporting anything either.
5. Budget inversion found while tracing this: the forced-exit timer is 15 s (`main.ts:16-20`) while each persistence
   stage gets 10 s (`index.ts:141`) and `close()` can add up to 2 s more (`inference-run-flush-queue.ts:31`, 120-123).
   Two stalled stages (20 s) exceed the forced window, so a slow-but-successful shutdown is killed at exit 1 with no
   persistence report, while a fast-but-failed one exits 0. Both halves of the exit-code story are inverted.

**Proof** (code evidence — the plumbing arrives, the entrypoint drops it):

```
index.ts:443-446   void shutdownPromise.then(() => finalCallback?.(error), failure => {
                     if (finalCallback) finalCallback(toError(failure));      // error delivered here
main.ts:24         server.close(() => {                                       // never received here
main.ts:33           process.exit(0);
```

**Fix**

- Take the argument and act on it: `server.close((error?: Error) => { …clear timer…; if (error) {
  process.stderr.write(`[siftKitStatus] Shutdown failed: ${getErrorMessage(error)}\n`); } … })`, then exit
  non-zero when `error` is present. Use `getErrorMessage` (`lib/errors.ts:10-12`), not an inline `instanceof` test.
- Exit codes: reuse the existing mapping (`main.ts:13`, 19 — 130 for SIGINT, 1 otherwise) rather than inventing a
  new value; "did not complete cleanly" already has a meaning for callers and one code keeps it.
- `SIGUSR2`: write the failure line before re-raising, then keep the re-raise (it is the restart handshake).
- No extra join/await is needed at the entrypoint: the callback already runs only after `shutdownPromise` settles
  (`afterClose`), so reading the argument is the whole change.
- Reconcile the budgets in the same edit: derive the forced-exit deadline from the stage budgets
  (stages × `SHUTDOWN_PERSISTENCE_TIMEOUT_MS` + `closeFlushWaitMs` + margin) from **one** exported constant that both
  files import, so the 15 s and 10 s numbers cannot drift apart again.

**Tests — process-level regression (required)**

New `tests/status-server-shutdown-exit.test.ts`, spawning the built entrypoint:

1. Spawn `dist/status-server/main.js` with `SIFTKIT_*` env pointed at a temp runtime root (same env shape as
   `tests/helpers/isolated-runtime.ts`), and wait for the ready JSON line on stdout (`index.ts:482`).
2. From the parent, open the child's `runtime.sqlite` and create
   `CREATE TRIGGER reject_run_logs_insert BEFORE INSERT ON run_logs BEGIN SELECT RAISE(ABORT,'injected'); END;`.
3. POST a terminal-metadata body to `/status` in the shape `routes/status-post.ts:157-158, 218-228` accepts, so the
   item sits in the child's queue.
4. Send `SIGINT`, await exit. Assert: **exit code non-zero**, stderr contains `Shutdown failed:` and the injected
   message, and the child's runtime directory is removable afterwards (§5). Today this fails at `exit code 0`.
5. Budget-inversion case: hold the child's DB write-locked so stage 1 rejects at its own timeout, and assert a
   reported shutdown failure rather than a forced kill. If the ~10 s wait is too slow for the suite, assert the
   budget relationship as a unit test on the shared constant and keep case 4 as the process-level one.
6. Assert only on exit code and stderr text, never on timing.

---

## 5. HIGH — cleanup is skipped when a persistence stage rejects

**Where:** `src/status-server/index.ts:512-525` (no `try/finally` around the shutdown chain).

**Mechanism**

1. The chain is a bare sequence: `waitForRequestsIdle` (513) → `drainForShutdown` (514) →
   `flushTerminalMetadataForShutdown` (515) → `flushDeferredArtifacts` (516) → `inferenceRunFlushQueue.close()` (518)
   → idle-summary db close (519-522) → `chatRuntimeOwner.release()` (523) → `closeRuntimeDatabase` (524).
2. A rejection at 514 jumps straight to `rejectShutdownPromise` (525): the flush worker is never terminated, the
   chat-runtime lease is never released, and the idle-summary and runtime database handles are never closed.
3. On Windows that is exactly the failure documented at `inference-run-flush-queue.ts:27-31` — the worker's sqlite
   fd survives until process exit and holds the directory containing `runtime.sqlite`, so temp cleanup fails
   (`tests/helpers/isolated-runtime.ts:23-26` throws when the directory cannot be removed).
4. §1 and §3 make this *more* likely, because they convert silent losses into rejections. Fixing the reporting bugs
   without this one turns a quiet bug into a handle leak.

**Fix**

- Keep the stage sequence verbatim inside `try`; move 518-524 into `finally`, preserving the documented order
  (509-511: release the lease **while the handle is open**, then close the path).
- Preserve the original error: `let failure: Error | null = null` set in the stage `catch`; run cleanup; then
  `if (failure) throw failure;` **after** cleanup settles. Collect cleanup failures separately and report each on
  `process.stderr.write` (precedent: 455, 490) — never let one replace the stage error. If the stages succeeded and
  only cleanup failed, that cleanup failure becomes the rejection value (it is then the only failure).
- Run cleanup steps sequentially and awaited — they have a hard order and share file handles; no `Promise.all`.
- Do not add a new "cleaned up" flag: `close()` on the queue (115-119) and `closeRuntimeDatabase` are already
  idempotent through their own null-out, and `closeRequested` (448-452) can re-enter this path. Assert that in a
  test instead of adding a guard.

**Tests**

1. RED: stage 1 rejects (trigger on `inference_run_log_chunks`, as at `tests/terminal-metadata-drain.test.ts:127-134`)
   → the queue's worker is gone, the lease is released, and the runtime db is closed so the temp directory removes.
2. Original error preserved when a cleanup step also throws (force it by closing the idle-summary db twice).
3. Success path unchanged: `tests/terminal-metadata-drain.test.ts:102-121` stays green.
4. Cleanup-only failure (stages fine, a close step throws) → shutdown rejects with the cleanup error.

---

## DRY violations observed while confirming these bugs

Not searched for deliberately — these are the ones the defects sit on. **They are observations, not prerequisites**
(retracted from the first draft): all five fixes are local to their own file, and none of them needs a shared
helper to exist first. Anything here that survives should be justified by the code the fixes leave behind, not by
the bugs.

**DRY-1 — two hand-rolled bounded waits.** `InferenceRunFlushQueue.waitForIdle` (201-216) and
`waitForTerminalMetadataIdle` (`terminal-metadata.ts:408-430`) are the same algorithm: timeout normalisation
(`Number.isFinite(x) ? Math.max(0, Math.trunc(x)) : 0` at 202 vs 413-416), `deadline = Date.now() + normalised`
(203 vs 417), poll loop, and a `"Timed out waiting for … after ${ms}ms: <snapshot dump>"` error (207-212 vs
421-426). Even the poll expression is identical — `Math.min(POLL_INTERVAL_MS, Math.max(1, deadline - Date.now()))`
(214) vs `Math.min(10, Math.max(1, deadline - Date.now()))` (428), where `POLL_INTERVAL_MS` **is** 10 (23), so one
copy spells the constant and the other hard-codes it.
*Consequence:* cosmetic today — two 10-line poll loops that must be kept in step by hand. It is **not** a blocker
for §3: that fix only needs `drainForShutdown` to own the deadline, which a private `waitForIdleUntil(deadlineMs)`
inside the same class provides.
*Fix (only if justified afterwards, and rule-compliant):* share **data, not callbacks**. `waitFor(deadlineMs,
isDone, describeState)` passes functions around, which conflicts with the "keep dependencies explicit / do not pass
functions dynamically" rule. Share `normalizeTimeoutMs(ms)` and the timeout-message builder (both take values, return
values) and leave each loop where it is — the loops also differ in what they consider idle, which is a real
difference, not duplication (see DRY-2). Minimum useful step: replace the hard-coded `10` at
`terminal-metadata.ts:428` with the same named constant the queue uses (23, 214).

**DRY-2 — the idle-delay *arithmetic* is written three times; the gates are not duplicated.**
`getTerminalMetadataIdleWaitMs` (`terminal-metadata.ts:171-184`) and `InferenceRunFlushQueue.getIdleWaitMs`
(307-316) share the tail computation (`Math.max(0, idleDelayMs - (Date.now() - (lastFinishedAtMs ?? fallback)))`),
and the clamp `Math.max(1, Math.min(1000, idleDelayMs || 1000))` appears three times (173, 181, 312).
*Consequence:* none of the *gates* are duplicated — only the arithmetic is. **Merging the two functions would be a
regression, and the first draft's suggestion to do so is retracted.** `getTerminalMetadataIdleWaitMs`
enforces a cross-writer ordering rule the queue knows nothing about: `terminal-metadata.ts:180-182` keeps deferring
while `!ctx.inferenceRunFlushQueue.isIdle()`, i.e. metadata must not be persisted before the inference-log batches
have landed. The queue's `getIdleWaitMs` (307-316) has no such notion and must not acquire one. They are also
independently configured — `SIFTKIT_TERMINAL_METADATA_IDLE_DELAY_MS` / `terminalMetadataIdleDelayMs`
(`index.ts:186-193`) versus `SIFTKIT_INFERENCE_RUN_FLUSH_IDLE_DELAY_MS` / `inferenceRunFlushIdleDelayMs`
(`index.ts:204-211`) — so one function serving both would silently tie two operators' knobs together and could
persist metadata before its logs.
*Fix:* extract **only** the arithmetic — `elapsedIdleWaitMs(idleDelayMs, lastFinishedAtMs, fallbackMs)` and
`deferredDrainWaitMs(idleDelayMs)` (the `Math.max(1, Math.min(1000, …))` clamp, three copies: 173, 181, 312) — as
value-in/value-out helpers. Both call sites keep their own gates, their own ordering dependency and their own
configured delay.

**DRY-3 — the timer-with-`unref` idiom three times.** `setTimeout` + `typeof timer.unref === 'function'` + store
handle appears at `terminal-metadata.ts:164-167`, `terminal-metadata.ts:191-198` and
`inference-run-flush-queue.ts:383-391`; the matching `clearTimeout` + null-the-handle bookkeeping appears twice
(`cancelScheduledTerminalMetadataDrain` 201-207 vs `clearDrainTimer` 370-375).
*Fix:* one `scheduleUnrefTimer(callback, delayMs)` / matching cancel helper. Low risk, removes a forgettable
`unref` (an un-unref'd timer holds the loop and delays exit — the very class of exit-time bug this area is about).

**DRY-4 — each writer has two drain loops.** `flushTerminalMetadataForShutdown` (384-398) re-implements
`drainTerminalMetadataQueue`'s body (340-349: guard on `drainRunning`, `queue.shift()`, process, `finally` reset,
reschedule if non-empty) minus the idle gate; `drainForShutdown` (102-110) re-does `drainNow`'s entry bookkeeping
(`clearDrainTimer` + `scheduled = false`, 104-105 vs 229).
*Consequence:* this is the direct cause of bug 1 — the shutdown loop inherited the swallow from the shared item
processor but not its retry opportunity, and the two loops can drift independently.
*Fix (post-fix, if the two loops still read as one routine after §1):* one drain routine parameterised by an
explicit mode (`'idle-gated' | 'forced'`), so the error policy is chosen at the call site (background =
swallow-and-log-and-count, shutdown = propagate) instead of being inherited from a shared catch. §1 achieves the
same policy split today by moving the catch, so this is only worth doing if the loops keep drifting.

**DRY-5 — inline error-message extraction, despite the canonical helpers.** `error instanceof Error ? error.message : String(error)`
at `terminal-metadata.ts:374`, `inference-run-flush-queue.ts:280` and `index.ts:490`, while `src/lib/errors.ts:6-12`
already exports `toError` / `getErrorMessage` — and `index.ts:525` uses `toError` in the same file that hand-rolls
it at 490. Both bug-1 and bug-2 fixes touch these exact lines, so replace them with `getErrorMessage(error)`
(`toError(error)` where an `Error` value is needed) as part of the same edits.

**DRY-6 — shutdown test fixtures are private to one test file.** `createDeferredContext`
(`tests/terminal-metadata-drain.test.ts:49-68`) and the row counters `countLogRows` / `countRunLogs` (75-83) are
file-local, so any second shutdown test must copy them — my repro did exactly that.
*Fix:* move them to `tests/helpers/` (next to `server-context-fixture.ts`, `isolated-runtime.ts`) when the new
regression tests land, then have `terminal-metadata-drain.test.ts` import them.

Minor, same neighbourhood: the two failure log lines disagree on escaping the message —
`error=${JSON.stringify(message)}` (`inference-run-flush-queue.ts:294`) vs bare `error=${...}`
(`terminal-metadata.ts:373-374`). Worth aligning while both lines are being edited, not worth a change of its own.

---

## Suggested order of work

Reordered after review: the entrypoint fix now comes first, because until it lands no other fix is observable from
outside the process, and its process-level test is the harness the later fixes reuse.

1. **§4** — read the close callback's error at `main.ts:24`, report it, exit non-zero; reconcile the 15 s forced-exit
   timer with the 10 s stage budgets from one shared constant. Add `tests/status-server-shutdown-exit.test.ts`.
   (Caveat: it spawns the built entrypoint, so it belongs to the post-build suite like the rest of `npm test`.)
2. **§5** — cleanup in `finally`, original error preserved, documented release-before-close order kept.
3. **§2** — reporting out of the retry scope, plus error ownership (`drainFailure`, reschedule, immediate reject,
   stderr reporting).
4. **§3** — deadline created before draining, ack watchdog that rejects without restoring. Needs §2's non-restoring
   rule and §5's guaranteed `close()`.
5. **§1** — propagate at shutdown, swallow-and-count in the background drain, single `.immediate()` transaction with
   memory published after commit.
6. **Then** the DRY items that the resulting code still justifies (DRY-5 is free while these lines are open; DRY-6
   when the new tests land; DRY-1/DRY-2/DRY-3/DRY-4 only on their own merits).
7. Fold the repros from `tests/tmp-bug-verification.test.ts` into `tests/terminal-metadata-drain.test.ts` and
   `tests/inference-run-flush-queue.test.ts`, then delete the `tmp-` file.

Each step follows the repo TDD rule: failing test first, minimum implementation, then refactor — and none of the
fixes needs a shim, fallback, or parallel path.

---

## Review round 2 — what was folded, what was corrected

| Review item | Verdict | Where it landed |
| --- | --- | --- |
| Shutdown errors still exit 0 (`main.ts:24`) | **Valid — folded.** One precision: `index.ts:443-446` already hands the error to the callback, so the entrypoint is the only missing link; no new promise plumbing is wanted. Tracing it also exposed the 15 s forced-exit vs 10 s stage-budget inversion, which fails the *successful* slow shutdown at exit 1. | §4 |
| Cleanup skipped on rejection | **Valid — folded**, and it invalidated §3's justification: `close()` is one of the skipped statements, so the "close() handles the leaked fd" trade-off was not real until cleanup runs unconditionally. Ordering changed accordingly. | §5, §3 |
| DRY-2 merges different policies | **Valid, narrowed rather than withdrawn.** The `isIdle()` dependency (`terminal-metadata.ts:180-182`) and the two separate `SIFTKIT_*_IDLE_DELAY_MS` knobs must both survive; merging the functions would persist metadata before its logs. The clamp/elapsed *arithmetic* duplication (173, 181, 312) is still real, so DRY-2 stays as an arithmetic-only extraction. | DRY-2, §Fix order |
| Fix 2 left background failures underspecified | **Valid — folded.** `.catch(serverLogger.error)` could re-throw through the same stdout sink, so the handler now writes to `process.stderr` (the `index.ts:455/490` precedent); the escaping throw also left remaining items unscheduled, and a shutdown joining a running drain only polled state. Error ownership is now specified, with the three requested scenarios as tests. | §2 |
| Row-first ordering is not atomicity; "a retry is possible later" is wrong | **Both valid — folded.** `finalizeTerminal` (288) precedes persistence (290), so a resubmission is `'duplicate'` (245-247) and persists nothing: the loss is permanent, and that sentence is deleted. Because `getMetricsPath()` **is** the runtime database and both writes share the cached connection, the fix is now one `.immediate()` transaction with memory published after commit, and the guarantee is stated as all-or-nothing rather than "row first". | §1 |
| Prerequisite refactors overstated; callback-based `waitFor` conflicts with the dependency rule | **Valid on both counts — folded.** DRY-1/DRY-4 are downgraded to post-fix follow-ups; §3's deadline becomes a private `waitForIdleUntil(deadlineMs)` in the same class; any future shared waiter passes values, not functions. | DRY-1, DRY-4, §Fix order |

Kept from the first draft, reduced in scope: the two waiters still hand-maintain the same 10 ms poll interval — that
is now a one-line constant alignment (`terminal-metadata.ts:428` → the queue's `POLL_INTERVAL_MS`) instead of a new
shared module.