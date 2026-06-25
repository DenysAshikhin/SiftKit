# F11 — Server/Workspace Split: Replace Execution Lease with Server-Owned Queue Ownership

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Delete the cross-process execution lease/lock entirely and make the already-existing server-owned model-request queue the sole authority over execution concurrency.

**Architecture:** The status server is the single owner of the managed `llama-server` and of all model execution; it already serializes work through the FIFO `modelRequestQueue` (`acquireModelRequestWithWait` → `grantNextModelRequest`/`releaseModelRequest`), which routes already use. A *workspace* is a transient CLI invocation that submits an HTTP request and awaits — it must never hold a cross-process lock or run a heartbeat. F11 removes the redundant lease layer (`execution-lock.ts`, `config/execution-lease.ts`, the `/execution*` routes, `lease-handlers.ts`, `ctx.activeExecutionLease`) that duplicated, and contended with, the queue.

**Tech Stack:** TypeScript (strict, zero-cast/zero-`any`), Node.js `node:test`, the existing status-server HTTP routes and `ServerContext` model-request queue.

**Key facts verified before planning (re-verify against current code):**
- `summary` runs server-side via `POST /summary`, which already acquires the queue (`core.ts:1034`) and passes `skipExecutionLock: true`.
- `eval` runs server-side via `POST /eval/run` → `EvalRunEndpoint`, which already holds a **whole-run** queue slot (`core.ts:900`, released `core.ts:1005`). The only defect is that `runEvaluation` (`eval.ts:75`) redundantly wraps `withExecutionLock` and calls `summarizeRequest` directly.
- `install` runs **client-side** (`run-install.ts:5`, `run-internal.ts:47`) and wraps `withExecutionLock` around idempotent config/probe work only.
- `command-output/analyzer.ts` and `preset-runner.ts` run server-side and pass `skipExecutionLock: true`.
- The cross-process lease's only remaining real (non-reentrant) acquirers are: `eval` (redundant), `install`, and the dev script `bench/repro/repro-fixture60-malformed-json.ts`.

**Non-goals (explicit):**
- Do **not** change eval to per-fixture `POST /summary`; keep its existing whole-run queue slot.
- Do **not** move `eval.ts`/`benchmark-spec-settings.ts` out of `src/` — `eval.ts` is server runtime (imported by `engine-service.ts`). Module/package repackaging stays in F15.
- **Bench direct `summarizeRequest` callers stay out of scope (F15).** `bench/benchmark/runner.ts:68` and `bench/repro/run-benchmark-fixture-debug.ts:210` call `summarizeRequest()` in-process. Today the client lease serialized them machine-wide; after this work they run with no cross-process coordination. This is acceptable: these are offline benchmark/debug harnesses run manually (typically with no other server work in flight), not production workspace paths. Routing them through `POST /summary` belongs to F15's eval/benchmark repackaging. **This task adds a `log()`-style note in the plan, not a code change, so the coverage gap is explicit.**
- Do **not** churn the `lock_wait_ms_total` metrics/DB schema. The `lockWaitMs` telemetry is retained and fed `0` (no lock ⇒ no wait). Repurposing it to the server-queue wait is a separate observability task.

**Validation discipline (critical):** `tsc --noEmit` over `tsconfig.json` covers **`src` only**. Every deletion below also touches `tests/` and `bench/`, so each task is validated with **`npm run typecheck`** (which runs `typecheck:test` + `typecheck:bench` + lint, per `package.json:16`). Each task is structured to leave `npm run typecheck` green at its commit — the test/fixture edits live in the **same** task as the deletion that breaks them. The full suite (`npm test`, `package.json:27`) runs in the final task.

---

## File Structure

**Deleted production files:** `src/execution-lock.ts`, `src/config/execution-lease.ts`, `src/status-server/core/lease-handlers.ts`.

**Deleted test files:** `tests/execution-lock.test.ts`, `tests/runtime-execution-lease.test.ts`, `tests/routes-core-lease.test.ts`.

**Modified production files:** `src/config/index.ts`, `src/summary/types.ts`, `src/summary/request-runner.ts`, `src/eval.ts`, `src/install.ts`, `src/command-output/analyzer.ts`, `src/status-server/preset-runner.ts`, `src/status-server/routes/core.ts`, `src/status-server/route-request-normalizers.ts`, `src/status-server/server-ops.ts`, `src/status-server/server-types.ts`, `src/status-server/index.ts`, `src/status-server/managed-llama.ts`, `bench/repro/repro-fixture60-malformed-json.ts`.

