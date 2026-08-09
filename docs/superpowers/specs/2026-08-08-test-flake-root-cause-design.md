# Test flake root-cause design

## Scope

Eliminate the three failures observed under the standard 24-file test concurrency and close the remaining dashboard-fixture startup leak paths. Keep the standard concurrency and production behavior intact.

## Root causes

1. `InferenceRunFlushQueue.waitForIdle(1000)` gives a correctly queued worker flush a private one-second deadline. Worker startup and retry scheduling can exceed it under suite load. The queue still completes; the test fails first.
2. Managed Tabby declares the HTTP model ready before the child-process log recorder is guaranteed to have received the MTP marker. A one-shot log read races pipe delivery.
3. Windows is configured with the ephemeral TCP range `1024-65534`. A test server using `listen(0)` can therefore own port 4765 or 8097, but the preload guard rejects requests solely by port and reports a false live-instance leak.
4. Dashboard fixtures acquire temp directories, cwd/env mutations, listeners, and database handles before startup completes. Rejection paths do not consistently roll those resources back.
5. The SSE latency-tail E2E compares a client receive timestamp with a server-side write timestamp. Under event-loop or socket batching, the tail and answer retain correct wire order but reach the client after the server recorded the answer write.
6. The temp-directory lock fixture treats `child.kill()` plus a 300 ms sleep as proof of exit and treats a 300 ms startup sleep as proof that the child acquired its cwd. Neither is an event-level guarantee under load.

## Design

### Flush completion

Make `waitForIdle` wait for the queue condition without a second internal deadline. The node:test per-test timeout remains the single hang bound. This removes duplicated timeout policy and continues to test the real asynchronous drain path.

### Managed Tabby readiness

Change the MTP assertion into an asynchronous readiness check. Poll the recorder's combined stdout/stderr view until the marker appears or the preset's existing `HealthcheckTimeoutMs` expires. Use the existing health-check interval as an upper bound for polling cadence. Preserve the current failure message when the semantic readiness window expires.

### Live-instance guard

Track TCP server ports owned by the current test process before user `listening` callbacks run. Requests to a currently owned guarded port are allowed; requests to any unowned guarded port remain fatal. Add a deterministic child-process regression that guards a random port, binds a local test server there, and requests it.

Port hand-off helpers that reserve a port and then launch a child must reject the two guarded default ports explicitly, because ownership moves between processes.

### Fixture rollback

Make successful close and failed startup use the same idempotent cleanup path. Restore cwd/env, close any created listeners/database handle, and delete the managed temp directory. Add deterministic failure injection through data getters that throw after acquisition, without adding production callbacks or test-only implementation hooks.

### SSE and child-process synchronization

Keep the SSE E2E assertions on observable client behavior: bounded delta sizes, reconstructed text, latency lower bound, and event order. Do not compare clocks from opposite sides of the socket.

Make the directory-lock child emit an explicit ready handshake after startup. Make release await its `exit` event before deleting the directory. Remove fixed startup and teardown sleeps.

## Acceptance criteria

- Each root cause has a regression that fails against the prior behavior.
- Focused tests pass repeatedly under concurrency.
- Multiple unmodified `npm test` runs pass and exit without orphan test/server processes.
- `npm run typecheck` and `npm run lint` pass.
