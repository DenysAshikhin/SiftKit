# Parallel Status Tracking Design

## Goal

Track every model-backed request independently while allowing different dashboard chat sessions and CLI/CMD operations to run concurrently. Prevent more than one operation from mutating the same chat session until its current operation finishes.

## Current Problem

The model-request layer permits concurrent EXL3 work, but status ownership is still keyed by the shared `statusPath`. `activeRequestIdByStatusPath` can name only one request, so a newer request marks an older, still-running request as `stale_status_abandoned`.

The dashboard has a second collision point. Its busy flag, live messages, errors, warnings, drafts, attachments, and usage state are global. Even if the server tracks concurrent requests correctly, a stream for session B can overwrite the visible state for session A.

## Required Invariants

### Status tracking

- `requestId` is the only run identity.
- `statusPath` is metadata and an aggregate status-file destination, never an ownership key.
- Starting one request never abandons, clears, completes, or enriches another request.
- Completion transitions only the matching request out of active reporting and is safe in any order.
- Duplicate completion and terminal-metadata delivery are idempotent.
- Late running updates cannot resurrect the same completed request.
- `requestId` is required at the status HTTP boundary. The `legacy:<statusPath>` fallback is removed.
- The status layer adds no concurrency cap; execution remains limited by the selected backend's existing admission policy.
- The published status file remains an aggregate busy/idle signal.

### Chat sessions

- A chat session permits exactly one active message, plan, or repo-search operation, streamed or non-streamed.
- A second submission for the same session is rejected immediately with `409 Conflict`; it is never queued.
- The session remains locked while waiting for model capacity, executing, persisting history, and finishing the response.
- Completion, failure, and client disconnect release only the matching session lease.
- Different chat sessions have independent locks and may stream concurrently.
- CLI/CMD operations do not acquire chat-session locks and remain independently concurrent.

### Backend capacity

- EXL3 continues to admit concurrent model work and streams.
- llama.cpp continues to serialize model execution through the existing model-request queue.
- Queued llama.cpp requests still retain independent status records and per-session ownership.

## Server Architecture

### `StatusRunRegistry`

Introduce a focused class that exclusively owns the status lifecycle. Server routes must use explicit methods rather than manipulating maps directly or passing behavior through callbacks.

The registry owns three lifecycle collections keyed by `requestId`:

- Active runs: currently running or advancing through multi-step work.
- Awaiting-terminal-metadata runs: completed from the caller's perspective but retaining an immutable timing/progress snapshot until enrichment arrives.
- Completed tombstones: recently finalized request IDs used to reject late or duplicate delivery.

The registry exposes explicit operations for:

- Starting or advancing a run.
- Completing a run and moving its immutable snapshot out of the active collection.
- Applying terminal metadata to the exact request.
- Producing a deterministic active-run snapshot for `GET /status`.
- Determining aggregate activity.
- Pruning expired terminal snapshots and completion tombstones.

Lifecycle results use typed discriminated outcomes such as started, advanced, completed, duplicate, late, and unknown. Callers switch explicitly on those outcomes. No dynamic function dispatch is introduced.

Awaiting-terminal snapshots expire after the named `TERMINAL_SNAPSHOT_RETENTION_MS` constant of five minutes if metadata never arrives and emit an error log containing the request ID. Completed tombstones expire after the named `COMPLETED_REQUEST_RETENTION_MS` constant of fifteen minutes. Five minutes covers the normally immediate second terminal POST without retaining lost enrichment indefinitely; fifteen minutes covers delayed duplicate or late status delivery through the existing model-queue timeout window. Expiration is evaluated on registry lifecycle operations and status reads, avoiding a separate background scheduler.

The existing fields and behavior are removed completely:

- `activeRequestIdByStatusPath`
- `completedRequestIdByStatusPath`
- `getResolvedRequestId()` legacy fallback
- `stale_status_abandoned`
- `logAbandonedRun()` for status-path replacement

### Status endpoint contract

`POST /status` requires a non-empty `requestId`. A running post creates a new run or advances the matching run. It never inspects another request sharing the same path.

`POST /status/complete` is an idempotent fast-path transition. It moves the exact request from active to awaiting-terminal-metadata state, removes it from active reporting, records its completion tombstone, and retains the run snapshot for later enrichment.

`POST /status/terminal-metadata` binds metadata to the exact request ID. If metadata arrives before `/complete`, it finalizes directly from the active run. If it arrives after `/complete`, it consumes the retained snapshot. Duplicate metadata cannot update metrics twice.

`GET /status` returns aggregate `running` plus a deterministic `activeRuns` array ordered by start time and then request ID. Each entry contains only operational metadata:

```json
{
  "requestId": "212ac38a",
  "statusPath": "C:/path/status.txt",
  "taskKind": "chat",
  "startedAtUtc": "2026-08-02T18:52:53.000Z",
  "currentStepStartedAtUtc": "2026-08-02T18:52:53.000Z",
  "stepCount": 1,
  "chunkIndex": null,
  "chunkTotal": null
}
```

Prompt text, generated text, images, and credentials are never exposed.

### `ChatSessionOperationRegistry`

Introduce a focused class keyed by `sessionId`. Acquisition returns either a typed conflict result or a lease containing a UUID v4 token, operation kind, and start time. Release requires both the session ID and token, so stale cleanup cannot release a newer operation.

All six mutating chat endpoints use the same registry:

- Message and message stream.
- Plan and plan stream.
- Repo-search and repo-search stream.

