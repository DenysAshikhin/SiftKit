# Six-Worker Test Suite Performance Implementation Plan

> **Superseded outcome (2026-08-08):** Commit `8f684f86` replaced this six-worker target with isolated prebuilt test bundles and a default concurrency of 12. Repeated warm runs completed in 51.9-55.2 seconds, so the original under-40-second target was not achieved. The plan below is retained unchanged as historical context and is not the current architecture or acceptance contract.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the already-built `npm test` command run the complete suite in under 40 seconds on one Windows machine with default concurrency six.

**Architecture:** Build relocatable JavaScript test artifacts once under `.test-build`, then make `npm test` validate and execute those artifacts without typechecking, compiling, or loading `tsx` in normal test children. Preserve per-file process isolation and remove deterministic waits from the measured hotspots by observing readiness, state transitions, and process death directly.

**Tech Stack:** TypeScript 5.9, Node 24 `node:test`, esbuild for the dashboard JSX/Bundler subset, PowerShell fixtures, JUnit profiling.

## Global Constraints

- The timed `npm test` command runs no build or typecheck work.
- Default test-file concurrency is exactly 6 on one machine.
- Preserve 2,633 discovered tests, 2,631 passes, and 2 existing skips.
- Preserve per-file process isolation and the live-instance leak guard.
- Do not weaken assertions, remove coverage, add retries, or mask failures.
- Keep generated test artifacts only under `.test-build/`.
- Missing or stale artifacts fail loudly; there is no source-TypeScript fallback.
- Use TDD for every correctness or behavioral change.
- Preserve unrelated changes and do not commit.

---

### Task 1: Correct option-only selection and make six workers the default

**Files:**
- Modify: `scripts/test-targets.ts`
- Modify: `tests/test-targets.test.ts`

**Interfaces:**
- Consumes: raw Node test runner arguments.
- Produces: `buildNodeTestArgs(repoRoot: string, rawArgs: string[]): string[]` with an exact default concurrency of six and explicit default targets when only options are supplied.

- [ ] **Step 1: Add the failing option-only regression test**

Add a test that calls:

```ts
const args = buildNodeTestArgs(process.cwd(), ['--test-concurrency=6']);
assert.equal(args.includes(path.join('tests', 'test-targets.test.ts')), true);
assert.equal(args.includes(path.join('tests', 'fixtures', 'hangs-forever.test.ts')), false);
```

Change existing default-concurrency expectations from `24` to `6`.

- [ ] **Step 2: Prove the regression test fails**

Run:

```powershell
node .\dist\scripts\run-tests.js test-targets.test.ts
```

Expected: the new option-only assertion fails because no default target is appended; the concurrency assertions also report 24 instead of 6.

- [ ] **Step 3: Track target count separately from forwarded arguments**

Introduce an internal resolver result inferred from this object shape:

```ts
return { args: resolvedArgs, targetCount };
```

Increment `targetCount` only for positional test paths and resolved dashboard test files. Option names and option values remain in `args` but never count as targets. Keep `resolveTestTargets` as the public array-returning wrapper used by existing tests. Set `DEFAULT_TEST_CONCURRENCY` to `6`.

- [ ] **Step 4: Verify the parser task**

Run the targeted test again. Expected: every `test-targets` test passes and the fixture path is absent.

---

### Task 2: Create one explicit test-build artifact tree

**Files:**
- Create: `tsconfig.test-build.json`
- Create: `scripts/test-build-state.ts`
- Create: `scripts/build-test.ts`
- Create: `tests/test-build-state.test.ts`
- Modify: `.gitignore`
- Modify: `package.json`
- Modify: `package-lock.json`
- Delete: `scripts/build-test.js`

**Interfaces:**
- Produces: `TEST_BUILD_ROOT`, `TEST_BUILD_STAMP_PATH`, `getTestBuildState(repoRoot: string)`, and `assertCurrentTestBuild(repoRoot: string)` from `scripts/test-build-state.ts`.
- Produces: `.test-build/tests/**/*.test.js`, compiled fixtures/helpers, bundled dashboard tests, and `.test-build/.complete`.

- [ ] **Step 1: Add failing build-state tests**

Use a managed temporary repository containing an input file, required output, and stamp. Cover all branches:

