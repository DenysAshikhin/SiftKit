# HTTP Test Harness Leak Prevention Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. The primary agent must dispatch each implementation task sequentially through `siftkit repo-agent`, review the diff, and verify the task before continuing.

**Goal:** Make every audited dashboard HTTP test owner terminate its active connections deterministically so `npm test` cannot retain a worker on an SSE stream.

**Architecture:** Keep teardown inside the two fixtures that own the servers, cache one cleanup promise per fixture, and force-close active connections as part of that cleanup. Give the dashboard SSE client a wall-clock deadline with guarded settlement so continuous traffic cannot keep a request alive forever.

**Tech Stack:** TypeScript, Node.js `http`, Node.js test runner, strict assertions, existing SiftKit test helpers.

## Global Constraints

- Keep the implementation local, explicit, DRY, and limited to the three unsafe test helpers and focused regression tests.
- Preserve existing request/response contracts and the exact `request timeout` diagnostic.
- Do not modify production status-server lifecycle code or merge the incompatible dashboard and streamed-operation SSE helpers.
- Do not add dependencies, compatibility paths, dynamic cleanup callbacks, type assertions, non-null assertions, or unvalidated IO.
- Preserve unrelated and parallel user changes. Do not use a worktree. Do not commit.
- Observe each regression failing before its implementation, then passing afterward.

---

## File Structure

- `tests/helpers/dashboard-http.ts`: retain the dashboard HTTP helper contract; replace only `requestSse` inactivity timeout and settlement behavior.
- `tests/dashboard-http-helpers.test.ts`: own the continuous-SSE absolute-deadline regression.
- `tests/helpers/dashboard-model-queue-harness.ts`: own deterministic, cached cleanup for its status server, fake Tabby server, and controlled responses.
- `tests/model-request-queue-http.test.ts`: own the original leak regression against a real active repo-search request.
- `tests/helpers/dashboard-server-fixture.ts`: own deterministic, cached cleanup for the shared dashboard status server and process state.
- `tests/dashboard-server-fixture-cleanup.test.ts`: exercise the shared fixture against the production benchmark-events SSE route that intentionally remains open until disconnect.

---

### Task 1: Give dashboard SSE requests an absolute deadline

**Files:**
- Modify: `tests/dashboard-http-helpers.test.ts`
- Modify: `tests/helpers/dashboard-http.ts:81-154`

**Interfaces:**
- Consumes: `requestSse(url: string, options?: RequestOptions): Promise<SseResponse>` and `RequestOptions.timeoutMs?: number`.
- Produces: the same signature and response types; timeout now means elapsed wall-clock time and rejects with `Error('request timeout')`.

- [ ] **Step 1: Add the continuous-stream regression**

Append this test to `tests/dashboard-http-helpers.test.ts`. The server-side failsafe makes the current implementation resolve, and therefore fail `assert.rejects`, without leaving a live stream behind.

