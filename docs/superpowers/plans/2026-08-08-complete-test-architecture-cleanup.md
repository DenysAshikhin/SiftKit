# Complete Test Architecture Cleanup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the ten diagnosed test-architecture drift findings while preserving the unchanged warm `npm test` command, test-file process isolation, assertions, production semantics, leak detection, and default concurrency 12.

**Architecture:** Test bundles execute unchanged importable modules; executable shells are separate and location-sensitive modules remain mirrored compiled modules. A content-addressed manifest owns exact discovery. Lifecycle tests use explicit port, PID, queue, metrics, and output-capture state with bounded failure ceilings.

**Tech Stack:** TypeScript 5.9, Node.js 24 `node:test`, esbuild 0.27, Zod 4, Windows process and networking APIs

## Global Constraints

- All implementation and test code is TypeScript; generated fixture text may target Node or Windows command interpreters only where the external process requires it.
- Do not use SiftKit, worktrees, subagents, compatibility paths, type assertions, `any`, non-null assertions, namespace imports, or unvalidated IO.
- Use TDD for every behavior correction: focused RED, minimum GREEN, then refactor.
- Preserve one Node process per test file and the default `--test-concurrency=12`.
- Do not commit unless the user explicitly requests a commit for this refactor.

---

### Task 1: Make the test-build manifest complete and content-addressed

**Files:**
- Modify: `scripts/test-build-state.ts`
- Modify: `scripts/build-test.ts`
- Modify: `scripts/test-targets.ts`
- Modify: `tests/test-build-state.test.ts`
- Modify: `tests/test-targets.test.ts`

**Interfaces:**
- Produces: `TestBuildManifestSchema` version 2 with `inputs: { path: string; sha256: string }[]`, `outputs: string[]`, and `tests: { source: string; entrypoint: string; bundle: string; suite: 'node' | 'dashboard' }[]`.
- Produces: `createTestBuildManifest(repoRoot: string): TestBuildManifest` and `readCurrentTestBuildManifest(repoRoot: string): TestBuildManifest`.
- Consumes: default discovery in `buildNodeTestArgs` reads `manifest.tests` rather than the filesystem.

- [ ] **Step 1: Add RED manifest regressions**

Add tests that create a current fixture, then verify:

```ts
fs.rmSync(path.join(root, '.test-build/tests/input.test.bundle.js'));
assert.deepEqual(getTestBuildState(root), { kind: 'incomplete', missingOutputPath: /* absolute path */ });

const originalTime = fs.statSync(inputPath).mtime;
fs.writeFileSync(inputPath, 'changed-with-same-time', 'utf8');
fs.utimesSync(inputPath, originalTime, originalTime);
assert.equal(getTestBuildState(root).kind, 'stale');
```

Add a target regression proving a manifest containing two tests still returns both even if an unrelated `.test.js` exists on disk.

- [ ] **Step 2: Run RED tests**

Run: `npx tsx --test tests/test-build-state.test.ts tests/test-targets.test.ts`

Expected: missing arbitrary outputs remain `current`, same-mtime content changes remain `current`, and discovery still follows directory contents.

- [ ] **Step 3: Implement manifest version 2**

Use `createHash('sha256')` over every input file. Derive every wrapper/bundle output from the source test inventory. Parse the manifest with Zod and return distinct `missing`, `malformed`, `stale`, `incomplete`, or `current` states. Validate every output before returning `current`.

Write the final manifest only after all artifacts exist. Make `assertCurrentTestBuild` return the parsed manifest so `buildNodeTestArgs` can use the exact validated test list.

- [ ] **Step 4: Make discovery consume the manifest**

Resolve exact names, prefixes, source paths, `.test-build` paths, and `--dashboard` against `manifest.tests`. Preserve explicit Node options. Make the override assertion compare:

```ts
assert.deepEqual(
  args.filter((arg) => arg.startsWith('--test-concurrency=')),
  ['--test-concurrency=32'],
);
```

- [ ] **Step 5: Run GREEN tests**

Run: `npx tsx --test tests/test-build-state.test.ts tests/test-targets.test.ts`

Expected: all manifest and target tests pass.

