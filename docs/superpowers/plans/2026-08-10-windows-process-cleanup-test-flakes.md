# Windows Process Cleanup Test Flakes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the two reproduced Windows process-cleanup false failures without weakening orphan detection or changing production termination behavior.

**Architecture:** Keep `terminateProcessTree` unchanged. Give process creation, runner timeout, and outer failure bounds distinct test budgets, then assert managed-worker cleanup by polling real PID liveness to confirmed exit. Every failure path retains explicit tree cleanup.

**Tech Stack:** TypeScript, Node `node:test`, Windows `taskkill`, PowerShell test runner.

## Global Constraints

- Do not use SiftKit in this session.
- Do not create a worktree or commit.
- Preserve the existing 20-second deliberately leaked process lifetime, so failed cleanup remains observable.
- Preserve real PID/process-tree behavior; do not mock process termination.
- Leave unrelated Gate B workspace changes untouched.

---

### Task 1: Separate startup, exit, watchdog, and hard-limit budgets

**Files:**
- Modify: `tests/helpers/process-tree-fixture.ts`
- Modify: `tests/run-tests-watchdog.test.ts`
- Test: `tests/run-tests-watchdog.test.ts`

**Interfaces:**
- Consumes: `waitForGrandchildPidFile(pidPath)` and `waitForProcessExit(pid)`.
- Produces: condition polling with a 10-second process-start ceiling and a 5-second process-exit ceiling; the nested watchdog fires at 5 seconds and the outer command remains bounded at 20 seconds.

- [x] **Step 1: Preserve RED evidence**

Run eight copies of `powershell-async` plus `run-tests-watchdog` concurrently.

Expected current result: the watchdog descendant test fails because its 500 ms run budget kills the nested runner before `grandchild.pid` can be created; the outer 2-second PID-file wait then expires.

- [x] **Step 2: Implement distinct timing ceilings**

In `tests/helpers/process-tree-fixture.ts`, replace the shared two-second constant with:

```ts
const PROCESS_START_WAIT_TIMEOUT_MS = 10_000;
const PROCESS_EXIT_WAIT_TIMEOUT_MS = 5_000;
```

Use the start ceiling only in `waitForGrandchildPidFile` and the exit ceiling only in `waitForProcessExit`, including their error messages.

In `tests/run-tests-watchdog.test.ts`, set:

```ts
const RUN_BUDGET_MS = 5_000;
const HARD_LIMIT_MS = 20_000;
```

The existing elapsed assertion must continue proving the nested watchdog fired before half of the outer hard limit.

- [x] **Step 3: Verify the watchdog under reproduced pressure**

Run the focused files once, then eight copies concurrently.

Expected: every run passes; the nested watchdog still reports `Test run exceeded`, returns exit code 124, and its grandchild PID reaches not-alive before the assertion completes.

---

### Task 2: Await managed-worker exit before asserting

**Files:**
- Modify: `tests/run-tests-watchdog.test.ts`
- Test: `tests/run-tests-watchdog.test.ts`

**Interfaces:**
- Consumes: the existing `waitForProcessExit(pid)` real-process polling helper.
- Produces: an eventual-exit assertion for every PID recorded by the managed-llama fixture, plus unconditional cleanup of every PID still alive on failure.

- [x] **Step 1: Preserve RED evidence**

Run twelve copies of only `managed llama readiness cleanup releases its worker and every failed launcher process` concurrently.

Expected current result: at least one run can observe a worker PID alive at the immediate snapshot even though it exits or is cleaned immediately afterward.

- [x] **Step 2: Await the real cleanup condition**

After validating the nested test result and the expected three PID records, await:

```ts
await Promise.all(managedProcessIds.map((pid) => waitForProcessExit(pid)));
```

Then assert that no PID is alive. In `finally`, inspect all recorded PIDs and call `terminateProcessTree` for each survivor so a failing assertion cannot leak a worker.

- [x] **Step 3: Verify the managed cleanup under reproduced pressure**

Run the focused test once, then twelve copies concurrently.

Expected: every run passes and a process-table check finds no repository test or fake-llama Node process.

---

### Task 3: Final validation and orphan audit

**Files:**
- Review: all files changed by Tasks 1–2

- [x] **Step 1: Rebuild test artifacts**

Run `npm run build:test`. Expected: exit 0.

- [x] **Step 2: Run focused and full validation**

Run the focused cleanup tests, `npm test`, `npm run typecheck`, and `npm run lint` outside the sandbox where Windows taskkill is permitted. Expected: zero failures.

- [x] **Step 3: Audit external and workspace state**

Verify no repository test Node process remains and ports 4765 and 8097 are closed. Run `git diff --check` and confirm only the intended test-harness files plus the pre-existing Gate B changes are present.
