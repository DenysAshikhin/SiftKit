# Repo-Agent Approval Lifecycle Design

## Goal

Make non-TTY `repo-agent` approvals reliably resumable for the full worker-owned
decision window. Remove the competing server timeout that currently deletes the
upstream approval gate before the worker can submit its automatic denial.

## Selected Approach

The detached worker remains the sole owner of approval timing. Its existing
600-second decision timeout ends with an explicit denial submitted through the
normal approval endpoint. The status server holds the corresponding approval gate
until it receives that decision or the SSE request is aborted.

The server will not keep an independent elapsed approval timeout. Using one
authoritative deadline avoids equal-timer races and prevents the server from
invalidating a still-resumable run.

## Architecture

### `ApprovalGate`

`ApprovalGate` will require an `AbortSignal` and will no longer accept `timeoutMs`.
Each pending approval stores the functions needed to resolve normally or reject
when the signal aborts.

When `request()` is called:

1. Read-only bypass behavior remains unchanged.
2. An already-aborted signal rejects immediately without emitting an approval.
3. Otherwise, the gate stores the pending approval, registers a one-shot abort
   listener, and emits `approval_request`.

When `submit()` receives a matching approval ID, it removes the pending entry and
its abort listener before resolving `approve`, `deny`, or `abort`. Unknown or
already-resolved IDs still return `false`.

When the SSE signal aborts, every pending approval rejects with the signal's abort
error and is removed. Repeated aborts or later submissions are harmless.

### Status-server wiring

The streamed-operation endpoint already owns an `AbortController` and aborts it
when the response closes before a terminal frame. `RepoTaskEndpoint` will pass
that signal into `ApprovalGate`.

The five-minute `DEFAULT_APPROVAL_TIMEOUT_MS`, `readApprovalTimeoutMs()`, and
`SIFTKIT_APPROVAL_TIMEOUT_MS` behavior will be removed completely. No legacy
timeout compatibility remains.

### Worker behavior

`RepoAgentRunApprovalPrompter` remains authoritative:

- a submitted decision resumes immediately;
- no decision within 600 seconds becomes a denial;
- that denial is submitted to the still-live server gate;
- worker or client disconnection aborts the SSE request and therefore the gate.

The initiating non-TTY CLI still exits with `approval_required`; the detached
worker continues to own the live SSE request.

## Error Handling

- SSE disconnect or worker crash: abort signal rejects the pending gate and the
  run exits through the existing streamed-operation error path.
- Late decision after disconnect: the approval endpoint returns the existing
  stale/unknown response because the run registry is gone.
- Duplicate decision: the first submission resolves the gate; later submissions
  remain rejected as stale.
- Worker decision timeout: produces the existing explicit denial instead of an
  HTTP 404.

## Testing

Tests will follow TDD and cover:

1. A pending approval remains unresolved without a server timer.
2. A decision resolves after a delay longer than the former test timeout.
3. An already-aborted signal rejects without emitting an approval.
4. Aborting after emission rejects and removes the pending approval.
5. Submission removes the abort listener and remains resolved after later abort.
6. Submitting after abort returns `false`.
7. Read-only bypass remains independent of signal-driven pending approval logic.
8. The streamed endpoint cleans up an approval when its SSE client disconnects.
9. Existing non-TTY start/decide coverage still proves the first CLI exits while
   the detached worker resumes through a second CLI.

Focused approval, streamed-operation, and repo-agent CLI tests will run before the
full test and typecheck suites.

## Non-goals

- Persisting approval gates across status-server restarts.
- Rolling back filesystem edits produced before a later run failure.
- Changing automatic-review verdict policy.
- Changing the worker's 600-second decision duration.
