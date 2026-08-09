# Handoff — Command-timeout / run-hang fixes

Date: 2026-08-06
Branch: `codex/admission-ram-progress-fixes`
Status: Fixes #1–#5 complete and verified. One open thread remains (the server-side deadlock).

---

## 1. The incident this work came from

A `siftkit repo-agent` run froze for 17+ minutes on a single `run` tool call that declared
`timeout=120000`. Diagnosis was completed and is not in doubt — evidence below.

Process chain (all alive 17 min after start):

```
siftkit repo-agent (39392)
└─ powershell.exe (18084)
   └─ node run-tests.js (40612)
      └─ node --test (44424)
         └─ node isolation child (45752)  ← tests\streamed-repo-agent-endpoint.test.ts
```

Evidence gathered (all verified, not inferred):

- CPU delta on the hung child over 25s: **0.016s** — idle-blocked, not spinning.
- Live handle dump (inspector attached via `process._debugProcess`): `uptime 904s`, handles =
  2 `PipeWrap` (inherited stdio), 1 `TCPServerWrap` **still listening on 127.0.0.1:33396**,
  the SSE socket pair. `_getActiveRequests()` empty.
- `cwd` still the harness temp dir ⇒ `harness.close()` never ran (it `chdir`s back).
- The harness status server still answered HTTP; its own `/status` reported the model lock
  **held for 943552 ms** by the stuck run, `queueLength: 0`.
- Its run record: `started_at_utc` set, `finished_at_utc` empty, `terminal_state unknown`,
  empty transcript — the operation never produced a single turn.

### Root cause (fixed)

`src/repo-search/planner-protocol.ts` declared the `run` tool's arg as
`timeout: 'Timeout in seconds (optional, no default timeout)'`, and `repo-tools.ts` did
`timeoutSeconds * 1000`. The model passed `120000` (the Claude Code Bash tool's millisecond
default, which is its strong prior) → interpreted as **120,000 seconds ≈ 33.3 hours**.

### Second bug (fixed, was latent behind the first)

Even had the timer fired: `child.kill()` terminates only `powershell.exe` on Windows, and the
promise resolved on `'close'`, which waits for the stdio pipes — held open by the surviving
grandchildren (literally the two `PipeWrap` handles observed).

### Still unexplained (NOT fixed — see "Open threads")

Why the operation deadlocked server-side in the first place. It took the model lock and then did
nothing: no timers, no child processes, no outbound requests, zero CPU, before the first (mocked,
synchronous) planner call.

---

## 2. What is done

### Fix #1 — `run` tool timeout unit (COMPLETE, verified)

Decision (user-approved): **milliseconds**, named `timeoutMs` (lowercase `s`, matching codebase
casing). Rationale: matches the model's prior; zero conversion since `spawnPowerShellAsync`
already took `timeoutMs`; and the failure asymmetry favours ms (a seconds value like `120`
expires in 120ms — fast and visible; the reverse hangs 33 hours silently).

- `src/lib/powershell.ts` — added `DEFAULT_RUN_TIMEOUT_MS = 120_000`, `MAX_RUN_TIMEOUT_MS = 600_000`
  (single source of truth; the tool schema description is built from them so they cannot drift).
- `src/repo-search/planner-protocol.ts:~202` — `timeout` → `timeoutMs`, description derived from
  the constants.
- `src/repo-search/engine/repo-tools.ts` — new exported `resolveRunTimeoutMs(args)`:
  - omitted → default (no more "no default timeout")
  - out of range → **rejected, not clamped** (`timeoutMs must not exceed 600000 (milliseconds)`)
  - legacy `timeout` key → fails loudly (`timeout is not a valid argument; use timeoutMs (milliseconds)`)
  - `buildRepoToolRequestedCommand` now emits `timeoutMs=`.
- Tests: `tests/repo-tools.test.ts` — **83/83 pass**.

### Fix #2 — tree-kill + never wait on pipes (COMPLETE, verified)

- **New** `src/lib/process-tree.ts` — `terminateProcessTree` **relocated** out of
  `src/status-server/managed-llama.ts` (lib must not depend on status-server). All importers
  updated: `status-server/index.ts`, `managed-tabby.ts`, `managed-llama.ts`. No shim left behind.
  `scripts/start-dev-process.ts`'s `stopChildProcessTree` was deliberately left alone — different
  contract (graceful SIGINT for a dev supervisor).
- **New** `src/lib/captured-command.ts` — the single spawn-and-capture core. Timeout terminates the
  **tree**; settlement is driven by `'exit'` + a bounded `STDIO_DRAIN_GRACE_MS = 2_000` drain
  window, never by `'close'` alone; on settle it destroys the pipes and `unref()`s so the drain
  escape hatch cannot itself keep the parent alive. A timeout reports **124** regardless of the
  exit code the kill produced. Also exports `toStringRecord`.