```ts
test('dashboard SSE requests reject at the absolute deadline while frames continue', async () => {
  const server = http.createServer((_request, response) => {
    response.writeHead(200, {
      'Content-Type': 'text/event-stream',
      Connection: 'keep-alive',
      'Cache-Control': 'no-cache',
    });
    response.write(': connected\n\n');
    const chatter = setInterval(() => response.write(': still-open\n\n'), 10);
    const failSafe = setTimeout(() => response.end(), 500);
    response.once('close', () => {
      clearInterval(chatter);
      clearTimeout(failSafe);
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = getAddressInfo(server);
  try {
    await assert.rejects(
      requestSse(`http://127.0.0.1:${port}/events`, { timeoutMs: 75 }),
      /request timeout/u,
    );
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
});
```

- [ ] **Step 2: Run the focused test and record RED**

Run:

```powershell
npm test -- dashboard-http-helpers
```

Expected: the new test fails because the chatty stream reaches its 500 ms failsafe and resolves; the existing `request.setTimeout()` never fires while bytes keep arriving.

- [ ] **Step 3: Replace inactivity timeout with guarded absolute settlement**

Keep the existing parser and public types. Inside `requestSse`, add `settled`, `deadline`, `clearDeadline`, `resolveOnce`, and `rejectOnce`; route every completion through them and replace `request.setTimeout` with a plain timer:

```ts
export function requestSse(url: string, options: RequestOptions = {}): Promise<SseResponse> {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const events: SseEvent[] = [];
    let settled = false;
    let deadline: NodeJS.Timeout | null = null;
    const clearDeadline = (): void => {
      if (deadline !== null) {
        clearTimeout(deadline);
        deadline = null;
      }
    };
    const resolveOnce = (response: SseResponse): void => {
      if (settled) return;
      settled = true;
      clearDeadline();
      resolve(response);
    };
    const rejectOnce = (error: Error): void => {
      if (settled) return;
      settled = true;
      clearDeadline();
      reject(error);
    };
    const request = http.request(
      {
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port,
        path: `${target.pathname}${target.search}`,
        method: options.method || 'GET',
        agent: testHttpAgent,
        headers: options.body ? {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(options.body, 'utf8'),
        } : undefined,
      },
      (response) => {
        let buffer = '';
        response.setEncoding('utf8');
        response.on('data', (chunk: string) => {
          buffer += chunk;
          let boundary = buffer.indexOf('\n\n');
          while (boundary >= 0) {
            const packet = buffer.slice(0, boundary);
            buffer = buffer.slice(boundary + 2);
            const lines = packet
              .split(/\r?\n/u)
              .map((line) => line.trim())
              .filter(Boolean);
            const eventLine = lines.find((line) => line.startsWith('event:'));
            const dataLine = lines.find((line) => line.startsWith('data:'));
            if (!dataLine) {
              boundary = buffer.indexOf('\n\n');
              continue;
            }
            const eventName = eventLine ? eventLine.slice(6).trim() : 'message';
            let payload: Dict | null = null;
            try {
              payload = asObject(parseJsonValueText(dataLine.slice(5).trim()));
            } catch {
              payload = null;
            }
            events.push({ event: eventName, payload, receivedAtMs: Date.now() });
            if (eventName === 'done' || eventName === 'error') {
              request.destroy();
              resolveOnce({ statusCode: response.statusCode || 0, events });
              return;
            }
            boundary = buffer.indexOf('\n\n');
          }
        });
        response.on('error', rejectOnce);
        response.on('end', () => {
          resolveOnce({ statusCode: response.statusCode || 0, events });
        });
      },
    );
    request.on('error', rejectOnce);
    deadline = setTimeout(() => {
      const error = new Error('request timeout');
      rejectOnce(error);
      request.destroy(error);
    }, Number(options.timeoutMs || 8000));
    if (options.body) request.write(options.body);
    request.end();
  });
}
```

- [ ] **Step 4: Run the focused test and record GREEN**

Run `npm test -- dashboard-http-helpers`.

Expected: all dashboard HTTP helper tests pass, including rejection near the 75 ms wall-clock deadline.

- [ ] **Step 5: Mutation-check the timeout regression and restore immediately**

Temporarily replace the plain deadline assignment with the original `request.setTimeout(...)`, run `npm test -- dashboard-http-helpers`, and confirm only the new deadline test fails by resolving at the failsafe. Restore the plain `setTimeout` implementation with `apply_patch`, rerun the focused test, and confirm GREEN. Do not use Git restoration commands or commit.

---

### Task 2: Make model-queue harness teardown terminate active requests

**Files:**
- Modify: `tests/model-request-queue-http.test.ts`
- Modify: `tests/helpers/dashboard-model-queue-harness.ts:68-453`

**Interfaces:**
- Consumes: `DashboardModelQueueHarness.holdModelLock(prompt: string, delayMs: number): Promise<SseResponse>` and `waitForActiveRequests(kind: string, count?: number): Promise<void>`.
- Produces: `DashboardModelQueueHarness.close(): Promise<void>` returning the exact cached cleanup promise to concurrent and later callers.

- [ ] **Step 1: Add a safe failing teardown regression**

Add `import { setTimeout as delay } from 'node:timers/promises';` and append this test to `tests/model-request-queue-http.test.ts`. The slow request is still bounded, so the RED run cleans itself up rather than reproducing an indefinite worker hang.

```ts
test('model queue harness closes an active request once without waiting for its work', async () => {
  const harness = new DashboardModelQueueHarness('siftkit-http-queue-close-', { parallelSlots: 1 });
  await harness.start();

  const heldRequest = harness.holdModelLock('request active during teardown', 5_000);
  const heldOutcome = heldRequest.then(
    () => 'resolved' as const,
    () => 'rejected' as const,
  );
  await harness.waitForActiveRequests('repo_search');

  const firstClose = harness.close();
  const concurrentClose = harness.close();
  const sharedConcurrentPromise = firstClose === concurrentClose;
  const allSettled = Promise.allSettled([firstClose, concurrentClose, heldOutcome]);
  const closedPromptly = await Promise.race([
    allSettled.then(() => true),
    delay(2_500, false, { ref: false }),
  ]);
  if (!closedPromptly) await allSettled;

  const laterClose = harness.close();
  const sharedLaterPromise = laterClose === firstClose;
  await firstClose;
  await concurrentClose;
  await laterClose;

  assert.equal(closedPromptly, true);
  assert.equal(await heldOutcome, 'rejected');
  assert.equal(sharedConcurrentPromise, true);
  assert.equal(sharedLaterPromise, true);
});
```

- [ ] **Step 2: Run the focused test and record RED**

Run:

```powershell
npm test -- model-request-queue-http
```

Expected: the new test waits for the simulated work instead of closing within 2.5 seconds, the held request resolves, and the two `async close()` calls do not return the same promise.

- [ ] **Step 3: Cache one cleanup operation and force-close both owned servers**

Add this field to `DashboardModelQueueHarness`:

```ts
private closePromise: Promise<void> | null = null;
```

Replace `async close()` with a non-`async` cache wrapper and move the current body into `closeOnce()`:

```ts
close(): Promise<void> {
  this.closePromise ??= this.closeOnce();
  return this.closePromise;
}