**Modified/new test files:** `tests/_runtime-helpers.ts`, `tests/_test-helpers.ts`, `tests/config.test.ts`, `tests/summary-request-runner.test.ts`, `tests/summary-status-server.test.ts`, `tests/timing-recorder.test.ts`, `tests/runtime-status-server.test.ts`, `tests/runtime-summarize.test.ts`, `tests/runtime-status-server.idle-summary.test.ts`, `tests/route-request-normalizers.test.ts`, `tests/error-diagnostics.test.ts`, `tests/model-request-queue.test.ts`, `tests/llama-passthrough-idle-rearm.test.ts`, `tests/status-running-wake.test.ts`, `tests/SiftKit.Tests.ps1`, new `tests/execution-ownership.test.ts`.

---

## Task 1: Remove `skipExecutionLock` and the client lease from all callers

Removes every **producer/consumer** of the lock except the lease modules themselves (deleted in Task 2). Includes the three tests that pass `skipExecutionLock`, so `npm run typecheck` stays green.

**Files:**
- Modify: `src/eval.ts:74-173`, `src/install.ts:79-110`, `src/summary/types.ts:46`, `src/summary/request-runner.ts` (regions below)
- Modify: `src/command-output/analyzer.ts:179`, `src/status-server/preset-runner.ts:171`, `src/status-server/routes/core.ts:1060`
- Modify: `bench/repro/repro-fixture60-malformed-json.ts:14,286,442-447`
- Modify: `tests/summary-request-runner.test.ts:19`, `tests/summary-status-server.test.ts:778`, `tests/timing-recorder.test.ts:194`

- [ ] **Step 1: Remove `withExecutionLock` from `runEvaluation`**

In `src/eval.ts` delete import line 8 (`import { withExecutionLock } from './execution-lock.js';`). Unwrap lines 74-75:
```ts
export async function runEvaluation(request: EvalRequest): Promise<EvaluationResult> {
  return withExecutionLock(async () => {
    const config = await loadConfig({ ensure: true });
```
→
```ts
export async function runEvaluation(request: EvalRequest): Promise<EvaluationResult> {
  const config = await loadConfig({ ensure: true });
```
and the close (lines 166-173):
```ts
    return {
      Backend: backend,
      Model: model,
      ResultPath: persistedEvalResult.uri,
      Results: results,
    };
  });
}
```
→
```ts
  return {
    Backend: backend,
    Model: model,
    ResultPath: persistedEvalResult.uri,
    Results: results,
  };
}
```
De-indent the function body (old lines 76-171) one level.

- [ ] **Step 2: Remove `withExecutionLock` from `installSiftKit`**

In `src/install.ts` delete import line 6. Unwrap lines 79-110 (`return withExecutionLock(async () => { ... });` → direct body), keeping `void force;`. De-indent the body one level.

- [ ] **Step 3: Remove `skipExecutionLock` from the request type**

In `src/summary/types.ts` delete line 46 (`skipExecutionLock?: boolean;`).

- [ ] **Step 4: Remove the lease + `lockWaitMs` threading from `request-runner.ts`**

In `src/summary/request-runner.ts`:
- Delete import line 15 (`import { acquireExecutionLock, releaseExecutionLock } from '../execution-lock.js';`).
- Delete type alias line 45 (`type SummaryExecutionLock = Awaited<ReturnType<typeof acquireExecutionLock>>;`).
- Replace `run()` body lines 115-125:
```ts
    const lockStartedAt = Date.now();
    const lock = this.request.skipExecutionLock ? null : await acquireExecutionLock();
    const lockWaitMs = this.request.skipExecutionLock ? 0 : Date.now() - lockStartedAt;
    try {
      return await this.runWithLock(lockWaitMs);
    } finally {
      await this.releaseLock(lock);
      await this.flushTiming();
    }
  }
```
→
```ts
    try {
      return await this.runRequest();
    } finally {
      await this.flushTiming();
    }
  }
```
- Rename `runWithLock` (line 170) to `runRequest` and drop its `lockWaitMs` param; drop the `lockWaitMs` args at its internal calls to `tryDeterministicPassFail` (173), `invokeModelSummary` (177), `handleFailure` (179).
- Drop the `lockWaitMs: number,` param from `tryDeterministicPassFail` (255), `invokeModelSummary` (291), `notifyDeterministicCompletion` (343), `notifyModelCompletion` (383), `handleFailure` (451), and the trailing `lockWaitMs` args where they call the notify helpers (284, 333).
- Set the two `deferredMetadata.lockWaitMs` fields (358, 406) to the literal `lockWaitMs: 0,`.
- In `handleFailure`, replace line 481 `lockWaitMs: failureContext?.lockWaitMs ?? lockWaitMs,` with `lockWaitMs: failureContext?.lockWaitMs ?? 0,`.
- Delete the `releaseLock` method (lines 520-524).