---

### Task 2: Remove bundle source mutation and executable side effects

**Files:**
- Create: `src/status-server/main.ts`
- Create: `src/cli/main.ts`
- Create: `src/repo-agent/worker-runner.ts`
- Create: `bench/benchmark/main.ts`
- Create: `bench/benchmark-matrix/main.ts`
- Create: `bench/repro/repro-fixture60-malformed-json-main.ts`
- Create: `bench/repro/run-benchmark-fixture-debug-main.ts`
- Modify: `src/cli/index.ts`
- Modify: `src/status-server/index.ts`
- Modify: `src/repo-agent/worker-main.ts`
- Modify: `src/repo-agent/worker-launcher.ts`
- Modify: `src/status-server/inference-run-flush-queue.ts`
- Modify: `src/install.ts`
- Modify: `bench/benchmark/index.ts`
- Modify: `bench/benchmark-matrix/index.ts`
- Modify: `bench/benchmark-matrix/benchmark-runner.ts`
- Modify: `bench/repro/repro-fixture60-malformed-json.ts`
- Modify: `bench/repro/run-benchmark-fixture-debug.ts`
- Modify: `package.json`
- Modify: `bin/siftkit.cmd`
- Modify: `bin/siftkit.ps1`
- Delete: `bin/siftkit.js`
- Modify: `scripts/run-benchmark-matrix.ps1`
- Modify: `scripts/refresh-global.ps1`
- Modify: `scripts/build-test.ts`
- Modify: `tests/test-build-artifacts.test.ts`
- Modify: `tests/repo-agent-worker.test.ts`
- Modify: `tests/repo-agent-worker-launcher.test.ts`
- Modify: `tests/lib-paths-esm.test.ts`

**Interfaces:**
- `src/status-server/index.ts` exports server APIs only; `main.ts` owns signals and process exit.
- `src/repo-agent/worker-runner.ts` exports `runRepoAgentWorkerMain(argv: string[]): Promise<void>`; `worker-main.ts` is the executable shell retained at the launcher path.
- Benchmark/repro implementation modules export APIs only; their new `main.ts` files own `process.argv` and exits.

- [ ] **Step 1: Add RED source-shape and behavior tests**

Extend `tests/test-build-artifacts.test.ts` to reject these strings in `scripts/build-test.ts`:

```ts
assert.doesNotMatch(builderSource, /locationSensitiveModulePaths|entrypointModulePaths/u);
assert.doesNotMatch(builderSource, /contents\.replace|sideEffects:\s*false/u);
```

Add direct import tests proving each implementation module imports without invoking its main routine. Update worker tests to import `worker-runner.js` and assert the launcher still ends in `worker-main.js`.

- [ ] **Step 2: Run RED tests**

Run: `npx tsx --test tests/test-build-artifacts.test.ts tests/repo-agent-worker.test.ts tests/repo-agent-worker-launcher.test.ts tests/lib-paths-esm.test.ts`

Expected: the builder source-shape test fails on both hardcoded sets and source replacements.

- [ ] **Step 3: Split executable shells completely**

Move direct-run blocks verbatim into the new main files. Leave no `isMainModule(import.meta.url)` branch in importable modules. Update npm/PowerShell entrypoint paths. Keep `worker-main.ts` as a shell importing `runRepoAgentWorkerMain` from `worker-runner.ts`.

- [ ] **Step 4: Preserve one local module graph**

Remove the mutation/externalization plugin entirely. Resolve package-root-relative worker and CLI entrypoints explicitly, then bundle every local dependency once. This preserves `import.meta.url` source semantics without duplicating stateful modules across bundled and mirrored graphs.

- [ ] **Step 5: Run GREEN tests and build artifacts**

Run: `npx tsx --test tests/test-build-artifacts.test.ts tests/repo-agent-worker.test.ts tests/repo-agent-worker-launcher.test.ts tests/lib-paths-esm.test.ts`

Run: `npm run build:test`

Run: `npm test -- test-build-artifacts`

Expected: focused tests and bundled-artifact execution pass with no source mutation.

---

### Task 3: Remove global server interception and released-port discovery

