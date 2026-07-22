# Streamed CLI Transport — Design

Date: 2026-07-22
Status: Approved (spec 1 of 2; spec 2 = interactive approval mode, rides on this layer)

## Problem

Every engine-backed CLI op (`siftkit summary`, `repo-search`, `run`, `run --preset`, `eval`)
is a fire-and-forget HTTP POST: the CLI blocks silently — often for minutes — until the
status server returns one JSON body. There is no progress, no feedback while queued on the
server's single-flight model lock, and a hung CLI can pin that lock for the full run.

The upcoming interactive approval mode (spec 2) requires a live bidirectional-ish channel;
this spec builds the streaming half as a universal transport rather than a repo-search
one-off.

## Goals

- Every engine-backed op streams progress to the terminal while it runs.
- Lock waiters see queue feedback instead of blocking blind; Ctrl+C exits cleanly and
  frees the server.
- One shared client/server streaming layer — no per-op transport forks.
- Result payload schemas unchanged; only the transport changes.

Non-goals: concurrent model runs (single-flight lock stays), spinner/TUI polish,
the approval gate itself (spec 2).

## Scope

Converted to SSE (JSON forms **removed**, not kept alongside):

| Endpoint | CLI command |
|---|---|
| `POST /summary` | `siftkit summary` |
| `POST /command-output/analyze` | `siftkit run`, internal `command`/`command-analyze`/`interactive-capture` |
| `POST /preset/run` | `siftkit run --preset` |
| `POST /eval/run` | `siftkit eval` |
| `POST /repo-search` | `siftkit repo-search` |

Unchanged plain JSON: `/config`, `/preset/list`, `/status`, `/health` — trivial reads with
no progress to report.

Verified: the five endpoints are CLI-only; the dashboard uses `/dashboard/*` routes
exclusively, so removal breaks no dashboard consumer.

## Wire protocol

One envelope for every streamed op — POST request body unchanged, response is
`text/event-stream`:

```
event: progress   data: <typed per-op progress event JSON>
event: result     data: <existing result payload, schema unchanged>
event: error      data: { "message": string }
```

- Exactly one terminal frame per stream: `result` or `error`.
- Result payloads keep their existing zod schemas (`SummaryResultSchema`,
  `RepoSearchExecutionResultSchema`, `CommandOutputAnalyzeResultSchema`,
  `PresetRunResultSchema`, `EvaluationResultSchema`).
- Server heartbeats (SSE comment frame `: hb`) every 15 s so client idle-timeout can
  distinguish a slow op from a dead server.

## Server side

### `SseResponseWriter` — `src/status-server/sse-response-writer.ts`

Extracted from the four duplicated `writeSse` closures
(`routes/chat.ts:942`, `routes/chat.ts:1272`, `routes/chat.ts:1510`,
`routes/dashboard.ts:488`). Owns: `writeHead(200, text/event-stream)`, frame framing,
client-disconnect suppression, heartbeat timer, `end()`. Existing chat/dashboard SSE
routes migrate onto it — the closures are deleted.

### `StreamedOperationEndpoint` — shared base for the five routes

Flow per request:

1. Parse/validate body (per-op zod parse, unchanged); parse failure returns plain
   HTTP 400 JSON — SSE is not opened yet.
2. Open SSE via `SseResponseWriter`.
3. Acquire model lock; while queued, emit
   `progress { kind: 'lock_wait', position, elapsedMs }` instead of blocking silently.
4. Wire `req.on('close')` → abort the op (`AbortSignal`) → release lock.
5. Execute op with a typed progress reporter that forwards events as `progress` frames.
6. Emit `result` (or `error` with the message) and end the stream.
7. `finally`: release model lock.

The five endpoints become thin subclasses supplying parse + execute. Existing admission
records, preset-readiness checks, sanity checks (`RepoSearchResponseSanityChecker`) move
into the repo-search subclass unchanged.

### Progress sources

- **repo-search**: already typed (`RepoSearchProgressEvent` via
  `repo-search/engine/progress-reporter.ts`). `onProgress` now also forwards frames to the
  SSE stream (server-side log emission at `routes/core.ts:928` is preserved).
- **summary** (also covers `run`, `run --preset`, `eval` — all funnel through
  `summarizeRequest`, see `command-output/analyzer.ts:170`, `status-server/eval.ts:86`):
  the 12 `logSummaryProgress` call sites in `summary/request-runner.ts` /
  `summary/core-runner.ts` currently print untyped lines to the *server's* stdout. They
  become typed `SummaryProgressEvent`s emitted through a new `SummaryProgressReporter`
  class (mirrors `ProgressReporter`: explicit methods per event kind, injected reporter,
  no dynamic callbacks). `summary/progress.ts` / `logSummaryProgress` are **deleted**.