- [ ] **Step 5: Drop `skipExecutionLock: true` at the three server call sites**

Delete `skipExecutionLock: true,` from `src/command-output/analyzer.ts:179`, `src/status-server/preset-runner.ts:171`, `src/status-server/routes/core.ts:1060`.

- [ ] **Step 6: Remove the lease from the bench repro script**

In `bench/repro/repro-fixture60-malformed-json.ts` delete import line 14, the acquire at line 286 (`lock = await acquireExecutionLock();`), and the release block (lines 442-447). Remove the now-unused `lock` declaration (`git grep -n "lock" bench/repro/repro-fixture60-malformed-json.ts` to find it). If `getErrorMessage` becomes unused there, remove its import.

- [ ] **Step 7: Remove `skipExecutionLock` from the three tests that pass it**

Delete the `skipExecutionLock: true,` line from `tests/summary-request-runner.test.ts:19`, `tests/summary-status-server.test.ts:778`, `tests/timing-recorder.test.ts:194`.

- [ ] **Step 8: Verify no `skipExecutionLock` references remain anywhere**

Run: `git grep -n "skipExecutionLock" -- src tests bench`
Expected: no matches.

- [ ] **Step 9: Typecheck and run affected tests**

Run: `npm run typecheck`
Expected: PASS (src + test + bench + lint). The lease modules still exist (used by `execution-lock.test.ts`/`config.test.ts`/harness until Task 2), so this is green.
Run: `npm run build:test && node ./dist/scripts/run-tests.js --test-name-pattern "eval|install|summarizeRequest|request runner"` (or run `tests/eval.test.ts tests/install.test.ts tests/summary-request-runner.test.ts tests/timing-recorder.test.ts tests/summary-status-server.test.ts` via the project's test runner)
Expected: PASS.

- [ ] **Step 10: Commit**

```bash
git add src/eval.ts src/install.ts src/summary/types.ts src/summary/request-runner.ts \
  src/command-output/analyzer.ts src/status-server/preset-runner.ts src/status-server/routes/core.ts \
  bench/repro/repro-fixture60-malformed-json.ts \
  tests/summary-request-runner.test.ts tests/summary-status-server.test.ts tests/timing-recorder.test.ts
git commit -m "refactor(F11): remove client execution lease + skipExecutionLock from callers"
```

---

## Task 2: Delete the client lease modules and every client-side importer

One atomic, green-at-commit change: the deleted modules and all their importers (config re-exports, `config.test.ts`, the two client lease tests, and the harness stub) go together.

**Files:**
- Delete: `src/execution-lock.ts`, `src/config/execution-lease.ts`, `tests/execution-lock.test.ts`, `tests/runtime-execution-lease.test.ts`
- Modify: `src/config/index.ts:79-85`
- Modify: `tests/config.test.ts` (imports `12,26,33`; tests `266-270,306-308,681-703`)
- Modify: `tests/_runtime-helpers.ts`, `tests/_test-helpers.ts`, `tests/runtime-status-server.test.ts`, `tests/runtime-summarize.test.ts`

- [ ] **Step 1: Delete the client lease modules and re-exports**

```bash
git rm src/execution-lock.ts src/config/execution-lease.ts
```
In `src/config/index.ts` delete lines 79-85 (the `export { getExecutionServerState, getExecutionServiceUrl, refreshExecutionLease, releaseExecutionLease, tryAcquireExecutionLease } from './execution-lease.js';` block).

- [ ] **Step 2: Delete the two client-lease test files**

```bash
git rm tests/execution-lock.test.ts tests/runtime-execution-lease.test.ts
```

- [ ] **Step 3: Remove lease imports/tests from `config.test.ts`**

In `tests/config.test.ts` remove the imports `getExecutionServerState` (12), `getExecutionServiceUrl` (26), `releaseExecutionLease` (33), and delete the three tests: `getExecutionServiceUrl returns execution endpoint URL` (266-270 incl. surrounding `test(...)`), `getExecutionServerState returns busy status` (306-308 block), and `releaseExecutionLease ignores already-cleared lease responses` (681-703 block). Verify exact block bounds in-file before deleting.

- [ ] **Step 4: Strip lease plumbing from `_runtime-helpers.ts`**

In `tests/_runtime-helpers.ts`:
- Delete `const FAST_LEASE_STALE_MS = 200;` (152) and remove `FAST_LEASE_STALE_MS,` from the export at 1568 (keep `FAST_LEASE_WAIT_MS` only if `git grep FAST_LEASE_WAIT_MS` shows non-lease use; otherwise remove it too).
- Remove `executionLeaseToken: string | null;` (205) and initializer `executionLeaseToken: null,` (527).
- Remove the `executionLeaseStaleMs?: number;` option fields (262, 288), the `SIFTKIT_EXECUTION_LEASE_STALE_MS` env passthrough (1181), and the option-to-env logic (1198-1201, 1273).
- Delete the stub `GET /execution` responder (~620) and the `acquire`/`heartbeat`/`release` responders (922-951).
- Remove the `withExecutionLock` re-export (1561).

- [ ] **Step 5: Strip lease plumbing from `_test-helpers.ts`**

In `tests/_test-helpers.ts` remove `executionLeaseToken: string | null;` (183), `executionLeaseToken: null,` (211), the `GET /execution` responder (238), and the acquire/release responders (253-264).

- [ ] **Step 6: Remove harness lease usages from the two runtime tests**

In `tests/runtime-status-server.test.ts` remove `FAST_LEASE_STALE_MS,` from the import (24) and delete the three `executionLeaseStaleMs: FAST_LEASE_STALE_MS,` option lines (72, 153, 569).
In `tests/runtime-summarize.test.ts` delete the `server.state.executionLeaseToken = ...` lines (244-246) and any assertion that summary *waited for the lease*; the test must now assert the summary simply completes (if the test existed only to prove lease-waiting, delete the whole `test(...)`).

- [ ] **Step 7: Verify the client lease is fully gone**

Run: `git grep -n "execution-lock\|execution-lease\|getExecutionServerState\|tryAcquireExecutionLease\|refreshExecutionLease\|withExecutionLock\|executionLeaseToken\|executionLeaseStaleMs\|FAST_LEASE_STALE_MS" -- src tests`
Expected: no matches.

- [ ] **Step 8: Typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "refactor(F11): delete client lease modules, re-exports, tests, and harness stubs"
```

---

## Task 3: Delete the server `/execution*` routes and lease state (TDD: routes-gone E2E first)

**Files:**
- New: `tests/execution-ownership.test.ts`
- Modify: `src/status-server/routes/core.ts` (imports `54,64,66,72-73`; classes `653-746`; routes `1769-1772`)
- Modify: `src/status-server/route-request-normalizers.ts:95-98` (+ `ExecutionTokenRequest` type)
- Modify: `src/status-server/server-ops.ts` (imports `42,49-53`; `isIdle` `307-312`; lease fns `370-387`)
- Modify: `src/status-server/server-types.ts:30,121`, `src/status-server/index.ts:230`, `src/status-server/managed-llama.ts:87`
- Delete: `src/status-server/core/lease-handlers.ts`, `tests/routes-core-lease.test.ts`
- Modify: `tests/model-request-queue.test.ts:47`, `tests/llama-passthrough-idle-rearm.test.ts:97`, `tests/status-running-wake.test.ts:85`, `tests/runtime-status-server.idle-summary.test.ts:351-407`, `tests/route-request-normalizers.test.ts:5,17,18`, `tests/error-diagnostics.test.ts:45,53`

- [ ] **Step 1: Write the failing E2E — `/execution*` must be gone**

Create `tests/execution-ownership.test.ts`:
```ts
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { getDefaultConfig, writeConfig } from '../src/status-server/config-store.js';
import { getConfigPath } from '../src/config/index.js';
import {
  withTempEnv,
  withRealStatusServer,
  requestJson,
} from './_runtime-helpers.js';

test('the status server exposes no execution-lease routes', async () => {
  await withTempEnv(async (tempRoot) => {
    const statusPath = path.join(tempRoot, 'status', 'inference.txt');
    const configPath = getConfigPath();
    const config = getDefaultConfig();
    config.Backend = 'noop';
    fs.mkdirSync(path.dirname(statusPath), { recursive: true });
    writeConfig(configPath, config);

    await withRealStatusServer(async ({ statusUrl }) => {
      const base = statusUrl.replace(/\/status$/u, '');
      await assert.rejects(() => requestJson(`${base}/execution`));
      await assert.rejects(() => requestJson(`${base}/execution/acquire`, { method: 'POST', body: '{}' }));
      await assert.rejects(() => requestJson(`${base}/execution/release`, { method: 'POST', body: '{"token":"x"}' }));
    }, { statusPath, configPath });
  });
}); 
```

- [ ] **Step 2: Run it to verify it FAILS**

Run the test via the project runner (e.g. `npm run build:test && node ./dist/scripts/run-tests.js --test-name-pattern "no execution-lease routes"`).
Expected: FAIL — the routes still return 200, so `assert.rejects` rejects.

- [ ] **Step 3: Remove the four endpoint classes, route entries, and imports in `core.ts`**

In `src/status-server/routes/core.ts`: delete classes `ExecutionReadEndpoint` (653-666), `ExecutionAcquireEndpoint` (668-687), `ExecutionHeartbeatEndpoint` (689-719), `ExecutionReleaseEndpoint` (721-746); delete route entries 1769-1772; remove `parseExecutionTokenRequest` from the import at 54; remove `EXECUTION_LEASE_STALE_MS` from the `managed-llama.js` import (64); delete the `lease-handlers.js` import (66); remove `getActiveExecutionLease` (72) and `releaseExecutionLease` (73) from the `server-ops.js` import. (Leave the queue's `releaseModelRequest` import intact — different symbol.)

- [ ] **Step 4: Remove `parseExecutionTokenRequest` + `ExecutionTokenRequest`**

In `src/status-server/route-request-normalizers.ts` delete the function (95-98) and the `ExecutionTokenRequest` type declaration (search the file).

- [ ] **Step 5: Remove the server lease state helpers**

In `src/status-server/server-ops.ts`: remove `ExecutionLease` from the `server-types.js` import (42); change the `managed-llama.js` import (49-52) to `import { logLine } from './managed-llama.js';`; delete the `lease-handlers.js` import (53); simplify `isIdle` (307-312) to:
```ts
export function isIdle(ctx: ServerContext): boolean {
  return !hasActiveRuns(ctx)
    && !ctx.activeModelRequest
    && ctx.modelRequestQueue.length === 0;
}
```
Delete both lease functions `getActiveExecutionLease` and `releaseExecutionLease` (370-387) and the section comment.

- [ ] **Step 6: Delete `lease-handlers.ts` and remove the type/field/constant**

```bash
git rm src/status-server/core/lease-handlers.ts
```
In `src/status-server/server-types.ts` delete the `ExecutionLease` type (30) and the `activeExecutionLease` field (121). In `src/status-server/index.ts` delete the `activeExecutionLease: null,` initializer (230). In `src/status-server/managed-llama.ts` delete `EXECUTION_LEASE_STALE_MS` (87). If `getPositiveIntegerFromEnv` becomes unused, leave it (shared helper).

- [ ] **Step 7: Fix the three `ServerContext` fixtures**

Delete the `activeExecutionLease: null,` line from `tests/model-request-queue.test.ts:47`, `tests/llama-passthrough-idle-rearm.test.ts:97`, `tests/status-running-wake.test.ts:85`.

- [ ] **Step 8: Delete the server-lease tests and stale references**

```bash
git rm tests/routes-core-lease.test.ts
```
In `tests/runtime-status-server.idle-summary.test.ts` delete the test `real status server does not count idle delay while an execution lease remains active` (351-407). Then remove any now-unused `LeaseResponse` type and `server.executionUrl` references in that file (`git grep -n "LeaseResponse\|executionUrl" tests/runtime-status-server.idle-summary.test.ts`); if `executionUrl` is unused across all tests, remove it from the harness return in `_runtime-helpers.ts`.
In `tests/route-request-normalizers.test.ts` remove `parseExecutionTokenRequest,` from the import (5) and delete the two assertions (17-18).
In `tests/error-diagnostics.test.ts` update the stale operation literal (45, 53): change `'execution:acquire'` → `'status:post'` (a real operation). *(Not a typecheck blocker — `operation` is typed `string` — but the literal references a removed operation and should not mislead.)*

- [ ] **Step 9: Verify, typecheck, and run the E2E (now PASS)**

Run: `git grep -n "activeExecutionLease\|ExecutionLease\|lease-handlers\|EXECUTION_LEASE_STALE_MS\|parseExecutionTokenRequest\|execution:acquire\|execution:release" -- src tests`
Expected: no matches (the `error-diagnostics` literals are now `status:post`).
Run: `npm run typecheck`
Expected: PASS.
Run the suite for the touched files (`tests/execution-ownership.test.ts tests/model-request-queue.test.ts tests/llama-passthrough-idle-rearm.test.ts tests/status-running-wake.test.ts tests/runtime-status-server.idle-summary.test.ts tests/route-request-normalizers.test.ts tests/error-diagnostics.test.ts`).
Expected: PASS, including `the status server exposes no execution-lease routes`.

- [ ] **Step 10: Commit**

```bash
git add -A
git commit -m "refactor(F11): remove server /execution routes, lease state, handlers, and fixtures"
```

---

## Task 4: Remove the lease stub from the PowerShell test server

**Files:**
- Modify: `tests/SiftKit.Tests.ps1` (lines `200,230,297-326`)

- [ ] **Step 1: Delete the inline-JS `/execution*` stub handlers**

In `tests/SiftKit.Tests.ps1` remove `let executionLeaseToken = null;` (200), the `/execution` GET responder returning `{ busy: !!executionLeaseToken }` (230), and the acquire/heartbeat/release handlers (297-326). Ensure the surrounding inline Node server still parses (no dangling `if`/`else`).

- [ ] **Step 2: Verify and (if runnable here) execute**

Run: `git grep -n "executionLeaseToken\|/execution" -- tests/SiftKit.Tests.ps1`
Expected: no matches.
Run the PowerShell suite if it is part of the local gate (`pwsh -File tests/SiftKit.Tests.ps1`); otherwise document that it was not executed in this environment.

- [ ] **Step 3: Commit**

```bash
git add tests/SiftKit.Tests.ps1
git commit -m "test(F11): remove execution-lease stub from PowerShell test server"
```

---

## Task 5: Full-suite verification and architecture-review update

**Files:**
- Modify: `ARCHITECTURE-REVIEW.md` (F11 section + priority list), `README.md` (if it mentions `/execution`)

- [ ] **Step 1: Run the full typecheck and test suite**

Run: `npm run typecheck`
Expected: PASS.
Run: `npm test`
Expected: PASS.

- [ ] **Step 2: Final grep gate**

Run: `git grep -ni "executionlease\|execution-lock\|execution-lease\|skipExecutionLock\|/execution\|withExecutionLock" -- src tests bench README.md`
Expected: no matches except this plan doc. Remove any stale `/execution` mention in `README.md` if present.

- [ ] **Step 3: Mark F11 resolved in the architecture review**

In `ARCHITECTURE-REVIEW.md` remove the `### F11` block (12-16) and the F11 entry in the Priority order list (98). Bump `Last pruned:` (6) to `2026-06-25`. Leave F15 noting eval/benchmark *code repackaging* and the **bench `summarizeRequest` direct callers** (`bench/benchmark/runner.ts`, `bench/repro/run-benchmark-fixture-debug.ts`) remain — they no longer serialize and should be routed through `POST /summary` when F15 repackages bench.

- [ ] **Step 4: Commit**

```bash
git add ARCHITECTURE-REVIEW.md README.md
git commit -m "docs(architecture-review): mark F11 resolved after execution-lease removal"
```

---

## Self-Review Notes (for the implementer)

- **Ownership invariant after this work:** the only execution-concurrency authority is `acquireModelRequestWithWait` / `releaseModelRequest` on `ServerContext.modelRequestQueue`. No client holds a cross-process lock; no heartbeat exists.
- **Green at every commit:** each deletion task also edits the tests/fixtures it breaks, validated by `npm run typecheck` (not bare `tsc --noEmit`, which misses `tests/` and `bench/`).
- **`lockWaitMs` retained, fed `0`:** the `lock_wait_ms_total` DB column, `metrics.ts`, `idle-summary.ts`, `status-file.ts` plumbing are intentionally untouched.
- **Eval isolation preserved:** `EvalRunEndpoint` still holds one whole-run queue slot; do not split eval into per-fixture HTTP calls.
- **Known coverage gap (intentional, → F15):** bench `summarizeRequest` callers run without cross-process serialization after this work.
- **Reentrancy gone:** the old lease had in-process reentrancy (`activeLockDepth`) that eval relied on while also holding the outer lease. Both layers are removed together, so there is nothing to re-enter.