**Files:**
- Modify: `scripts/live-instance-guard.ts`
- Modify: `tests/live-instance-guard.test.ts`
- Replace: `tests/helpers/free-port.ts` with `tests/helpers/test-endpoints.ts`
- Modify: `tests/_runtime-helpers.ts`
- Modify: `tests/helpers/managed-llama-fixtures.ts`
- Modify: every test importing `getFreePort` as identified by `rg -n "getFreePort" tests`

**Interfaces:**
- Produces: `listenOnEphemeralPort(server: http.Server): Promise<number>` for in-process servers.
- Produces: `createDeadHttpEndpoint(): Promise<{ baseUrl: string; close(): Promise<void> }>` whose bound server immediately destroys accepted sockets.
- Produces: `acquireChildPortLease(name: string): Promise<{ port: number; release(): Promise<void> }>` only for production-managed child launchers that require a predeclared port; leases use an atomic per-port directory under the managed test scratch root and live until child teardown.

- [ ] **Step 1: Add RED guard and endpoint tests**

Change the owned-server guard test to expect exit code 1 and `LIVE INSTANCE CONTACTED`. Add endpoint tests proving two concurrent ephemeral listeners receive different bound ports and a dead endpoint remains owned until `close()`.

- [ ] **Step 2: Run RED tests**

Run: `npx tsx --test tests/live-instance-guard.test.ts tests/dashboard-http-helpers.test.ts`

Expected: the owned-server request remains exempt and the new endpoint API is absent.

- [ ] **Step 3: Remove prototype interception**

Delete the `node:net` import, ownership map, `serverEmitGuard`, prototype assignment, and ownership exemption. Preserve unconditional HTTP/HTTPS/fetch rejection for guarded ports.

- [ ] **Step 4: Replace port discovery completely**

Use port zero for every in-process listener and read the bound port. Use owned dead endpoints where tests need an unavailable backend. For managed child fixtures, acquire and release an explicit suite lease in the fixture lifecycle; never expose a bare probe-and-close function.

Delete `getFreePort` exports and update all imports. Parse any child readiness/lease file with Zod.

- [ ] **Step 5: Run GREEN and managed-runtime tests**

Run: `npx tsx --test tests/live-instance-guard.test.ts tests/dashboard-http-helpers.test.ts tests/managed-tabby.test.ts tests/runtime-loadconfig.test.ts tests/runtime-status-server.lifecycle.test.ts`

Expected: no guarded-port exemption and no `getFreePort` usage remain.

---

### Task 4: Centralize PID liveness and restore bounded queue waits

**Files:**
- Modify: `src/lib/process-tree.ts`
- Modify: `src/status-server/inference-run-flush-queue.ts`
- Modify: `tests/helpers/process-tree-fixture.ts`
- Modify: `tests/status-server-shutdown.test.ts`
- Modify: `tests/inference-run-flush-queue.test.ts`
- Modify: `tests/inference-runs.test.ts`

**Interfaces:**
- `isProcessAlive(pid: number | string, processObject?: Pick<NodeJS.Process, 'kill'>): boolean` returns false only for invalid IDs or `ESRCH`, true for success or `EPERM`, and rethrows other validated errors.
- `waitForIdle(timeoutMs: number = 2_000): Promise<void>` waits on `isIdle()` and throws with `getSnapshot()` diagnostics at the ceiling.

- [ ] **Step 1: Add RED error-branch and stuck-queue tests**

Use injected `processObject.kill` implementations that throw `{ code: 'ESRCH' }`, `{ code: 'EPERM' }`, and `{ code: 'EIO' }`. Assert false, true, and throw respectively. Add a queue test with forced non-idle internals and a 25 ms ceiling asserting the snapshot appears in the error.

- [ ] **Step 2: Run RED tests**

Run: `npx tsx --test tests/status-server-shutdown.test.ts tests/inference-run-flush-queue.test.ts`

Expected: EPERM returns false, EIO is swallowed, and wait-for-idle has no failure ceiling.

- [ ] **Step 3: Implement and deduplicate**

Parse error objects with a Zod `{ code: z.string() }` schema. Import production `isProcessAlive` from the fixture and delete its local implementation/schema. Restore the queue ceiling without changing the idle condition.