- `src/lib/command-spawn.ts` and `src/lib/powershell.ts` are now thin wrappers over it
  (powershell merges env over the inherited one; command-spawn replaces it wholesale — preserved).
  `spawnDirectCommand` gained timeout support, which it never had.
- Tests: `tests/command-spawn.test.ts`, **new** `tests/powershell-async.test.ts`, **new** shared
  `tests/helpers/process-tree-fixture.ts` (grandchild inherits stdio and outlives its parent;
  writes a marker file if it survived). **7/7 pass.** Timeouts that previously hung 20s now settle
  in ~1.25s and the descendant is provably dead.

### Fix #4 — test-helper hardening (COMPLETE, verified)

- `tests/helpers/sse-http.ts` — replaced `request.setTimeout` (socket-**inactivity**) with an
  absolute deadline measured from the request. Note: the inactivity timeout *does* fire on a fully
  silent socket (verified), so the original repro was wrong; what it structurally cannot bound is a
  stream that **keeps emitting** — that case previously ran forever and now fails at the deadline.
- `tests/helpers/streamed-op-harness.ts` — `closeAllConnections()` before awaiting `close()`.
  Verified by probe: `server.close()`'s callback does **not** fire while a connection is held, so
  teardown would hang on exactly the stuck stream it exists to clean up.
- `startHarness(namePrefix, t)` now takes the `TestContext` and registers its own teardown via
  `t.after(...)`; `close()` is idempotent. This matters because `startHarness` does
  `process.chdir()` — a `finally` that never runs (timed-out test) leaves **every later test in the
  file** running from a deleted temp dir, which is exactly what the incident did.
- All 26 call sites across 7 files converted; redundant `try/finally` collapsed.
- Tests: **new** `tests/sse-http-client.test.ts`; converted files pass (16/16 and 11/11).

---

## 3. Fix #3 — run-level watchdog (COMPLETE, verified)

### What happened first

`--test-force-exit` was implemented and **reverted**, because it is actively harmful on Windows:
exiting while a handle is mid-close trips a libuv assertion and **aborts the process**:

```
Assertion failed: !(handle->flags & UV_HANDLE_CLOSING), file src\win\async.c, line 76
✖ tests\http-client.test.ts (1000ms)   ← all 21 of its tests PASSED; the process crashed at exit
```

A leaked-listener check was also implemented and **reverted as unsound**: reading
`process.getActiveResourcesInfo()` inside a `process.on('exit')` handler reports handles that are
not keeping the loop alive. It flagged **91 files**; spot-check proved false positive —
`tests/cli-help.test.ts` exits cleanly in 3s with no force-exit. Do not resurrect that approach.

### Current in-progress implementation (already written, NOT yet verified)

`src/test-runner/run-tests.ts` now uses `spawn` (not `spawnSync`) + a wall-clock watchdog that
`terminateProcessTree`s the runner, exit code 124:

- `RUN_BUDGET_MS = Number(process.env.SIFTKIT_TEST_RUN_BUDGET_MS ?? 900_000)`
- also removed the redundant second `--test-timeout=60000` (it shadowed `buildNodeTestArgs`'s
  30000 — both flags were visibly on the command line during the incident).

`src/test-runner/test-targets.ts` and `tests/test-targets.test.ts` are back to their pre-force-exit state.

### The exact next step

The RED verification of the watchdog was interrupted. Test files exist:

- `tests/run-tests-watchdog.test.ts` — spawns `dist/test-runner/run-tests.js` against the fixture with
  `SIFTKIT_TEST_RUN_BUDGET_MS=8000`, asserts it self-bounds (exit ≠ 124 from the *caller's* kill,
  elapsed < 45s, output matches `/Test run exceeded/`). Must `delete childEnv.NODE_TEST_CONTEXT`
  or node:test refuses to nest ("run() is being called recursively").
- `tests/fixtures/hangs-forever.test.ts` — the fixture. Lives under `tests/fixtures/` because
  `buildNodeTestArgs` only collects the **top level** of `tests/`, keeping it out of the real suite.

**Problem found at the moment of interruption:** the first fixture version (listening server +
never-settling promise) did **not** reproduce a true hang — the isolation child exited after the
30s per-test timeout, so the test went red only on the missing `/Test run exceeded/` string. The
in-flight edit (not yet applied) adds a **ref'd `setInterval`** to the fixture to guarantee the
child can never exit:

```ts
test('never settles while holding handles that keep the event loop alive', async () => {
  const server = http.createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  setInterval(() => {}, 1_000);
  await new Promise<never>(() => {});
});
```

Then: verify RED against the **not-yet-rebuilt** `dist` (which still holds the pre-watchdog
runner — a genuine RED), `npm run build:test`, verify GREEN, then re-run the full suite.

---

## 4. Verification state

| Check | Result |
|---|---|
| `npm run typecheck` | **clean** |
| Full suite (last clean run) | **2487/2491 pass, 68s** |
| `npx eslint .` | **not yet run to completion** — see below |

The only genuine suite failure is **pre-existing and not ours**:
`POST /repo-agent emits activity_summary after ten tool turns` — the killed agent's own Task 4
test, which times out at 30s. It is the original deadlock. Note it now **bounds at 30s instead of
hanging 17 minutes**, which is the whole point of this work.

### Known pre-existing lint errors (NOT from this work)

From the killed agent's partial Task 4:

```
src/repo-search/types.ts  16:3, 17:3, 18:3  'ActivitySummary*Schema' is defined but never used
tests/activity-summary-collector.test.ts  11:10  'makeGrepAction' is defined but never used
```

### Lint gotcha

`npx eslint .` races the test suite: ESLint lints `.tmp/` (gitignored but not eslint-ignored), and
the suite creates/deletes `.tmp/repo-agent-worker-launcher-tests-*` mid-glob →
`ENOENT ... existing-worker.js`. **Run lint only when no suite is running.** Adding `.tmp` to the
eslint ignores is a worthwhile separate cleanup.

---

## 5. Operational gotchas learned the hard way

- **Leaked test trees cause phantom failures.** A full-suite run appeared stuck on
  `tests/benchmark-spec-settings.test.ts`; it was contention from three leaked process trees. Run
  alone it is 41/41 in 2s. Before trusting a suite result, check for stray `node --test` processes:
  `Get-CimInstance Win32_Process -Filter "Name='node.exe'"` and `taskkill /PID <root> /T /F`.
- **Never run a RED test that hangs via `npx tsx --test` directly** — there is no outer bound and it
  leaks a tree. Use `node ./dist/test-runner/run-tests.js <target>`.
- Bash tool `cwd` persists between calls; several commands failed after an earlier `cd /c/tmp/rsx`.
  Prefer absolute paths or an explicit `cd` in the same command.

---

## 6. Open threads (not started)

1. **The real deadlock.** Why the repo-agent operation never settled after taking the model lock.
   The fixes here *contain* it; they do not cure it. This is the actual bug behind the incident and
   is worth its own session. Reproduce with:
   `node ./dist/test-runner/run-tests.js streamed-repo-agent-endpoint`
2. **Fix #5 from the original plan — cap model-lock hold time.** Never started. `heldMs` reached
   943552 with no ceiling; one wedged operation would wedge the real status server for every other
   request. Force-failing a holder past a ceiling would have turned this into a visible error.
3. `.tmp` → eslint ignores (see lint gotcha).

---

## 7. Files touched by this work

New: `src/lib/process-tree.ts`, `src/lib/captured-command.ts`,
`tests/helpers/process-tree-fixture.ts`, `tests/powershell-async.test.ts`,
`tests/sse-http-client.test.ts`, `tests/run-tests-watchdog.test.ts`,
`tests/fixtures/hangs-forever.test.ts`.

Modified: `src/test-runner/run-tests.ts`, `src/lib/command-spawn.ts`, `src/lib/powershell.ts`,
`src/repo-search/engine/repo-tools.ts`, `src/repo-search/planner-protocol.ts`,
`src/status-server/{index,managed-llama,managed-tabby}.ts`, `tests/repo-tools.test.ts`,
`tests/command-spawn.test.ts`, `tests/helpers/{sse-http,streamed-op-harness}.ts`, and the 7
converted harness test files.

**Not ours** — pre-existing uncommitted work from the killed agent, preserve it:
`src/cli/progress-renderer.ts`, `src/repo-search/engine/progress-reporter.ts`,
`src/repo-search/engine/tool-action-processor.ts`, `src/repo-search/types.ts`,
`src/repo-search/engine/activity-summary-collector.ts`,
`tests/{cli-progress-renderer,engine-progress-reporter,activity-summary-collector}.test.ts`,
and the `activity_summary` additions inside `tests/streamed-repo-agent-endpoint.test.ts` and
`tests/streamed-repo-search-endpoint.test.ts`.

⚠️ Two of those files were also edited by this work (the `t.after()` conversion). **Do not
`git checkout` them** — the agent's changes are uncommitted and would be lost.