```ts
type SummaryProgressEvent =
  | { kind: 'start'; requestId: string; inputChars: number }
  | { kind: 'config_done'; backend: string; model: string }
  | { kind: 'chunk_plan'; chunkCount: number }
  | { kind: 'core_start' | 'core_done'; backend: string }
  | { kind: 'completed'; classification: string }
  | { kind: 'failed'; error: string };
// exact set derived from the 12 existing call sites during implementation
```

### Lock behavior

Single-flight is unchanged. Changes: queued callers stream `lock_wait` progress; client
disconnect (including Ctrl+C) aborts the op and releases the lock — today a hung CLI can
pin it for the full run.

## CLI side

### `SseClient` — `src/lib/sse-client.ts`

POST + `text/event-stream` parser on the existing `httpRequest` plumbing in
`lib/http-client.ts`. Explicit class:

```ts
type SseFrame = { event: string; data: string };

class SseClient {
  async *stream(options: {
    url: string;
    body: string;
    idleTimeoutMs: number; // default 10 min (matches DEFAULT_SERVER_REQUEST_TIMEOUT_MS)
  }): AsyncGenerator<SseFrame>;
}
```

Idle timeout (no frame for N ms → destroy socket) replaces whole-request timeout: a
healthy stream heartbeats, so idle silence means a dead server. Heartbeat comment frames
reset the timer but are not yielded.

### `StatusServerApiClient`

Method signatures keep their return types
(`requestRepoSearch(...): Promise<RepoSearchExecutionResult>` etc.) and gain a
**required** per-op `onProgress` reporter parameter. Internally: consume frames, dispatch
`progress` to the reporter, zod-parse the `result` frame with the existing schema, throw
on `error` frame or on stream end without a terminal frame. Non-rendering callers (eval
harness, internal ops) pass an explicit no-op reporter — the parameter is not optional.

### `CliProgressRenderer` — `src/cli/progress-renderer.ts`

- One line per progress event to **stderr**; stdout reserved for the final result, so
  piping (`siftkit summary ... | jq`) is unaffected.
- Format: `[HH:MM:SS] <op> <event summary>` — e.g.
  `[12:04:11] repo-search turn 3/24 grep "ApprovalGate" (1.2k tokens)`,
  `[12:04:13] summary chunk 2/5`, `[12:03:59] waiting for model lock (1 ahead)`.
- Non-TTY stderr: same lines, no ANSI. No spinner/repaint in this spec.

## Error handling

| Failure | Behavior |
|---|---|
| Server unreachable | Existing `getStatusServerUnavailableMessage()` path unchanged. |
| `error` frame | CLI throws with the message; exit 1. |
| Stream ends without terminal frame | CLI exits 1: `stream ended before result`. |
| Idle timeout | CLI destroys socket, exits 1; server sees close, aborts, frees lock. |
| Ctrl+C | CLI destroys socket; server `close` handler aborts engine run and frees lock. |
| Client sends malformed body | Plain HTTP 400 JSON (before SSE opens); CLI surfaces it via the existing `HTTP <status>` error path. |

## Testing (TDD, E2E-first)

Extend the real-server harness style of `tests/repo-search-status-server.test.ts` using
existing model mocks (`mockResponses`, `mockCommandResults`):

1. Each of the five ops: progress frames arrive before `result`; `result` parses with the
   existing schema; CLI exit code 0.
2. Lock queue: second concurrent request receives `lock_wait` progress, then runs.
3. Mid-stream client disconnect: op aborted, lock released (third request proceeds).
4. `error` frame path: engine failure → `error` frame, exit 1, lock released.
5. CLI rendering: progress lines on stderr, result only on stdout (pipe-safety).
6. Idle timeout: silent server → client exits 1 with timeout error.
7. `SseClient` unit: frame parsing across chunk boundaries, heartbeat handling.

Existing JSON-transport tests for the five endpoints are rewritten to SSE — not kept.

## Follow-up (spec 2, separate design)

Interactive approval mode: `--interactive` flag; server emits
`progress { kind: 'approval_request', approvalId, ... }` on this same stream and parks
the engine (gate point after `prepareCommandToRun` in
`repo-search/engine/tool-action-processor.ts`); CLI prompts
Approve / Deny+reason / Abort on the TTY and POSTs the decision to a small approval
endpoint; unanswered prompts abort after a configurable timeout; non-TTY + `--interactive`
fails fast at startup. Decisions from the earlier brainstorm: gate every tool call;
purpose is to unlock the withheld `write`/`edit`/`run` tools.
