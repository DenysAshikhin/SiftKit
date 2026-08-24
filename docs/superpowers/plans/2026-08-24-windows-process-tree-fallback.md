# Windows Process-Tree Fallback Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Guarantee that timed-out Windows commands terminate their complete rooted process tree even when `taskkill /T /F` is denied.

**Architecture:** Keep `taskkill` as the primary Windows tree-kill path. On failure, obtain a native Toolhelp32 process snapshot through a bounded PowerShell helper, validate the snapshot with Zod, derive only descendants reachable from the requested root, and terminate them deepest-first before terminating the root. Preserve the current non-Windows behavior and public API.

**Tech Stack:** TypeScript, Node child processes, Windows Toolhelp32 API invoked through Windows PowerShell `Add-Type`, Zod, Node test runner.

**Spec:** User-approved bounded design in this session; no separate specification file.

## Global Constraints

- Existing timeout values and assertions remain unchanged.
- Never kill siblings, ancestors, cousins, or unrelated processes; only the requested root and graph-reachable descendants are eligible.
- Validate process-snapshot IO with a runtime Zod schema and derive its TypeScript type with `z.infer`.
- No `any`, type assertions, non-null assertions, compatibility path, new dependency, worktree, commit, or retained diagnostic artifact.
- Preserve the `terminateProcessTree(pid, options): boolean` interface and non-Windows `SIGTERM` behavior.

---

### Task 1: Typed Toolhelp Fallback and Regression Coverage

**Files:**
- Modify: `src/lib/process-tree.ts`
- Create: `tests/process-tree.test.ts`

**Interfaces:**
- Consumes: existing `TerminateProcessTreeOptions.processObject`, `TerminateProcessTreeOptions.spawnSyncImpl`, `parseJsonValueText`, and `z`.
- Produces: `orderDescendantProcessIds(rootPid: number, entries: readonly WindowsProcessEntry[]): number[]`, used by `terminateProcessTree`; returns descendants only, ordered deepest-first.

- [ ] **Step 1: Write the failing pure graph regression**

Add a test with this hand-derived process snapshot:

```ts
const entries = [
  { ProcessId: 10, ParentProcessId: 1 },
  { ProcessId: 20, ParentProcessId: 10 },
  { ProcessId: 30, ParentProcessId: 20 },
  { ProcessId: 40, ParentProcessId: 10 },
  { ProcessId: 50, ParentProcessId: 1 },
  { ProcessId: 60, ParentProcessId: 50 },
];
assert.deepEqual(orderDescendantProcessIds(10, entries), [30, 20, 40]);
```

This catches killing parents before children and killing the sibling/cousin branch rooted at PID 50.

- [ ] **Step 2: Run RED**

```powershell
npm run build:test
npm test -- process-tree
```

Expected: build/test fails because `orderDescendantProcessIds` does not exist.

- [ ] **Step 3: Implement graph ordering and validated Toolhelp snapshot**

In `src/lib/process-tree.ts`:

1. Add `WindowsProcessEntrySchema = z.object({ ProcessId: z.number().int().positive(), ParentProcessId: z.number().int().nonnegative() })`, `WindowsProcessSnapshotSchema = z.array(WindowsProcessEntrySchema)`, and `type WindowsProcessEntry = z.infer<typeof WindowsProcessEntrySchema>`.
2. Implement `orderDescendantProcessIds` as cycle-safe depth-first traversal from `rootPid`, appending each child after its own descendants. Never append `rootPid` and never traverse an entry not reachable from it.
3. Add one private PowerShell command string that uses `CreateToolhelp32Snapshot`, `Process32FirstW`, and `Process32NextW` to emit a JSON array of `{ ProcessId, ParentProcessId }`. It performs no termination itself.
4. Parse stdout with `parseJsonValueText` then `WindowsProcessSnapshotSchema.safeParse`; a failed helper, non-zero status, malformed output, or empty output yields no fallback descendants.
5. When Windows `taskkill` returns non-zero or throws, snapshot descendants, call `processObject.kill(pid, 'SIGTERM')` for each deepest-first, then kill the root. Return true if at least one eligible process accepted termination.

- [ ] **Step 4: Run GREEN unit and real integration tests**

```powershell
npm run build:test
npm test -- process-tree powershell-async command-spawn
```

Acceptance: graph ordering excludes relatives; unchanged sandboxed PowerShell tests pass 3/3; direct-command tests pass 4/4.

---

### Task 2: Independent Cleanup and Complete Verification

**Files:**
- Delete: `.scratch/powershell-tree-diagnosis/`
- Verify only: all files changed in this session

**Interfaces:**
- Consumes: completed Task 1 implementation and existing test runner.
- Produces: no code; establishes zero leaked fixture PIDs and zero test failures.

- [ ] **Step 1: Inspect the Task 1 diff**

Verify the fallback is reachable only after failed Windows `taskkill`, snapshot data is validated, traversal is rooted/cycle-safe, descendants precede parents, root is killed last, and non-Windows behavior is untouched.

- [ ] **Step 2: Remove diagnostics**

Delete only the verified absolute directory `C:\Users\denys\Documents\GitHub\SiftKit\.scratch\powershell-tree-diagnosis` after confirming it is inside the workspace.

- [ ] **Step 3: Run repeated focused validation**

Run the sandboxed `powershell-async` suite three independent times, followed by `process-tree`, `command-spawn`, and the relevant captured-command/repo-tool suites. All runs must report zero failures and no fixture PID may remain alive.

- [ ] **Step 4: Run repository gates**

```powershell
npm test
npm run typecheck
npm run lint
npm run build
git diff --check
```

Acceptance: full suite has zero failures; typecheck, lint, build, and diff checks pass; no scratch artifacts or commits remain.
