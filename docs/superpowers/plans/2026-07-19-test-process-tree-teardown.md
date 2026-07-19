# Test Process-Tree Teardown Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Windows runtime-test teardown terminate the entire spawned status-server process tree and prove that managed fake llama children cannot survive the test.

**Architecture:** Keep process ownership in the shared runtime test harness. Reuse the production `terminateProcessTree()` primitive for Windows teardown, preserve graceful `SIGINT` behavior on POSIX, and add a real endpoint-level regression assertion to the existing leaking integration test.

**Tech Stack:** TypeScript, Node.js test runner, Node child processes, Windows `taskkill` through `terminateProcessTree()`.

## Global Constraints

- Windows test teardown terminates the complete status-server process tree.
- POSIX test teardown retains graceful `SIGINT` shutdown and the existing timeout fallback.
- Teardown waits for the status-server child to exit before returning.
- No production runtime shutdown behavior changes.
- Use TDD: observe the regression assertion fail before changing the harness.
- The complete suite must pass and leave zero new SiftKit-related processes.

---

### Task 1: Deterministic runtime-test process-tree teardown

**Files:**
- Modify: `tests/runtime-status-server.idle-summary.test.ts:114`
- Modify: `tests/_runtime-helpers.ts:78`
- Modify: `tests/_runtime-helpers.ts:1356`

**Interfaces:**
- Consumes: `terminateProcessTree(pid: number | string): boolean` from `src/status-server/index.ts`.
- Produces: `startStatusServerProcess(...).close(): Promise<void>` that terminates the full Windows process tree and returns only after the child exits.

- [ ] **Step 1: Add the failing endpoint-level regression assertion**

After the `finally` block in `real status server leaves managed llama.cpp running after the idle summary block is emitted`, add:

```ts
    await waitForAsyncExpectation(
      async () => assert.rejects(() => requestJson(`${managed.baseUrl}/v1/models`)),
      5000,
    );
```

This checks real externally observable behavior instead of inspecting mocks or child-process internals.

- [ ] **Step 2: Run the named test and verify RED**

Run:

```powershell
node .\dist\scripts\run-tests.js --test-name-pattern "real status server leaves managed llama.cpp running after the idle summary block is emitted" tests\runtime-status-server.idle-summary.test.ts
```

Expected: FAIL because `requestJson()` still reaches `fake-llama-server.js` after `server.close()`.

After the expected failure, terminate the exact leaked test PID before continuing and confirm no `siftkit-node-test-*\fake-llama-server.js` process remains.

- [ ] **Step 3: Reuse process-tree termination in the Windows harness path**

Add `terminateProcessTree` to the existing status-server import in `tests/_runtime-helpers.ts`:

```ts
import {
  buildIdleMetricsLogMessage,
  buildStatusRequestLogMessage,
  formatElapsed,
  getIdleSummarySnapshotsPath,
  startStatusServer,
  terminateProcessTree,
} from '../src/status-server/index.js';
```

Replace the beginning of `startStatusServerProcess(...).close()` with an explicit Windows branch:

```ts
    async close() {
      if (child.exitCode !== null || child.killed) {
        return;
      }

      if (process.platform === 'win32' && child.pid) {
        assert.equal(terminateProcessTree(child.pid), true);
        await Promise.race([
          closePromise,
          sleep(5000).then(() => {
            throw new Error('Timed out waiting for Windows status-server process-tree termination.');
          }),
        ]);
        return;
      }

      child.kill('SIGINT');
```

Leave the existing POSIX graceful-exit wait and forced fallback below this branch unchanged.

- [ ] **Step 4: Build test artifacts and verify GREEN for the named test**

Run:

```powershell
npm run build:test
node .\dist\scripts\run-tests.js --test-name-pattern "real status server leaves managed llama.cpp running after the idle summary block is emitted" tests\runtime-status-server.idle-summary.test.ts
```

Expected: PASS, followed by zero processes matching `siftkit-node-test-*\fake-llama-server.js`.

- [ ] **Step 5: Verify the containing integration-test file**

Run:

```powershell
node .\dist\scripts\run-tests.js tests\runtime-status-server.idle-summary.test.ts
```

Expected: all tests pass and no matching fake llama process remains.

- [ ] **Step 6: Run full static and behavioral verification**

Take a baseline process snapshot, then run:

```powershell
npm test
npm run typecheck
```

Expected:

- `npm test`: 0 failures.
- `npm run typecheck`: exit 0, including ESLint.
- Post-suite process snapshot contains no new process matching SiftKit, status-server, fake llama, llama-server, TabbyAPI, or `start-dev.ts`.

- [ ] **Step 7: Commit the implementation**

```powershell
git add -- tests/runtime-status-server.idle-summary.test.ts tests/_runtime-helpers.ts
git commit -m "test: terminate Windows status-server process trees"
```