```ts
assert.deepEqual(getTestBuildState(root), { kind: 'missing' });
assert.deepEqual(getTestBuildState(rootWithMissingOutput), { kind: 'missing' });
assert.deepEqual(getTestBuildState(rootWithOlderStamp), { kind: 'stale', newestInputPath });
assert.deepEqual(getTestBuildState(rootWithCurrentStamp), { kind: 'current' });
assert.throws(() => assertCurrentTestBuild(root), /npm run build:test/u);
```

The stamp content must equal `siftkit-test-build-v1\n`; malformed content is `missing`, never accepted by mtime alone.

- [ ] **Step 2: Run the new test and confirm the missing-module failure**

Run the single test through the existing runner. Expected: failure because `scripts/test-build-state.ts` does not exist.

- [ ] **Step 3: Implement shared build-state validation**

Walk only these inputs: `src`, `scripts`, `tests`, `dashboard/src`, `dashboard/tests`, `package.json`, `tsconfig.test-build.json`, and the dashboard TypeScript configs. Ignore `.test-build`, `dist`, temporary data, and dependency trees. Require the compiled runner, target resolver, live-instance guard, production config entrypoint, test-build package marker, at least one top-level test artifact, and the completion stamp. Return a discriminated union using literal `kind` values; do not cast parsed IO.

- [ ] **Step 4: Define the ESM test compiler configuration**

Create `tsconfig.test-build.json` extending `tsconfig.test.json` with:

```json
{
  "compilerOptions": {
    "noEmit": false,
    "noEmitOnError": true,
    "declaration": false,
    "outDir": ".test-build",
    "rootDir": ".",
    "module": "ESNext",
    "moduleResolution": "Bundler"
  }
}
```

Retain the current eight dashboard-import exclusions; they are emitted by the next step.

- [ ] **Step 5: Replace the JavaScript build wrapper with TypeScript**

Implement `scripts/build-test.ts` to:

1. Return immediately when `getTestBuildState(repoRoot).kind === 'current'`.
2. Resolve `.test-build` and verify it is a child of the repository before removing it.
3. Run the contracts build, production `tsconfig.json`, `tsconfig.scripts.json`, and `sync-dist-runtime.js` exactly as the current wrapper does.
4. Run `tsc -p tsconfig.test-build.json`.
5. Write `.test-build/package.json` containing `{ "type": "module" }`.
6. Bundle each excluded dashboard-import test and each `dashboard/tests/**/*.test.tsx?` entry independently with esbuild, `platform: 'node'`, `format: 'esm'`, `packages: 'external'`, and source maps disabled.
7. Write `.test-build/.complete` only after every preceding operation succeeds.

Add `esbuild` as an explicit dev dependency. Replace the package script with:

```json
"build:test": "tsx .\\scripts\\build-test.ts"
```

Ignore only `/.test-build/` in `.gitignore`.

- [ ] **Step 6: Build and inspect the artifact contract**

Run `npm run build:test`. Expected: exit 0, the fixed stamp exists, top-level test artifacts are JavaScript, the hanging fixture exists only below `.test-build/tests/fixtures`, and dashboard bundles exist at their deterministic paths.

- [ ] **Step 7: Verify build-state branches**

Run `test-build-state.test.ts`. Expected: all missing, malformed, stale, and current cases pass.

---

### Task 3: Make `npm test` a run-only compiled-artifact command

**Files:**
- Modify: `scripts/run-tests.ts`
- Modify: `scripts/test-targets.ts`
- Modify: `tests/test-targets.test.ts`
- Modify: `tests/run-tests-watchdog.test.ts`
- Modify: `tests/config.test.ts`
- Modify: `tests/dashboard-status-server.test.ts`
- Modify: `tests/install.test.ts`
- Modify: `tests/live-instance-guard.test.ts`
- Modify: `tests/package-artifact.test.ts`
- Modify: `tests/refresh-global-script.test.ts`
- Modify: `tests/runtime-planner-token-aware.test.ts`
- Modify: `tests/runtime-planner-mode.test.ts`
- Modify: `tests/runtime-benchmark.test.ts`
- Modify: `tests/runtime-cli.test.ts`
- Modify: `tests/test-hygiene-gate.test.ts`
- Modify: `tests/_runtime-helpers.ts`
- Modify: `tests/benchmark-spec-settings.test.ts`
- Modify: `tests/lib-paths-esm.test.ts`
- Modify: `tests/repo-search-status-server.test.ts`
- Modify: `package.json`