- [ ] **Step 4: Run GREEN tests**

Run: `npx tsx --test tests/status-server-shutdown.test.ts tests/run-tests-watchdog.test.ts tests/inference-run-flush-queue.test.ts tests/inference-runs.test.ts`

Expected: all liveness and queue tests pass promptly.

---

### Task 5: Expose terminal-metadata completion instead of quiet polling

**Files:**
- Modify: `src/status-server/routes/core.ts`
- Modify: `src/status-server/server-types.ts`
- Modify: `src/status-server/index.ts`
- Modify: `tests/helpers/dashboard-server-fixture.ts`
- Modify: `tests/helpers/server-context-fixture.ts`
- Modify: `tests/dashboard-server-fixture-cleanup.test.ts`
- Modify: `tests/chat-status-metrics.test.ts`
- Modify: `tests/parallel-status-server.test.ts`

**Interfaces:**
- Produces: `waitForTerminalMetadataIdle(ctx: ServerContext, timeoutMs: number): Promise<void>` with queue/scheduled/running diagnostics.
- `ExtendedServer.waitForTerminalMetadataIdle(timeoutMs?: number): Promise<void>` exposes the server-owned lifecycle state.
- `DashboardTestServer.readMetricsAfterTerminalMetadata(minimumCompletedRequestCount: number): Promise<Metrics>` awaits that method once, reads metrics, and asserts the lower bound.

- [ ] **Step 1: Add RED completion tests**

Add a context test that enqueues delayed terminal metadata, waits for the new idle API, and verifies persistence. Add a forced-stuck context test with a short ceiling and diagnostic assertion. Update one metrics E2E to call the wished-for fixture method.

- [ ] **Step 2: Run RED tests**

Run: `npx tsx --test tests/dashboard-server-fixture-cleanup.test.ts tests/chat-status-metrics.test.ts`

Expected: the explicit completion APIs do not exist.

- [ ] **Step 3: Implement observable completion**

Export the context wait from `routes/core.ts`, attach it to `ExtendedServer`, and replace the fixture's 12-poll quiet window. Remove `METRICS_SETTLE_POLL_INTERVAL_MS`, `METRICS_SETTLE_QUIET_POLLS`, and snapshot-string comparison.

- [ ] **Step 4: Migrate all callers and run GREEN tests**

Run: `npx tsx --test tests/dashboard-server-fixture-cleanup.test.ts tests/chat-status-metrics.test.ts tests/parallel-status-server.test.ts`

Expected: metrics tests use explicit server lifecycle completion and pass.

---

### Task 6: Replace callback-based output capture completely

**Files:**
- Modify: `tests/helpers/stdout-capture.ts`
- Modify: `tests/http-client-logging.test.ts`
- Modify: `tests/inference-run-flush-queue.test.ts`
- Modify: `tests/inference-runs.test.ts`
- Modify: `tests/model-request-queue.test.ts`
- Modify: `tests/repo-search-status-server.test.ts`
- Modify: `tests/repo-search.test.ts`
- Modify: `tests/runtime-status-server.idle-persistence.test.ts`
- Modify: `tests/runtime-status-server.idle-summary.test.ts`
- Modify: `tests/status-server-drain-log.test.ts`
- Modify: `tests/summary-status-server.test.ts`

**Interfaces:**
- Produces: `OutputCapture.start(stream: NodeJS.WriteStream): OutputCapture`.
- Exposes: `readonly lines: readonly string[]` and `restore(): void`; `restore()` is idempotent.
- No capture helper accepts an operation callback.

- [ ] **Step 1: Add RED capture API tests**

Add helper tests that start stdout and stderr captures, write complete and partial lines, restore twice, and verify later writes are not collected. Add a source scan asserting no local `captureStdoutLines` or `captureStderrLines` declaration remains outside the helper.

- [ ] **Step 2: Run RED tests**

Run: `npx tsx --test tests/runtime-helper-modules.test.ts`

Expected: `OutputCapture` is absent and duplicate declarations remain.

- [ ] **Step 3: Implement one stateful capture and migrate callers**

