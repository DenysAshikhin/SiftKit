# Late Acknowledgement Report Before Ownership Guard — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A late acknowledgement for an abandoned flush batch is always reported, and only the running-state hand-back is skipped when a newer batch already owns that state.

**Architecture:** `InferenceRunFlushQueue.releaseAbandonedRun` currently returns before reporting when `runningMessageId` no longer matches the replying batch, so a superseded batch's reply is dropped silently and the regression test `a late acknowledgement cannot clear a newer batch of the same run` (which waits for the `flush_late_ack` line) times out. Reorder the method: report first, then guard the state release. No other file changes.

**Tech Stack:** TypeScript, node:test via `node ./dist/test-runner/run-tests.js`, `npm run typecheck`.

---

### Task 1: Report the late acknowledgement before the ownership guard

**Files:**
- Modify: `src/status-server/inference-run-flush-queue.ts:538-552` (`releaseAbandonedRun`)
- Test (already written, currently RED): `tests/inference-run-flush-queue.test.ts:668` — `a late acknowledgement cannot clear a newer batch of the same run`

- [ ] **Step 1: Run the existing failing test to confirm it fails**

Run:
```powershell
npm run build:test
node ./dist/test-runner/run-tests.js inference-run-flush-queue
```
Expected: 1 failing test — `a late acknowledgement cannot clear a newer batch of the same run` with `Error: Condition still false after 5000ms: the abandoned batch answered`. All other tests in the file pass.

- [ ] **Step 2: Reorder `releaseAbandonedRun` so the report is unconditional**

Replace the method and its doc comment in `src/status-server/inference-run-flush-queue.ts` (currently lines 538-552) with exactly:

```ts
  /**
   * Hands back the running state an abandoned batch left behind, once its reply has proved that batch
   * is over. Nothing is restored, retried or recounted: the drain that gave up on the batch reported
   * the unknown outcome, so the reply is always reported — it is the only evidence the write landed.
   * The message id is what keeps that reply from clearing a flush that started in the meantime,
   * including a newer batch of the *same* run, whose `runningRunId` this reply cannot tell apart from
   * its own: the report still goes out, the hand-back is skipped.
   */
  private releaseAbandonedRun(messageId: number, runId: string, startedAtMs: number): void {
    this.reportLateAcknowledgement(runId, Date.now() - startedAtMs);
    if (this.runningMessageId !== messageId) {
      return;
    }
    this.runningMessageId = null;
    this.runningRunId = null;
  }
```

Do not change `reportLateAcknowledgement`, `flushInWorker`, or any test.

- [ ] **Step 3: Run the flush-queue tests to verify they pass**

Run:
```powershell
npm run build:test
node ./dist/test-runner/run-tests.js inference-run-flush-queue
```
Expected: all tests pass, including `a late acknowledgement cannot clear a newer batch of the same run` and `a late acknowledgement whose report cannot be written is still released` (the report now fails before the hand-back, is caught, and the state is still released).

- [ ] **Step 4: Typecheck and lint**

Run:
```powershell
npm run typecheck
```
Expected: exit 0, no errors.

- [ ] **Step 5: Do not commit**

Leave the change uncommitted; the working tree already holds related uncommitted work.

**Acceptance criteria**
- `releaseAbandonedRun` calls `reportLateAcknowledgement` before the `runningMessageId` comparison.
- `node ./dist/test-runner/run-tests.js inference-run-flush-queue` reports 0 failures.
- `npm run typecheck` exits 0.
- No files other than `src/status-server/inference-run-flush-queue.ts` are modified.
