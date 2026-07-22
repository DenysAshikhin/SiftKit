# Streamed CLI Transport Corrections — Design

Date: 2026-07-22
Status: Approved
Related: `2026-07-22-streamed-cli-transport-design.md`

## Problem

The streamed CLI transport works and its tests pass, but the implementation drifted from
three core constraints:

1. Progress functions are passed through request objects and service layers dynamically.
2. Streamed error frames discard the structured diagnostics produced by
   `recordServerError`.
3. `StatusServerApiClient` constructs a separate `SseClient`, bypassing its injected
   `HttpClient` and duplicating HTTP/SSE connection logic.

This correction is a complete refactor. It does not retain compatibility aliases,
callback-shaped options, or the standalone `SseClient`.

## Goals

- Application layers exchange progress through typed reporter objects with explicit
  methods, never function-valued request properties.
- Every terminal streamed server failure preserves the complete diagnostic payload:
  `error`, `errorName`, `diagnosticId`, and recursive `diagnostic` data. Queue failures
  additionally preserve model-request queue diagnostics.
- `HttpClient` is the only client-side owner of local HTTP and SSE transport.
- Injecting an `HttpClient` into `StatusServerApiClient` controls both JSON and streamed
  requests.
- Existing result and progress wire payloads remain unchanged.
- All changes are runtime-schema validated and fully typed without assertions, `any`,
  non-null assertions, or namespace imports.

## Non-goals

- Changing CLI progress text or result schemas.
- Changing model-lock concurrency.
- Adding compatibility for the callback APIs or standalone `SseClient`.
- Generalizing unrelated event systems.

## Architecture

### One SSE transport

`HttpClient.streamSse(options)` becomes an async generator of parsed `SseFrame` values.
It owns:

- local HTTP/HTTPS agent selection;
- JSON POST headers and `Accept: text/event-stream`;
- response status handling;
- incremental `SseFrameParser` use;
- idle timeout and abort handling;
- request lifecycle logging; and
- deterministic socket destruction when iteration stops.

It accepts no callback. Consumers iterate explicitly.

`StatusServerApiClient` uses `this.client.streamSse(...)`, so constructor injection applies
to all requests. `src/lib/sse-client.ts` is deleted.

The llama.cpp client also iterates `HttpClient.streamSse(...)` directly. Llama-specific
rules stay at that protocol boundary: ignore malformed JSON packets, detect `[DONE]`, stop
when the response accumulator is complete, and translate an HTTP response failure into
the existing llama-specific error shape where required. This removes the old callback
parameter from `HttpClient.streamSse` without moving llama semantics into the generic
transport.

Node's event APIs necessarily receive handlers. Those handlers remain private inside
`HttpClient`; no application or service API accepts or stores a function-valued
dependency.

### Explicit progress reporters

Function-valued `onProgress`, `onSummaryProgress`, and `onRepoSearchProgress` fields are
removed from streamed operation paths.

Each operation passes a typed reporter object with an explicit reporting method. The
concrete families are summary and repo-search reporters because those are the two source
event unions. Command-output, presets, and evaluation reuse the summary/repo-search
reporters used by their underlying operation; they do not introduce parallel callback
or event abstractions.

Silent callers use explicit no-output reporter objects. Production callers never use an
optional function or dynamically compose callback closures.

At the status-server boundary, concrete SSE reporters own transport-specific behavior:

- summary events are written as `progress` frames;
- repo-search tool-start events retain their existing server logging;
- repo-search `thinking` and `answer` events retain their existing suppression from the
  CLI stream; and
- all other repo-search events are written as `progress` frames.

Core summary and repo-search progress reporter classes receive these typed reporter
objects and invoke their methods. Routes pass reporter objects into `EngineService`,
evaluation, preset execution, command-output analysis, summary requests, and repo-search
requests. Function-valued progress fields are removed rather than deprecated.

`CliProgressRenderer` already satisfies this shape: it is an explicit class consumed by
`StatusServerApiClient` while iterating frames. No callback replacement is needed there.

## Streamed error contract

The error event changes from `{ message }` to a runtime-validated payload matching the
server's canonical diagnostic result:

```ts
{
  error: string;
  errorName: string;
  diagnosticId: string;
  diagnostic: ErrorDiagnostic;
  modelRequests?: ModelRequestQueueDiagnostics;
}
```

`ErrorDiagnostic` is recursively schema-backed and remains the single source for its
inferred TypeScript type. Queue diagnostics also receive or reuse a runtime schema at the
wire boundary.

Readiness failures and execution failures emit the complete object returned by
`recordServerError`. Lock-acquisition timeout becomes a recorded server error too, then
adds the current queue diagnostics. Therefore every terminal error has the same required
diagnostic fields and only the queue-specific field is optional.

`StatusServerApiClient` validates the entire frame and throws a typed
`StatusServerOperationError`. Its message is `payload.error`, its name reflects
`payload.errorName`, and it exposes `diagnosticId`, `diagnostic`, and optional
`modelRequests` as readonly fields. Normalization does not replace this error, so callers
and CLI error formatting retain the diagnostic identity and cause chain.

Malformed pre-stream request bodies remain plain HTTP 400 responses because the SSE
stream has not opened. Transport failures continue through the existing unavailable-server
normalization.

## Data flow

1. A CLI command supplies its concrete `CliProgressRenderer` to
   `StatusServerApiClient`.
2. `StatusServerApiClient` starts `this.client.streamSse(...)` and iterates frames.
3. The status endpoint constructs typed SSE progress reporter objects and passes them
   through explicit service/request fields.
4. Core engines invoke reporter methods; the status reporter writes progress frames.
5. The CLI renders progress frames, validates a result frame, or validates and throws a
   complete structured error.
6. Early iterator completion, abort, timeout, or disconnect destroys the request and
   reaches the server abort signal so the model lock is released.

## Testing strategy

Implementation is TDD and E2E-first.

1. Add failing endpoint tests proving readiness, execution, and queue-timeout error frames
   contain all diagnostic fields; queue timeout also contains queue diagnostics.
2. Add failing `StatusServerApiClient` tests proving the injected `HttpClient` owns the SSE
   request and `StatusServerOperationError` retains all validated fields.
3. Rewrite `HttpClient` streaming tests around async iteration, including chunked frames,
   `[DONE]` visibility, HTTP failure, idle timeout, abort, early iterator exit, and agent
   reuse.
4. Update llama streaming tests to prove packet parsing, early completion, malformed-packet
   tolerance, `[DONE]`, and failure translation after callback removal.
5. Convert progress tests to concrete collecting reporter objects, covering summary,
   command-output, preset, eval, and repo-search flows.
6. Remove callback-shaped test fixtures and assert no production `onProgress`,
   `onSummaryProgress`, standalone `SseClient`, or duplicate SSE request path remains.
7. Run the full test suite and all typecheck/lint projects. Fix every failure before
   completion.

## Completion criteria

- `src/lib/sse-client.ts` no longer exists.
- `StatusServerApiClient` streams only through its injected `HttpClient`.
- `HttpClient.streamSse` is callback-free and is the sole local SSE client transport.
- No streamed operation request/service API contains function-valued progress fields.
- Every streamed terminal error retains full diagnostic parity.
- Full tests and typecheck pass with no temporary investigation files remaining.
