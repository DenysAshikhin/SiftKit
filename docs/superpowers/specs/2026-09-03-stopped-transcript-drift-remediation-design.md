# Stopped Transcript Drift Remediation Design

## Objective

Make a chat Stop operation a durable transcript boundary while removing the duplicated, compatibility-oriented implementation introduced by the initial fix. The persisted transcript and WebUI must preserve every streamed thinking, narration/progress, tool, and answer segment in canonical order. Future model requests must replay only semantically complete context.

This refactor covers direct chat, plan, repo-search, and repo-agent streams. It does not change normal completed-stream content or introduce general event sourcing.

## Chosen approach

Use one shared, pure transcript reducer plus an explicit stopped-turn persistence path.

The reducer lives in the Node-free contracts package because both the status server and dashboard consume the same wire contracts. It owns message identity, cumulative text replacement, narration promotion/demotion, progress replacement, tool upserts, and terminal stopping. The server retains the reducer result for persistence; the dashboard uses the same reducer result for live display.

Alternatives rejected:

- Keeping separate server and dashboard reducers would preserve the current DRY violation and allow visible and persisted state to diverge.
- Persisting the browser's state back to the server would lose durability on disconnect and make the client authoritative.
- Continuing to splice partial rows into a normally-built answer would retain the fake-completed-turn invariant and ordering risks.

## Message contracts

Replace the identical `LiveChatMessage` and `PersistedChatMessage` aliases with a canonical `ChatTranscriptMessageSchema` plus distinct derived lifecycle schemas. `PersistedChatTranscriptMessageSchema` accepts terminal transcript rows and rejects running tools; `ReplayableChatMessageSchema` accepts only prompt-safe rows. All existing consumers migrate to those explicit names; no compatibility aliases remain.

Define tool lifecycle status as `running | done | stopped`. `running` is live-only state, `done` is replayable completed work, and `stopped` is terminal transcript-only evidence. When Stop finalizes a transcript, every still-running tool becomes `stopped`.

Export explicit persisted and replayable schemas and type guards derived from the canonical runtime schema. The persisted schema accepts ordinary user/answer/thinking/narration/progress/image/summary/approval rows plus `done` or `stopped` tools. The replayable schema accepts ordinary user/answer/thinking/image/summary/approval rows and only `done` tool rows. Narration, progress, and stopped/running tool rows cannot enter prompt history, retained web-tool state, or context-usage accounting.

## Shared transcript reducer

Create a focused shared module that consumes the existing typed chat stream events and produces ordered `ChatTranscriptMessage[]`.

The reducer must:

- append or replace cumulative thinking by turn;
- append or replace narration by turn;
- demote a turn's narration to progress when a tool starts;
- promote a turn's narration/progress row to the cumulative answer when that turn starts answering;
- keep one replaceable general progress row;
- upsert tool start/result rows by tool-call ID;
- ignore empty cumulative text snapshots that never reached the UI;
- preserve every completed turn's thinking rather than applying live stack display limits;
- use injected request metadata (`sourceRunId`, timestamp) rather than generating environment-dependent state internally;
- finalize Stop by changing running tools to `stopped` and appending the operation-specific stop marker to the single partial answer, or creating one marker answer when no partial answer exists.

The dashboard runtime store delegates message transitions to this reducer. `ChatStreamProgressWriter` remains responsible only for SSE batching/forwarding and retaining the reducer's current result. Server and dashboard adapters may translate their existing event wrappers into the shared reducer input, but may not reimplement state transitions.

## First-class stopped-turn persistence

Extract the existing user-message construction into one typed helper shared by completed and stopped turn builders.

Add a stopped-turn builder that accepts:

- the current session;
- user content and images;
- the already-finalized ordered transcript messages;
- optional repo-agent approval rows.

It appends the user row and transcript rows directly, applies compaction metadata where relevant, updates the session timestamp, validates the canonical transcript schema, and performs one `saveChatSession` transaction. It does not create a marker-only completed answer first, inspect the last row, slice it away, or attach transcript rows afterward.