Use explicit call-site structure:

```ts
const capture = OutputCapture.start(process.stdout);
try {
  await operationUnderTest();
} finally {
  capture.restore();
}
assert.match(capture.lines.join('\n'), /expected/u);
```

Delete all local and shared callback-based implementations.

- [ ] **Step 4: Run GREEN tests**

Run: `npx tsx --test tests/runtime-helper-modules.test.ts tests/inference-run-flush-queue.test.ts tests/inference-runs.test.ts tests/model-request-queue.test.ts tests/repo-search.test.ts tests/repo-search-status-server.test.ts tests/runtime-status-server.idle-persistence.test.ts tests/runtime-status-server.idle-summary.test.ts tests/status-server-drain-log.test.ts tests/summary-status-server.test.ts tests/http-client-logging.test.ts`

Expected: all capture callers pass with one implementation and explicit restoration.

---

### Task 7: Restore independent lifecycle scenarios and current documentation

**Files:**
- Modify: `tests/managed-tabby-run-history.test.ts`
- Modify: `tests/managed-tabby.test.ts`
- Modify: `tests/runtime-loadconfig.test.ts`
- Modify: `docs/superpowers/plans/2026-08-08-six-worker-test-suite-performance.md`
- Modify: `docs/superpowers/specs/2026-08-08-six-worker-test-suite-performance-design.md`

**Interfaces:**
- Each launch/log/shutdown, launch/reuse/restart, and managed-startup/verbose-env scenario is a separate top-level `test` with fresh fixture state.
- Historical six-worker documents begin with a superseded outcome containing commit `8f684f86`, default 12, and observed warm results 51.9–55.2 seconds.

- [ ] **Step 1: Establish characterization and mutation evidence**

Run the three current combined files. Temporarily add a failing assertion after the first transition of each combined test and confirm later assertions in that test do not execute; then remove the temporary mutation before editing structure.

Run: `npx tsx --test tests/managed-tabby-run-history.test.ts tests/managed-tabby.test.ts tests/runtime-loadconfig.test.ts`

- [ ] **Step 2: Restore separate scenarios**

Split the merged tests at their former lifecycle boundaries. Extract only data/setup builders that do not own mutable runtime state. Preserve every assertion introduced by the combined versions.

- [ ] **Step 3: Update historical outcome headers**

Add an explicit `Superseded outcome` block to both documents. Do not rewrite their historical task steps; state that their six-worker/under-40 acceptance criteria were superseded by the user's concurrency-12 decision and record actual validation.

- [ ] **Step 4: Run GREEN tests**

Run: `npx tsx --test tests/managed-tabby-run-history.test.ts tests/managed-tabby.test.ts tests/runtime-loadconfig.test.ts tests/test-targets.test.ts`

Expected: every restored scenario is independently selectable and passes.

---

### Task 8: Rebuild and verify the complete refactor

**Files:**
- Verify all files above
- Remove generated scratch/log artifacts only

- [ ] **Step 1: Run drift-removal scans**

Run exact scans for `locationSensitiveModulePaths`, `entrypointModulePaths`, `contents.replace`, `net.Server.prototype.emit`, `getFreePort`, duplicate capture declarations, quiet-poll constants, unbounded `waitForIdle()`, and stale current six-worker claims. Expected: no executable drift matches; historical documents contain only their labeled superseded history.

- [ ] **Step 2: Build warm artifacts**

Run: `npm run build:test`

Expected: exit 0 and a current version-2 manifest.

- [ ] **Step 3: Run the unchanged full suite twice**

Run twice: `npm test`

Expected each run: complete expected test-file inventory, zero failures, zero leaks, default concurrency 12. Record Node's actual `duration_ms`.

- [ ] **Step 4: Run static validation**

Run: `npm run typecheck`

Run: `npm run lint`

Run: `git diff --check`

Expected: all exit 0.

- [ ] **Step 5: Clean and review**

Remove the dedicated scratch directory and generated logs, inspect `git status --short`, and review the full diff for scope, forbidden TypeScript constructs, generated JavaScript, and obsolete parallel paths. Do not commit without a new explicit request.
