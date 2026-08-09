# HTTP Test Harness Leak Prevention Design

## Purpose

Eliminate the nondeterministic `npm test` worker hang caused by HTTP/SSE test harnesses awaiting `http.Server.close()` while owned connections remain active. Apply the same ownership rule to every concrete unsafe harness found in the session audit, and protect it with behavior-level regression tests.

## Root Cause

`tests/model-request-queue-http.test.ts` starts `/repo-search` SSE requests through `DashboardModelQueueHarness.holdModelLock()`. Under full-suite load, a two-second model-queue poll can time out before those request promises settle. The test enters `finally`, but `DashboardModelQueueHarness.close()` does not own or abort those client requests and awaits the status server's `close()` callback without first closing active connections.

Node stops accepting new connections when `server.close()` begins but does not invoke its callback until existing HTTP connections terminate. The dashboard SSE helper uses `request.setTimeout()`, an inactivity timeout that can be reset by continued SSE traffic, so an active stream has no absolute lifetime. The resulting test promise remains stuck in teardown and its worker process retains sockets and temporary directories beyond the test runner's 30-second test timeout.

The same unsafe server-close pattern exists in `DashboardTestServer`. Other audited test-server owners either call `closeAllConnections()` or synchronously call it immediately after initiating close. No WebSocket or HTTP-upgrade connections exist in the two affected harnesses, so `closeAllConnections()` covers their SSE and JSON traffic.

## Architecture

Keep resource ownership local and explicit:

- `DashboardModelQueueHarness` owns its status server, fake Tabby server, controlled fake responses, environment backup, working-directory backup, and temporary root. Its `close()` method must cache one cleanup promise so concurrent and later callers observe the same result, destroy controlled responses, force-close connections on both servers, await both close callbacks, and then restore process state and remove its temporary root.
- `DashboardTestServer` owns one status server plus its environment, working directory, and temporary root. Its `close()` method must cache one cleanup promise, force-close active connections, await the close callback, then restore process state and remove its temporary root.
- `tests/helpers/dashboard-http.ts::closeHttpServer()` owns test-server connection draining. It must reject connections accepted while an overridden close is still waiting, initiate close, terminate already-active connections, await the close callback, and remove its temporary connection listener.
- `tests/helpers/dashboard-http.ts::requestSse()` owns its client request, response listeners, and absolute deadline timer. It must settle once, clear its timer, destroy the request on timeout, and reject even if the server continues sending frames.

Do not introduce a lifecycle framework, injected cleanup callbacks, compatibility overloads, or a merger with `tests/helpers/sse-http.ts`; the two SSE helpers have incompatible request and response contracts.

## Components and Behavior

### DashboardModelQueueHarness

Cache the first cleanup promise in a private field. The first `close()` starts cleanup; concurrent and later calls return that same promise without repeating environment restoration or directory deletion.

During the one cleanup operation:

1. Destroy every controlled fake Tabby response and clear the tracking collections.
2. Close the status server through `closeHttpServer()`, so both existing and newly accepted connections are terminated while the existing overridden `close()` performs bounded runtime shutdown.
3. In `finally`, close the fake Tabby server through the same helper, so a status-server close failure cannot leave the fake backend listening.

Environment, working-directory, database, and temporary-directory restoration remains in `finally`, so it executes if either server close rejects.

### DashboardTestServer

Use the same cached-cleanup-promise pattern and shared `closeHttpServer()` policy. Put the existing working-directory, database, environment, and temporary-directory restoration sequence in `finally` so a server-close error cannot leak process state.

### Dashboard SSE Client

Replace socket-inactivity timeout semantics with one absolute `setTimeout` started when the request is created. Use explicit resolve-once and reject-once paths backed by shared timer cleanup; do not pass completion functions through a generic settlement abstraction.

Terminal `done` or `error` SSE events keep their current response shape and early-completion behavior. Request errors, response errors, response end, and deadline expiry all use the same settlement guard and timer cleanup. Deadline expiry destroys the request with `Error('request timeout')` and rejects the returned promise even when frames continue arriving.

## Error Handling

- Server connection termination during harness shutdown is expected teardown behavior; in-flight request promises may reject, but each test must attach a rejection observer before initiating shutdown so no unhandled rejection is produced.
- A server close callback error propagates from `close()` after process-state cleanup runs.
- Concurrent and repeated `close()` calls return the original cleanup promise and therefore share its success or failure.
- The SSE deadline error remains `request timeout` to preserve caller-facing diagnostics.
- Production status-server shutdown remains unchanged. Its runtime shutdown calls are bounded by configured deadlines and its `finally` always reaches the original server close.

## Testing

Use real HTTP servers and requests; do not assert mocks or source text.

1. Add a failing `DashboardModelQueueHarness` regression that starts a deliberately long model-lock request, waits until it is active, observes its rejection, and asserts `close()` completes well before the simulated work would finish. Without forced connection closure, the elapsed-time assertion fails.
2. Add a failing `DashboardTestServer` regression that opens `GET /dashboard/benchmark/sessions/leak-regression/events`, waits for its SSE response, starts `close()`, and asserts teardown and the observed client settlement complete promptly. This production endpoint intentionally leaves the stream open until client disconnect, so it deterministically exercises fixture-owned connection termination without exposing the private server.
3. Add a failing dashboard SSE-client regression whose server emits frames more frequently than the configured timeout. Assert the request rejects at the absolute deadline. The current inactivity timeout fails this test because traffic continually resets it.
4. Cover concurrent and later repeated `close()` calls for both harnesses; every caller must observe the same cleanup completion without duplicate process-state restoration or directory removal.
5. Add a delayed-underlying-close regression that starts teardown, opens a new long-lived request during the delay, and proves both client settlement and server close remain bounded.
6. Mutation-check the regressions by removing each connection-termination guard and replacing the absolute deadline with `request.setTimeout()` one change at a time; the matching test must fail for the intended reason without leaking its own worker.
7. Run the affected files repeatedly, including at least 20 iterations of `model-request-queue-http.test.ts`.
8. Run every caller suite of `DashboardModelQueueHarness`, `DashboardTestServer`, and dashboard `requestSse`, followed by the complete `npm test`, `npm run typecheck`, and `npm run lint` gates.

## Scope

Expected implementation files:

- `tests/helpers/dashboard-model-queue-harness.ts`
- `tests/helpers/dashboard-server-fixture.ts`
- `tests/helpers/dashboard-http.ts`
- Existing or new focused TypeScript test files for those three components

Do not modify production server lifecycle code, the incompatible `tests/helpers/sse-http.ts`, already-safe server harnesses, or unrelated parallel changes.

## Acceptance Criteria

- Both affected harnesses close promptly with active SSE/HTTP requests and tolerate repeated close calls.
- Existing connections and connections accepted during delayed underlying shutdown cannot survive fixture teardown.
- Dashboard SSE requests obey an absolute deadline even under continuous traffic.
- No audited unsafe harness remains that awaits server close without first terminating its owned active connections.
- Regression tests are observed failing before implementation and passing afterward.
- The model-request queue test passes at least 20 consecutive isolated iterations.
- All caller suites, the complete test suite, typecheck, and lint pass.
- No orphaned test worker, listener, established socket, or managed temporary directory remains after verification.