Repo-agent completion uses the same stopped-turn builder when its terminal result is aborted. Completed, failed, and approval-timeout outcomes continue through the normal repo-agent builder.

## Durable Stop lifecycle

Each acquired `ChatSessionOperation` exposes a completion promise settled by `ChatSessionOperationEndpoint` only after `run()` returns and all transcript persistence has completed. Completion is a discriminated internal result: `completed` or `failed` with an error message.

The Stop endpoint verifies ownership, requests abort, then awaits that operation completion. It returns `200` only after the stopped transcript is durable and the operation lease has finalized. If finalization fails, it returns an explicit `500` and does not claim success. The stream still emits `done` after persistence or `error` on failure.

The registry owns completion state. Endpoint implementations do not pass completion callbacks through route layers. Existing abort registration remains only where an external API requires a callback; the refactor must not add new dynamically-passed functions.

## Persistence and migration

The uncommitted schema migration remains version 60 and becomes the complete migration for this feature.

Migration v60 must:

- require the predecessor `chat_messages.kind` column and fail immediately if it is absent;
- explicitly backfill legitimate null historical kinds from role before strict reads are enabled;
- add `tool_call_status` with `running | done | stopped` validation;
- backfill historical tool rows as `done`;
- leave non-tool status null.

`MessageRowSchema.kind` becomes non-null. Remove `normalizeMessageKind`; parse kinds through the exported runtime schema. Invalid roles or kinds fail at the database boundary rather than being guessed.

Correct old migration fixtures so a database stamped as v32 actually contains every schema change through v32. Remove redundant hardcoded current-version assertions from unrelated migration tests; only the v60-specific test asserts the literal version 60.

## Tool rendering

Rendering derives tool presentation from `toolCallStatus` as well as exit code:

- `running`: active present-tense label;
- `done`: completed label, with failure styling when exit code is nonzero;
- `stopped`: terminal stopped label and non-active styling.

Persisted stopped tools therefore never appear to still be executing.

## Test architecture

Replace `StatusEngineService.prototype` mutation with typed engine injection in the existing server test harness. Each test receives its own engine instance. The production server continues to construct the real engine by default; the injection seam is test configuration, not a global mutable override.

The abort wait helper throws immediately when no `AbortSignal` is supplied.

Use TDD in these independently verifiable slices:

1. Shared reducer parity and stopped tool finalization.
2. Canonical transcript/replay contracts and strict database migration.
3. First-class stopped-turn builders for direct and repo-agent flows.
4. Durable Stop completion semantics.
5. Dashboard integration using the shared reducer.
6. Test-harness engine injection and removal of every prototype mutation.

Tests cover direct chat, plan, repo-search, repo-agent, empty partial state, cumulative buffered text, multi-turn ordering, narration promotion/demotion, running/done/stopped tools, persistence/API round-trip, immediate post-Stop reads, finalization failure, replay exclusion, and WebUI replacement.

## Error handling

- Missing or invalid persisted kinds fail at migration/read boundaries.
- Missing abort signals in tests fail immediately.
- Stop finalization failures surface through both the stream error event and Stop HTTP failure.
- A stopped transcript without a terminal answer is valid; finalization creates the marker answer.
- Multiple terminal answers are invalid reducer state and fail loudly.

## Acceptance criteria

- Stop `200` means the complete stopped transcript is already readable from storage.
- Server and dashboard use one transcript state-transition implementation.
- No fake completed turn or post-build answer splicing remains.
- No `LiveChatMessage`/`PersistedChatMessage` compatibility aliases remain.
- Interrupted tools persist and render as `stopped`, never `running`.
- Migration prerequisites and malformed persisted kinds fail loudly.
- No Stop test mutates a production prototype or hides a missing signal with an infinite promise.
- Relevant tests, the full applicable suite, `npm run typecheck`, `npm run lint`, and the production build pass.