**Interfaces:**
- Consumes: a current `.test-build` from Task 2.
- Produces: run-only `npm test` and compiled target selection rooted at `.test-build/tests`.

- [ ] **Step 1: Add failing compiled-target assertions**

Update target tests to expect `.test-build/tests/test-targets.test.js`. Add assertions that a source request such as `tests/mock-repo-search-loop.test.ts` resolves to `.test-build/tests/mock-repo-search-loop.test.js`, and that a missing artifact throws instead of forwarding the source path.

- [ ] **Step 2: Make test paths relocatable before switching the runner**

Replace repository-root calculations based on `path.resolve(__dirname, '..')` with `process.cwd()`. Replace the hygiene directory with `path.resolve(process.cwd(), 'tests')`. Replace ESM-incompatible `createRequire(__filename)` calls with `createRequire(import.meta.url)` and the direct `__filename` URL test with `import.meta.url`. These are complete replacements; no dual root-resolution path remains.

- [ ] **Step 3: Point target resolution at compiled artifacts**

Use `.test-build/tests` and `.test.js` for normal enumeration. Map source `.ts` and `.tsx` arguments to their compiled `.js` artifact. Keep selection by basename/prefix deterministic and top-level-only by default. `--dashboard` enumerates compiled dashboard artifacts rather than source files.

- [ ] **Step 4: Remove the TypeScript loader from the runner**

At runner startup call:

```ts
assertCurrentTestBuild(repoRoot);
```

Spawn Node as:

```ts
spawn(process.execPath, ['--test', ...testArgs], runnerOptions);
```

Remove `tsxLoaderUrl`, its imports, and its loader commentary completely. Keep the live-instance guard in `NODE_OPTIONS`, the watchdog, and process-tree termination unchanged.

- [ ] **Step 5: Make the package command run-only**

Set:

```json
"test": "node .\\dist\\scripts\\run-tests.js"
```

Keep typecheck and build as separate commands. Do not add an implicit repair path.

- [ ] **Step 6: Verify missing, stale, targeted, and full selection behavior**

Run the runner tests against a current build. Temporarily advance one managed fixture input mtime without changing content, assert `npm test` fails immediately with `npm run build:test`, restore the original timestamp, rebuild, and confirm the targeted run passes. Expected: no compiler process appears beneath `npm test`.

- [ ] **Step 7: Record the first compiled baseline**

Run the full suite with JUnit output and concurrency six. Record wall time, test count, aggregate testcase time, and the thirty slowest files. Acceptance for this checkpoint: 2,633 tests with no new failure and materially less runner overhead than 56.9 seconds.

---

### Task 4: Replace future-marker process tests with direct liveness proof

**Files:**
- Modify: `tests/helpers/process-tree-fixture.ts`
- Modify: `tests/command-spawn.test.ts`
- Modify: `tests/powershell-async.test.ts`
- Modify: `tests/fixtures/hangs-forever.test.ts`
- Modify: `tests/run-tests-watchdog.test.ts`

**Interfaces:**
- Produces: `ProcessTreeFixture` with `parentScript`, `grandchildPidPath`, `waitForGrandchildPid()`, and `waitForProcessExit(pid)`.

- [ ] **Step 1: Write failing liveness-based assertions**

Change each descendant-reaping test to start the operation, await the fixture PID, await the timeout result, then call:

```ts
await waitForProcessExit(grandchildPid);
assert.equal(isProcessAlive(grandchildPid), false);
```

Set the command timeout to 250 ms and the runner budget to 500 ms. Remove marker-delay sleeps from the tests. Before implementing the fixture, the new imports fail.

- [ ] **Step 2: Implement the PID fixture**

The parent writes the spawned grandchild PID synchronously to `grandchildPidPath`. `waitForGrandchildPid` polls the validated positive integer for at most two seconds. `isProcessAlive` uses `process.kill(pid, 0)` and handles a missing process explicitly. `waitForProcessExit` polls for at most two seconds and throws with the PID if it remains alive.

- [ ] **Step 3: Update the hanging-run fixture**