private async closeOnce(): Promise<void> {
  try {
    for (const pending of this.pendingChatRequests.values()) {
      pending.response.destroy();
    }
    this.pendingChatRequests.clear();
    this.chatSessionIdByContent.clear();
    this.releasedChatResponseBySessionId.clear();
    this.queuedChatResponses.length = 0;
    this.abortedChatSessionIds.clear();

    try {
      const server = this.server;
      if (server !== null && server.listening) {
        server.closeAllConnections();
        await new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
        });
      }
    } finally {
      const fakeTabby = this.fakeTabbyServer;
      if (fakeTabby !== null) {
        fakeTabby.closeAllConnections();
        await new Promise<void>((resolve, reject) => {
          fakeTabby.close((error) => (error ? reject(error) : resolve()));
        });
      }
    }
  } finally {
    try {
      try {
        restoreDashboardTestEnv(this.envBackup);
      } finally {
        restoreDashboardTestRepo(this.previousCwd);
      }
    } finally {
      await removeDirectoryWithRetries(this.tempRoot);
    }
  }
}
```

- [ ] **Step 4: Run the focused test and record GREEN**

Run `npm test -- model-request-queue-http`.

Expected: all model request queue HTTP tests pass; the active request rejects, teardown wins the 2.5-second race, and all close calls return one promise.

- [ ] **Step 5: Mutation-check connection ownership and restore immediately**

Temporarily remove only `server.closeAllConnections()`, run `npm test -- model-request-queue-http`, and confirm the new test misses the prompt-close deadline while the original queue tests still clean up. Restore the call with `apply_patch`, rerun the focused file, and confirm GREEN. Do not commit.

---

### Task 3: Make the shared dashboard fixture teardown leak-proof

**Files:**
- Create: `tests/dashboard-server-fixture-cleanup.test.ts`
- Modify: `tests/helpers/dashboard-server-fixture.ts:51-166`

**Interfaces:**
- Consumes: `DashboardTestServer.start(namePrefix: string, backend?: DashboardTestBackend, options?: DashboardTestServerOptions): Promise<DashboardTestServer>`, public `baseUrl`, and the registered `GET /dashboard/benchmark/sessions/:id/events` SSE route.
- Produces: `DashboardTestServer.close(): Promise<void>` returning the exact cached cleanup promise to concurrent and later callers.

- [ ] **Step 1: Add the real open-SSE teardown regression**

Create `tests/dashboard-server-fixture-cleanup.test.ts` with the following content. The client exposes an abort only so the RED path can release the intentionally open stream after proving teardown was blocked.

```ts
import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

