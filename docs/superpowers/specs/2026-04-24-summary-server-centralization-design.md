# Summary Server Centralization Design

## Goal

Move summary execution to the SiftKit status/config server so summary has the same runtime ownership model as repo-search.

After this change, the client should stop executing summary locally. The server becomes the single runtime owner for all summary execution paths.

## Problem

Today `summary` is split across processes:

- `siftkit summary` runs `summarizeRequest()` in the client process.
- The client still depends on the server for config, status, and metrics.
- `repo-search` already runs inside the server behind `POST /repo-search`.

This split creates an inconsistent architecture and makes summary more fragile than repo-search. Summary currently performs multiple status/backend updates during execution and rewrites many different failures into the same misleading "status/config server is not reachable at .../health" message. It also allows bookkeeping failures to fail an otherwise successful summary result.

## Decision

Adopt a server-owned summary model:

- Add `POST /summary` to the status server.
- Make all public and internal summary entrypoints call that route instead of calling `summarizeRequest()` locally.
- Keep `summarizeRequest()` as the core execution engine, but run it only inside the server.
- Change summary metrics flow to match repo-search in spirit:
  - one `running:true` status post at request start
  - local in-memory metric accumulation during execution
  - one aggregate `running:false` status post at completion or failure
- Make artifact persistence non-fatal for successful summary responses.

## Non-Goals

- Do not redesign summary prompting or model behavior.
- Do not move repo-search or chat execution again.
- Do not remove the server as the authoritative source for config/readiness.
- Do not preserve the current per-step summary metric posting model.

## Target Architecture

### Public execution path

`siftkit summary` should:

1. Parse CLI args and stdin/file/text input.
2. Serialize a summary request.
3. Send the request to `POST /summary`.
4. Print the returned `SummaryResult.Summary`.

The client remains responsible for shell-facing input handling, but it no longer owns summary execution.

### Server execution path

The server should expose `POST /summary`, similar to `POST /repo-search`.

The route should:

1. Parse and validate the request body.
2. Acquire the same model-request coordination used for other model-backed server operations.
3. Load config from the server-owned config store.
4. Execute `summarizeRequest()`.
5. Return the `SummaryResult` payload as JSON.

This makes the server the single runtime owner for summary.

### Internal callers

All current summary entrypoints should converge on the server-owned path in the same migration:

- `siftkit summary`
- `run`
- `eval`
- `interactive`
- `preset`
- internal summary operations currently routed through `run-internal`

The important rule is that no public or internal production path should continue to execute summary locally in the client after migration. Split ownership would preserve the current inconsistency and keep the failure surface fragmented.

## Request Shape

The new `POST /summary` route should accept the current summary inputs:

- `question`
- `inputText`
- `format`
- `policyProfile`
- `backend`
- `model`
- `sourceKind`
- `commandExitCode`
- optional debug/supporting fields already used by summary callers

The response shape should match the existing `SummaryResult` object so current callers can adapt with minimal behavior change.

## Metrics And Status Behavior

### Required behavior

Summary should follow repo-search in spirit:

- one `running:true` post at request start
- aggregate metrics collected locally during execution
- one final `running:false` post with aggregate totals

### Explicitly removed behavior

Summary should stop posting per-step `running:false` updates from:

- provider leaf execution
- planner turns
- chunk completion
- intermediate summary phases

These posts are the main behavioral difference from repo-search and are a major part of the current fragility.

### Local metric accumulation

During summary execution, the runtime should accumulate:

- prompt/input token totals
- output token totals
- tool token totals
- thinking token totals
- prompt cache / prompt eval totals
- request duration
- per-tool stats
- raw input and output character counts

This should be stored in request-local memory during the summary run and emitted once at the end.

### Failure behavior

If the final aggregate status post fails, that should not be rewritten into a fake health-check failure without preserving the actual cause. Server/client error handling should preserve the real server failure details.

## Artifact Persistence

Summary artifacts still serve a valid purpose:

- dashboard history
- request inspection
- planner-debug inspection
- failed-request debugging
- post-run forensics

But artifacts are observability, not product correctness.

### Required rule

Artifact persistence must not be allowed to fail a successful summary result.

That means:

- successful summary generation returns success even if artifact upload/persistence fails
- artifact write failures may be logged and surfaced as diagnostics
- failed summaries may still attempt to persist debugging artifacts on a best-effort basis

This preserves observability without making bookkeeping part of the user-visible success contract.

## Error Reporting

Current summary failures are misleading because downstream `/status` failures are frequently rewritten into the same canonical health/unreachable message.

After migration:

- true server reachability failures should still be reported as reachability failures
- route failures should preserve the actual HTTP/status or server-side error
- bookkeeping failures should be distinguished from summary-generation failures

The key requirement is that the returned error must describe the real failure class instead of collapsing everything into the `/health` message.

## Migration Plan

### Phase 1: Add server route

- Add `POST /summary`
- Reuse existing server request coordination patterns
- Execute `summarizeRequest()` inside the server
- Return `SummaryResult`

### Phase 2: Convert CLI summary

- Update `siftkit summary` to call `POST /summary`
- Remove direct local execution from the public CLI path

### Phase 3: Centralize remaining summary callers

- Update `run`, `eval`, `interactive`, `preset`, and internal summary call paths
- Ensure all production summary execution goes through the server route

### Phase 4: Simplify summary status reporting

- Remove per-step `running:false` posts
- Add request-local aggregate metric accumulation
- Emit one final `running:false` metrics post

### Phase 5: Harden artifact/error behavior

- Make artifact persistence non-fatal for successful summaries
- Preserve real status/route/server failures in returned errors

## Risks

### Reduced live progress visibility

Removing per-step summary status posts means the status server will no longer expose the same granularity of intermediate summary state during execution. This is acceptable because repo-search already works with a much coarser status model, and the current summary granularity is not worth the reliability cost.

### Wider migration surface

Centralizing all summary callers in one pass touches multiple entrypoints. That is intentional. A partial migration would leave two runtime owners and preserve the current architecture problem.

### Route payload size

Summary requests can include large `inputText` payloads. The route must continue to support the existing input sizes already accepted by client-side summary behavior.

## Testing Strategy

Add or update tests for:

- `POST /summary` success path
- `POST /summary` failure path
- CLI `summary` delegating to the server
- all summary entrypoints using the server path instead of local execution
- aggregate-only final summary metrics posting
- no per-step `running:false` summary metric posts
- artifact persistence failure not breaking successful summaries
- real server/status errors surfacing accurately

## Acceptance Criteria

The migration is complete when all of the following are true:

1. No public production summary flow executes summary locally in the client.
2. The server owns summary execution through `POST /summary`.
3. Summary posts one start status and one final aggregate status instead of multiple per-step final-status posts.
4. Successful summaries are not failed by artifact persistence problems.
5. Error messages preserve the real failure instead of collapsing into the fake `/health` message.
6. Existing user-facing summary CLI behavior remains intact.