Have `hangs-forever.test.ts` synchronously write its grandchild PID through `SIFTKIT_WATCHDOG_GRANDCHILD_PID_PATH`. In the watchdog test, start `spawnDirectCommand` without immediately awaiting it, observe the PID file, await the runner result, and assert the PID exits. Remove `SIFTKIT_WATCHDOG_MARKER_DELAY_MS` and all future-marker logic.

- [ ] **Step 4: Verify process semantics and duration**

Run the three affected files. Expected: every assertion passes, no descendant remains, and their combined testcase duration is below four seconds instead of about thirty-four seconds.

---

### Task 5: Remove fixed drain and concurrency sleeps

**Files:**
- Modify: `tests/status-server-drain-log.test.ts`
- Modify: `tests/summary-status-server.test.ts`
- Modify: `tests/repo-search-status-server.test.ts`

**Interfaces:**
- Consumes: existing `terminalMetadataIdleDelayMs`, `waitForAsyncExpectation`, status routes, and captured log lines.
- Produces: the same ordering and responsiveness assertions without production-scale waits.

- [ ] **Step 1: Tighten the drain-log test before changing it**

Set `terminalMetadataIdleDelayMs` to `10`, keep the queue non-idle until at least two drain attempts have occurred, release it, and poll captured output for `drain_resume`. Assert the same single `drain_wait`, single `drain_resume`, ordering, and `cycles >= 2` properties. The old 2.5-second/1.5-second sleeps must be deleted.

- [ ] **Step 2: Use scenario-sized idle delays in summary tests**

For tests that currently wait 1,100 ms for the one-second drain retry, pass a 10–20 ms terminal metadata idle delay and wait for the persisted row/log transition with `waitForAsyncExpectation`. Preserve the assertions about queue ordering and deferred persistence.

- [ ] **Step 3: Shorten held repo-search work only after entry is observed**

In `status server stays responsive while repo-search is running`, reduce the mock command delay from 2,000 ms to 100 ms. Replace the unconditional 100 ms pre-health sleep with polling `/status` until the repo-search request is active, then perform the existing health-latency assertion while it is still held.

- [ ] **Step 4: Verify the status timing group**

Run the three files. Expected: identical assertions and test counts, no flaky timeout, and at least six seconds removed from aggregate duration.

---

### Task 6: Remove production-sized managed-model startup waits

**Files:**
- Modify: `tests/helpers/managed-llama-fixtures.ts`
- Modify: `tests/helpers/tabby-fake.ts`
- Modify: `tests/inference-passthrough-status-server.test.ts`
- Modify: `tests/repo-search-status-server.test.ts`
- Modify: `tests/status-server-restart.test.ts`
- Modify: `tests/managed-tabby.test.ts`
- Modify: `tests/runtime-status-server.test.ts`

**Interfaces:**
- Produces: deterministic fake-process ready/exit files and scenario-sized startup configurations.

- [ ] **Step 1: Add readiness and exit assertions to fake-process tests**

For each managed fake, assert that the ready file appears only after the listening socket is active and that the exit file appears when the fake exits. Parse PID and exit metadata explicitly; malformed files fail.

- [ ] **Step 2: Make loading-response coverage minimal and deterministic**

In the passthrough 503 test, change `initial503LoadingModelCount` from 20 to 2, `HealthcheckIntervalMs` to 10, and keep a localhost-safe healthcheck timeout. Assert the fake's observed model-probe count is at least three, proving two loading responses were retried before success.

- [ ] **Step 3: Remove unrelated automatic startup from restart-only tests**

Pass `disableManagedLlamaStartup: true` when the test's action is the explicit `/status/restart` request. Use a 500 ms startup timeout for the immediate OOM fixture. Preserve structured OOM kind, required-memory, available-memory, restart-success, and thread-argument assertions.

- [ ] **Step 4: Make readiness-queue tests release on observed state**

Use the fake's ready/probe files plus the model-queue status endpoint to prove serialization. Remove waits whose only purpose is to guess when startup began. Keep the assertion that the second request cannot enter managed readiness before the first releases the model lock.

- [ ] **Step 5: Verify managed-process tests**

Run the five hotspot files. Expected: no managed process or reserved port survives, all branches remain covered, and their combined aggregate duration drops by at least forty seconds from the recorded baseline.