The server validates the session and request body, then acquires the session lease before requesting model capacity. The session lease is only an integrity guard and reserves no backend capacity. A rejected request never reaches model-capacity acquisition or status creation.

The successful lifecycle is:

```text
validate
-> acquire session lease
-> acquire backend model capacity
-> open SSE when applicable
-> execute
-> persist the exact session
-> send done/error and close the response
-> release backend capacity
-> release session lease
```

Every endpoint uses an explicit `try/finally` cleanup path. No callback-based generic lock wrapper is added.

The conflict response is:

```http
HTTP/1.1 409 Conflict
Content-Type: application/json
```

```json
{
  "error": "Chat session already has an active operation.",
  "sessionId": "session-a",
  "operationKind": "message"
}
```

The active operation continues unaffected.

## Dashboard Architecture

Replace global chat runtime state with state keyed by `sessionId`. Each session owns:

- Active operation kind and request state.
- Live thinking, tool, and answer messages.
- Error and warning state.
- Context usage and live tool token counts.
- Draft text and pending attachments.

Creating or switching sessions remains enabled while another session streams. Submit and delete controls are disabled only when the selected session is active. A session cannot be deleted while its operation owns a lease.

Each HTTP stream retains its own `ChatStreamReader`. The API exposes an async typed event iterator instead of accepting dynamically supplied event callbacks. The composer captures the initiating `sessionId`, explicitly switches over each event, and updates only that session's runtime entry. Completion refreshes and persists only that session.

The server remains authoritative. If another tab or direct API caller creates a conflict, the dashboard associates the `409` error only with the affected session.

Reloading or closing the page aborts its open HTTP connections through normal connection closure. Stream reconnection or replay is not part of this work.

An unexpected stream close without `done` is handled as a session-scoped failure and clears that session's local active state. This includes status-server restart; no UI stream remains falsely busy after its connection terminates.

## CLI/CMD Behavior

CLI and CMD requests already create unique request IDs. They continue posting to the same status endpoints, but the new registry prevents their status from colliding with chats or other commands sharing the same `statusPath`.

CLI/CMD work does not participate in `ChatSessionOperationRegistry`. It competes with dashboard work through the same existing backend admission coordinator and FIFO queue: EXL3 may admit it concurrently, while llama.cpp serializes it. Each invocation retains its own progress output, status record, and terminal result.

Preset selection and switching keep their existing coordinator semantics. A switch waits for active requests to drain before changing backend, so a single request never changes backend mid-lifecycle. Backend fallback behavior is outside this status-tracking change.

## Error Handling and Observability

- Same-session rejection logs a `session_busy_rejected` event with session ID, requested operation, active operation, and active duration.
- Status lifecycle logs include request ID, task kind, active-run count, and lifecycle outcome.
- Chat lifecycle logs include session ID and operation kind without exposing content.
- A late running update is a `running=true` status post received while its exact request ID has an unexpired completion tombstone; it is logged and ignored.
- Unknown or expired terminal metadata is logged and cannot mutate another request.
- Duplicate terminal delivery is logged as idempotent and cannot double-count runtime metrics.
- Stream, engine, persistence, and disconnect failures release the exact backend and session leases.
- Switching dashboard sessions does not cancel active work.
- Process restart clears in-memory active state; no in-process request survives the server process.

## TDD and Verification

Implementation is test-driven. Each behavior begins with a failing test, followed by the minimal implementation and focused verification. Existing real HTTP server fixtures are preferred over isolated unit mocks.

### Status-server E2E coverage

- Start multiple request IDs on the same status path and observe all in `activeRuns`.
- Complete them in every relevant order and remove only the matching run.
- Run parallel chat and CLI/CMD status lifecycles without collision.
- Deliver completion and terminal metadata in both orders.
- Repeat terminal calls and prove runtime totals, per-task totals, input/output/tool/thinking tokens, duration, and speculative counters are each counted exactly once.
- Ignore late running updates only for the same completed request ID.
- Keep aggregate `running=true` until all active work finishes.
- Expire orphaned terminal snapshots without affecting active requests.
- Prove no `stale_status_abandoned` event is emitted.

### Chat-server E2E coverage

- Stream sessions A, B, and C concurrently and persist each independently.
- Keep every SSE event attached to its originating session.
- Reject a second streamed or non-streamed operation for session A with `409`.
- Prove message, plan, and repo-search operations mutually block within one session.
- Keep session B usable while A streams or waits for llama.cpp capacity.
- Accept a new A operation immediately after success, failure, or disconnect.
- Verify llama.cpp queues different sessions without merging status.
- Verify EXL3 admits different sessions concurrently.

### Dashboard integration/E2E coverage

- Continue updating session A while session B is selected.
- Starting B does not clear A's live messages, warnings, errors, usage, draft, or attachments.
- Disable submit/delete controls only for the busy session.
- Keep session creation and switching enabled during another stream.
- Scope a server-side `409` to the conflicting session.
- Complete streams in either order and retain correct histories and indicators.

### Final quality gates

- Full test suite passes.
- TypeScript typecheck and production build pass.
- New registry classes and every changed concurrency/error branch have 100% branch coverage; repository-wide coverage must not decrease.
- No type assertions, `any`, non-null assertions, namespace imports, compatibility shims, dynamically passed behavior, duplicated lifecycle logic, or unrelated abstractions are introduced.

## Non-Goals

- Concurrent mutations within one chat session.
- Queuing submissions within a chat session.
- Stream reconnection or replay after page reload.
- Changing llama.cpp or EXL3 backend scheduling policy.
- Changing preset switching or backend fallback policy.
- Persisting active in-process requests across server restart.