import { DashboardTestServer } from './helpers/dashboard-server-fixture.js';
import { testHttpAgent } from './helpers/http-agent.js';

function openBenchmarkEventStream(baseUrl: string): {
  started: Promise<void>;
  settled: Promise<void>;
  abort: () => void;
} {
  let resolveStarted = (): void => {};
  let rejectStarted = (_error: Error): void => {};
  let resolveSettled = (): void => {};
  const started = new Promise<void>((resolve, reject) => {
    resolveStarted = resolve;
    rejectStarted = (error) => reject(error);
  });
  const settled = new Promise<void>((resolve) => {
    resolveSettled = resolve;
  });
  const request = http.get(
    `${baseUrl}/dashboard/benchmark/sessions/leak-regression/events`,
    { agent: testHttpAgent },
    (response) => {
      response.resume();
      response.once('close', resolveSettled);
      response.once('end', resolveSettled);
      response.once('error', resolveSettled);
      resolveStarted();
    },
  );
  request.once('error', (error) => {
    rejectStarted(error);
    resolveSettled();
  });
  return {
    started,
    settled,
    abort: () => request.destroy(),
  };
}

test('DashboardTestServer closes one active SSE stream exactly once', async () => {
  const fixture = await DashboardTestServer.start('siftkit-dashboard-close-');
  const stream = openBenchmarkEventStream(fixture.baseUrl);
  try {
    await stream.started;
    const firstClose = fixture.close();
    const concurrentClose = fixture.close();
    const sharedConcurrentPromise = concurrentClose === firstClose;
    const allSettled = Promise.allSettled([firstClose, concurrentClose, stream.settled]);
    const closedPromptly = await Promise.race([
      allSettled.then(() => true),
      delay(2_000, false, { ref: false }),
    ]);
    if (!closedPromptly) {
      stream.abort();
      await allSettled;
    }

    const laterClose = fixture.close();
    const sharedLaterPromise = laterClose === firstClose;
    await firstClose;
    await concurrentClose;
    await laterClose;

    assert.equal(closedPromptly, true);
    assert.equal(sharedConcurrentPromise, true);
    assert.equal(sharedLaterPromise, true);
  } finally {
    stream.abort();
    await Promise.allSettled([fixture.close()]);
  }
});
```

- [ ] **Step 2: Run the focused test and record RED**

Run:

```powershell
npm test -- dashboard-server-fixture-cleanup
```

Expected: teardown loses the two-second race until the test aborts the stream, and the uncached `async close()` calls return different promises.

- [ ] **Step 3: Cache cleanup and close active connections before awaiting shutdown**

Add this field to `DashboardTestServer`:

```ts
private closePromise: Promise<void> | null = null;
```

Replace `async close()` with:

```ts
close(): Promise<void> {
  this.closePromise ??= this.closeOnce();
  return this.closePromise;
}