---

### Task 7: Eliminate the remaining measured waits above the 40-second budget

**Files:**
- Modify: `tests/runtime-loadconfig.test.ts`
- Modify: `tests/runtime-status-server.idle-summary.test.ts`
- Modify: `tests/runtime-planner-mode.test.ts`
- Modify: `tests/runtime-cli.test.ts`
- Modify: `tests/repo-agent-cli.test.ts`
- Modify: `tests/parallel-status-server.test.ts`
- Modify: `tests/nested-agent-server-reject.test.ts`
- Modify: `tests/runtime-benchmark.matrix.test.ts`
- Modify: `tests/managed-tabby-run-history.test.ts`
- Modify: `tests/runtime-status-server.lifecycle.test.ts`
- Modify: `tests/inference-run-flush-queue.test.ts`
- Modify: `tests/model-request-queue-http.test.ts`

**Interfaces:**
- Consumes: readiness, queue-idle, process-exit, and HTTP helpers established by earlier tasks.
- Produces: no individual passing testcase above two seconds unless it launches an external shell whose measured startup alone exceeds that threshold.

- [ ] **Step 1: Re-profile and select only still-slow named tests**

Generate JUnit output from the compiled six-worker runner. For the files above, list testcases above 500 ms and associate each with one of four observable completions: HTTP response, stdout line, file creation, or process exit.

- [ ] **Step 2: Replace post-completion sleeps with the associated observation**

Use `waitForAsyncExpectation`, `waitForStdoutMatch`, the process-exit helper, or the existing request promise. Delete sleeps after the asserted condition can already be observed. In the benchmark interruption test, remove the 300 ms post-rejection sleep and wait until the session and run rows both report their final states.

- [ ] **Step 3: Replace timeout races used as success paths**

Where `Promise.race` uses a multi-second timer to prove prompt close, retain the timer only as a failure ceiling and await the real close/rejection promise. Assert elapsed time with a generous ceiling after it settles; do not spend the ceiling on passing runs.

- [ ] **Step 4: Verify each changed file immediately**

Run each changed file three consecutive times at concurrency six. Expected: identical test counts, no intermittent failure, no leaked handle/process/temp directory, and lower median duration than its pre-change JUnit value.

- [ ] **Step 5: Run the full performance checkpoint**

Run `npm test` once. If wall time is at least 40 seconds, use its JUnit report to repeat Steps 1–4 only for the next slowest testcase in the named files. Stop changing tests when the full run is below 40 seconds; do not alter an assertion solely because it is expensive.

---

### Task 8: Final correctness, leak, and performance validation

**Files:**
- Review only: every file changed by Tasks 1–7

**Interfaces:**
- Produces: evidence that the new command contract and performance target hold together.

- [ ] **Step 1: Rebuild once outside the timed command**

Run:

```powershell
npm run build:test
```

Expected: exit 0 and a current `.test-build/.complete` stamp.

- [ ] **Step 2: Verify targeted runner behavior**

Run the target parser, build-state, watchdog, command-spawn, PowerShell, managed-model, and status-server hotspot files. Expected: all pass.

- [ ] **Step 3: Verify static correctness separately**

Run:

```powershell
npm run typecheck
npm run lint
```

Route large output through `siftkit summary` when the service is available; otherwise capture only pass/fail and actionable diagnostics. Expected: both exit 0.

- [ ] **Step 4: Prove the warm performance requirement five times**

Run the unchanged command five consecutive times without rebuilding:

```powershell
npm test
```

For every run record wall time, test count, pass/skip/fail counts, and leak-guard result. Expected for each run: under 40 seconds, 2,633 tests, 2,631 pass, 2 skip, 0 fail.

- [ ] **Step 5: Audit external state after every run**

Verify no Node, PowerShell, managed llama, Tabby, or status-server process launched by the suite remains; reserved ports are bindable; and the managed temp registry reports no survivors. Generated artifacts may remain only under `.test-build` and normal `dist` outputs.

- [ ] **Step 6: Review the final diff**

Confirm `npm test` contains no typecheck/build invocation, `run-tests.ts` contains no `tsx` loader, default concurrency is six, no compatibility path remains, no test was removed or skipped, and unrelated working-tree changes are intact.
