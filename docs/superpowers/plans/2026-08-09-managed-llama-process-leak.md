# Managed Llama Process Leak Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make failed Windows managed-llama fixture launches terminate and release the Node test worker when `taskkill` is unavailable.

**Architecture:** Preserve the working production tree-termination path. Make the deliberately hanging fake managed process exit when its test-only launcher disappears, and prove both worker exit and descendant exit with a restricted-taskkill nested test and complete fake-process PID history.

**Tech Stack:** TypeScript 5.9, Node.js 24 `node:test`, Windows `cmd.exe` and `taskkill`

## Global Constraints

- Work inline in the current checkout; do not use worktrees or subagents.
- Use TDD and do not commit.
- Preserve unrelated changes and avoid compatibility paths.

### Task 1: Add the process-lifecycle regression

**Files:**
- Modify: `tests/helpers/managed-llama-fixtures.ts`
- Modify: `tests/run-tests-watchdog.test.ts`

- [x] Record every hanging fake managed-process PID in a caller-provided history file.
- [x] Spawn the exact managed-llama readiness test in a nested Node worker.
- [x] Force only the nested worker's `taskkill` call to fail.
- [x] Require exit code 0 and assert every recorded PID is dead.
- [x] Clean recorded PIDs in `finally` on failure.
- [x] Build test artifacts and witness the regression fail because the worker times out.

### Task 2: Make the fake managed process follow launcher lifetime

**Files:**
- Modify: `tests/helpers/managed-llama-fixtures.ts`

- [x] Poll the hanging fake process's launcher PID and exit when it disappears.
- [x] Rebuild test artifacts.
- [x] Run the regression and focused process-tree/lifecycle tests to green.

### Task 3: Validate no process leaks

- [x] Record the clean Node PID baseline.
- [x] Run the unchanged full suite.
- [x] Compare Node PIDs and reject any new surviving process.
- [x] Run typecheck, lint, and `git diff --check`.
- [x] Review the scoped diff and remove temporary artifacts.

### Task 4: Close settings metadata regressions

**Files:**
- Modify: `dashboard/src/settings-sections.ts`
- Modify: `tests/settings-sections.test.ts`

- [x] Run `npm test -- settings-sections --test-concurrency=1` and confirm the exact-label and help-text tests fail.
- [x] Add `Max image size (MP)` and `Vision image retention` to the expected canonical label sequence.
- [x] Add concise, non-empty `helpText` values to the `Vision enabled`, `Max image size (MP)`, and `Vision image retention` descriptors.
- [x] Rebuild test artifacts and rerun the focused settings tests to green.
- [x] Repeat the full suite with before/after Node-process snapshots, then run typecheck, lint, and `git diff --check`.