private async closeOnce(): Promise<void> {
  try {
    this.server.closeAllConnections();
    await new Promise<void>((resolve, reject) => {
      this.server.close((error) => (error ? reject(error) : resolve()));
    });
  } finally {
    try {
      process.chdir(this.previousCwd);
    } finally {
      try {
        closeRuntimeDatabase();
      } finally {
        try {
          for (const [key, value] of Object.entries(this.envBackup)) {
            if (value === undefined) {
              delete process.env[key];
            } else {
              process.env[key] = value;
            }
          }
        } finally {
          await removeDirectoryWithRetries(this.tempRoot);
        }
      }
    }
  }
}
```

- [ ] **Step 4: Run the focused test and fixture callers**

Build once, then run each focused caller against the same compiled output:

```powershell
npm run build:test
@(
  'dashboard-server-fixture-cleanup',
  'chat-status-metrics',
  'chat-speculative-fallback',
  'config-preset-http',
  'config-update-endpoint'
) | ForEach-Object {
  node .\dist\scripts\run-tests.js $_
  if ($LASTEXITCODE -ne 0) { throw "caller test failed: $_" }
}
```

Expected: the cleanup regression and all filtered `DashboardTestServer` callers pass.

- [ ] **Step 5: Mutation-check fixture connection ownership and restore immediately**

Temporarily remove only `this.server.closeAllConnections()`, run `npm test -- dashboard-server-fixture-cleanup`, and confirm the regression loses its two-second race before its abort cleanup releases the stream. Restore the call with `apply_patch`, rerun the focused file, and confirm GREEN. Do not commit.

---

### Final Review Fix: Close the delayed-shutdown acceptance window

**Files:**
- Modify: `tests/helpers/dashboard-http.ts`
- Modify: `tests/dashboard-http-helpers.test.ts`
- Modify: `tests/helpers/dashboard-model-queue-harness.ts`
- Modify: `tests/helpers/dashboard-server-fixture.ts`

- [x] Add shared `closeHttpServer(server: http.Server): Promise<void>` ownership policy: register a connection-destroy listener, initiate close, terminate existing connections, await the callback, and remove the listener in `finally`.
- [x] Replace the three duplicated server-close blocks in both fixtures with the shared helper while preserving cached cleanup and nested `finally` ordering.
- [x] Add a bounded real-server regression that opens a long-lived request during a delayed underlying close.
- [x] Observe the regression fail safely when the connection listener is removed, restore it, and verify the three focused files pass together.
- [x] Obtain a scoped final re-review confirming the delayed-close finding is addressed with no new Critical or Important issue.

---

## Final Verification

- [ ] Run `npm run build:test` once, then run the compiled model-queue test at least 20 consecutive times. Stop on the first failure and retain the exact failing iteration and stack:

```powershell
npm run build:test
1..20 | ForEach-Object {
  node .\dist\scripts\run-tests.js model-request-queue-http
  if ($LASTEXITCODE -ne 0) { throw "model-request-queue-http failed on iteration $_" }
}
```

- [ ] Run a SiftKit repository audit for every test-owned `http.Server.close()` call. Require file:line evidence that each owner either force-closes active connections before awaiting shutdown or cannot own a long-lived connection; inspect any newly reported unsafe owner directly.

```powershell
siftkit repo-search 'Audit all TypeScript tests and test helpers that own a Node HTTP server and await server.close(). Return every close site with file:line anchors, whether closeAllConnections() is invoked as part of the same synchronous teardown initiation before the close callback is awaited, whether the server can own SSE or other long-lived traffic, and a safe/unsafe verdict. Facts and verdicts only; do not plan or design.'
```

- [ ] Run the complete suite through SiftKit summary and independently require zero failed tests and a normal process exit:

```powershell
npm test 2>&1 | siftkit summary --question "Return pass/fail, total/passed/failed/skipped counts, duration, failing test names, root errors, and whether the command exited normally."
```

- [ ] Run static gates through SiftKit summary:

```powershell
npm run typecheck 2>&1 | siftkit summary --question "Return pass/fail and every diagnostic with file:line anchors."
npm run lint 2>&1 | siftkit summary --question "Return pass/fail and every diagnostic with file:line anchors."
```

- [ ] After all commands exit, run this exact orphan check. It must print `workers=0`, `sockets=0`, and `tempDirs=0`. If it does not, retain the full rows, resolve their exact process IDs and paths, and do not report completion until the owning test is fixed and verification reruns cleanly.

```powershell
$workspacePattern = 'SiftKit.*(?:dist\\scripts\\run-tests\.js|dist\\tests\\)'
$workers = @(Get-CimInstance Win32_Process | Where-Object {
  $_.Name -eq 'node.exe' -and $_.CommandLine -match $workspacePattern
})
$workerIds = @($workers | ForEach-Object { [int]$_.ProcessId })
$sockets = if ($workerIds.Count -eq 0) {
  @()
} else {
  @(Get-NetTCPConnection | Where-Object { $_.OwningProcess -in $workerIds })
}
$tempDirs = @(Get-ChildItem -LiteralPath ([IO.Path]::GetTempPath()) -Directory | Where-Object {
  $_.Name -match '^(?:siftkit-http-queue-close-|siftkit-dashboard-close-)'
})
$workers | Format-Table ProcessId, Name, CommandLine -AutoSize
$sockets | Format-Table OwningProcess, State, LocalAddress, LocalPort, RemoteAddress, RemotePort -AutoSize
$tempDirs | Format-Table FullName -AutoSize
"workers=$($workers.Count) sockets=$($sockets.Count) tempDirs=$($tempDirs.Count)"
```

- [ ] Review the scoped diff against the design, confirm no unrelated/user-parallel file was overwritten, and leave all changes uncommitted.
